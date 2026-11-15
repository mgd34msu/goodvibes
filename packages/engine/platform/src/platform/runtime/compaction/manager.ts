/**
 * manager.ts
 *
 * CompactionManager, orchestrates the full compaction lifecycle state machine.
 *
 * Responsibilities:
 * - Drive state transitions (idle → checking_threshold → strategy → boundary_commit → done/failed)
 * - Create boundary commits with lineage tracking (counts and summary; the
 *   conversation holds the messages)
 * - Emit CompactionEvents at each transition
 * - Own the lifecycle of a compaction the session itself runs (`runLifecycle`):
 *   the orchestrator's conversation compaction goes through the session's
 *   manager, so every real compaction moves the state machine, emits the
 *   lifecycle events and leaves a boundary commit
 */

import { logger } from '../../utils/logger.js';
import type { RuntimeEventBus } from '../events/index.js';
import type { EmitterContext } from '../emitters/index.js';
import {
  compactionLifecycle,
  strategyToState,
} from './lifecycle.js';
import {
  createBoundaryCommit,
  validateBoundaryCommit,
} from './strategies/index.js';
import type {
  BoundaryCommit,
  CompactionLifecycleState,
  CompactionStrategy,
  CompactionTrigger,
} from './types.js';
import {
  emitCompactionCheck,
  emitCompactionDone,
  emitCompactionFailed,
  emitCompactionBoundaryCommit,
  emitCompactionMicrocompact,
  emitCompactionCollapse,
  emitCompactionAutocompact,
  emitCompactionReactive,
} from '../emitters/compaction.js';
import type { ProviderMessage } from '../../providers/interface.js';
import { summarizeError } from '../../utils/error-display.js';

// ---------------------------------------------------------------------------
// Manager options
// ---------------------------------------------------------------------------

/** Options for constructing a CompactionManager. */
export interface CompactionManagerOptions {
  /** Session ID for event correlation. */
  sessionId: string;
  /** Runtime event bus for emitting CompactionEvents. */
  bus: RuntimeEventBus;
  /**
   * Model context window size (tokens). A function is read at each use, so a
   * session whose model changes keeps the window of the model in play.
   */
  contextWindow: number | (() => number);
  /** Threshold fraction at which compaction is triggered (default: 0.75). */
  thresholdFraction?: number | undefined;
}

/**
 * What a compaction the session ran applied, as `runLifecycle` records it in
 * the boundary commit.
 */
export interface SessionCompactionOutcome {
  /** The conversation as the compaction left it. */
  messages: ProviderMessage[];
  /** Estimated tokens after the compaction. */
  tokensAfter: number;
  /** Human-readable summary stored with the boundary commit. */
  summary: string;
  /** Warnings the compaction reported. */
  warnings?: string[] | undefined;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/**
 * CompactionManager, owns the lifecycle of the compactions a session runs.
 *
 * Usage:
 * ```ts
 * const manager = createCompactionManager({ sessionId, bus, contextWindow });
 * await manager.runLifecycle({ trigger: 'auto', strategy: 'autocompact', messages, tokenCount, execute, outcome });
 * ```
 */
export class CompactionManager {
  private readonly _sessionId: string;
  private readonly _bus: RuntimeEventBus;
  private readonly _readContextWindow: () => number;
  private readonly _thresholdFraction: number;

  /** Tail of the serialized lifecycle runs (one run at a time per session). */
  private _runChain: Promise<unknown> = Promise.resolve();

  /** Set by dispose(); a disposed manager starts no run and emits nothing. */
  private _disposed = false;
  private readonly _lifetime = new AbortController();

  /** Current state machine state. */
  private _state: CompactionLifecycleState = 'idle';

  /** Most recent boundary commit (null until first successful compaction); the next commit's parent. */
  private _lastCommit: BoundaryCommit | null = null;

  /** Emitter context used for all event emissions. */
  private readonly _ctx: EmitterContext;

