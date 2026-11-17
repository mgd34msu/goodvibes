import { assertAnswerVerificationActive } from './answer-verification/budget.js';
import { answerHasCompleteVerification, answerNeedsEvidenceGap } from './answer-quality.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeSourceRecord } from '../types.js';
import type { KnowledgeObjectProfilePolicy } from '../extensions.js';
import { logger } from '../../utils/logger.js';
import { scheduleBackground, yieldEvery, yieldToEventLoop } from '../cooperative.js';
import { MAX_TIMER_MS } from './self-improvement-budget.js';
import { getKnowledgeSpaceId, isHomeAssistantKnowledgeSpace, normalizeKnowledgeSpaceId } from '../spaces.js';
import { answerKnowledgeQuery } from './answer.js';
import { refreshAnswerCandidateWindowAfterRepair } from './answer-candidate-window.js';
import { isRepairedAnswerGap } from './answer-gaps.js';
import { enrichKnowledgeSource, type EnrichKnowledgeSourceOptions } from './enrichment.js';
import type {
  KnowledgeSemanticAnswerInput,
  KnowledgeSemanticAnswerRefinement,
  KnowledgeSemanticAnswerResult,
  KnowledgeSemanticEnrichmentResult,
  KnowledgeSemanticGapRepairer,
  KnowledgeSemanticLlm,
  KnowledgeSemanticSelfImproveInput,
  KnowledgeSemanticSelfImproveResult,
} from './types.js';
import { readRecord, readString, readStringArray } from './utils.js';
import { uniqueStrings } from './utils.js';
import { semanticSourceFreshness } from './source-revisions.js';
import { isSelfImproveHold, runKnowledgeSemanticSelfImprovement } from './self-improvement.js';
import {
  BackgroundSelfImproveScheduler,
  DEFAULT_SELF_IMPROVE_MIN_DELAY_MS,
  DEFAULT_SELF_IMPROVE_ZERO_GAP_BACKOFF_MS,
  selfImprovementRunKey,
} from './background-scheduler.js';
import { isGeneratedKnowledgeSource } from '../generated-projections.js';
import { isClassicOperation, requireDecisionFeature } from '../../runtime/decision-policy.js';

export interface KnowledgeSemanticServiceOptions {
  readonly llm?: KnowledgeSemanticLlm | null | undefined;
  readonly maxLlmSourcesPerReindex?: number | undefined;
  readonly gapRepairer?: KnowledgeSemanticGapRepairer | null | undefined;
  readonly maxReindexRunMs?: number | undefined;
  readonly backgroundRepairDelayMs?: number | undefined;
  readonly backgroundRepairLimit?: number | undefined;
  readonly objectProfiles?: readonly KnowledgeObjectProfilePolicy[] | undefined;
  /**
   * Minimum floor (ms) enforced on EVERY background self-improvement schedule.
   * A background run can never be scheduled sooner than this even when a caller
   * asks for `delayMs=0`, that bare-zero path is what turned an enrichment
   * burst into a CPU-bound hot loop. Default 5000.
   */
  readonly backgroundSelfImproveMinDelayMs?: number | undefined;
  /**
   * After a background run finds ZERO candidate gaps, further self-scheduled
   * runs for that scope are suppressed for this window (ms), the work backs off
   * to the hourly reindex schedule instead of self-perpetuating. Default
   * 3_600_000 (one hour, matching the reindex cadence).
   */
  readonly backgroundSelfImproveZeroGapBackoffMs?: number | undefined;
  /**
   * Backpressure gate the MemoryGovernor drives: when it returns true the
   * background self-improvement job is paused and new runs are not scheduled
   * (the foreground path is untouched). Wired from the daemon composition.
   */
  readonly isBackgroundPaused?: (() => boolean) | undefined;
  /**
   * MemoryGovernor admission gate: consulted before a background run fires and
   * before an explicit reindex, at the critical tier the run is refused with
   * an honest structured reason instead of allocating toward OOM.
   */
  readonly admitExpensiveWork?: ((label: string) => { allowed: boolean; reason?: string | undefined }) | undefined;
  /** Test seam: timer scheduling (defaults to scheduleBackground). */
  readonly scheduleSeam?: ((callback: () => void, delayMs: number, signal?: AbortSignal) => void) | undefined;
  /** Test seam: clock (defaults to Date.now). */
  readonly now?: (() => number) | undefined;
}

/** Event-loop yield cadence for the single-pass distinct-space scan. */
const SELF_IMPROVE_SPACE_PAGE_SIZE = 500;

export class KnowledgeSemanticService {
  private readonly activeGapRepairs = new Set<string>();
  private readonly gapRepairWaiters = new Set<() => void>();
  private readonly activeSelfImprovementRuns = new Map<AbortSignal | undefined, Map<string, Promise<KnowledgeSemanticSelfImproveResult>>>();

  constructor(
    private readonly store: KnowledgeStore,
    private options: KnowledgeSemanticServiceOptions = {},
  ) {}

