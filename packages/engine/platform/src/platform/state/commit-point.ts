/**
 * One commit point for a change spread over several writes.
 *
 * Two forms; a store uses the first unless it cannot.
 *
 * Pointer last ({@link stageReplacement}, {@link publishReplacement},
 * {@link recoverReplacements}): the new version of a file or directory is built
 * beside the old one, synced, and published with one rename; the old version is
 * kept until the published one is complete and verified, and only then
 * removed. Readers trust only what the target path names. A crash at any step
 * leaves either the old version or the new one in place, and the next open
 * restores the old one when the new one does not verify.
 *
 * Intent line ({@link withIntent}, {@link recoverIntents}): for a change across
 * stores that cannot share a rename (a secret and a row, a unit file and a
 * receipt). The intent names every write and how to undo each, and is synced
 * before the first write; `committed` is appended after the last. An intent
 * with no `committed` after it is undone, step by step, at the next start.
 *
 * Cost: pointer last adds one rename and one directory fsync to a whole
 * replacement (plus a second rename when an old version exists); intent adds
 * one line and one fdatasync before the change and one batched line after it.
 */
import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { RecordLog } from './record-log.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

// ---------------------------------------------------------------- pointer last

/** A replacement being built: `staged` beside `target`; `previous` is where the current target is kept while the new one is checked (null when there is none). */
export interface Replacement {
  readonly target: string;
  readonly staged: string;
  readonly previous: string | null;
  readonly kind: 'file' | 'directory';
}

const MARK = /^\.(.+)\.(staged|previous)-\d+-[a-z0-9]+$/;

function sibling(target: string, role: 'staged' | 'previous', tag: string): string {
  return join(dirname(target), `.${basename(target)}.${role}-${tag}`);
}

function syncPath(path: string, directory: boolean): void {
  const fd = openSync(path, directory ? constants.O_RDONLY | constants.O_DIRECTORY : constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Syncs a file, or a directory with every file and directory under it, so a rename publishes complete content. */
function syncTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) { syncPath(path, false); return; }
  for (const entry of readdirSync(path)) syncTree(join(path, entry));
  syncPath(path, true);
}