  constructor(opts: CompactionManagerOptions) {
    this._sessionId = opts.sessionId;
    this._bus = opts.bus;
    const window = opts.contextWindow;
    this._readContextWindow = typeof window === 'function' ? window : () => window;
    this._thresholdFraction = opts.thresholdFraction ?? 0.75;
    this._ctx = {
      sessionId: opts.sessionId,
      source: 'compaction-manager',
      traceId: crypto.randomUUID(),
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Returns the current lifecycle state. */
  get state(): CompactionLifecycleState {
    return this._state;
  }

  /** True once dispose() has run. */
  get disposed(): boolean {
    return this._disposed;
  }

  /** Model context window in play (tokens). */
  private get _contextWindow(): number {
    return this._readContextWindow();
  }

  /** Returns the most recent boundary commit, or null. */
  get lastCommit(): BoundaryCommit | null {
    return this._lastCommit;
  }

  /**
   * Runs the lifecycle of a compaction the session itself performs.
   *
   * The session decides that it compacts and how (the orchestrator's threshold
   * and model-warning checks, and the conversation's structured, distiller or
   * small-window compaction); this manager owns the run's lifecycle: it moves
   * the state machine idle, checking_threshold, the strategy state,
   * boundary_commit, done (or failed) and back to idle, emits the matching
   * COMPACTION_* events on the session's bus, and records a boundary commit
   * chained to the previous one. Runs are serialized per session.
   *
   * `execute` performs the compaction; `outcome` reads what it applied from
   * its result (null when nothing was applied). A throw from `execute` is a
   * failed run: COMPACTION_FAILED is emitted and the error is rethrown to the
   * caller unchanged.
   *
   * @returns Whatever `execute` returned.
   */
  runLifecycle<T>(opts: {
    trigger: CompactionTrigger;
    strategy: CompactionStrategy;
    messages: readonly ProviderMessage[];
    tokenCount: number;
    /** Window used for this run's threshold report; defaults to the manager's. */
    contextWindow?: number | undefined;
    /** Threshold (tokens) the session compared against; defaults to window x fraction. */
    threshold?: number | undefined;
    execute: (lifetime: { signal: AbortSignal; assertCurrent: () => void }) => Promise<T>;
    outcome: (result: T) => SessionCompactionOutcome | null;
  }): Promise<T> {
    if (this._disposed) {
      return Promise.reject(new Error(`CompactionManager for session ${this._sessionId} is disposed`));
    }
    const run = this._runChain.then(() => {
      if (this._disposed) throw new Error(`CompactionManager for session ${this._sessionId} is disposed`);
      return this._runLifecycle(opts);
    });
    this._runChain = run.catch(() => undefined);
    return run;
  }

  /**
   * Releases the manager with its session: no further run starts, a run still
   * in flight loses permission to read or publish on the session's behalf,
   * and the boundary commit chain is dropped.
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._lastCommit = null;
    this._abandon();
    this._lifetime.abort(new Error(`CompactionManager for session ${this._sessionId} is disposed`));
  }

  private async _runLifecycle<T>(opts: {
    trigger: CompactionTrigger;
    strategy: CompactionStrategy;
    messages: readonly ProviderMessage[];
    tokenCount: number;
    contextWindow?: number | undefined;
    threshold?: number | undefined;
    execute: (lifetime: { signal: AbortSignal; assertCurrent: () => void }) => Promise<T>;
    outcome: (result: T) => SessionCompactionOutcome | null;
  }): Promise<T> {
    const runStart = Date.now();
    const { strategy, tokenCount, trigger } = opts;
    const contextWindow = opts.contextWindow ?? this._contextWindow;
    const threshold = opts.threshold ?? Math.floor(contextWindow * this._thresholdFraction);
    const live = (): boolean => !this._disposed;
    const assertCurrent = (): void => { this._lifetime.signal.throwIfAborted(); };
    assertCurrent();

    this._abandon();
    this._transition('checking_threshold');
    if (live()) {
      emitCompactionCheck(this._bus, this._ctx, { sessionId: this._sessionId, tokenCount, threshold });
    }
    assertCurrent();
    this._transition(strategyToState(strategy));

    const fail = (error: string): void => {
      if (!live()) return;
      this._transition('failed');
      if (live()) emitCompactionFailed(this._bus, this._ctx, { sessionId: this._sessionId, strategy, error });
      this._transition('idle');
      if (!live()) return;
      logger.warn('[CompactionManager] session compaction failed', { sessionId: this._sessionId, strategy, trigger, error });
    };

    let result: T;
    try {
      assertCurrent();
      result = await opts.execute({ signal: this._lifetime.signal, assertCurrent });
    } catch (err) {
      fail(summarizeError(err));
      throw err;
    }

    try {
      // The callback may already have applied messages. Preserve its truthful result.
      if (!live()) return result;
      const applied = opts.outcome(result);
      if (!live()) return result;
      if (applied === null) {
        fail('compaction applied no result');
        return result;
      }

      this._emitStrategyEvent(strategy, opts.messages.length, tokenCount, applied.tokensAfter, contextWindow);
      if (!live()) return result;

      this._transition('boundary_commit');
      const commit = createBoundaryCommit({
        sessionId: this._sessionId,
        strategyOutput: {
          messages: applied.messages,
          tokensAfter: applied.tokensAfter,
          summary: applied.summary,
          strategy,
          durationMs: Date.now() - runStart,
          warnings: applied.warnings ?? [],
        },
        parent: this._lastCommit,
        tokensBefore: tokenCount,
      });
      const commitErrors = validateBoundaryCommit(commit);
      if (commitErrors.length > 0) {
        // The compaction was applied and announced above, so it is not reported
        // as failed: it simply has no boundary commit to chain the next run to.
        logger.warn('[CompactionManager] an applied compaction has no valid boundary commit', {
          sessionId: this._sessionId, strategy, trigger, problems: commitErrors.join('; '),
        });
      } else if (live()) {
        emitCompactionBoundaryCommit(this._bus, this._ctx, { sessionId: this._sessionId, checkpointId: commit.checkpointId });
        if (!live()) return result;
        this._lastCommit = commit;
      }

      this._transition('done');
      if (live()) {
        emitCompactionDone(this._bus, this._ctx, {
          sessionId: this._sessionId,
          strategy,
          tokensBefore: tokenCount,
          tokensAfter: applied.tokensAfter,
          durationMs: Date.now() - runStart,
        });
      }
      this._transition('idle');
      return result;
    } catch (error) {
      // Anything that throws after `execute` applied the compaction still ends the
      // run: the machine returns to idle and observers are told it failed.
      try { fail(summarizeError(error)); } catch { /* the original error is the one to report */ }
      throw error;
    } finally {
      if (!this._disposed) this._abandon();
    }
  }