  /**
   * The configured semantic LLM, or null when unconfigured. Home Graph issue
   * triage prompts through this the same way `enrichment.ts`/`answer-llm.ts` do
   * inside this service; exposing it lets the Home Graph refinement loop share the
   * one model route without re-plumbing a provider registry.
   */
  get llm(): KnowledgeSemanticLlm | null {
    return this.options.llm ?? null;
  }

  setGapRepairer(gapRepairer: KnowledgeSemanticGapRepairer | null | undefined): void {
    this.options = {
      ...this.options,
      gapRepairer: gapRepairer ?? null,
    };
  }

  addObjectProfiles(profiles: readonly KnowledgeObjectProfilePolicy[] | null | undefined): void {
    if (!profiles?.length) return;
    const byId = new Map((this.options.objectProfiles ?? []).map((profile) => [profile.id, profile]));
    for (const profile of profiles) byId.set(profile.id, profile);
    this.options = {
      ...this.options,
      objectProfiles: [...byId.values()],
    };
  }

  async enrichSource(
    sourceId: string,
    input: EnrichKnowledgeSourceOptions = {},
  ): Promise<KnowledgeSemanticEnrichmentResult | null> {
    requireDecisionFeature('semantic knowledge enrichment');
    await this.store.init();
    const source = this.store.getSource(sourceId);
    if (!source) return null;
    return enrichKnowledgeSource({ store: this.store, llm: this.options.llm }, source, input);
  }

  async enrichSources(
    sources: readonly KnowledgeSourceRecord[],
    input: EnrichKnowledgeSourceOptions & { readonly limit?: number } = {},
  ): Promise<readonly KnowledgeSemanticEnrichmentResult[]> {
    requireDecisionFeature('semantic knowledge enrichment');
    const results: KnowledgeSemanticEnrichmentResult[] = [];
    const selected = sources.slice(0, Math.max(1, input.limit ?? sources.length));
    for (const [index, source] of selected.entries()) {
      if (input.signal?.aborted || input.shouldStop?.()) break;
      await yieldEvery(index);
      const result = await this.enrichSource(source.id, input);
      if (result) results.push(result);
      await yieldToEventLoop();
    }
    return results;
  }

  async reindex(input: {
    readonly sourceIds?: readonly string[] | undefined;
    readonly limit?: number | undefined;
    readonly maxRunMs?: number | undefined;
    readonly force?: boolean | undefined;
    readonly knowledgeSpaceId?: string | undefined;
    /** Original caller lifetime; optional for standalone reindex operations. */
    readonly signal?: AbortSignal | undefined;
  } = {}): Promise<{
    readonly scanned: number;
    readonly enriched: number;
    readonly skipped: number;
    readonly failed: number;
    readonly errors: readonly { readonly sourceId: string; readonly error: string }[];
    readonly selfImprovement: KnowledgeSemanticSelfImproveResult;
  }> {
    requireDecisionFeature('semantic knowledge reindexing');
    const signal = input.signal;
    signal?.throwIfAborted();
    // Critical-tier admission: reindex is one of the expensive verbs the
    // governor refuses honestly under memory pressure.
    const admission = this.options.admitExpensiveWork?.('knowledge semantic reindex');
    if (admission && !admission.allowed) {
      throw new Error(admission.reason ?? 'knowledge semantic reindex refused: daemon is under critical memory pressure.');
    }
    signal?.throwIfAborted();
    await this.store.init();
    signal?.throwIfAborted();
    const allowed = input.sourceIds?.length ? new Set(input.sourceIds) : null;
    const sources = listSemanticSources(this.store, input.knowledgeSpaceId)
      .filter((source) => !allowed || allowed.has(source.id))
      .slice(0, Math.max(1, input.limit ?? 10_000));
    const maxLlmSources = Math.max(0, this.options.maxLlmSourcesPerReindex ?? Infinity);
    const maxRunMs = Math.max(100, input.maxRunMs ?? this.options.maxReindexRunMs ?? 45_000);
    const startedAt = Date.now();
    let llmAttempts = 0;
    let enriched = 0;
    let skipped = 0;
    let failed = 0;
    let processed = 0;
    const errors: { sourceId: string; error: string }[] = [];
    for (const [index, source] of sources.entries()) {
      await yieldEvery(index);
      signal?.throwIfAborted();
      if (Date.now() - startedAt >= maxRunMs) {
        skipped += sources.length - processed;
        break;
      }
      processed += 1;
      try {
        const llm = this.options.llm && llmAttempts < maxLlmSources && sourceNeedsLlmUpgrade(this.store, source)
          ? this.options.llm
          : null;
        if (llm) llmAttempts += 1;
        const result = await enrichKnowledgeSource({ store: this.store, llm }, source, { ...input, signal });
        signal?.throwIfAborted();
        if (result?.skipped) skipped += 1;
        else if (result) enriched += 1;
      } catch (error) {
        signal?.throwIfAborted();
        failed += 1;
        errors.push({ sourceId: source.id, error: error instanceof Error ? error.message : String(error) });
      }
      await yieldToEventLoop();
      signal?.throwIfAborted();
    }
    signal?.throwIfAborted();
    const selfImprovement = await this.selfImprove({
      knowledgeSpaceId: input.knowledgeSpaceId,
      sourceIds: input.sourceIds,
      force: input.force,
      reason: 'reindex',
      signal,
      limit: input.limit,
      maxRunMs: input.maxRunMs,
      deferRepair: Boolean(this.options.gapRepairer),
    });
    signal?.throwIfAborted();
    const backgroundRepairLimit = Math.max(1, this.options.backgroundRepairLimit ?? 8);
    // Unforced: gaps inside their retry window or with a final task are left out
    // before the limit applies, so the slots go to gaps that can be worked.
    this.queueBackgroundSelfImprove({
      knowledgeSpaceId: input.knowledgeSpaceId,
      sourceIds: input.sourceIds,
      reason: 'reindex',
      signal,
      limit: Math.min(Math.max(1, input.limit ?? backgroundRepairLimit), backgroundRepairLimit),
      maxRunMs: 30_000,
    }, this.options.backgroundRepairDelayMs ?? 2_000);
    signal?.throwIfAborted();
    return { scanned: sources.length, enriched, skipped, failed, errors, selfImprovement };
  }

