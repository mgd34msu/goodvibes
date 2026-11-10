/**
 * background-scheduler.ts, THE governed scheduler for background knowledge
 * self-improvement. Every trigger (enrichment tails, answer refinement, Home
 * Graph ingest, knowledge-service ingest) routes through here so five guards
 * apply to all of them, no caller can schedule a bare-0ms run (the hot loop
 * that fanned control-plane events until the 2026-07-14 daemon OOM):
 *
 *  1. FLOOR, a background run is never scheduled sooner than the minimum
 *     delay, even when a caller asks for 0ms.
 *  2. COALESCING, one pending slot per caller owner+scope+reason; a same-owner burst
 *     yields one run, and a later trigger's gapIds MERGE into the queued run
 *     instead of being dropped.
 *  3. CARDINALITY BOUND, one owner's burst across more distinct scopes than the pending
 *     cap collapses into ONE queued global sweep for that owner; settled state is evicted
 *     so the map never accretes.
 *  4. ZERO-GAP BACKOFF, a run that found no candidate gaps parks its scope
 *     until the backoff lapses; a new trigger carrying concrete gapIds is
 *     EVIDENCE and clears the window instead of being swallowed.
 *  5. GOVERNOR PRESSURE, pause is rechecked at fire time (a timer queued
 *     before the pause re-arms instead of executing), and the critical-tier
 *     admission gate refuses the run with an honest logged reason.
 */
import { logger } from '../../utils/logger.js';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { normalizeKnowledgeSpaceId } from '../spaces.js';
import { uniqueStrings } from './utils.js';
import type { KnowledgeSemanticSelfImproveInput, KnowledgeSemanticSelfImproveResult } from './types.js';

/** Default floor for background self-improvement scheduling (ms). */
export const DEFAULT_SELF_IMPROVE_MIN_DELAY_MS = 5_000;
/** Default zero-gap backoff window; matches the hourly reindex cadence (ms). */
export const DEFAULT_SELF_IMPROVE_ZERO_GAP_BACKOFF_MS = 3_600_000;
/**
 * Max distinct scope keys with a pending background run. A burst across MORE
 * distinct scopes (the incident touched ~1,400 distinct sources) collapses
 * into one queued global sweep instead of N concurrent runs.
 */
export const MAX_PENDING_BACKGROUND_KEYS = 8;
/** Hard bound on retained scheduling-state entries (evicted oldest-first). */
export const MAX_BACKGROUND_STATE_ENTRIES = 256;
/** The collapsed many-scope-burst key: one sweep covers every space. */
const GLOBAL_SWEEP_KEY = 'global|sweep';

/** The coalescing scope key for a self-improve input. */
export function selfImprovementRunKey(input: KnowledgeSemanticSelfImproveInput): string {
  if (input.knowledgeSpaceId) return `space:${normalizeKnowledgeSpaceId(input.knowledgeSpaceId)}`;
  if (input.sourceIds?.length) return `sources:${uniqueStrings(input.sourceIds).sort().join(',')}`;
  return 'global';
}

/** Per-scope background scheduling state: coalescing flag + zero-gap backoff deadline. */
interface BackgroundRunState {
  pending: boolean;
  zeroGapUntil: number;
  /** The queued run's merged input, later triggers' gapIds merge in rather than being dropped. */
  pendingInput?: KnowledgeSemanticSelfImproveInput | undefined;
}

interface BackgroundOwner {
  readonly state: Map<string, BackgroundRunState>;
  readonly signal: AbortSignal;
}

export interface BackgroundSelfImproveSchedulerDeps {
  /** Execute the run (the semantic service's selfImprove with stopWhenPaused). */
  readonly run: (input: KnowledgeSemanticSelfImproveInput) => Promise<KnowledgeSemanticSelfImproveResult>;
  /** Whether a gap repairer is configured (no repairer = nothing to schedule). */
  readonly enabled: () => boolean;
  /** Governor pause probe (rechecked at fire time). */
  readonly isPaused?: (() => boolean) | undefined;
  /** Governor critical-tier admission gate. */
  readonly admit?: ((label: string) => { allowed: boolean; reason?: string | undefined }) | undefined;
  readonly minDelayMs: () => number;
  readonly backoffMs: () => number;
  readonly now: () => number;
  readonly schedule: (callback: () => void, delayMs: number, signal?: AbortSignal) => void;
}

