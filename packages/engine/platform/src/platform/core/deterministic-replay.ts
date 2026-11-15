/**
 * DeterministicReplayEngine.
 *
 * Holds one recorded run (its start snapshot and its ordered ledger entries)
 * for stepping, seeking and export, and compares it event by event with
 * another event stream: a second recorded run, or a re-execution's events.
 *
 * The engine never re-emits events onto a live bus, so replay cannot affect
 * live state.
 */
import { GATE_EVENT_TYPES } from '../../events/gate.js';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { normalize, relative, resolve } from 'node:path';
import { logger } from '../utils/logger.js';
import type { LedgerEntry } from '../runtime/telemetry/exporters/local-ledger.js';
import type { RuntimeStateSnapshot } from '../runtime/diagnostics/types.js';
import { summarizeError } from '../utils/error-display.js';

// ── Mismatch classifier ────────────────────────────────────────────────────

/**
 * Category of a mismatch between expected and replayed state.
 *
 * - `missing_event`    : an event expected at this revision was absent.
 * - `extra_event`      : an event appeared that was not in the recording.
 * - `payload_mismatch` : event name matched but payload differed.
 * - `ordering`         : events arrived in different order than recorded.
 * - `state_divergence` : domain state diverged after applying event.
 */
export type MismatchClass =
  | 'missing_event'
  | 'extra_event'
  | 'payload_mismatch'
  | 'ordering'
  | 'state_divergence';

export type ReplayMismatchOwnerDomain =
  | 'turn'
  | 'tasks'
  | 'tools'
  | 'providers'
  | 'session'
  | 'conversation'
  | 'agents'
  | 'contracts'
  | 'gate'
  | 'transport'
  | 'unknown';

export type ReplayMismatchFailureMode =
  | 'missing_event'
  | 'extra_event'
  | 'ordering_violation'
  | 'payload_schema_mismatch'
  | 'payload_type_mismatch'
  | 'payload_value_mismatch'
  | 'missing_terminal_summary'
  | 'terminal_outcome_diverged'
  | 'stop_reason_diverged';

/**
 * A single actionable mismatch entry produced by diff mode.
 */
export interface ReplayMismatch {
  /** The revision at which the mismatch was detected. */
  readonly rev: number;
  /** Mismatch classifier. */
  readonly kind: MismatchClass;
  /** Human-readable description, sufficient to act on without raw dumps. */
  readonly description: string;
  /** The event name involved, if applicable. */
  readonly eventName?: string | undefined;
  /** Key fields from the recorded payload, if applicable. */
  readonly recordedSummary?: string | undefined;
  /** Key fields from the replayed payload, if applicable. */
  readonly replayedSummary?: string | undefined;
  /** Likely owning runtime domain for the divergence. */
  readonly ownerDomain?: ReplayMismatchOwnerDomain | undefined;
  /** Narrower replay failure mode for operator triage. */
  readonly failureMode?: ReplayMismatchFailureMode | undefined;
  /** Related turn ID when the divergence can be tied to a single turn. */
  readonly relatedTurnId?: string | undefined;
}

export type ReplayTurnOutcome = 'completed' | 'failed' | 'cancelled';

export interface ReplayTurnSummary {
  readonly turnId: string;
  readonly outcome: ReplayTurnOutcome;
  readonly terminalEvent: 'PREFLIGHT_FAIL' | 'TURN_COMPLETED' | 'TURN_ERROR' | 'TURN_CANCEL';
  readonly startedRev?: number | undefined;
  readonly terminalRev: number;
  readonly stopReason?: string | undefined;
  readonly message?: string | undefined;
}

// ── Replay state ───────────────────────────────────────────────────────────

/** One position in the loaded run: rev 0 is the start snapshot, every later rev one ledger entry. */
export interface ReplayFrame {
  /** The revision this frame represents (0 = initial snapshot). */
  readonly rev: number;
  /** The event recorded at this revision (absent for the initial snapshot). */
  readonly entry?: LedgerEntry | undefined;
}

// ── Engine status ──────────────────────────────────────────────────────────

export type ReplayStatus =
  | 'idle'       // No run loaded.
  | 'loaded'     // Run loaded, positioned at rev 0 (snapshot).
  | 'running'    // Stepping through events.
  | 'exhausted'; // All events have been replayed.

/**
 * Snapshot of engine state for the Replay panel.
 */