  /**
   * Answers, then repairs what the answer could not establish. A subject-scoped
   * ask runs one foreground repair bounded by the caller's timeout (else
   * {@link DEFAULT_FOREGROUND_ANSWER_REPAIR_MS}) and recomputes the answer only
   * when the repair changed evidence (a linked source or a promoted fact), or
   * when it waited for another caller's repair of the same gap that was
   * actually running and that repair retired the gap. Every other case returns
   * the first answer with `refinement.status: 'active'` while the repair
   * continues in the background.
   */
  async answer(input: KnowledgeSemanticAnswerInput): Promise<KnowledgeSemanticAnswerResult> {
    requireDecisionFeature('verified semantic knowledge answers; use local knowledge search during Classic');
    await this.store.init();
    const answerOnce = (current: KnowledgeSemanticAnswerInput) => answerKnowledgeQuery({
      store: this.store,
      llm: this.options.llm,
      objectProfiles: this.options.objectProfiles,
    }, current);
    let answer = await answerOnce(input);
    assertAnswerVerificationActive(input.signal);
    if (input.autoRepairGaps === false || !this.options.gapRepairer || answer.answer.gaps.length === 0) return answer;
    const repairSpaceId = answerRepairSpaceId(answer);
    const originalGapIds = answer.answer.gaps
      .filter((gap) => readString(readRecord(gap.metadata).gapKind) === 'answer')
      .map((gap) => gap.id);
    const foregroundBudgetMs = foregroundAnswerRepairBudget(input, answer);
    const startedAt = Date.now();
    let foregroundRepair = emptySelfImproveResult();
    if (foregroundBudgetMs > 0) {
      foregroundRepair = await this.repairAnswerGaps({
        answer, signal: input.signal,
        maxRunMs: foregroundBudgetMs,
        limit: answer.answer.gaps.length,
      });
      assertAnswerVerificationActive(input.signal);
      let evidenceChanged = foregroundRepair.linkedRepairs > 0 || (foregroundRepair.promotedFactCount ?? 0) > 0;
      if (!evidenceChanged) {
        // Only a repair of these gaps that is running right now is worth waiting for.
        const waited = await this.waitForActiveAnswerGapRepairs(repairSpaceId, originalGapIds,
          Math.max(0, foregroundBudgetMs - (Date.now() - startedAt)), input.signal);
        evidenceChanged = waited && originalGapIds.some((id) => {
          const gap = this.store.getNode(id);
          return gap !== null && isRepairedAnswerGap(gap);
        });
      }
      if (evidenceChanged) {
        input = await refreshAnswerCandidateWindowAfterRepair(input);
        answer = withRefinementTaskIds(await answerOnce(input), foregroundRepair.taskIds);
        assertAnswerVerificationActive(input.signal);
        if (answerHasUsableEvidence(answer)) {
          return withAnswerRefinement(answer, answerRefinementFromRepair(this.completedRepairEvidence(foregroundRepair, repairSpaceId, originalGapIds, answer), 'repaired', {
            waitedMs: Date.now() - startedAt,
            answerCacheInvalidated: true,
          }));
        }
      }
    }
    // The answer stands; repair of what it could not establish goes on in the background.
    const refinementGapIds = answerGapIdsForRefinement(answer, originalGapIds);
    const taskIds = uniqueStrings([...foregroundRepair.taskIds, ...this.taskIdsForGaps(repairSpaceId, refinementGapIds)]);
    // Every gap still inside the retry window of an earlier attempt: nothing runs until then.
    const waitingUntil = this.gapsWaitingUntil(refinementGapIds);
    if (waitingUntil === undefined) this.runAnswerRefinementInBackground(repairSpaceId, refinementGapIds);
    const status: KnowledgeSemanticAnswerRefinement['status'] = (foregroundRepair.acceptedSourceIds?.length ?? 0) > 0 || (foregroundRepair.promotedFactCount ?? 0) > 0
      ? 'incomplete' : waitingUntil !== undefined || this.isBackgroundWorkPaused() ? 'deferred' : 'active';
    const refinement = answerRefinementFromRepair(foregroundRepair, status, {
      waitedMs: Date.now() - startedAt,
      answerCacheInvalidated: foregroundRepair.linkedRepairs > 0 || (foregroundRepair.promotedFactCount ?? 0) > 0,
    });
    const reason = refinement.reason ?? (waitingUntil !== undefined
      ? `An earlier repair of this question found nothing to add; the next attempt is due at ${new Date(waitingUntil).toISOString()}.`
      : status === 'active' ? 'Repair continues in the background; ask again for an updated answer.'
        : status === 'deferred' ? 'Background knowledge work is paused; repair resumes when it is allowed again.' : undefined);
    return withAnswerRefinement(withRefinementTaskIds(answer, taskIds), {
      ...refinement,
      refinementTaskIds: taskIds,
      ...(reason !== undefined ? { reason } : {}),
      ...(waitingUntil !== undefined ? { nextRepairAttemptAt: waitingUntil } : {}),
    });
  }

