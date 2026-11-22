import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SqliteDecisionLog, type DecisionLogCarriedForward, type DecisionLogStorage } from '@goodvibes/judgment';
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
  const home = homedir();
  const shown = home && kept.startsWith(`${home}/`) ? `~${kept.slice(home.length)}` : kept;
  const notice = `The record of past decisions could not be read (${summarizeError(error)}). It was kept at ${shown} and a new one was started.`;
  logger.warn(notice, { path, kept });
  return { log: new SqliteDecisionLog(path), notice };
}

/**
 * How long the decision log keeps entries: the owner's age cap for logs
 * (`atRest.retentionMaxAgeDays`, 30 days unless changed), and at most the
 * newest 100,000 (the widest window the call-volume monitor reads). Entries
 * with a truth note (an owner correction, an outcome, a calibration fixture)
 * are kept whatever their age, because accuracy-against-confidence reports and
 * calibration read them. Pruning runs in batches after start-up and once a
 * day, so start-up never waits on a large backlog; the space it frees goes
 * back to the file system a few megabytes at a time (`reclaimPages` pages per
 * step). A file written before decision questions were stored once per set is
 * carried forward by the same pass, `batch` rows at a time, and rewritten once
 * to the incremental form when its live data is at most `finishBelowBytes`
 * (a rewrite that size takes a fraction of a second), so the rewrite never
 * holds a large file.
 */
export const DECISION_LOG_RETENTION = {
  days: 30,
  maxEntries: 100_000,
  batch: 500,
  reclaimPages: 2_048,
  finishBelowBytes: 32 * 1024 * 1024,
  firstPassDelayMs: 10_000,
  intervalMs: 24 * 60 * 60 * 1000,
} as const;

/** What retention needs from a log; the SQLite log has all of it. */
export interface PrunableDecisionLog {
  prune(rule: { readonly before: string; readonly maxEntries: number; readonly batch: number }): number;
  checkpoint?(): void;
  /** Carries up to `batch` rows written before questions were stored once per set; returns how many. */
  carryForward?(batch: number): number;
  storage?(): DecisionLogStorage;
  /** Gives up to `pages` free pages back; returns how many went. */
  reclaim?(pages: number): number;
  /** The one rewrite that ends a carry-forward, with the file's size before and after; undefined when there was none to end. */
  finishCarryForward?(): DecisionLogCarriedForward | undefined;
}

const MB = 1024 * 1024;
const megabytes = (bytes: number): string => {
  const value = Math.max(0, bytes / MB);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} MB`;
};

/** The one line said when an older decision log has been carried forward: how much space came back. */
export function describeDecisionLogCarriedForward(result: DecisionLogCarriedForward): string {
  return `The decision log was carried forward to its smaller form: ${megabytes(result.fromBytes)} became ${megabytes(result.toBytes)}, so ${megabytes(result.fromBytes - result.toBytes)} came back to the disk.`;
}

/**
 * Applies the retention rule to a log in the background: one pass shortly
 * after start-up and one a day, each a series of bounded batches with an
 * event-loop turn between them: prune, carry older rows forward, give freed
 * pages back. `days` reads the owner's age cap at each pass. Dispose before
 * closing the log. Cost on a turn: none; each batch is one short write
 * between turns of the event loop.
 */
export function scheduleDecisionLogRetention(
  log: PrunableDecisionLog,
  options: {
    readonly now?: () => number;
    readonly rule?: { readonly [K in keyof typeof DECISION_LOG_RETENTION]?: number };
    readonly days?: () => number;
    /** Called once, when an older file's carry-forward ends, with what came back. */
    readonly onCarriedForward?: (result: DecisionLogCarriedForward) => void;
  } = {},
): { dispose(): void; pass(): Promise<number> } {
  const rule = { ...DECISION_LOG_RETENTION, ...options.rule };
  const now = options.now ?? Date.now;
  let disposed = false;
  let running: Promise<number> | undefined;
  const nextTurn = (): Promise<void> => new Promise<void>(resolve => setImmediate(resolve));
  /** Runs `step` until it does less than `full`, a turn of the event loop between calls; returns the total. */
  const drain = async (step: () => number, full: number): Promise<number> => {
    let total = 0;
    for (;;) {
      if (disposed) break;
      const count = step();
      total += count;
      if (count < full) break;
      await nextTurn();
    }
    return total;
  };
  const daysNow = (): number => {
    const days = options.days?.();
    return typeof days === 'number' && Number.isFinite(days) && days >= 1 ? days : rule.days;
  };
  // The body starts a microtask after `running` is assigned, so its `finally`
  // always clears the pass it belongs to, even when the first batch is the last
  // and nothing in the body awaits. Otherwise a pass that finished without
  // yielding would stay `running` forever and every later pass would be skipped.
  const pass = (): Promise<number> => running ??= Promise.resolve().then(async () => {
    let removed = 0;
    try {
      const before = new Date(now() - daysNow() * 24 * 60 * 60 * 1000).toISOString();
      removed = await drain(() => log.prune({ before, maxEntries: rule.maxEntries, batch: rule.batch }), rule.batch);
      const carried = log.carryForward ? await drain(() => log.carryForward!(rule.batch), rule.batch) : 0;
      let reclaimed = 0;
      const storage = disposed ? undefined : log.storage?.();
      if (storage?.vacuum === 'incremental' && storage.freePages > 0 && log.reclaim) {
        reclaimed = await drain(() => log.reclaim!(rule.reclaimPages), rule.reclaimPages);
      }
      if ((removed > 0 || carried > 0 || reclaimed > 0) && !disposed) log.checkpoint?.();
      const settled = disposed ? undefined : log.storage?.();
      if (settled !== undefined && settled.rowsToCarry === 0 && (settled.pageCount - settled.freePages) * settled.pageSize <= rule.finishBelowBytes) {
        const finished = log.finishCarryForward?.();
        if (finished !== undefined) options.onCarriedForward?.(finished);
      }
    } catch (error) {
      if (!disposed) logger.warn('The decision log\'s background pass (removing old entries, carrying older rows forward, freeing space) stopped; the next pass tries again.', { error: summarizeError(error) });
    } finally {
      running = undefined;
    }
    return removed;
  });
  const first = setTimeout(() => { void pass(); }, rule.firstPassDelayMs);
  const daily = setInterval(() => { void pass(); }, rule.intervalMs);
  first.unref?.();
  daily.unref?.();
  return {
    pass,
    dispose() { disposed = true; clearTimeout(first); clearInterval(daily); },
  };
}

/** Opens (creating when absent) the state root's decision log. Close it with `[Symbol.dispose]()`. */
export function openStateDecisionLog(stateRoot: string): SqliteDecisionLog {
  return openStateDecisionLogWithNotice(stateRoot).log;
}