export interface ReplayEngineSnapshot {
  readonly status: ReplayStatus;
  readonly runId: string | null;
  readonly currentRev: number;
  readonly totalRevisions: number;
  readonly currentFrame: ReplayFrame | null;
  readonly mismatches: readonly ReplayMismatch[];
  readonly turnSummaries: readonly ReplayTurnSummary[];
  /**
   * What the last `diff()` compared the recording against. `none` means no
   * events were supplied, so nothing was compared and an empty mismatch list
   * does not mean the run is deterministic.
   */
  readonly diffSource?: 'none' | 'replayed-events' | 'recorded-run' | undefined;
  /** The run compared with, when `diffSource` is `recorded-run`. */
  readonly comparedRunId?: string | undefined;
}

// ── DeterministicReplayEngine ──────────────────────────────────────────────

/**
 * DeterministicReplayEngine.
 *
 * Usage:
 * ```ts
 * const engine = new DeterministicReplayEngine('/path/to/project');
 * engine.load(runId, snapshot, ledgerEntries);
 * engine.step();          // advance one event
 * engine.step(5);         // advance five events
 * engine.seek(10);        // jump to rev 10
 * const report = engine.diff(otherEntries, { runId: 'other' });  // compare with another recorded run
 * engine.export('replay.json');  // write report inside the project root
 * ```
 */
export class DeterministicReplayEngine {
  private readonly _projectRoot: string;
  private _status: ReplayStatus = 'idle';
  private _runId: string | null = null;
  private _snapshot: RuntimeStateSnapshot | null = null;

  /**
   * Returns the initial snapshot that was loaded, or null if no run is loaded.
   */
  getInitialSnapshot(): RuntimeStateSnapshot | null {
    return this._snapshot;
  }
  private _entries: LedgerEntry[] = [];
  private _currentFrameIndex = 0;
  private _mismatches: ReplayMismatch[] = [];
  private _diffSource: 'none' | 'replayed-events' | 'recorded-run' = 'none';
  private _comparedRunId: string | undefined;
  private _turnSummaries: ReplayTurnSummary[] = [];
  private readonly _subscribers = new Set<() => void>();

  constructor(projectRoot: string) {
    this._projectRoot = resolve(projectRoot);
  }