  async repairAnswerGaps(input: {
    readonly answer: KnowledgeSemanticAnswerResult;
    readonly signal?: AbortSignal | undefined;
    readonly maxRunMs?: number | undefined;
    readonly limit?: number | undefined;
  }): Promise<KnowledgeSemanticSelfImproveResult> {
    requireDecisionFeature('automatic semantic answer-gap repair');
    assertAnswerVerificationActive(input.signal);
    const gaps = input.answer.answer.gaps.filter((gap) => readString(readRecord(gap.metadata).gapKind) === 'answer');
    if (!this.options.gapRepairer || gaps.length === 0) return emptySelfImproveResult();
    return this.selfImprove({
      knowledgeSpaceId: answerRepairSpaceId(input.answer),
      gapIds: gaps.map((gap) => gap.id),
      reason: 'answer',
      limit: Math.max(1, input.limit ?? gaps.length),
      maxRunMs: input.maxRunMs, signal: input.signal,
      force: true,
    });
  }

  /** Unforced: a gap the foreground repair just attempted waits out its retry window instead of being searched again. */
  private runAnswerRefinementInBackground(spaceId: string, gapIds: readonly string[]): void {
    if (!this.options.gapRepairer || gapIds.length === 0) return;
    this.queueBackgroundSelfImprove({
      knowledgeSpaceId: spaceId,
      gapIds,
      reason: 'answer',
      limit: Math.max(1, gapIds.length),
      maxRunMs: 30_000,
    });
  }

  /** The governed background scheduler (floor/coalesce/backoff/pause/admit). */
  private readonly backgroundScheduler = new BackgroundSelfImproveScheduler({
    run: (input) => this.selfImprove(input, { stopWhenPaused: true }),
    enabled: () => Boolean(this.options.gapRepairer),
    isPaused: () => this.options.isBackgroundPaused?.() === true,
    admit: (label) => this.options.admitExpensiveWork?.(label) ?? { allowed: true },
    minDelayMs: () => this.options.backgroundSelfImproveMinDelayMs ?? DEFAULT_SELF_IMPROVE_MIN_DELAY_MS,
    backoffMs: () => this.options.backgroundSelfImproveZeroGapBackoffMs ?? DEFAULT_SELF_IMPROVE_ZERO_GAP_BACKOFF_MS,
    now: () => this.options.now?.() ?? Date.now(),
    schedule: (callback, delayMs, signal) => {
      if (this.options.scheduleSeam) this.options.scheduleSeam(callback, delayMs, signal);
      else scheduleBackground(callback, delayMs, signal);
    },
  });

  /**
   * THE background self-improvement entry point: every trigger (enrichment
   * tails, answer refinement, Home Graph ingest, knowledge-service ingest)
   * routes through the governed scheduler, see background-scheduler.ts for
   * the five guards. Public so out-of-package producers (home-graph) use it.
   */
  queueBackgroundSelfImprove(input: KnowledgeSemanticSelfImproveInput, delayMs = 0): void {
    if (isClassicOperation()) return;
    this.backgroundScheduler.queue(input, delayMs);
  }

  /** Retire scheduled work synchronously, then drain every admitted background run. */
  dispose(): Promise<void> { return this.backgroundScheduler.dispose(); }

  async selfImprove(
    input: KnowledgeSemanticSelfImproveInput = {},
    runOptions: { readonly stopWhenPaused?: boolean } = {},
  ): Promise<KnowledgeSemanticSelfImproveResult> {
    requireDecisionFeature('automatic semantic knowledge improvement');
    const signal = input.signal;
    await this.store.init();
    const ownedInput = { ...input, signal };
    if (ownedInput.deferRepair !== true) {
      const runKey = selfImprovementRunKey(ownedInput);
      let ownerRuns = this.activeSelfImprovementRuns.get(signal);
      const activeRun = ownerRuns?.get(runKey);
      if (activeRun && !ownedInput.gapIds?.length) return activeSelfImproveResult(ownedInput);
      const run = this.runSelfImproveUnlocked(ownedInput, runOptions);
      if (!ownedInput.gapIds?.length) {
        if (!ownerRuns) { ownerRuns = new Map(); this.activeSelfImprovementRuns.set(signal, ownerRuns); }
        ownerRuns.set(runKey, run);
      }
      try {
        return await run;
      } finally {
        if (ownerRuns?.get(runKey) === run) {
          ownerRuns.delete(runKey);
          if (ownerRuns.size === 0 && this.activeSelfImprovementRuns.get(signal) === ownerRuns) this.activeSelfImprovementRuns.delete(signal);
        }
      }
    }
    return this.runSelfImproveUnlocked(ownedInput, runOptions);
  }

