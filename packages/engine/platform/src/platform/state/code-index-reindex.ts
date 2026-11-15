/**
 * CodeIndexReindexScheduler, tool-site reindex hooks.
 *
 * After a successful file-writing tool call (write / edit, including the edit
 * tool's notebook operations), the touched path(s) are scheduled for an
 * incremental `CodeIndexStore.reindexFile()`. Three properties the brief asks
 * for, all enforced here rather than at the (two) tool-execution call sites:
 *
 *  1. NEVER BLOCKS THE TURN. `onToolExecuted` only records paths and arms a
 *     timer; the reindex runs later, off the tool-result path. Nothing here is
 *     awaited by the caller.
 *
 *  2. DEBOUNCED + COALESCED, per path. Each touched path gets its own timer;
 *     re-touching the same path before its quiet window elapses resets that
 *     path's timer, so a phased edit or several edits to one file in a turn
 *     collapse to a SINGLE reindex. Distinct paths reindex independently, each
 *     after its own quiet window. Timers are `unref()`'d so a pending reindex
 *     never keeps the process alive.
 *
 *  3. NO-OP WHEN THERE IS NOTHING TO MAINTAIN, and CONTAINED FAILURE. At fire
 *     time the scheduler re-checks (live, so a runtime toggle is respected)
 *     that the code index is enabled AND already built (available &&
 *     indexedChunks > 0), reindexing a single file into an index that was
 *     never built would fabricate a misleading one-file index, so that case is
 *     a silent no-op. `reindexFile` is cheap when the file is unchanged
 *     (hash-gated). Any error is caught, logged, and recorded as the last
 *     activity, it never rethrows into the turn.
 *
 * The most-recent completed reindex is exposed via `lastActivity()` for honest
 * surfacing (e.g. TUI `/codebase status`).
 */

import { resolve as resolvePathAbsolute } from 'node:path';
import type { CodeChunkMode } from './code-index-chunking.js';
import type { CodeIndexStats } from './code-index-store.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** Default per-path debounce window: long enough to coalesce a burst of edits to one file, short enough that the index trails the working tree by well under a second. */
export const DEFAULT_REINDEX_DEBOUNCE_MS = 300;

/** Edits made while reindexing is switched off or paused wait here, bounded in count and age, and are applied when it resumes. */
const MAX_DEFERRED_PATHS = 200;
const DEFERRED_MAX_AGE_MS = 10 * 60 * 1000;
const DEFERRED_RETRY_MS = 5_000;

/** The subset of CodeIndexStore this scheduler drives, kept structural so tests can supply a minimal fake. */
export interface CodeIndexReindexTarget {
  reindexFile(absPath: string, options?: { automatic?: boolean }): Promise<{ indexed: boolean; mode: CodeChunkMode }>;
  stats(): Pick<CodeIndexStats, 'available' | 'indexedChunks'>;
}

/** Honest record of the most recent reindex the scheduler actually ran (gate passed). */
export interface CodeIndexReindexActivity {
  /** Absolute path that was reindexed. */
  readonly path: string;
  /** Completion timestamp (ms since epoch). */
  readonly at: number;
  /** 'indexed' when chunks were (re)written; 'skipped' when the file was ignored/too-large/removed (reindexFile returned indexed:false); 'error' when reindexFile threw. */
  readonly status: 'indexed' | 'skipped' | 'error';
  /** The chunk mode reindexFile reported (absent on error). */
  readonly mode?: CodeChunkMode | undefined;
  /** Present exactly when status==='error': the contained failure message. */
  readonly error?: string | undefined;
  /** Present when the edit was not indexed because reindexing is off or paused: why, and that it will be retried. */
  readonly reason?: string | undefined;
}

export interface CodeIndexReindexSchedulerDeps {
  readonly target: CodeIndexReindexTarget;
  /**
   * Root directory tool-arg paths are resolved against (absolute paths pass
   * through). Pass a getter when the workspace can be swapped at runtime, so a
   * relative path resolves against the current root rather than the boot-time one.
   */
  readonly workingDirectory: string | (() => string);
  /** Live gate for the embedder's storage.codeIndexEnabled setting. Default: always enabled. */
  readonly isEnabled?: (() => boolean) | undefined;
  /** Per-path debounce window in ms. Default DEFAULT_REINDEX_DEBOUNCE_MS. */
  readonly debounceMs?: number | undefined;
  /** Injectable clock for deterministic activity timestamps in tests. */
  readonly now?: (() => number) | undefined;
}

/**
 * Tool names whose successful execution touches files worth reindexing, and the
 * argument shapes that carry the touched path(s). `write` carries `files[].path`;
 * `edit` carries `edits[].path` plus an optional `notebook_operations.path`. A
 * top-level `path`/`file_path` is also honored for robustness against tool
 * variants. Anything else yields no paths (no-op).
 */