  private _isInsideRoot(root: string, candidate: string): boolean {
    const rel = relative(root, candidate);
    return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Load a run for replay.
   *
   * Replaces any currently loaded run. The engine is positioned at rev 0
   * (the initial snapshot) after loading.
   *
   * @param runId    - The run identifier.
   * @param snapshot - The initial state snapshot captured at run start.
   * @param entries  - All ledger entries for this run, in any order (sorted internally).
   */
  load(runId: string, snapshot: RuntimeStateSnapshot, entries: LedgerEntry[]): void {
    this._runId = runId;
    this._snapshot = snapshot;
    this._mismatches = [];
    this._diffSource = 'none';
    this._comparedRunId = undefined;

    const sorted = [...entries].sort((a, b) => a.rev - b.rev);
    this._entries = sorted;
    this._turnSummaries = this._deriveTurnSummaries(sorted);
    this._currentFrameIndex = 0;
    this._status = sorted.length === 0 ? 'exhausted' : 'loaded';

    logger.debug('[DeterministicReplayEngine] run loaded', {
      runId,
      revisions: sorted.length,
      domains: snapshot.domains.length,
    });

    this._notify();
  }

  /**
   * Advance the replay cursor by `n` steps (default: 1).
   *
   * Returns the frames that were stepped over.
   * If fewer than `n` events remain, steps to the end.
   *
   * @param n - Number of steps to advance.
   * @returns The frames produced by the steps.
   */
  step(n: number = 1): ReplayFrame[] {
    if (this._status === 'idle') {
      logger.warn('[DeterministicReplayEngine] step called with no run loaded');
      return [];
    }

    const stepped: ReplayFrame[] = [];
    const last = this._entries.length;
    for (let i = 0; i < n; i++) {
      if (this._currentFrameIndex >= last) {
        this._status = 'exhausted';
        break;
      }
      this._currentFrameIndex++;
      this._status = 'running';
      stepped.push(this._frameAt(this._currentFrameIndex)!);
    }

    if (this._currentFrameIndex >= last) {
      this._status = 'exhausted';
    }

    if (stepped.length > 0) this._notify();

    return stepped;
  }

  /**
   * Seek to a specific revision.
   *
   * Valid revisions are 0 (initial snapshot) through `totalRevisions`.
   * Clamped to valid range.
   *
   * @param targetRev - Target revision number.
   */
  seek(targetRev: number): void {
    if (this._status === 'idle') {
      logger.warn('[DeterministicReplayEngine] seek called with no run loaded');
      return;
    }

    const clamped = Math.max(0, Math.min(targetRev, this._entries.length));
    this._currentFrameIndex = clamped;
    if (clamped === 0) {
      this._status = 'loaded';
    } else if (clamped >= this._entries.length) {
      this._status = 'exhausted';
    } else {
      this._status = 'running';
    }

    logger.debug('[DeterministicReplayEngine] seeked', { targetRev, clamped });

    this._notify();
  }

  /**
   * Compare the loaded run, event by event, with another stream: a second
   * recorded run (pass its `runId`) or the events a re-execution produced.
   *
   * Without a stream nothing is compared: the result is empty, the snapshot's
   * `diffSource` is `none`, and the caller must not present that as "no
   * divergence".
   *
   * Diff analysis covers:
   * - Missing events (a loaded entry has no counterpart in the other stream)
   * - Extra events (entries of the other stream past the loaded sequence)
   * - Payload mismatches (event name matches, but key payload fields differ)
   * - Ordering violations (different event at the same position)
   * - Per-turn terminal outcome and stop-reason divergence
   *
   * @param replayed - The other stream's ledger entries, in any order.
   * @param source   - `runId` when the other stream is a recorded run.
   * @returns Ordered list of mismatches (by rev).
   */
  diff(replayed?: readonly LedgerEntry[], source?: { readonly runId: string }): ReplayMismatch[] {
    if (this._status === 'idle') {
      return [];
    }
    if (replayed === undefined) {
      logger.warn('[DeterministicReplayEngine] diff called without events to compare; nothing was compared', { runId: this._runId });
      this._mismatches = [];
      this._diffSource = 'none';
      this._comparedRunId = undefined;
      this._notify();
      return [];
    }

    const other = source ? `run "${source.runId}"` : 'the replay';
    const replayedEntries = [...replayed].sort((a, b) => a.rev - b.rev);
    const mismatches: ReplayMismatch[] = [];
    const maxRev = Math.max(this._entries.length, replayedEntries.length);

    for (let i = 0; i < maxRev; i++) {
      const recorded = this._entries[i];
      const replayedEntry = replayedEntries[i];

      if (!recorded && replayedEntry) {
        // Extra entry: replayed more events than recorded.
        mismatches.push({
          rev: replayedEntry.rev,
          kind: 'extra_event',
          ownerDomain: this._inferOwnerDomain(replayedEntry.eventName),
          failureMode: 'extra_event',
          relatedTurnId: this._extractTurnId(replayedEntry.payload),
          description: `Rev ${replayedEntry.rev}: event "${replayedEntry.eventName}" is in ${other} but not in the loaded run.`,
          eventName: replayedEntry.eventName,
        });
        continue;
      }

      if (recorded && !replayedEntry) {
        // Missing entry: recording has an event that replay did not produce.
        mismatches.push({
          rev: recorded.rev,
          kind: 'missing_event',
          ownerDomain: this._inferOwnerDomain(recorded.eventName),
          failureMode: 'missing_event',
          relatedTurnId: this._extractTurnId(recorded.payload),
          description: `Rev ${recorded.rev}: event "${recorded.eventName}" of the loaded run is missing from ${other}.`,
          eventName: recorded.eventName,
        });
        continue;
      }

      if (!recorded || !replayedEntry) continue;

      if (recorded.eventName !== replayedEntry.eventName) {
        mismatches.push({
          rev: recorded.rev,
          kind: 'ordering',
          ownerDomain: this._inferOwnerDomain(recorded.eventName),
          failureMode: 'ordering_violation',
          relatedTurnId: this._extractTurnId(recorded.payload, replayedEntry.payload),
          description: `Rev ${recorded.rev}: the loaded run has "${recorded.eventName}" where ${other} has "${replayedEntry.eventName}". Possible ordering difference.`,
          eventName: recorded.eventName,
          recordedSummary: recorded.eventName,
          replayedSummary: replayedEntry.eventName,
        });
        continue;
      }

      const payloadMismatch = this._diffPayloads(
        recorded.rev,
        recorded.eventName,
        recorded.payload,
        replayedEntry.payload,
      );
      if (payloadMismatch) {
        mismatches.push(payloadMismatch);
      }
    }

    mismatches.push(...this._diffTurnSummaries(replayedEntries, other));

    this._mismatches = mismatches;
    this._diffSource = source ? 'recorded-run' : 'replayed-events';
    this._comparedRunId = source?.runId;
    this._notify();

    logger.debug('[DeterministicReplayEngine] diff complete', {
      runId: this._runId,
      mismatchCount: mismatches.length,
    });

    return mismatches;
  }

  /**
   * Export the current replay report (frames + mismatches) to a JSON file.
   *
   * The exported object contains:
   * - `runId`
   * - `exportedAt` (epoch ms)
   * - `totalRevisions`
   * - `currentRev`
   * - `mismatches`
   * - `baselineDomains` (domain names of the start snapshot)
   * - `frames` (condensed: rev and eventName)
   *
   * @param filePath - Absolute path to write the JSON report.
   * @returns A promise that resolves when the file is written.
   */
  async export(filePath: string): Promise<void> {
    if (this._status === 'idle') {
      logger.warn('[DeterministicReplayEngine] export called with no run loaded');
      return;
    }

    const tempRoot = resolve(tmpdir());
    // Path traversal guard, confine exports to the project directory or the active temp root.
    const resolved = resolve(this._projectRoot, normalize(filePath));
    if (!this._isInsideRoot(this._projectRoot, resolved) && !this._isInsideRoot(tempRoot, resolved)) {
      throw new Error(`Export path must be within project directory or the active temp root. Got: ${resolved}`);
    }

    const report = {
      runId: this._runId,
      exportedAt: Date.now(),
      totalRevisions: this._entries.length,
      currentRev: this._currentFrameIndex,
      mismatches: this._mismatches,
      ...(this._comparedRunId !== undefined ? { comparedRunId: this._comparedRunId } : {}),
      turnSummaries: this._turnSummaries,
      baselineDomains: this._snapshot?.domains.map((d) => d.domain) ?? [],
      frames: [{ rev: 0, eventName: null }, ...this._entries.map((e) => ({ rev: e.rev, eventName: e.eventName }))],
    };

    try {
      await writeFile(resolved, JSON.stringify(report, null, 2), 'utf8');
      logger.info('[DeterministicReplayEngine] exported report', { filePath: resolved, runId: this._runId });
    } catch (err) {
      logger.warn('[DeterministicReplayEngine] export failed', { filePath: resolved, err: summarizeError(err) });
      throw err;
    }
  }

  /**
   * Get a snapshot of engine state for the Replay panel.
   */
  getSnapshot(): ReplayEngineSnapshot {
    return {
      status: this._status,
      runId: this._runId,
      currentRev: this._frameAt(this._currentFrameIndex)?.rev ?? 0,
      totalRevisions: this._entries.length,
      currentFrame: this._frameAt(this._currentFrameIndex),
      mismatches: this._mismatches,
      turnSummaries: this._turnSummaries,
      diffSource: this._diffSource,
      ...(this._comparedRunId !== undefined ? { comparedRunId: this._comparedRunId } : {}),
    };
  }

  /**
   * Register a callback invoked when engine state changes.
   * @returns An unsubscribe function.
   */
  subscribe(callback: () => void): () => void {
    this._subscribers.add(callback);
    return () => this._subscribers.delete(callback);
  }

  /** Reset to idle, clears all loaded state. */
  reset(): void {
    this._status = 'idle';
    this._runId = null;
    this._snapshot = null;
    this._entries = [];
    this._currentFrameIndex = 0;
    this._mismatches = [];
    this._diffSource = 'none';
    this._comparedRunId = undefined;
    this._turnSummaries = [];
    this._notify();
  }

  // ── Private helpers ────────────────────────────────────────────────────

  /** Index 0 is the start snapshot; index i is the i-th entry. Null when no run is loaded. */
  private _frameAt(index: number): ReplayFrame | null {
    if (this._status === 'idle' || index < 0 || index > this._entries.length) return null;
    if (index === 0) return { rev: 0 };
    const entry = this._entries[index - 1]!;
    return { rev: entry.rev, entry };
  }

  /**
   * Compare two payloads at a key-level and return a mismatch if they diverge.
   *
   * Reports only the first differing key to keep the output actionable.
   */
  private _diffPayloads(
    rev: number,
    eventName: string,
    recorded: unknown,
    replayed: unknown,
  ): ReplayMismatch | null {
    const recKeys =
      recorded && typeof recorded === 'object' && !Array.isArray(recorded)
        ? Object.keys(recorded as object).sort()
        : [];
    const repKeys =
      replayed && typeof replayed === 'object' && !Array.isArray(replayed)
        ? Object.keys(replayed as object).sort()
        : [];

    const repSet = new Set(repKeys);
    const missingInReplay = recKeys.filter((k) => !repSet.has(k));
    const recSet = new Set(recKeys);
    const extraInReplay = repKeys.filter((k) => !recSet.has(k));

    if (missingInReplay.length > 0 || extraInReplay.length > 0) {
      return {
        rev,
        kind: 'payload_mismatch',
        eventName,
        ownerDomain: this._inferOwnerDomain(eventName),
        failureMode: 'payload_schema_mismatch',
        relatedTurnId: this._extractTurnId(recorded, replayed),
        description:
          `Rev ${rev} "${eventName}": payload schema mismatch.`
          + (missingInReplay.length ? ` Missing keys in replay: [${missingInReplay.join(', ')}].` : '')
          + (extraInReplay.length ? ` Extra keys in replay: [${extraInReplay.join(', ')}].` : ''),
        recordedSummary: `keys: [${recKeys.join(', ')}]`,
        replayedSummary: `keys: [${repKeys.join(', ')}]`,
      };
    }

    const rec = recorded as Record<string, unknown>;
    const rep = replayed as Record<string, unknown>;
    for (const key of recKeys) {
      const rv = rec[key]!;
      const pv = rep[key]!;
      if (typeof rv !== typeof pv) {
        return {
          rev,
          kind: 'payload_mismatch',
          eventName,
          ownerDomain: this._inferOwnerDomain(eventName),
          failureMode: 'payload_type_mismatch',
          relatedTurnId: this._extractTurnId(recorded, replayed),
          description: `Rev ${rev} "${eventName}": field "${key}" type mismatch (recorded: ${typeof rv}, replayed: ${typeof pv}).`,
          recordedSummary: `${key}: ${typeof rv}`,
          replayedSummary: `${key}: ${typeof pv}`,
        };
      }
      // Scalar equality check.
      if (
        (typeof rv === 'string' || typeof rv === 'number' || typeof rv === 'boolean')
        && rv !== pv
      ) {
        return {
          rev,
          kind: 'payload_mismatch',
          eventName,
          ownerDomain: this._inferOwnerDomain(eventName),
          failureMode: 'payload_value_mismatch',
          relatedTurnId: this._extractTurnId(recorded, replayed),
          description: `Rev ${rev} "${eventName}": field "${key}" value differs. Recorded: ${String(rv).slice(0, 80)}. Replayed: ${String(pv).slice(0, 80)}.`,
          recordedSummary: `${key}=${String(rv).slice(0, 40)}`,
          replayedSummary: `${key}=${String(pv).slice(0, 40)}`,
        };
      }
    }

    return null;
  }

  private _deriveTurnSummaries(
    entries: ReadonlyArray<Pick<LedgerEntry, 'rev' | 'eventName' | 'payload'>>
  ): ReplayTurnSummary[] {
    const starts = new Map<string, number>();
    const summaries: ReplayTurnSummary[] = [];

    for (const entry of entries) {
      const payload =
        entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload)
          ? entry.payload as Record<string, unknown>
          : null;
      const turnId = typeof payload?.turnId === 'string' ? payload.turnId : undefined;
      if (!turnId) continue;

      if (entry.eventName === 'TURN_SUBMITTED') {
        starts.set(turnId, entry.rev);
        continue;
      }

      if (
        entry.eventName !== 'PREFLIGHT_FAIL'
        && entry.eventName !== 'TURN_COMPLETED'
        && entry.eventName !== 'TURN_ERROR'
        && entry.eventName !== 'TURN_CANCEL'
      ) {
        continue;
      }

      const outcome: ReplayTurnOutcome =
        entry.eventName === 'TURN_COMPLETED'
          ? 'completed'
          : entry.eventName === 'TURN_CANCEL'
            ? 'cancelled'
            : 'failed';

      const message =
        typeof payload?.reason === 'string'
          ? payload.reason
          : typeof payload?.error === 'string'
            ? payload.error
            : typeof payload?.response === 'string'
              ? payload.response.slice(0, 160)
              : undefined;

      summaries.push({
        turnId,
        outcome,
        terminalEvent: entry.eventName,
        startedRev: starts.get(turnId),
        terminalRev: entry.rev,
        stopReason: typeof payload?.stopReason === 'string' ? payload.stopReason : undefined,
        message,
      });
    }

    return summaries;
  }