function remove(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/**
 * Names the staged path beside `target` (`.<name>.staged-<pid>-<rand>`) and,
 * when `target` exists, the path it is kept at during the swap. The caller
 * writes the new version at `staged` (for `directory`, the caller creates it).
 */
export function stageReplacement(target: string, kind: 'file' | 'directory'): Replacement {
  const tag = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  return {
    target,
    kind,
    staged: sibling(target, 'staged', tag),
    previous: existsSync(target) ? sibling(target, 'previous', tag) : null,
  };
}

/**
 * Syncs the staged version, moves the current target aside, renames the staged
 * version into place, syncs the directory, then runs `verify` on the target.
 * When `verify` throws, the previous version is put back and the error is
 * rethrown; otherwise the previous version is removed. Throws, leaving the
 * target as it was, when a step before the second rename fails.
 */
export function publishReplacement(r: Replacement, verify: (path: string) => void): void {
  const dir = dirname(r.target);
  syncTree(r.staged);
  const keptPrevious = r.previous !== null && existsSync(r.target);
  if (keptPrevious) renameSync(r.target, r.previous!);
  try {
    renameSync(r.staged, r.target);
  } catch (error) {
    if (keptPrevious) renameSync(r.previous!, r.target);
    throw error;
  }
  syncPath(dir, true);
  try {
    verify(r.target);
  } catch (error) {
    // The published version is not right: the previous one comes back, and the new one is kept aside to be looked at, then removed.
    remove(r.staged);
    renameSync(r.target, r.staged);
    if (keptPrevious) renameSync(r.previous!, r.target);
    syncPath(dir, true);
    remove(r.staged);
    throw error;
  }
  if (keptPrevious) remove(r.previous!);
}

/**
 * At open: for every replacement in `dir` a crash interrupted, keeps a target
 * that verifies and removes what it replaced; otherwise puts the previous
 * version back. Staged versions that were never published are removed.
 */
export function recoverReplacements(dir: string, verify: (path: string) => boolean): void {
  let names: string[];
  try { names = readdirSync(dir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const byTarget = new Map<string, { staged: string[]; previous: string[] }>();
  for (const name of names) {
    const match = MARK.exec(name);
    if (!match) continue;
    const entry = byTarget.get(match[1]!) ?? { staged: [], previous: [] };
    (match[2] === 'staged' ? entry.staged : entry.previous).push(join(dir, name));
    byTarget.set(match[1]!, entry);
  }
  let changed = false;
  for (const [name, entry] of byTarget) {
    const target = join(dir, name);
    for (const staged of entry.staged) { remove(staged); changed = true; }
    if (entry.previous.length === 0) continue;
    let targetGood = false;
    try { targetGood = existsSync(target) && verify(target); } catch { targetGood = false; }
    if (targetGood) {
      for (const previous of entry.previous) remove(previous);
    } else {
      // The newest kept version comes back; a target that does not verify goes.
      const [restore, ...older] = entry.previous.sort((a, b) => lstatSync(b).mtimeMs - lstatSync(a).mtimeMs);
      if (existsSync(target)) remove(target);
      renameSync(restore!, target);
      for (const previous of older) remove(previous);
      logger.warn('[commit-point] an interrupted replacement was rolled back to the version before it', { target });
    }
    changed = true;
  }
  if (changed) syncPath(dir, true);
}

// ---------------------------------------------------------------- intent line

/** One write of a change and how to undo it. */
export type IntentStep =
  | { readonly op: 'file'; readonly path: string; readonly undo: 'delete' | { readonly restoreFrom: string } }
  | { readonly op: 'secret'; readonly key: string; readonly undo: 'delete' }
  | { readonly op: 'unit'; readonly path: string; readonly undo: 'delete' };

export interface IntentLine {
  readonly id: string;
  readonly kind: string;
  readonly state: 'intent' | 'committed' | 'undone';
  /** Every write of the change, on the `intent` line; empty on `committed` and `undone`. */
  readonly steps: readonly IntentStep[];
}

/**
 * Appends the intent and waits for its sync, runs the change, then appends
 * `committed` (batched, not awaited). When `run` throws, the intent stays
 * open and the error is rethrown: the caller undoes it now with
 * {@link recoverIntents}, or the next start does.
 */
export async function withIntent(log: RecordLog<IntentLine>, intent: Omit<IntentLine, 'state'>, run: () => Promise<void>): Promise<void> {
  log.append({ ...intent, state: 'intent' });
  await log.flush();
  await run();
  log.append({ id: intent.id, kind: intent.kind, state: 'committed', steps: [] });
}

/**
 * Undoes every intent with no `committed` after it: its steps in reverse order
 * through `undo`, then `undone` is appended. A step whose undo throws is
 * logged and the rest still run; the intent is then left open for the next start.
 */
export function recoverIntents(log: RecordLog<IntentLine>, undo: (step: IntentStep) => void): void {
  const latest = new Map<string, IntentLine>();
  const steps = new Map<string, readonly IntentStep[]>();
  for (const line of log.scan()) {
    if (!line || typeof line !== 'object' || typeof line.id !== 'string') continue;
    latest.set(line.id, line);
    if (line.state === 'intent') steps.set(line.id, line.steps);
  }
  for (const [id, line] of latest) {
    if (line.state !== 'intent') continue;
    let failed = false;
    for (const step of [...(steps.get(id) ?? [])].reverse()) {
      try { undo(step); } catch (error) {
        failed = true;
        logger.error('[commit-point] undoing a step of an unfinished change failed; the next start tries again', { id, kind: line.kind, step: step.op, error: summarizeError(error) });
      }
    }
    if (!failed) log.append({ id, kind: line.kind, state: 'undone', steps: [] });
  }
}
