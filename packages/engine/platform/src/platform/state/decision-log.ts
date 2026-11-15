import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteDecisionLog } from '@goodvibes-jev/judgment';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/**
 * The state layer's decision log: every Jev reading the engine takes,
 * answered or failed, in one SQLite file at the state root, beside the memory
 * and code-index stores. A composition opens it when it opens its state and
 * closes it when its disposal scope runs; runtime/judgment-services.ts wraps
 * the judgment port so every call is recorded here.
 */
export const DECISION_LOG_FILE = 'decisions.sqlite';

/** Where the decision log lives under a state root (`<workspace>/.goodvibes/<surface root>`). */
export function decisionLogPath(stateRoot: string): string {
  return join(stateRoot, DECISION_LOG_FILE);
}

/** A log written by a build this one does not recognise, or a file that is not a database at all. A busy or locked log is neither: it is still someone's. */
function isUnreadableLog(error: unknown): boolean {
  if (error instanceof RangeError && /schema version/.test(error.message)) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'SQLITE_NOTADB' || code === 'SQLITE_CORRUPT';
}

/** Moves the log and its write-ahead files to `decisions.sqlite.unrecognized-<n>`; never deletes anything. */
function setUnreadableLogAside(path: string): string {
  let n = 1;
  while (existsSync(`${path}.unrecognized-${n}`)) n++;
  const target = `${path}.unrecognized-${n}`;
  renameSync(path, target);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(path + suffix)) renameSync(path + suffix, target + suffix);
  }
  return target;
}

/**
 * Opens (creating when absent) the state root's decision log. A log this build cannot read is kept
 * aside and a new one started, so the whole composition does not fail on it; `notice` says what happened.
 * Close the log with `[Symbol.dispose]()`.
 */
export function openStateDecisionLogWithNotice(stateRoot: string): { readonly log: SqliteDecisionLog; readonly notice?: string } {
  mkdirSync(stateRoot, { recursive: true });
  const path = decisionLogPath(stateRoot);
  try {
    return { log: new SqliteDecisionLog(path) };
  } catch (error) {
    if (!isUnreadableLog(error)) throw error;
    return recoverUnreadableLog(path, error);
  }
}

/**
 * Called after an open failed as unreadable. Opens again first: another process starting on the same
 * state root may have already set the bad file aside and begun a new log, and that live log must not be moved.
 */
export function recoverUnreadableLog(path: string, error: unknown): { readonly log: SqliteDecisionLog; readonly notice?: string } {
  try {
    return { log: new SqliteDecisionLog(path) };
  } catch (again) {
    if (!isUnreadableLog(again)) throw again;
  }
  const kept = setUnreadableLogAside(path);
  const notice = `The decision log could not be read (${summarizeError(error)}). It was kept at ${kept} and a new log was started.`;
  logger.warn(notice, { path, kept });
  return { log: new SqliteDecisionLog(path), notice };
}

/** Opens (creating when absent) the state root's decision log. Close it with `[Symbol.dispose]()`. */
export function openStateDecisionLog(stateRoot: string): SqliteDecisionLog {
  return openStateDecisionLogWithNotice(stateRoot).log;
}