  private _diffTurnSummaries(replayedEntries: readonly LedgerEntry[], other: string): ReplayMismatch[] {
    const recorded = this._deriveTurnSummaries(this._entries);
    const replayed = this._deriveTurnSummaries(replayedEntries);

    const mismatches: ReplayMismatch[] = [];
    const replayedByTurnId = new Map(replayed.map((summary) => [summary.turnId, summary] as const));

    for (const recordedSummary of recorded) {
      const replayedSummary = replayedByTurnId.get(recordedSummary.turnId);
      if (!replayedSummary) {
        mismatches.push({
          rev: recordedSummary.terminalRev,
          kind: 'missing_event',
          eventName: recordedSummary.terminalEvent,
          ownerDomain: 'turn',
          failureMode: 'missing_terminal_summary',
          relatedTurnId: recordedSummary.turnId,
          description: `Rev ${recordedSummary.terminalRev}: turn "${recordedSummary.turnId}" ended in the loaded run but has no ending in ${other}.`,
          recordedSummary: `${recordedSummary.outcome}/${recordedSummary.stopReason ?? 'none'}`,
        });
        continue;
      }

      if (recordedSummary.outcome !== replayedSummary.outcome) {
        mismatches.push({
          rev: recordedSummary.terminalRev,
          kind: 'state_divergence',
          eventName: recordedSummary.terminalEvent,
          ownerDomain: 'turn',
          failureMode: 'terminal_outcome_diverged',
          relatedTurnId: recordedSummary.turnId,
          description: `Rev ${recordedSummary.terminalRev}: turn "${recordedSummary.turnId}" terminal outcome diverged (loaded run ${recordedSummary.outcome}, ${other} ${replayedSummary.outcome}).`,
          recordedSummary: `${recordedSummary.outcome}/${recordedSummary.stopReason ?? 'none'}`,
          replayedSummary: `${replayedSummary.outcome}/${replayedSummary.stopReason ?? 'none'}`,
        });
        continue;
      }

      if (recordedSummary.stopReason !== replayedSummary.stopReason) {
        mismatches.push({
          rev: recordedSummary.terminalRev,
          kind: 'state_divergence',
          eventName: recordedSummary.terminalEvent,
          ownerDomain: 'turn',
          failureMode: 'stop_reason_diverged',
          relatedTurnId: recordedSummary.turnId,
          description: `Rev ${recordedSummary.terminalRev}: turn "${recordedSummary.turnId}" stop reason diverged (loaded run ${recordedSummary.stopReason ?? 'none'}, ${other} ${replayedSummary.stopReason ?? 'none'}).`,
          recordedSummary: `${recordedSummary.outcome}/${recordedSummary.stopReason ?? 'none'}`,
          replayedSummary: `${replayedSummary.outcome}/${replayedSummary.stopReason ?? 'none'}`,
        });
      }
    }

    return mismatches;
  }