  /** Emits the strategy-specific lifecycle event for a finished strategy run. */
  private _emitStrategyEvent(
    strategy: CompactionStrategy,
    messageCount: number,
    tokensBefore: number,
    tokensAfter: number,
    contextWindow: number,
  ): void {
    if (this._disposed) return;
    switch (strategy) {
      case 'microcompact':
        emitCompactionMicrocompact(this._bus, this._ctx, { sessionId: this._sessionId, turnCount: messageCount, tokensBefore, tokensAfter });
        return;
      case 'collapse':
        emitCompactionCollapse(this._bus, this._ctx, { sessionId: this._sessionId, messageCount, tokensBefore, tokensAfter });
        return;
      case 'autocompact':
        emitCompactionAutocompact(this._bus, this._ctx, { sessionId: this._sessionId, strategy: 'autocompact', tokensBefore, tokensAfter });
        return;
      case 'reactive':
        emitCompactionReactive(this._bus, this._ctx, { sessionId: this._sessionId, tokenCount: tokensBefore, limit: contextWindow });
        return;
      default: {
        const _exhaustive: never = strategy;
        throw new Error(`Unknown compaction strategy: ${_exhaustive}`);
      }
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * The one place a table-legal move is applied. A refusal is logged and leaves
   * the state untouched; it never throws. Returns whether the move applied.
   */
  private _setState(target: CompactionLifecycleState): boolean {
    const check = compactionLifecycle.check(this._state, target);
    if (!check.ok) {
      logger.error('[CompactionManager] invalid state transition', {
        from: this._state,
        to: target,
        reason: check.reason,
        sessionId: this._sessionId,
      });
      return false;
    }
    this._state = target;
    return true;
  }

  /**
   * The deliberate way out of the table: abandons whatever the machine was
   * doing and rests at `idle` (end of a run, start of a lifecycle run, dispose),
   * or at `failed` when a refused move left it in no state it can trust.
   */
  private _abandon(to: 'idle' | 'failed' = 'idle'): void {
    this._state = to;
  }

  /**
   * Applies a state transition. A refused move is logged and, so a bad call
   * cannot leave the machine mid-run, recovers to `failed`.
   */
  private _transition(target: CompactionLifecycleState): void {
    if (this._disposed) return;
    if (!this._setState(target)) this._abandon('failed');
  }
}