export class BackgroundSelfImproveScheduler {
  /** Requests without a caller signal use this scheduler-owned state. */
  private readonly state = new Map<string, BackgroundRunState>();
  private readonly owners = new Map<AbortSignal | undefined, BackgroundOwner>();
  private readonly shutdown = new AbortController();
  private readonly active = new Set<Promise<void>>();
  private disposing: Promise<void> | undefined;

  constructor(private readonly deps: BackgroundSelfImproveSchedulerDeps) {}

  /** Drop settled state entries (not pending, backoff expired) and bound the map. */
  private prune(owner: BackgroundOwner, now: number): void {
    for (const [key, state] of owner.state) {
      if (!state.pending && state.zeroGapUntil <= now) owner.state.delete(key);
    }
    if (owner.state.size > MAX_BACKGROUND_STATE_ENTRIES) {
      for (const [key, state] of owner.state) {
        if (owner.state.size <= MAX_BACKGROUND_STATE_ENTRIES) break;
        if (!state.pending) owner.state.delete(key);
      }
    }
  }

  queue(input: KnowledgeSemanticSelfImproveInput, delayMs = 0): void {
    const originalSignal = input.signal;
    if (this.shutdown.signal.aborted || originalSignal?.aborted || !this.deps.enabled()) return;
    let owner = this.owners.get(originalSignal);
    if (!owner) {
      // Only this originating caller and this scheduler's own lifetime are
      // combined. Independent callers never share cancellation or backoff.
      const signal = originalSignal ? AbortSignal.any([originalSignal, this.shutdown.signal]) : this.shutdown.signal;
      if (signal.aborted) return;
      owner = { state: originalSignal ? new Map() : this.state, signal };
      const retained = owner;
      signal.addEventListener('abort', () => {
        retained.state.clear();
        if (this.owners.get(originalSignal) === retained) this.owners.delete(originalSignal);
      }, { once: true });
      this.owners.set(originalSignal, owner);
    }
    this.queueOwned(owner, { ...input, signal: owner.signal }, delayMs);
  }