export function extractReindexPaths(toolName: string, args: Record<string, unknown>): string[] {
  if (toolName !== 'write' && toolName !== 'edit') return [];
  const paths = new Set<string>();
  const addIfString = (value: unknown): void => {
    if (typeof value === 'string' && value.trim().length > 0) paths.add(value);
  };

  addIfString(args['path']);
  addIfString(args['file_path']);

  const files = args['files'];
  if (Array.isArray(files)) {
    for (const file of files) {
      if (file && typeof file === 'object') addIfString((file as Record<string, unknown>)['path']);
    }
  }

  const edits = args['edits'];
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (edit && typeof edit === 'object') addIfString((edit as Record<string, unknown>)['path']);
    }
  }

  const notebookOps = args['notebook_operations'];
  if (notebookOps && typeof notebookOps === 'object') {
    addIfString((notebookOps as Record<string, unknown>)['path']);
  }

  return [...paths];
}

export class CodeIndexReindexScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Set<Promise<void>>();
  private last: CodeIndexReindexActivity | null = null;
  /** Paths edited while the live gate was closed, with when they were deferred. */
  private readonly deferred = new Map<string, number>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: CodeIndexReindexSchedulerDeps) {
    this.debounceMs = deps.debounceMs ?? DEFAULT_REINDEX_DEBOUNCE_MS;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Entry point wired into both tool-execution loops. A no-op for a failed call
   * or a non-file tool. Extracts touched paths and schedules each (debounced).
   * Returns immediately, never awaits a reindex.
   */
  onToolExecuted(toolName: string, args: Record<string, unknown>, success: boolean): void {
    if (!success) return;
    for (const p of extractReindexPaths(toolName, args)) {
      const root = typeof this.deps.workingDirectory === 'function' ? this.deps.workingDirectory() : this.deps.workingDirectory;
      this.schedule(resolvePathAbsolute(root, p));
    }
  }

  /** Arm (or reset) the per-path debounce timer for one absolute path. */
  schedule(absPath: string): void {
    const existing = this.timers.get(absPath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(absPath);
      this.track(this.runReindex(absPath));
    }, this.debounceMs);
    timer.unref?.();
    this.timers.set(absPath, timer);
  }

  /** The most recent reindex the scheduler actually ran, or null if none has completed. */
  lastActivity(): CodeIndexReindexActivity | null {
    return this.last;
  }

  /** Count of paths with a pending (debouncing) reindex. */
  pendingCount(): number {
    return this.timers.size;
  }

  /** Test/shutdown helper: fire every pending debounce timer now and await all in-flight reindexes. */
  async flush(): Promise<void> {
    for (const [path, timer] of [...this.timers]) {
      clearTimeout(timer);
      this.timers.delete(path);
      this.track(this.runReindex(path));
    }
    await Promise.allSettled([...this.inFlight]);
  }

  /** Count of edits waiting for reindexing to be switched back on or resumed. */
  deferredCount(): number {
    return this.deferred.size;
  }

  /**
   * Reindex the edits that were deferred while the gate was closed, if it is open now.
   * Runs on a timer while any wait; a host may also call it when it resumes reindexing.
   * Edits older than ten minutes are dropped: a setting left off for good must not hold paths forever.
   */
  retryDeferred(): void {
    const now = this.now();
    for (const [path, at] of this.deferred) {
      if (now - at > DEFERRED_MAX_AGE_MS) this.deferred.delete(path);
    }
    if (this.deferred.size === 0) return;
    if (this.deps.isEnabled && !this.deps.isEnabled()) {
      this.armRetry();
      return;
    }
    const paths = [...this.deferred.keys()];
    this.deferred.clear();
    for (const path of paths) this.track(this.runReindex(path));
  }

  /** Cancel every pending timer (does not touch in-flight reindexes). */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.deferred.clear();
  }

  private defer(absPath: string): void {
    this.deferred.delete(absPath);
    if (this.deferred.size >= MAX_DEFERRED_PATHS) {
      const oldest = this.deferred.keys().next().value;
      if (oldest !== undefined) this.deferred.delete(oldest);
    }
    this.deferred.set(absPath, this.now());
    this.last = {
      path: absPath, at: this.now(), status: 'skipped',
      reason: 'code index reindexing is off or paused; this edit is queued and will be indexed when it resumes',
    };
    this.armRetry();
  }

  private armRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.retryDeferred(); }, DEFERRED_RETRY_MS);
    this.retryTimer.unref?.();
  }

  private track(promise: Promise<void>): void {
    this.inFlight.add(promise);
    void promise.finally(() => this.inFlight.delete(promise));
  }

  private async runReindex(absPath: string): Promise<void> {
    // Live gates, respect a runtime toggle of the setting and never fabricate a
    // one-file index when nothing was ever built.
    if (this.deps.isEnabled && !this.deps.isEnabled()) { this.defer(absPath); return; }
    const stats = this.deps.target.stats();
    if (!stats.available || stats.indexedChunks === 0) return;

    try {
      const { indexed, mode } = await this.deps.target.reindexFile(absPath, { automatic: true });
      this.last = { path: absPath, at: this.now(), status: indexed ? 'indexed' : 'skipped', mode };
    } catch (err) {
      const error = summarizeError(err);
      logger.warn('Code index incremental reindex failed', { path: absPath, error });
      this.last = { path: absPath, at: this.now(), status: 'error', error };
    }
  }
}