  /** True when a background run should stop at the next safe yield point. */
  private backgroundStopRequested(runOptions: { readonly stopWhenPaused?: boolean }): boolean {
    return runOptions.stopWhenPaused === true && this.options.isBackgroundPaused?.() === true;
  }

  /** Public pause probe so producers (home-graph ask/ingest tails) can defer their own background work. */
  isBackgroundWorkPaused(): boolean {
    return isClassicOperation() || this.options.isBackgroundPaused?.() === true;
  }

  /** Public admission probe (MemoryGovernor critical tier) for producers' own expensive tails. */
  admitBackgroundWork(label: string): { allowed: boolean; reason?: string | undefined } {
    if (isClassicOperation()) return { allowed: false, reason: 'Classic does not run automatic semantic knowledge work.' };
    return this.options.admitExpensiveWork?.(label) ?? { allowed: true };
  }

  private async runSelfImproveUnlocked(
    input: KnowledgeSemanticSelfImproveInput,
    runOptions: { readonly stopWhenPaused?: boolean } = {},
  ): Promise<KnowledgeSemanticSelfImproveResult> {
    // Critical-tier admission for the expensive run shapes (space/whole-store
    // sweeps, not the answer path's cheap deferRepair task-queue pass): refuse
    // with an honest structured result instead of allocating toward OOM.
    if (input.deferRepair !== true) {
      const admission = this.options.admitExpensiveWork?.('knowledge self-improvement run');
      if (admission && !admission.allowed) {
        return {
          ...emptySelfImproveResult(),
          truncated: true,
          errors: [{ gapId: input.knowledgeSpaceId ?? 'global', error: admission.reason ?? 'refused: daemon is under critical memory pressure' }],
        };
      }
    }
    if (!input.knowledgeSpaceId && !input.sourceIds?.length && !input.gapIds?.length) {
      // Distinct-space discovery over the WHOLE store: one O(N) cursor pass
      // (never a full array+sort materialization, never an O(N²) offset
      // re-scan), yielding to the event loop between chunks.
      const spaces = uniqueStrings([...await this.collectSemanticSpaceIds(() => this.backgroundStopRequested(runOptions))]);
      let combined = emptySelfImproveResult();
      for (const [index, spaceId] of spaces.entries()) {
        await yieldEvery(index, 1);
        // Governor backpressure lands mid-run too: a paused background run
        // stops at the next space boundary instead of allocating through the
        // whole store while the daemon sheds memory.
        if (this.backgroundStopRequested(runOptions)) {
          return { ...combined, truncated: true };
        }
        try {
          const result = await runKnowledgeSemanticSelfImprovement({
            store: this.store,
            gapRepairer: this.options.gapRepairer,
            currentGapRepairer: () => this.options.gapRepairer,
            activeGapRepairs: this.activeGapRepairs,
            repairSettled: () => this.notifyGapRepairSettled(),
            objectProfiles: this.options.objectProfiles,
            enrichSource: (sourceId, options) => {
              const source = this.store.getSource(sourceId);
              return source ? enrichKnowledgeSource({ store: this.store, llm: this.options.llm }, source, options) : Promise.resolve(null);
            },
            // Pause stop is consulted INSIDE the run too (per-gap boundary),
            // not only between spaces here.
            shouldStop: () => this.backgroundStopRequested(runOptions),
          }, { ...input, knowledgeSpaceId: spaceId });
          combined = mergeSelfImproveResults(combined, result);
        } catch (error) {
          // One space held by a model reading must not stop every later space.
          if (input.signal?.aborted || !isSelfImproveHold(error)) throw error;
          combined = { ...combined, truncated: true, errors: [...combined.errors, { gapId: spaceId, error: error instanceof Error ? error.message : String(error) }] };
        }
      }
      return combined;
    }
    // SPACE-SCOPED run (every sync-pump round takes this branch): thread the
    // pause stop into the runner's per-gap yield points, without this,
    // stopWhenPaused was structurally inert for space-scoped runs and the pump
    // ran its full LLM budget straight through a high-tier governor pause.
    return runKnowledgeSemanticSelfImprovement({
      store: this.store,
      gapRepairer: this.options.gapRepairer,
      currentGapRepairer: () => this.options.gapRepairer,
      activeGapRepairs: this.activeGapRepairs,
      repairSettled: () => this.notifyGapRepairSettled(),
      objectProfiles: this.options.objectProfiles,
      enrichSource: (sourceId, options) => {
        const source = this.store.getSource(sourceId);
        return source ? enrichKnowledgeSource({ store: this.store, llm: this.options.llm }, source, options) : Promise.resolve(null);
      },
      shouldStop: () => this.backgroundStopRequested(runOptions),
    }, input);
  }

