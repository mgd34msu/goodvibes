/**
 * Multi-session Orchestration, Cross-Session Task Registry
 *
 * Wraps SessionTaskGraph with persistence to a host-owned task graph path
 * and reconnect/resume hydration.
 *
 * The file is the shared truth. Every terminal opened in a project holds a
 * registry over the same file, so a change made by another process is new
 * input, not a fault: each read compares the file's stat identity with the one
 * this process last saw (one `lstat`) and re-reads the file only when it
 * changed. Every change is a read-modify-write under the kernel-released
 * process lock (`<graph>.writer.sqlite`): re-read if changed, apply, write
 * the whole graph, all before the lock is released, so no process overwrites
 * another's change and nothing waits in memory to be written later.
 *
 * Housekeeping contract (the persisted graph is a recoverable store, so it
 * carries the full set of store obligations; the pure half lives in
 * registry-housekeeping.ts):
 *  - REAP ON RECOVERY, hydration drops refs whose owning session no longer
 *    exists (via the injected `sessionExists` predicate), drops edges left
 *    dangling by that removal, and retires handoffs that have already fired.
 *    A handoff that leaves without being accepted releases its task.
 *  - BOUND, every collection has BOTH a count cap and an age TTL.
 *  - VALIDATE BY CONTENT, the file is parsed and shape-checked record by
 *    record; a torn/zero-byte/truncated file is preserved aside, never served.
 *  - SWEEP PERIODICALLY, the same reap runs on an interval, not only at
 *    startup, because a daemon-hosted registry can stay up for weeks.
 *  - DISCLOSE, every reap that removed anything logs its counts.
 */

import { lstatSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { captureExistingDirectory, writeDocument } from '../../utils/atomic-json-store.js';
import { fileObservationIdentity, readFileObservation } from '../../utils/file-observation.js';
import { withProcessLockSync } from '../../utils/process-lock.js';
import { basename, dirname, join, resolve } from 'node:path';
import { logger } from '../../utils/logger.js';
import { SessionTaskGraph } from './graph.js';
import type {
  CrossSessionTaskRef,
  TaskHandoffRecord,
  CancellationRequest,
  CancellationResult,
  SessionTaskGraphSnapshot,
} from './types.js';
import { isLegacyTaskNamespace, makeRefKey } from './types.js';
import type { TaskLifecycleState } from '../../runtime/store/domains/tasks.js';
import { summarizeError } from '../../utils/error-display.js';
import {
  EMPTY_REAP_SUMMARY,
  QUARANTINE_RETENTION_MS,
  QUARANTINE_SUFFIX,
  SWEEP_INTERVAL_MS,
  parseGraphFile,
  reapGraphSnapshot,
  releasedStatus,
  type CrossSessionGraphReapSummary,
} from './registry-housekeeping.js';

/** How long a change waits for another process's change to the same graph. A hold is one small read and write. */
const LOCK_WAIT_MS = 1000;

export class CrossSessionGraphUnavailableError extends Error {
  override readonly name = 'CrossSessionGraphUnavailableError';
  constructor(
    readonly kind: 'future-version' | 'unavailable',
    readonly fileVersion?: number,
    readonly graphPath?: string,
    readonly detail?: string,
  ) {
    super(kind === 'future-version'
      ? `The cross-session task graph${graphPath ? ` at ${graphPath}` : ''} was written by a newer GoodVibes (format ${fileVersion ?? 'unknown'}); this version leaves it untouched. Nothing was changed. Update GoodVibes to use it.`
      : `The cross-session task graph${graphPath ? ` at ${graphPath}` : ''} cannot be used${detail ? ` (${detail})` : ''}. Nothing was changed. Move the file aside or remove it, then retry.`);
  }
}
const missing = (error: unknown): boolean => error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';

/** Resolve existing parent aliases, never the selected graph leaf. A graph's
 * ordinary parent may not have been created yet; retain the exact missing
 * suffix rather than create a directory merely to select an existing owner. */
function canonicalGraphPath(path: string): string {
  let directory = dirname(resolve(path));
  const suffix = [basename(path)];
  for (;;) {
    try {
      const parent = captureExistingDirectory(directory);
      parent.assertCurrent();
      return join(parent.canonical, ...suffix);
    } catch (error) {
      if (!missing(error)) throw error;
      const next = dirname(directory);
      if (next === directory) throw error;
      suffix.unshift(basename(directory)); directory = next;
    }
  }
}

function graphFrom(snapshot: SessionTaskGraphSnapshot): SessionTaskGraph {
  const graph = new SessionTaskGraph();
  graph.hydrate(snapshot);
  return graph;
}

/**
 * The text a session's next request carries when handoffs are waiting for it,
 * or `undefined` when none are. One place for the wording, so the turn notice
 * and the task tool say the same thing.
 */
export function describeAwaitingHandoffs(handoffs: readonly TaskHandoffRecord[]): string | undefined {
  if (handoffs.length === 0) return undefined;
  const lines = handoffs.map((handoff) => `- ${handoff.handoffId}: task ${handoff.taskRef.taskId} from session ${handoff.fromSessionId}`
    + (handoff.reason ? ` (reason: ${handoff.reason})` : ''));
  return `[Task handoffs] ${handoffs.length === 1 ? 'A task was' : `${handoffs.length} tasks were`} handed to this session and ${handoffs.length === 1 ? 'waits' : 'wait'} for you to accept:\n`
    + `${lines.join('\n')}\nAccept one with the task tool (mode=acknowledge handoffId=<id>); the task stays blocked in its source session until you do.`;
}

export type { CrossSessionGraphReapSummary } from './registry-housekeeping.js';

// ── CrossSessionTaskRegistry ──────────────────────────────────────────────────

/** Construction-time seams for {@link CrossSessionTaskRegistry}. */
export interface CrossSessionTaskRegistryOptions {
  /**
   * "Does this session still exist?", INJECTED so the registry can reap
   * records whose owning session is gone without growing a hard dependency on
   * the session store (and so tests can drive it directly).
   *
   * Omitted means owner-existence reaping is skipped entirely; the age TTL and
   * count caps still apply. Callers that can answer this question should pass
   * it, otherwise refs for vanished sessions survive until they age out.
   */
  readonly sessionExists?: ((sessionId: string) => boolean) | undefined;
  /** Clock seam (tests). Defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
  /** Periodic sweep interval in ms. `0` disables the timer (tests, short-lived processes). Defaults to one hour. */
  readonly sweepIntervalMs?: number | undefined;
}

/** Outcome of withdrawing a handoff. */
export interface HandoffWithdrawal {
  readonly ok: boolean;
  readonly error?: string | undefined;
  /** The withdrawn handoff. */
  readonly handoff?: TaskHandoffRecord | undefined;
  /** The task's status after the withdrawal. */
  readonly status?: TaskLifecycleState | undefined;
}

/**
 * CrossSessionTaskRegistry, persistent wrapper around `SessionTaskGraph`.
 *
 * Responsibilities:
 * - Load the graph from disk on construction (reconnect/resume hydration),
 *   validating it by content and reaping records whose owner is gone.
 * - Follow changes other processes make to the same file.
 * - Write the graph on every change, under the cross-process lock.
 * - Sweep the graph periodically, not only at startup.
 * - Expose a stable interface for command handlers and sync adapters.
 * - Generate unique handoff IDs.
 */
export class CrossSessionTaskRegistry {
  private _graph = new SessionTaskGraph();
  private readonly _graphPath: string;
  private readonly _lockPath: string;
  private readonly _sessionExists: ((sessionId: string) => boolean) | undefined;
  private readonly _now: () => number;
  /** Stat identity of the file the in-memory graph reflects: `null` no file, `undefined` not read yet. */
  private _seen: string | null | undefined;
  /** A damaged file seen without the lock; it is preserved aside by the next change. */
  private _damaged: { key: string; detail: string } | undefined;
  /** The current file cannot be used (written by a newer version, or no slot to preserve it aside). */
  private _blocked: { key: string; error: CrossSessionGraphUnavailableError } | undefined;
  private _malformed = { refs: 0, edges: 0, handoffs: 0 };
  private _sweepTimer: ReturnType<typeof setInterval> | null = null;
  private _lastReap: CrossSessionGraphReapSummary = EMPTY_REAP_SUMMARY;

  /**
   * @param graphPath - Absolute host-owned task graph path.
   * @param options - Injected seams (session-existence predicate, clock, sweep interval).
   */
  public constructor(graphPath: string, options: CrossSessionTaskRegistryOptions = {}) {
    this._graphPath = resolve(graphPath);
    this._lockPath = `${this._graphPath}.writer.sqlite`;
    this._sessionExists = options.sessionExists;
    this._now = options.now ?? Date.now;
    this._load();

    const sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
    if (sweepIntervalMs > 0) {
      this._sweepTimer = setInterval(() => {
        try { this.reap(); this._sweepQuarantine(); }
        catch (error) { logger.warn('CrossSessionTaskRegistry: sweep skipped; the graph is unchanged', { error: summarizeError(error) }); }
      }, sweepIntervalMs);
      this._sweepTimer.unref?.();
    }
  }

  /** A nested runtime may borrow this actual owner for the same selected
   * graph. It must not dispose it: the composing host drains all borrowers
   * before its own final flush. A different workspace never supplies this
   * owner. */
  public borrowForGraphPath(graphPath: string): CrossSessionTaskRegistry | undefined {
    return canonicalGraphPath(this._graphPath) === canonicalGraphPath(graphPath) ? this : undefined;
  }

  // ── Task ref operations ───────────────────────────────────────────────────────

  /**
   * Link a task into the global graph, registers the task as a
   * cross-session ref and optionally adds a dependency edge.
   *
   * @param ref - The task ref to link.
   * @param dependsOn - Optional ref this task depends on.
   * @param reason - Optional reason for the dependency edge.
   * @returns Result of the link operation.
   */
  public linkTask(
    ref: CrossSessionTaskRef,
    dependsOn?: { sessionId: string; taskId: string },
    reason?: string,
  ): { ok: boolean; error?: string | undefined } {
    return this._change(() => {
      // A ref that is already registered keeps its lifecycle status: linking is not a status
      // report, and a caller that only names the task must not reset a running or blocked one.
      const existing = this._graph.getRef(ref.sessionId, ref.taskId);
      const result = this._graph.linkRef(existing ? { ...ref, status: existing.status } : ref, dependsOn, reason);
      // A refused link changed nothing (the graph restores the ref), so there is nothing to write.
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    }, (result) => result.ok);
  }

  /**
   * Update the status of a task ref.
   *
   * @param sessionId - Owning session.
   * @param taskId - Target task.
   * @param status - New lifecycle status.
   * @returns `true` if the status changed and was written.
   */
  public propagateStatus(
    sessionId: string,
    taskId: string,
    status: TaskLifecycleState,
  ): boolean {
    return this._change(() => this._graph.propagateStatus(sessionId, taskId, status), (changed) => changed);
  }

  /**
   * Look up a ref by session + task ID.
   */
  public getRef(sessionId: string, taskId: string): CrossSessionTaskRef | undefined {
    return this._current().getRef(sessionId, taskId);
  }

  /**
   * Return all refs in the graph.
   */
  public getAllRefs(): CrossSessionTaskRef[] {
    return this._current().getAllRefs();
  }

  /**
   * Return all refs for a given session.
   */
  public getRefsBySession(sessionId: string): CrossSessionTaskRef[] {
    return this._current().getRefsBySession(sessionId);
  }

  /**
   * Return all direct dependencies of a task.
   */
  public getDependencies(sessionId: string, taskId: string): CrossSessionTaskRef[] {
    return this._current().getDependencies(sessionId, taskId);
  }

  /**
   * Return all direct dependents of a task.
   */
  public getDependents(sessionId: string, taskId: string): CrossSessionTaskRef[] {
    return this._current().getDependents(sessionId, taskId);
  }

  // ── Handoff operations ────────────────────────────────────────────────────────

  /**
   * Initiate a task handoff from one session to another.
   *
   * The task's ref must be registered under the originating session, and the
   * destination must be a session this host knows (it exists, or already owns
   * a task ref). The ref moves to 'blocked' while the handoff awaits the
   * destination's acknowledgement, and returns to the status it had when the
   * handoff is acknowledged, withdrawn or expires. A task has at most one
   * waiting handoff. A handoff that cannot move the task (a finished task) is
   * refused and recorded nowhere.
   *
   * @param taskRef - The task being handed off.
   * @param fromSessionId - Source session.
   * @param toSessionId - Destination session.
   * @param reason - Optional human-readable reason.
   * @returns Result of the handoff operation.
   */
  public initiateHandoff(
    taskRef: { sessionId: string; taskId: string },
    fromSessionId: string,
    toSessionId: string,
    reason?: string,
  ): { ok: boolean; handoffId?: string; error?: string | undefined } {
    return this._change((): { ok: boolean; handoffId?: string; error?: string | undefined } => {
      const ref = this._graph.getRef(taskRef.sessionId, taskRef.taskId);
      if (!ref) {
        return {
          ok: false,
          error: `Task ref not found: ${makeRefKey(taskRef.sessionId, taskRef.taskId)}. ` +
            'Add the task to the graph first (Sessions, Hand-offs, or the task tool).',
        };
      }
      if (taskRef.sessionId !== fromSessionId) {
        return { ok: false, error: `Task ${taskRef.taskId} belongs to session ${taskRef.sessionId}, not ${fromSessionId}; only the owning session can hand it off. Nothing was changed.` };
      }
      if (toSessionId === fromSessionId) {
        return { ok: false, error: 'A task cannot be handed off to its own session. Nothing was changed.' };
      }
      const open = this._graph.getHandoffs().find((handoff) => !handoff.acknowledged
        && handoff.taskRef.sessionId === taskRef.sessionId && handoff.taskRef.taskId === taskRef.taskId);
      if (open) {
        return { ok: false, error: `Task ${taskRef.taskId} already has an open handoff (${open.handoffId}) to session ${open.toSessionId}. Nothing was changed. Withdraw that handoff first (task mode=withdraw handoffId=${open.handoffId}), or wait for that session to accept it.` };
      }
      if (!this._knowsSession(toSessionId)) {
        return { ok: false, error: `Destination session ${toSessionId} is not a known session, so nobody could acknowledge the handoff. Check the session id; nothing was changed.` };
      }
      if (ref.status !== 'blocked' && !this._graph.propagateStatus(taskRef.sessionId, taskRef.taskId, 'blocked')) {
        return { ok: false, error: `Task ${taskRef.taskId} is ${ref.status} and cannot be handed off (it cannot move to blocked). Nothing was changed.` };
      }

      const handoffId = crypto.randomUUID();
      this._graph.recordHandoff({
        handoffId,
        taskRef: { sessionId: taskRef.sessionId, taskId: taskRef.taskId },
        fromSessionId,
        toSessionId,
        reason,
        initiatedAt: this._now(),
        acknowledged: false,
        previousStatus: ref.status,
      });
      return { ok: true, handoffId };
    }, (result) => result.ok);
  }

  /**
   * Acknowledge a handoff from the destination session. The source task, held
   * 'blocked' only while the handoff awaited this, goes back to the status it
   * had before (a task that moved on in the meantime is left as it is).
   *
   * @param handoffId - The handoff to acknowledge.
   * @param bySessionId - When given, only the handoff's destination may acknowledge it.
   * @returns `true` if the handoff exists and is acknowledged (already, or now).
   */
  public acknowledgeHandoff(handoffId: string, bySessionId?: string): boolean {
    return this._change(() => {
      const record = this._graph.getHandoffs().find((handoff) => handoff.handoffId === handoffId);
      if (!record || (bySessionId !== undefined && record.toSessionId !== bySessionId)) return { ok: false, changed: false };
      if (record.acknowledged) return { ok: true, changed: false };
      this._graph.acknowledgeHandoff(handoffId);
      this._release(record);
      return { ok: true, changed: true };
    }, (result) => result.changed).ok;
  }

  /**
   * Withdraw a handoff that is still waiting. The record is removed and the
   * task returns to the status it had before the handoff.
   *
   * @param handoffId - The handoff to withdraw.
   * @param bySessionId - When given, only the handoff's source may withdraw it.
   */
  public withdrawHandoff(handoffId: string, bySessionId?: string): HandoffWithdrawal {
    return this._change((): HandoffWithdrawal => {
      const record = this._graph.getHandoffs().find((handoff) => handoff.handoffId === handoffId);
      if (!record) return { ok: false, error: `Unknown handoff: ${handoffId}. Nothing was changed. List handoffs with task mode=handoffs or Sessions, Hand-offs.` };
      if (bySessionId !== undefined && record.fromSessionId !== bySessionId) {
        return { ok: false, error: `Handoff ${handoffId} was made by session ${record.fromSessionId}; only that session can withdraw it. Nothing was changed.` };
      }
      if (record.acknowledged) {
        return { ok: false, error: `Handoff ${handoffId} was already accepted by session ${record.toSessionId}, so it cannot be withdrawn. Nothing was changed.` };
      }
      this._graph.removeHandoff(handoffId);
      this._release(record);
      return { ok: true, handoff: record, status: this._graph.getRef(record.taskRef.sessionId, record.taskRef.taskId)?.status };
    }, (result) => result.ok);
  }

  /** Whether `sessionId` is one this host can vouch for: alive, legacy, or already owning refs. */
  private _knowsSession(sessionId: string): boolean {
    if (!this._sessionExists || isLegacyTaskNamespace(sessionId)) return true;
    return this._sessionExists(sessionId) || this._graph.getRefsBySession(sessionId).length > 0;
  }

  /** Return the task a handoff held 'blocked' to the status it had before, unless it moved on. */
  private _release(record: TaskHandoffRecord): void {
    const held = this._graph.getRef(record.taskRef.sessionId, record.taskRef.taskId);
    const before = releasedStatus(record);
    if (held?.status === 'blocked' && before !== 'blocked') {
      this._graph.propagateStatus(record.taskRef.sessionId, record.taskRef.taskId, before);
    }
  }

  /**
   * Return all handoff records.
   */
  public getHandoffs(): TaskHandoffRecord[] {
    return this._current().getHandoffs();
  }

  /** Handoffs addressed to `sessionId` that it has not accepted yet. */
  public handoffsAwaiting(sessionId: string): TaskHandoffRecord[] {
    return this._current().getHandoffsForSession(sessionId)
      .filter((handoff) => handoff.toSessionId === sessionId && !handoff.acknowledged);
  }

  // ── Scoped cancellation ───────────────────────────────────────────────────────

  /**
   * Apply a scoped cancellation to the graph.
   *
   * @param request - The cancellation request.
   * @returns Result describing what was cancelled and what was skipped.
   */
  public cancel(request: CancellationRequest): CancellationResult {
    return this._change(() => this._graph.applyCancellation(request), (result) => result.ok && result.cancelled.length > 0);
  }

  // ── Snapshot / persistence ────────────────────────────────────────────────────

  /**
   * Take a snapshot of the current graph state.
   * Suitable for display (e.g. `/session graph`).
   */
  public snapshot(): SessionTaskGraphSnapshot {
    return this._current().snapshot();
  }

  /**
   * Run a housekeeping pass now: drop refs whose owning session is gone, refs
   * past their TTL, dangling edges, fired or aged-out handoffs, and anything
   * over the count caps; a task held by a removed, unaccepted handoff is
   * released.
   *
   * A second pass immediately after a first reclaims nothing.
   *
   * @returns The counts reclaimed by this pass.
   */
  public reap(): CrossSessionGraphReapSummary {
    return this._change(() => this._reapNow('sweep'), (summary) => summary.total > 0);
  }

  /** The counts reclaimed by the most recent reap pass (hydration or sweep). */
  public lastReapSummary(): CrossSessionGraphReapSummary {
    return this._lastReap;
  }

  /**
   * Every change is written when it is made, so nothing is ever pending; kept
   * for hosts that flush their stores at shutdown.
   */
  public flush(): void {}

  /**
   * Release process-level resources held by the registry (the periodic sweep).
   * Safe to call multiple times.
   */
  public dispose(): void {
    if (this._sweepTimer !== null) { clearInterval(this._sweepTimer); this._sweepTimer = null; }
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  /**
   * Read the persisted graph at start, then reap and preserve aside a damaged
   * file under the lock only when there is something to change: opening a
   * project creates no directory and takes no lock. A graph that cannot be
   * used is reported here and refused by every change, never a failed start.
   */
  private _load(): void {
    // Before a damaged file can take the one preserved-aside slot.
    this._sweepQuarantine();
    try {
      this._refresh(false);
      const preview = reapGraphSnapshot(this._graph.snapshot(), { sessionExists: this._sessionExists, now: this._now() });
      const malformed = this._malformed.refs + this._malformed.edges + this._malformed.handoffs;
      if (this._damaged || preview.summary.total > 0 || preview.tasksReleased > 0 || malformed > 0) {
        this._change(() => this._reapNow('hydration'), (summary) => summary.total > 0);
      }
      logger.debug('CrossSessionTaskRegistry: hydrated graph from disk', { path: this._graphPath, refs: this._graph.getAllRefs().length });
    } catch (error) {
      logger.warn('CrossSessionTaskRegistry: task graph unavailable at start; changes are refused until it is fixed', { path: this._graphPath, error: summarizeError(error) });
    }
  }

  /** The graph for a read: re-read first when another process changed the file. */
  private _current(): SessionTaskGraph {
    try { this._refresh(false); }
    catch (error) { logger.debug('CrossSessionTaskRegistry: graph re-read skipped', { path: this._graphPath, error: summarizeError(error) }); }
    return this._graph;
  }

  /**
   * One change: under the cross-process lock, catch up with the file, apply
   * `apply`, and write the graph when `changed` says it changed. A failed
   * write restores the graph from the file, so memory never shows a change
   * that was not saved.
   */
  private _change<T>(apply: () => T, changed: (result: T) => boolean): T {
    return withProcessLockSync(this._lockPath, () => {
      this._refresh(true);
      if (this._blocked) throw this._blocked.error;
      const result = apply();
      if (!changed(result)) return result;
      try {
        writeDocument(this._graphPath, this._graph.snapshot());
        this._seen = this._statKey();
      } catch (error) {
        this._seen = undefined;
        try { this._refresh(true); } catch { this._graph = new SessionTaskGraph(); }
        logger.warn('CrossSessionTaskRegistry: task graph write failed; nothing was changed', { path: this._graphPath, error: summarizeError(error) });
        throw new Error(`The cross-session task graph at ${this._graphPath} could not be saved (${summarizeError(error)}). Nothing was changed; retry once the disk can be written.`, { cause: error });
      }
      return result;
    }, { waitMs: LOCK_WAIT_MS });
  }

  /** Stat identity of the graph file, `null` when there is none. A file that is
   * not a plain, single-link file owned by this user is never read. */
  private _statKey(): string | null {
    let stat;
    try { stat = lstatSync(this._graphPath, { bigint: true }); }
    catch (error) { if (missing(error)) return null; throw new CrossSessionGraphUnavailableError('unavailable', undefined, this._graphPath, summarizeError(error)); }
    if (!stat.isFile() || stat.nlink !== 1n || (process.geteuid && stat.uid !== BigInt(process.geteuid()))) {
      throw new CrossSessionGraphUnavailableError('unavailable', undefined, this._graphPath, 'it is not a plain file owned by this user');
    }
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  }

  /**
   * Make the in-memory graph match the file when the file changed since it was
   * last seen. Without the lock (`locked` false) a damaged file is only noted;
   * with it, the damaged file is preserved aside and the graph starts empty.
   */
  private _refresh(locked: boolean): void {
    const key = this._statKey();
    if (key === this._seen) return;
    if (key !== null && key === this._blocked?.key) return;
    if (key !== null && key === this._damaged?.key && !locked) return;
    this._blocked = undefined;
    if (key === null) {
      this._damaged = undefined;
      this._replace(new SessionTaskGraph(), null);
      return;
    }
    let bytes: Buffer;
    try { bytes = readFileSync(this._graphPath); }
    catch (error) {
      if (missing(error)) { this._damaged = undefined; this._replace(new SessionTaskGraph(), null); return; }
      throw new CrossSessionGraphUnavailableError('unavailable', undefined, this._graphPath, summarizeError(error));
    }
    let verdict: ReturnType<typeof parseGraphFile>;
    try { verdict = parseGraphFile(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { verdict = { kind: 'corrupt', detail: 'invalid UTF-8' }; }
    if (verdict.kind === 'future') {
      this._blocked = { key, error: new CrossSessionGraphUnavailableError('future-version', verdict.version, this._graphPath) };
      logger.warn('CrossSessionTaskRegistry: task graph written by a newer version; left untouched', { path: this._graphPath, version: verdict.version });
      return;
    }
    if (verdict.kind === 'corrupt') {
      if (this._damaged?.key !== key) logger.warn('CrossSessionTaskRegistry: task graph failed content validation, not loaded', { path: this._graphPath, detail: verdict.detail, bytes: bytes.byteLength });
      this._damaged = { key, detail: verdict.detail };
      if (locked) this._quarantine(key, verdict.detail);
      return;
    }
    this._damaged = undefined;
    this._malformed = { refs: verdict.refsMalformed, edges: verdict.edgesMalformed, handoffs: verdict.handoffsMalformed };
    this._replace(graphFrom(verdict.snapshot), key);
  }

  private _replace(graph: SessionTaskGraph, key: string | null): void {
    this._graph = graph;
    this._seen = key;
    if (key === null) this._malformed = { refs: 0, edges: 0, handoffs: 0 };
  }

  /** Preserve a damaged file aside (under the lock) and start from an empty graph. One slot: a
   * second damaged file never replaces the first, and the graph is refused until one is removed. */
  private _quarantine(key: string, detail: string): void {
    const quarantinePath = `${this._graphPath}${QUARANTINE_SUFFIX}`;
    let occupied = true;
    try { lstatSync(quarantinePath); } catch (error) { if (!missing(error)) throw error; occupied = false; }
    if (occupied) {
      this._blocked = { key, error: new CrossSessionGraphUnavailableError('unavailable', undefined, this._graphPath, `${detail}; an earlier damaged graph is already kept at ${quarantinePath}`) };
      return;
    }
    renameSync(this._graphPath, quarantinePath);
    this._damaged = undefined;
    this._replace(new SessionTaskGraph(), null);
    logger.warn('CrossSessionTaskRegistry: preserved unreadable task graph aside', { path: this._graphPath, quarantinePath, reason: detail });
  }

  /** One reap pass over the in-memory graph (the caller holds the lock and writes it). */
  private _reapNow(phase: 'hydration' | 'sweep'): CrossSessionGraphReapSummary {
    const { snapshot, summary, tasksReleased } = reapGraphSnapshot(this._graph.snapshot(), {
      sessionExists: this._sessionExists,
      now: this._now(),
    });
    const malformed = phase === 'hydration' ? this._malformed : { refs: 0, edges: 0, handoffs: 0 };
    const result: CrossSessionGraphReapSummary = {
      ...summary,
      refsMalformed: malformed.refs,
      edgesMalformed: malformed.edges,
      handoffsMalformed: malformed.handoffs,
      total: summary.total + malformed.refs + malformed.edges + malformed.handoffs,
    };
    this._lastReap = result;
    if (result.total === 0) return result;
    this._graph = graphFrom(snapshot);
    this._malformed = { refs: 0, edges: 0, handoffs: 0 };
    this._disclose(phase, result, tasksReleased);
    return result;
  }

  /** Surface what a reap reclaimed. Counts only, graph contents are never logged. */
  private _disclose(phase: 'hydration' | 'sweep', summary: CrossSessionGraphReapSummary, tasksReleased: number): void {
    logger.info('CrossSessionTaskRegistry: reclaimed stale task graph records', {
      phase,
      path: this._graphPath,
      refsMissingSession: summary.refsMissingSession,
      refsExpired: summary.refsExpired,
      // Reported on its own line rather than folded into refsExpired: this is
      // the pre-binding `'local'` store draining away, which an operator
      // watching an upgrade land should be able to see for what it is.
      refsLegacyNamespaceExpired: summary.refsLegacyNamespaceExpired,
      refsOverCap: summary.refsOverCap,
      refsMalformed: summary.refsMalformed,
      edgesDangling: summary.edgesDangling,
      edgesMalformed: summary.edgesMalformed,
      handoffsOrphaned: summary.handoffsOrphaned,
      handoffsRetired: summary.handoffsRetired,
      handoffsOverCap: summary.handoffsOverCap,
      handoffsMalformed: summary.handoffsMalformed,
      tasksReleased,
      total: summary.total,
    });
  }

  /** Reap only the original single-link regular quarantine. Unknown future
   * versions, aliases, replacements and foreign files remain available. */
  private _sweepQuarantine(): void {
    const path = `${this._graphPath}${QUARANTINE_SUFFIX}`;
    try {
      const source = readFileObservation(path), stat = lstatSync(path);
      if (fileObservationIdentity(path) !== source.physical || process.geteuid && stat.uid !== process.geteuid()) return;
      const ageMs = this._now() - stat.mtimeMs;
      if (ageMs <= QUARANTINE_RETENTION_MS) return;
      let verdict: ReturnType<typeof parseGraphFile>;
      try { verdict = parseGraphFile(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes)); }
      catch { verdict = { kind: 'corrupt', detail: 'invalid UTF-8' }; }
      if (verdict.kind === 'future') return;
      if (fileObservationIdentity(path) !== source.physical) return;
      unlinkSync(path);
      logger.info('CrossSessionTaskRegistry: removed expired preserved task graph', { quarantinePath: path, ageMs, bytes: source.bytes.byteLength });
    } catch (error) {
      if (!missing(error)) logger.warn('CrossSessionTaskRegistry: preserved task graph cleanup unavailable', { error: summarizeError(error) });
    }
  }
}