  private _extractTurnId(...payloads: unknown[]): string | undefined {
    for (const payload of payloads) {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
      const maybeTurnId = (payload as Record<string, unknown>).turnId;
      if (typeof maybeTurnId === 'string' && maybeTurnId.length > 0) return maybeTurnId;
    }
    return undefined;
  }

  private _inferOwnerDomain(eventName: string | undefined): ReplayMismatchOwnerDomain {
    if (!eventName) return 'unknown';
    if (eventName.startsWith('TURN_') || eventName.startsWith('PREFLIGHT_') || eventName.startsWith('STREAM_')) return 'turn';
    if (eventName.startsWith('TASK_')) return 'tasks';
    if (eventName.startsWith('TOOL_')) return 'tools';
    if (eventName.startsWith('CONTRACT_')) return 'contracts';
    if (eventName.startsWith('AGENT_')) return 'agents';
    if ((GATE_EVENT_TYPES as readonly string[]).includes(eventName)) return 'gate';
    if (eventName.startsWith('PROVIDER_') || eventName.startsWith('MODEL_')) return 'providers';
    if (eventName.startsWith('SESSION_')) return 'session';
    if (eventName.startsWith('CONVERSATION_')) return 'conversation';
    if (eventName.startsWith('TRANSPORT_') || eventName.startsWith('ACP_') || eventName.startsWith('DAEMON_')) return 'transport';
    return 'unknown';
  }

  private _notify(): void {
    for (const cb of this._subscribers) {
      try {
        cb();
      } catch (err) {
        // Subscriber errors must not crash the engine.
        logger.warn('[DeterministicReplayEngine] subscriber error', { error: summarizeError(err) });
      }
    }
  }
}