  /**
   * Collect every distinct non-stale knowledge-space id across all sources and
   * nodes in ONE cursor pass over each collection (O(N)), yielding to the
   * event loop every SELF_IMPROVE_SPACE_PAGE_SIZE records so a huge store
   * never blocks the loop, and honoring a stop signal at each yield.
   */
  private async collectSemanticSpaceIds(stop?: () => boolean): Promise<Set<string>> {
    const spaceIds = new Set<string>();
    let index = 0;
    for (const source of this.store.iterateSources()) {
      if (index > 0 && index % SELF_IMPROVE_SPACE_PAGE_SIZE === 0) {
        await yieldToEventLoop();
        if (stop?.()) return spaceIds;
      }
      index += 1;
      if (source.status !== 'stale') spaceIds.add(getKnowledgeSpaceId(source));
    }
    for (const node of this.store.iterateNodes()) {
      if (index > 0 && index % SELF_IMPROVE_SPACE_PAGE_SIZE === 0) {
        await yieldToEventLoop();
        if (stop?.()) return spaceIds;
      }
      index += 1;
      if (node.status !== 'stale') spaceIds.add(getKnowledgeSpaceId(node));
    }
    return spaceIds;
  }

  /** Report a coalesced/background repair from its actual native records.
   * The refreshed answer has already verified its facts; these fields describe
   * that work and never authorize another repair or publication. */
  private completedRepairEvidence(result: KnowledgeSemanticSelfImproveResult, spaceId: string,
    gapIds: readonly string[], answer: KnowledgeSemanticAnswerResult): KnowledgeSemanticSelfImproveResult {
    const wanted = new Set(gapIds);
    const tasks = this.store.listRefinementTasks(Number.MAX_SAFE_INTEGER, { spaceId })
      .filter(task => task.gapId !== undefined && wanted.has(task.gapId));
    const verifiedSources = new Set(answer.answer.sources.map(source => source.id));
    const recordedSources = uniqueStrings([
      ...tasks.flatMap(task => task.acceptedSourceIds ?? []),
      ...gapIds.flatMap(id => {
        const gap = this.store.getNode(id);
        return gap && getKnowledgeSpaceId(gap) === spaceId ? readStringArray(gap.metadata.acceptedSourceIds) : [];
      }),
    ]).filter(id => verifiedSources.has(id));
    const acceptedSourceIds = uniqueStrings([...(result.acceptedSourceIds ?? []), ...recordedSources]);
    const accepted = new Set(acceptedSourceIds);
    const promoted = new Set(answer.answer.facts.filter(fact => fact.metadata.extractor === 'repair-promotion'
      && [fact.sourceId, ...readStringArray(fact.metadata.sourceIds)].some(id => id !== undefined && accepted.has(id))).map(fact => fact.id));
    return { ...result, taskIds: uniqueStrings([...result.taskIds, ...tasks.map(task => task.id)]), acceptedSourceIds,
      promotedFactCount: Math.max(result.promotedFactCount ?? 0, promoted.size) };
  }

  /** The earliest next attempt when every named gap is inside the retry window of an earlier attempt; otherwise undefined. */
  private gapsWaitingUntil(gapIds: readonly string[]): number | undefined {
    if (gapIds.length === 0) return undefined;
    let earliest = Infinity;
    const now = Date.now();
    for (const id of gapIds) {
      const gap = this.store.getNode(id);
      const next = gap?.metadata.nextRepairAttemptAt;
      if (!gap || gap.status !== 'active' || readString(gap.metadata.repairStatus) === 'repaired' || typeof next !== 'number' || next <= now) return undefined;
      earliest = Math.min(earliest, next);
    }
    return earliest;
  }

  private taskIdsForGaps(spaceId: string, gapIds: readonly string[]): readonly string[] {
    const wanted = new Set(gapIds);
    if (wanted.size === 0) return [];
    return this.store.listRefinementTasks(Number.MAX_SAFE_INTEGER, { spaceId })
      .filter((task) => task.gapId && wanted.has(task.gapId))
      .map((task) => task.id);
  }