  /** Stop timers synchronously, then retain every admitted run until it drains. */
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.shutdown.abort();
    this.owners.clear();
    this.state.clear();
    this.disposing = Promise.all([...this.active]).then(() => undefined);
    return this.disposing;
  }

  private mergePending(state: BackgroundRunState, input: KnowledgeSemanticSelfImproveInput, hasGapEvidence = Boolean(input.gapIds?.length)): void {
    if (!hasGapEvidence && input.force !== true) return;
    const prior = state.pendingInput ?? input;
    state.pendingInput = {
      ...prior,
      ...(input.gapIds?.length ? {
        gapIds: uniqueStrings([...(prior.gapIds ?? []), ...input.gapIds]),
        limit: Math.max(prior.limit ?? 1, input.limit ?? 1, input.gapIds.length),
      } : {}),
      ...(input.force === true ? { force: true } : {}),
    };
  }

  private queueOwned(owner: BackgroundOwner, input: KnowledgeSemanticSelfImproveInput, delayMs: number, retainedKey?: string): void {
    if (owner.signal.aborted || !this.deps.enabled()) return;
    const now = this.deps.now();
    this.prune(owner, now);
    let key = retainedKey ?? `${selfImprovementRunKey(input)}|${input.reason ?? 'none'}`;
    let effectiveInput = input;
    const existing = owner.state.get(key);
    // New-gap EVIDENCE clears the zero-gap backoff: a trigger carrying concrete
    // gapIds is proof the scope is no longer gap-free, so the window must not
    // silently swallow it.
    if (input.gapIds?.length && existing) existing.zeroGapUntil = 0;
    if (existing?.pending) {
      // Coalesce, but PRESERVE the later trigger's payload: merge its gapIds
      // into the queued run's input instead of dropping them.
      this.mergePending(existing, input);
      return;
    }
    const state = existing ?? { pending: false, zeroGapUntil: 0 };
    if (now < state.zeroGapUntil) return; // zero-gap backoff (gapIds evidence already cleared it above)
    // Cardinality bound: past the pending-key cap, further distinct scopes
    // collapse into ONE queued global sweep (which covers every space).
    let pendingKeys = 0;
    for (const s of owner.state.values()) if (s.pending) pendingKeys += 1;
    if (pendingKeys >= MAX_PENDING_BACKGROUND_KEYS && key !== GLOBAL_SWEEP_KEY) {
      key = GLOBAL_SWEEP_KEY;
      effectiveInput = { reason: input.reason, signal: owner.signal, ...(input.force !== undefined ? { force: input.force } : {}) };
      const sweep = owner.state.get(key);
      if (sweep) {
        // The backoff must be checked against the FINAL key: a sustained
        // distinct-scope burst would otherwise re-run the collapsed sweep
        // back-to-back straight through the sweep's own zero-gap window.
        // Concrete gap evidence still clears it, exactly like a scoped key.
        if (input.gapIds?.length) sweep.zeroGapUntil = 0;
        if (sweep.pending) { this.mergePending(sweep, effectiveInput, Boolean(input.gapIds?.length)); return; }
        if (now < sweep.zeroGapUntil) return; // the sweep found nothing recently, parked
      }
    }
    const minDelayMs = Math.max(0, this.deps.minDelayMs());
    const backoffMs = Math.max(0, this.deps.backoffMs());
    // Enforce the floor: a background run is NEVER scheduled sooner than
    // minDelayMs, even when the caller passes delayMs=0.
    const flooredDelayMs = Math.max(minDelayMs, Math.max(0, delayMs));
    const scheduledState: BackgroundRunState = owner.state.get(key) ?? { pending: false, zeroGapUntil: 0 };
    scheduledState.pending = true;
    scheduledState.pendingInput = effectiveInput;
    owner.state.set(key, scheduledState);
    let consumed = false;
    const fire = (): void => {
      if (consumed || owner.signal.aborted || owner.state.get(key) !== scheduledState || !scheduledState.pending) return;
      const st = scheduledState;
      // Governor pause recheck AT FIRE TIME: a timer queued before the pause
      // must not execute a full self-improve mid-pressure. Re-arm at the floor
      // cadence (no LLM work) until resumed.
      if (this.deps.isPaused?.()) {
        this.deps.schedule(fire, Math.max(minDelayMs, 1_000), owner.signal);
        return;
      }
      consumed = true;
      // Critical-tier admission: refuse honestly instead of allocating.
      const decision = this.deps.admit?.('knowledge self-improvement');
      if (decision && !decision.allowed) {
        logger.warn('Knowledge semantic background self-improvement refused by the memory governor', {
          reason: decision.reason,
        });
        if (st) {
          st.pending = false;
          st.pendingInput = undefined;
        }
        return;
      }
      // CONSUME the queued input: anything re-armed onto pendingInput after
      // this point arrived MID-RUN and must not be lost when the run settles.
      const runInput = st?.pendingInput ?? effectiveInput;
      if (st) st.pendingInput = undefined;
      // If new input (gap evidence) merged in while the run executed, the
      // completion re-queues it through the full guard set instead of wiping
      // it, and a zero-gap RESULT must not park the scope over that fresh
      // evidence (the run that just finished never looked at it).
      const settle = (result: { candidateGaps?: number | undefined } | null): void => {
        if (owner.signal.aborted || owner.state.get(key) !== scheduledState) return;
        const next = scheduledState;
        next.pending = false;
        const rearmed = next.pendingInput;
        next.pendingInput = undefined;
        if (rearmed) {
          next.zeroGapUntil = 0;
          owner.state.set(key, next);
          this.queueOwned(owner, rearmed, 0, key);
          return;
        }
        // Zero candidate gaps ⇒ back off; a run that found nothing must not
        // keep rescheduling itself. New-gap evidence clears the window.
        next.zeroGapUntil = result !== null && (result.candidateGaps ?? 0) === 0 ? this.deps.now() + backoffMs : 0;
        owner.state.set(key, next);
      };
      const joined = Promise.withResolvers<void>();
      this.active.add(joined.promise);
      let run: Promise<KnowledgeSemanticSelfImproveResult>;
      try { run = this.deps.run(runInput); }
      catch (error) { drainOwned(error); run = Promise.reject(error); }
      void Promise.resolve(run)
        .then((result) => settle(result))
        .catch((error: unknown) => {
          drainOwned(error);
          settle(null);
          if (!owner.signal.aborted) logger.warn('Knowledge semantic background self-improvement failed', {
            error: error instanceof Error ? error.message : String(error),
            knowledgeSpaceId: input.knowledgeSpaceId,
            reason: input.reason,
          });
        }).then(
          () => { this.active.delete(joined.promise); joined.resolve(); },
          error => { drainOwned(error); this.active.delete(joined.promise); joined.resolve(); },
        );
    };
    this.deps.schedule(fire, flooredDelayMs, owner.signal);
  }
}
