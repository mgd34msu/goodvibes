/** Per-invocation live-source adapter. Captured sources never enter this filesystem path. */
import { lstatSync, realpathSync, type Stats } from 'node:fs';
import { join, relative, isAbsolute, dirname } from 'node:path';
import { executePolicyCheck } from '../gate/execute-policy-check.js';
import { captureCodeFileObservation, type CodeFileObservation } from './code-file-observation.js';
import { rankCodeInjectionSnapshots, type CodeInjectionAuthorityOptions } from './code-injection-ranking.js';
import type { CodeContextResult } from './code-index-types.js';

/**
 * The most bytes of one hit's file read back to rank it: the whole file is read
 * (its revision is the hash of all of it) and screened locally; only the hit's
 * lines are sent. The same bound as the lexical code index.
 */
export const CODE_INJECTION_READ_BYTES = 1024 * 1024;

/** Why one code hit was left out of this turn's injection. */
export type SkippedCodeHitReason = 'changed' | 'missing' | 'too-large' | 'restricted';
/** A code hit left out of the injection, and the file it named. */
export interface SkippedCodeHit {
  readonly path: string;
  readonly absolutePath: string;
  readonly reason: SkippedCodeHitReason;
}

/**
 * Ranks the hits whose files are as indexed. A hit whose file changed since
 * indexing, is gone, is over the read bound or is not readable now is left out
 * and listed in `skipped`; the other hits are still ranked. Only a failure of
 * the whole operation (the root, the read authority, cancellation) throws.
 */
export async function rankLiveCodeInjection(root: string, query: string, hits: readonly CodeContextResult[], options: CodeInjectionAuthorityOptions, assertSource: () => void) {
  const policy = options.readAccessFilter;
  if (!policy) throw new Error('Code injection requires current read authority');
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const sourceRoot = realpathSync(root);
  const identity = (stat: Stats) => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const directories = new Map<string, string>([[sourceRoot, identity(lstatSync(sourceRoot))]]);
  const observed = new Map<string, CodeFileObservation>();
  // One pass authorizes and reads every hit once: before the ranking request,
  // and again at consumption. The directory identities are compared once at the
  // end of a pass, after its last await, not around every policy call.
  const check = (): void => { signal.throwIfAborted(); assertSource(); if (realpathSync(root) !== sourceRoot) throw new Error('Code injection root is stale');
    for (const [path, expected] of directories) if (identity(lstatSync(path)) !== expected) throw new Error('Code injection directory is stale'); };
  const authorize = async (path: string): Promise<void> => {
    signal.throwIfAborted();
    if (!(await executePolicyCheck(() => policy(path), signal))) throw new Error('Code injection source is access-restricted');
  };
  const sourcePath = (hit: CodeContextResult): string => {
    const path = join(sourceRoot, hit.chunk.path), rel = relative(sourceRoot, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || realpathSync(path) !== path) throw new Error('Code injection path is stale');
    return path;
  };
  const read = (hit: CodeContextResult): string => {
    const path = sourcePath(hit);
    const source = captureCodeFileObservation(sourceRoot, path, CODE_INJECTION_READ_BYTES);
    if (source.revision !== hit.chunk.fileRevision) throw new Error('Code injection source is stale');
    const previous = observed.get(path);
    if (previous) {
      previous.assertCurrent();
      if (source.revision !== previous.revision || source.content !== previous.content) throw new Error('Code injection source is stale');
      return previous.content;
    }
    observed.set(path, source);
    return source.content;
  };
  const timer = setTimeout(() => controller.abort(new Error('Code injection read budget exceeded')), 15_000);
  try {
    await authorize(root); await authorize(sourceRoot);
    const snapshots: { hit: CodeContextResult; code: string }[] = [];
    const skipped: SkippedCodeHit[] = [];
    for (const hit of hits) {
      const absolutePath = join(sourceRoot, hit.chunk.path);
      const skip = (reason: SkippedCodeHitReason) => { skipped.push({ path: hit.chunk.path, absolutePath, reason }); };
      let path: string;
      try { path = sourcePath(hit); } catch { skip('missing'); continue; }
      const size = (() => { try { return lstatSync(path).size; } catch { return undefined; } })();
      if (size === undefined) { skip('missing'); continue; }
      if (size > CODE_INJECTION_READ_BYTES) { skip('too-large'); continue; }
      const checked: string[] = [];
      let readable = true;
      for (let directory = dirname(path); directory !== sourceRoot; directory = dirname(directory)) {
        if (directories.has(directory)) continue;
        if (!(await executePolicyCheck(() => policy(directory), signal))) { readable = false; break; }
        checked.push(directory);
      }
      signal.throwIfAborted();
      if (!readable || !(await executePolicyCheck(() => policy(path), signal))) { skip('restricted'); continue; }
      for (const directory of checked) directories.set(directory, identity(lstatSync(directory)));
      let code: string;
      try { code = read(hit); }
      catch (error) {
        signal.throwIfAborted();
        skip(error instanceof Error && /stale|changed/i.test(error.message) ? 'changed' : 'missing');
        continue;
      }
      snapshots.push({ hit, code });
    }
    check();
    const assertCurrent = async () => {
      const assertionTimer = setTimeout(() => controller.abort(new Error('Code injection authority budget exceeded')), 15_000);
      try {
      await authorize(root); await authorize(sourceRoot);
      for (const path of directories.keys()) if (path !== sourceRoot) await authorize(path);
      for (const snapshot of snapshots) { await authorize(sourcePath(snapshot.hit)); if (read(snapshot.hit) !== snapshot.code) throw new Error('Code injection source is stale'); }
      check();
      for (const original of observed.values()) original.assertCurrent();
      } finally { clearTimeout(assertionTimer); }
    };
    const reading = snapshots.length === 0
      ? { ranked: [], assertCurrent }
      : await rankCodeInjectionSnapshots(query, snapshots, { signal, assertCurrent, checkedBeforeRequest: true });
    return { ...reading, skipped: Object.freeze(skipped) };
  } catch (error) { controller.abort(); throw error; }
  finally { clearTimeout(timer); }
}