  private async waitForActiveAnswerGapRepairs(
    spaceId: string,
    gapIds: readonly string[],
    maxWaitMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (gapIds.length === 0 || maxWaitMs <= 0) return false;
    const keys = gapIds.map((gapId) => `${spaceId}:${gapId}`);
    // Nothing running: there is nothing to wait for.
    if (!keys.some((key) => this.activeGapRepairs.has(key))) return false;
    const deadlineAt = Number.isFinite(maxWaitMs) ? Date.now() + maxWaitMs : Infinity;
    for (;;) {
      assertAnswerVerificationActive(signal);
      if (!keys.some((key) => this.activeGapRepairs.has(key))) return true;
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) return false;
      // Wake when a repair settles or the caller cancels, not on a poll tick.
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const wake = (): void => {
          clearTimeout(timer);
          this.gapRepairWaiters.delete(wake);
          signal?.removeEventListener('abort', wake);
          resolve();
        };
        if (Number.isFinite(remainingMs)) { timer = setTimeout(wake, Math.min(remainingMs, MAX_TIMER_MS)); timer.unref?.(); }
        this.gapRepairWaiters.add(wake);
        signal?.addEventListener('abort', wake, { once: true });
      });
    }
  }

  private notifyGapRepairSettled(): void {
    for (const wake of [...this.gapRepairWaiters]) wake();
  }
}

function listSemanticSources(
  store: KnowledgeStore,
  spaceId: string | undefined,
): KnowledgeSourceRecord[] {
  if (!spaceId) return store.listSources(Number.MAX_SAFE_INTEGER).filter(isSemanticSourceCandidate);
  const normalized = normalizeKnowledgeSpaceId(spaceId);
  if (normalized === 'homeassistant') {
    return store.listSources(Number.MAX_SAFE_INTEGER)
      .filter((source) => isSemanticSourceCandidate(source) && isHomeAssistantKnowledgeSpace(normalizeKnowledgeSpaceId(getKnowledgeSpaceId(source))));
  }
  return store.listSourcesInSpace(normalized).filter(isSemanticSourceCandidate);
}

function isSemanticSourceCandidate(source: KnowledgeSourceRecord): boolean {
  return source.status !== 'stale' && !isGeneratedKnowledgeSource(source);
}

function answerRepairSpaceId(answer: KnowledgeSemanticAnswerResult): string {
  for (const gap of answer.answer.gaps) {
    const spaceId = normalizeKnowledgeSpaceId(getKnowledgeSpaceId(gap));
    if (spaceId && spaceId !== 'default' && spaceId !== 'homeassistant') return spaceId;
  }
  for (const source of answer.answer.sources) {
    const spaceId = normalizeKnowledgeSpaceId(getKnowledgeSpaceId(source));
    if (spaceId && spaceId !== 'default' && spaceId !== 'homeassistant') return spaceId;
  }
  for (const node of answer.answer.linkedObjects) {
    const spaceId = normalizeKnowledgeSpaceId(getKnowledgeSpaceId(node));
    if (spaceId && spaceId !== 'default' && spaceId !== 'homeassistant') return spaceId;
  }
  return answer.spaceId;
}

/** How long a subject-scoped ask waits for its own repair when the caller set no timeout. */
export const DEFAULT_FOREGROUND_ANSWER_REPAIR_MS = 20_000;

function foregroundAnswerRepairBudget(
  input: KnowledgeSemanticAnswerInput,
  answer: KnowledgeSemanticAnswerResult,
): number {
  if (!answerNeedsForegroundRepair(input, answer)) return 0;
  return typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
    ? input.timeoutMs : DEFAULT_FOREGROUND_ANSWER_REPAIR_MS;
}

function answerNeedsForegroundRepair(
  input: KnowledgeSemanticAnswerInput,
  answer: KnowledgeSemanticAnswerResult,
): boolean {
  const subjectScoped = input.strictCandidates === true
    || (input.linkedObjects?.length ?? 0) > 0
    || answer.answer.linkedObjects.length > 0
    || answer.answer.gaps.some((gap) => readStringArray(readRecord(gap.metadata).linkedObjectIds).length > 0);
  if (!subjectScoped) return false;
  return answer.answer.quality?.status === 'no-evidence' || answerNeedsEvidenceGap(answer.answer.quality);
}

function answerHasUsableEvidence(answer: KnowledgeSemanticAnswerResult): boolean {
  return answer.answer.gaps.length === 0
    && answerHasCompleteVerification(answer.answer.quality);
}

function withRefinementTaskIds(
  answer: KnowledgeSemanticAnswerResult,
  taskIds: readonly string[],
): KnowledgeSemanticAnswerResult {
  const ids = uniqueStrings([...(answer.answer.refinementTaskIds ?? []), ...taskIds]);
  if (ids.length === 0) return answer;
  return {
    ...answer,
    answer: {
      ...answer.answer,
      refinementTaskIds: ids,
    },
  };
}

function answerGapIdsForRefinement(
  answer: KnowledgeSemanticAnswerResult,
  originalGapIds: readonly string[],
): readonly string[] {
  const currentGapIds = answer.answer.gaps
    .filter((gap) => readString(readRecord(gap.metadata).gapKind) === 'answer')
    .map((gap) => gap.id);
  return currentGapIds.length > 0 ? currentGapIds : originalGapIds;
}

function withAnswerRefinement(
  answer: KnowledgeSemanticAnswerResult,
  refinement: KnowledgeSemanticAnswerRefinement,
): KnowledgeSemanticAnswerResult {
  return {
    ...answer,
    answer: {
      ...answer.answer,
      refinement,
    },
  };
}

function answerRefinementFromRepair(
  repair: KnowledgeSemanticSelfImproveResult,
  status: KnowledgeSemanticAnswerRefinement['status'],
  options: {
    readonly waitedMs?: number | undefined;
    readonly answerCacheInvalidated?: boolean | undefined;
  } = {},
): KnowledgeSemanticAnswerRefinement {
  const acceptedSourceIds = repair.acceptedSourceIds ?? [];
  const promotedFactCount = repair.promotedFactCount ?? 0;
  const reason = repair.errors[0]?.error
    ?? (repair.coalesced ? 'Another repair run for this scope was already active, so this one did not run.' : undefined)
    ?? (repair.budgetExhausted ? 'Repair did not finish within the current run budget.' : undefined);
  return {
    status,
    ...(reason ? { reason } : {}),
    repairStatus: status === 'repaired' ? 'repaired' : status === 'active' ? 'active' : 'deferred',
    refinementTaskIds: repair.taskIds,
    acceptedSourceIds,
    promotedFactCount,
    ...(repair.nextRepairAttemptAt ? { nextRepairAttemptAt: repair.nextRepairAttemptAt } : {}),
    ...(typeof options.waitedMs === 'number' ? { waitedMs: options.waitedMs } : {}),
    ...(options.answerCacheInvalidated ? { answerCacheInvalidated: true } : {}),
  };
}

function activeSelfImproveResult(input: KnowledgeSemanticSelfImproveInput): KnowledgeSemanticSelfImproveResult {
  const requestedLimit = Math.max(1, input.limit ?? 1);
  return {
    ...emptySelfImproveResult(),
    skippedGaps: 1,
    requestedLimit,
    effectiveLimit: 0,
    coalesced: true,
    truncated: true,
  };
}


function sourceNeedsLlmUpgrade(store: KnowledgeStore, source: KnowledgeSourceRecord): boolean {
  const extraction = store.getExtractionBySourceId(source.id);
  if (!extraction) return false;
  const freshness = semanticSourceFreshness(store, source, extraction);
  return !freshness.current || freshness.extractor !== 'llm';
}

function emptySelfImproveResult(): KnowledgeSemanticSelfImproveResult {
  return {
    scannedGaps: 0,
    candidateGaps: 0,
    processedGaps: 0,
    createdGaps: 0,
    repairableGaps: 0,
    suppressedGaps: 0,
    skippedGaps: 0,
    searched: 0,
    ingestedSources: 0,
    linkedRepairs: 0,
    blockedGaps: 0,
    closedGaps: 0,
    queuedTasks: 0,
    requestedLimit: 0,
    effectiveLimit: 0,
    truncated: false,
    budgetExhausted: false,
    taskIds: [],
    ingestedSourceIds: [],
    acceptedSourceIds: [],
    promotedFactCount: 0,
    errors: [],
  };
}

function mergeSelfImproveResults(
  left: KnowledgeSemanticSelfImproveResult,
  right: KnowledgeSemanticSelfImproveResult,
): KnowledgeSemanticSelfImproveResult {
  return {
    scannedGaps: left.scannedGaps + right.scannedGaps,
    candidateGaps: (left.candidateGaps ?? 0) + (right.candidateGaps ?? 0),
    processedGaps: (left.processedGaps ?? 0) + (right.processedGaps ?? 0),
    createdGaps: left.createdGaps + right.createdGaps,
    repairableGaps: left.repairableGaps + right.repairableGaps,
    suppressedGaps: left.suppressedGaps + right.suppressedGaps,
    skippedGaps: left.skippedGaps + right.skippedGaps,
    searched: left.searched + right.searched,
    ingestedSources: left.ingestedSources + right.ingestedSources,
    linkedRepairs: left.linkedRepairs + right.linkedRepairs,
    blockedGaps: left.blockedGaps + right.blockedGaps,
    closedGaps: left.closedGaps + right.closedGaps,
    queuedTasks: left.queuedTasks + right.queuedTasks,
    requestedLimit: (left.requestedLimit ?? 0) + (right.requestedLimit ?? 0),
    effectiveLimit: (left.effectiveLimit ?? 0) + (right.effectiveLimit ?? 0),
    coalesced: Boolean(left.coalesced || right.coalesced),
    truncated: Boolean(left.truncated || right.truncated),
    budgetExhausted: Boolean(left.budgetExhausted || right.budgetExhausted),
    taskIds: uniqueStrings([...left.taskIds, ...right.taskIds]),
    ingestedSourceIds: uniqueStrings([...left.ingestedSourceIds, ...right.ingestedSourceIds]),
    acceptedSourceIds: uniqueStrings([...(left.acceptedSourceIds ?? []), ...(right.acceptedSourceIds ?? [])]),
    promotedFactCount: (left.promotedFactCount ?? 0) + (right.promotedFactCount ?? 0),
    nextRepairAttemptAt: maxDefined(left.nextRepairAttemptAt, right.nextRepairAttemptAt),
    errors: [...left.errors, ...right.errors],
  };
}

function maxDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (typeof left !== 'number') return right;
  if (typeof right !== 'number') return left;
  return Math.max(left, right);
}
