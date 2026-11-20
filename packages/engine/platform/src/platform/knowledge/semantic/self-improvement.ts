import { bindWebGapRepairInvocation, assertWebGapRepairResultCurrent } from './web-gap-repair/ownership.js';
import { yieldToEventLoop } from '../cooperative.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { getKnowledgeSpaceId, normalizeKnowledgeSpaceId } from '../spaces.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeObjectProfilePolicy } from '../extensions.js';
import type {
  KnowledgeNodeRecord,
  KnowledgeRefinementTaskTrigger,
  KnowledgeRefinementTaskRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import type {
  KnowledgeSemanticGapRepairer,
  KnowledgeSemanticSelfImproveInput,
  KnowledgeSemanticSelfImproveResult,
} from './types.js';
import { NO_REPAIRER_BLOCK, NO_REPAIRER_REASON, recoverNoRepairerTasks, recoverStaleActiveTasks } from './self-improvement-recovery.js';
import { readString, sourceKnowledgeSpace, uniqueStrings } from './utils.js';
import { ACTIVE_REFINEMENT_STATES } from '../types.js';
import { KnowledgeScopeSelectionHeldError } from '../scope-selection.js';
import { SemanticIdentityHeldError } from '../store-semantic-fact-selector.js';
import { runWithBudget, timerBudgetMs } from './self-improvement-budget.js';
import { captureRepairFailureReader, type RepairFailureConclusion } from './self-improvement-failure.js';
import { captureRepairFailureWrites, KnowledgeRepairFailureWriteStaleError } from './self-improvement-failure-writes.js';
import { KnowledgeNodeActivationHeldError } from '../activation/types.js';
import { DecisionModelsDisabledError, JudgmentPortMissingError } from '@goodvibes/engine/errors';
import { isKnowledgeSourceQualityFailure } from '../source-quality.js';
import { isTerminalRefinementState } from '../store-lifecycle-authority.js';
import { storedRefinementTaskForGap, updateRefinementTask, upsertRefinementTaskForGap } from './self-improvement-tasks.js';
import { promoteRepairSources } from './self-improvement-promotion.js';
import { discoverIntrinsicGaps } from './self-improvement-intrinsic-gaps.js';
import {
  buildGapContext,
  classifyGap,
  collectCandidateGaps,
  linkRepairSources,
} from './self-improvement-gap-context.js';
import {
  SELF_IMPROVEMENT_RETRY_DELAY_MS,
  gapRetryAt,
  markGapRepairAttempt,
  suppressGap,
} from './self-improvement-gap-state.js';
import { BASE_OBJECT_PROFILES } from './self-improvement-graph.js';
import { captureGapRepairLifecycle } from './self-improvement-lifecycle.js';


interface SelfImproveContext {
  readonly store: KnowledgeStore;
  readonly gapRepairer?: KnowledgeSemanticGapRepairer | null | undefined;
  /** The service's repairer right now; a repair started under another one is retired. */
  readonly currentGapRepairer?: (() => KnowledgeSemanticGapRepairer | null | undefined) | undefined;
  readonly activeGapRepairs: Set<string>;
  /** Called after a gap's repair leaves `activeGapRepairs`, so a waiter wakes without polling. */
  readonly repairSettled?: (() => void) | undefined;
  readonly objectProfiles?: readonly KnowledgeObjectProfilePolicy[] | undefined;
  readonly enrichSource?: (sourceId: string, options: { readonly force?: boolean; readonly knowledgeSpaceId?: string; readonly signal?: AbortSignal; readonly shouldStop?: (() => boolean) | undefined }) => Promise<unknown>;
  /**
   * Cooperative stop probe (memory-governor pause), consulted at the SAME
   * yield points as `input.signal`, before/after gap discovery and at the top
   * of every per-gap iteration. This is what makes `stopWhenPaused` real for
   * SPACE-SCOPED runs: without it the pause was only honored between spaces of
   * a whole-store sweep, and every sync-pump round (always space-scoped) ran
   * its full LLM-backed budget straight through a governor pause.
   */
  readonly shouldStop?: (() => boolean) | undefined;
}

interface GapRepairOutcome {
  readonly budgetExhausted?: boolean;
  readonly repairableGaps: number;
  readonly skippedGaps: number;
  readonly blockedGaps: number;
  readonly closedGaps: number;
  readonly queuedTasks: number;
  readonly searched: number;
  readonly ingestedSources: number;
  readonly linkedRepairs: number;
  readonly promotedFactCount: number;
  readonly ingestedSourceIds: readonly string[];
  readonly acceptedSourceIds: readonly string[];
  readonly errors: readonly { gapId: string; error: string }[];
  readonly nextRepairAttemptAt?: number | undefined;
}
type GapRepairerResult = Awaited<ReturnType<KnowledgeSemanticGapRepairer>>;

interface SelfImproveRunPlan {
  readonly candidates: readonly KnowledgeNodeRecord[];
  readonly gaps: readonly KnowledgeNodeRecord[];
  readonly requestedLimit: number;
  readonly cappedLimit: number;
  readonly effectiveLimit: number;
  readonly maxRunMs: number;
  readonly startedAt: number;
  readonly trigger: KnowledgeRefinementTaskTrigger;
}

interface SelfImproveRunState {
  truncated: boolean;
  budgetExhausted: boolean;
  processedGaps: number;
  repairableGaps: number;
  suppressedGaps: number;
  skippedGaps: number;
  blockedGaps: number;
  closedGaps: number;
  queuedTasks: number;
  searched: number;
  ingestedSources: number;
  linkedRepairs: number;
  promotedFactCount: number;
  nextRepairAttemptAt?: number | undefined;
  readonly taskIds: string[];
  readonly ingestedSourceIds: string[];
  readonly acceptedSourceIds: string[];
  readonly errors: { gapId: string; error: string }[];
}

export async function runKnowledgeSemanticSelfImprovement(
  context: SelfImproveContext,
  input: KnowledgeSemanticSelfImproveInput = {},
): Promise<KnowledgeSemanticSelfImproveResult> {
  await context.store.init();
  const sourceIdFilter = input.sourceIds?.length ? new Set(input.sourceIds) : null;
  const gapIdFilter = input.gapIds?.length ? new Set(input.gapIds) : null;
  const spaceId = resolveSelfImproveSpace(context.store, input);
  const objectProfiles = [...BASE_OBJECT_PROFILES, ...(input.objectProfiles ?? context.objectProfiles ?? [])];
  // A repair this process is still running is not stale, however long its step takes.
  await recoverStaleActiveTasks(context.store, spaceId, (task) => task.gapId !== undefined && context.activeGapRepairs.has(`${spaceId}:${task.gapId}`));
  if (context.gapRepairer) {
    await recoverNoRepairerTasks(context.store, spaceId);
  }
  if (input.signal?.aborted) return emptySelfImproveResult(spaceId, 'Run was cancelled before intrinsic gap discovery.');
  if (context.shouldStop?.()) return emptySelfImproveResult(spaceId, 'Run was stopped before intrinsic gap discovery: background knowledge work is paused for memory pressure.');
  const createdGaps = gapIdFilter ? 0 : await discoverIntrinsicGaps(context.store, spaceId, sourceIdFilter, objectProfiles, input.signal, context.shouldStop);
  if (input.signal?.aborted) return emptySelfImproveResult(spaceId, 'Run was cancelled after intrinsic gap discovery.');
  if (context.shouldStop?.()) return emptySelfImproveResult(spaceId, 'Run was stopped after intrinsic gap discovery: background knowledge work is paused for memory pressure.');
  const candidates = await collectCandidateGaps(context.store, spaceId, sourceIdFilter, gapIdFilter,
    { signal: input.signal, shouldStop: context.shouldStop });
  candidates.assertCurrent();
  // Decided from what is stored, before any reading and before the limit is
  // applied: a gap waiting out its retry window (forced or not) or one whose
  // task is final costs no model request and no task write, and does not take
  // a slot from a gap that can be worked.
  const workable: KnowledgeNodeRecord[] = [];
  let waiting = 0, finishedSuppressions = 0;
  let nextWaitingAttemptAt: number | undefined;
  for (const gap of candidates.gaps) {
    const stored = storedGapState(context.store, spaceId, gap);
    if (stored.kind === 'ready') { workable.push(gap); continue; }
    if (stored.kind === 'waiting') nextWaitingAttemptAt = Math.min(nextWaitingAttemptAt ?? Infinity, stored.nextAttemptAt);
    if (stored.kind === 'suppressed') {
      // A suppress decision writes its task first; a run stopped between the two
      // writes left the gap active under a final task, so finish the gap.
      await suppressGap(context.store, gap, stored.task.trace.findLast((entry) => entry.state === 'suppressed')?.message ?? 'Gap was classified as not applicable.', spaceId);
      finishedSuppressions += 1;
      continue;
    }
    waiting += 1;
  }
  const plan = createSelfImproveRunPlan(workable, input);
  const state = createSelfImproveRunState(plan);
  state.skippedGaps += waiting;
  state.suppressedGaps += finishedSuppressions;
  // When the next attempt of a gap that is waiting out its retry window is due.
  if (nextWaitingAttemptAt !== undefined) state.nextRepairAttemptAt = nextWaitingAttemptAt;

  for (const plannedGap of plan.gaps) {
    // A preceding repair can close or update another planned gap.
    const gap = context.store.getNode(plannedGap.id);
    if (!gap || gap.kind !== 'knowledge_gap' || gap.status !== 'active') { state.skippedGaps += 1; continue; }
    // Governor pause stop lands INSIDE a space-scoped run too: the per-gap
    // boundary is the run's natural yield point, same as signal abort.
    if (input.signal?.aborted || context.shouldStop?.()) {
      state.truncated = true;
      break;
    }
    if (Date.now() - plan.startedAt >= plan.maxRunMs) {
      markRunBudgetExhausted(state);
      break;
    }
    // A preceding repair in this run can have started this gap's retry window.
    if (storedGapState(context.store, spaceId, gap).kind !== 'ready') { state.skippedGaps += 1; continue; }
    state.processedGaps += 1;
    // The task a repair is running for, so a cancel that throws out of the repair still settles it.
    let repairingTaskId: string | undefined;
    try {
      // The run's remaining time bounds every judgment reading, so a hung model
      // port ends this gap at the run deadline instead of stalling the run.
      const readingBudget = { signal: input.signal, shouldStop: context.shouldStop, ...(Number.isFinite(plan.maxRunMs)
        ? { timeoutMs: Math.max(1, plan.startedAt + plan.maxRunMs - Date.now()) } : {}) };
      const gapContext = await buildGapContext(context.store, spaceId, gap, objectProfiles, readingBudget);
      const lifecycleStopped = captureGapRepairLifecycle(context.store, gap);
      // A missing usefulness reader must not rewrite an existing task merely to
      // discover that its previous repaired-fact decision cannot be revalidated.
      const classification = await classifyGap(gapContext, input.force === true, objectProfiles, context.store, readingBudget);
      classification.assertCurrent?.();
      let task = await upsertRefinementTaskForGap(context.store, spaceId, gapContext, plan.trigger, 'detected', 'Gap was detected for semantic refinement.', {}, classification.assertCurrent);
      state.taskIds.push(task.id);
      const repaired = classification.action === 'skip' && (classification.status === 'repaired' || classification.status === 'already_repaired');
      if (task.state === 'closed') {
        if (repaired) {
          // Repaired before repaired gaps were retired: retire it now.
          state.closedGaps += 1;
          await markGapRepairAttempt(context.store, gap, spaceId, { status: 'repaired', reason: classification.reason, assertCurrent: classification.assertCurrent });
          continue;
        }
        // The gap was repaired once and is open again: its task starts a new attempt.
        task = await updateRefinementTask(context.store, task, 'detected', 'Gap was observed again after its repair; a new repair attempt starts.', {}, classification.assertCurrent);
      }
      const shouldStop = () => input.signal?.aborted === true || context.shouldStop?.() === true || lifecycleStopped(task.id);
      if (isTerminalRefinementState(task.state)) {
        // A suppress decision writes its task first. A run that stopped between
        // the two writes left the gap active under a final task: finish the gap.
        if (task.state === 'suppressed' && classification.action === 'suppress' && !input.signal?.aborted && !context.shouldStop?.()) {
          await suppressGap(context.store, gap, classification.reason, spaceId, classification.assertCurrent);
          state.suppressedGaps += 1;
          continue;
        }
        // A cancelled task is the owner's decision about this gap; it is skipped, not reported again.
        state.skippedGaps += 1;
        continue;
      }
      if (shouldStop()) { state.skippedGaps += 1; continue; }
      if (classification.action === 'suppress') {
        await updateRefinementTask(context.store, task, 'suppressed', classification.reason ?? 'Gap was classified as not applicable.', {}, classification.assertCurrent);
        await suppressGap(context.store, gap, classification.reason, spaceId, classification.assertCurrent);
        state.suppressedGaps += 1;
        continue;
      }
      if (classification.action === 'skip') {
        if (repaired) {
          state.closedGaps += 1;
          await updateRefinementTask(context.store, task, 'closed', classification.reason ?? 'Gap is already repaired.', {}, classification.assertCurrent);
          // Retire the repaired gap so it leaves the candidate set.
          await markGapRepairAttempt(context.store, gap, spaceId, { status: 'repaired', reason: classification.reason, assertCurrent: classification.assertCurrent });
          continue;
        }
        state.blockedGaps += 1;
        await updateRefinementTask(context.store, task, 'blocked', classification.reason ?? 'Gap is not currently repairable.', {}, classification.assertCurrent);
        // The blocked task records the skip. Rewriting the gap each run would
        // append a node revision per run and, for a gap waiting out its retry
        // window, replace the failure status that window belongs to.
        const status = classification.status === 'needs_context' ? 'needs_context' : 'skipped';
        if (classification.markAttempt && classification.status !== 'retry_wait' && readString(gap.metadata.repairStatus) !== status) {
          await markGapRepairAttempt(context.store, gap, spaceId, {
            status,
            reason: classification.reason,
            assertCurrent: classification.assertCurrent,
          });
        }
        continue;
      }
      if (input.deferRepair === true && context.gapRepairer) {
        state.queuedTasks += 1;
        await updateRefinementTask(context.store, task, 'queued', 'Gap repair was queued for background refinement.', {
          deferred: true,
        }, classification.assertCurrent);
        continue;
      }
      if (!context.gapRepairer) {
        await markNoRepairer(context.store, spaceId, gap, task, classification.assertCurrent);
        state.blockedGaps += 1;
        continue;
      }
      classification.assertCurrent?.();
      repairingTaskId = task.id;
      const repair = await repairCandidateGap({
        context,
        input,
        spaceId,
        objectProfiles,
        gap,
        gapContext,
        task,
        startedAt: plan.startedAt,
        maxRunMs: plan.maxRunMs,
        shouldStop,
      });
      repairingTaskId = undefined;
      applyRepairOutcome(state, repair);
      // A cancel or a governor pause stops this run; it settles what it left
      // behind, so the task never reads as running when nothing runs it.
      if (input.signal?.aborted) await settleCancelledTask(context.store, task.id);
      else if (context.shouldStop?.()) await settleStoppedTask(context.store, task.id, 'background knowledge work is paused for memory pressure');
    } catch (error) {
      if (input.signal?.aborted) {
        if (repairingTaskId !== undefined) await settleCancelledTask(context.store, repairingTaskId);
        throw error;
      }
      // One gap whose saved identity, graph or model reading is held must not
      // stop every later gap; they are processed in the same order each run.
      if (!isSelfImproveHold(error)) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      // A hold writes nothing, so the gap keeps its state and is read again next run.
      state.errors.push({ gapId: gap.id, error: reason });
      state.skippedGaps += 1;
    }
    await yieldToEventLoop();
  }

  return buildSelfImproveResult(plan, state, createdGaps);
}

type StoredGapState =
  | { readonly kind: 'ready' }
  | { readonly kind: 'waiting'; readonly nextAttemptAt: number }
  | { readonly kind: 'final'; readonly task: KnowledgeRefinementTaskRecord }
  | { readonly kind: 'suppressed'; readonly task: KnowledgeRefinementTaskRecord };

/** What the stored gap and its task already say: inside its retry window, final, or ready to work. */
function storedGapState(store: KnowledgeStore, spaceId: string, gap: KnowledgeNodeRecord): StoredGapState {
  const nextAttemptAt = gapRetryAt(gap.metadata);
  if (readString(gap.metadata.repairStatus) !== 'repaired' && nextAttemptAt !== undefined && nextAttemptAt > Date.now()) return { kind: 'waiting', nextAttemptAt };
  const task = storedRefinementTaskForGap(store, spaceId, gap.id);
  if (task && isTerminalRefinementState(task.state)) return task.state === 'suppressed' ? { kind: 'suppressed', task } : { kind: 'final', task };
  return { kind: 'ready' };
}

/**
 * A hold stops the one gap or space it happened in; the run reports it and
 * moves on. Anything else (a store fault, a bug) still stops the run.
 */
export function isSelfImproveHold(error: unknown): boolean {
  // No decision model at all holds every gap the same way; that stops the run.
  if (error instanceof DecisionModelsDisabledError || error instanceof JudgmentPortMissingError
    || (error instanceof Error && (error as { reason?: unknown }).reason === 'unconfigured')) return false;
  return error instanceof SemanticIdentityHeldError
    || (error instanceof KnowledgeScopeSelectionHeldError && error.reason === 'stale')
    || (isKnowledgeSourceQualityFailure(error) && !(error instanceof KnowledgeNodeActivationHeldError && error.reason === 'aborted'));
}

/**
 * A repair that returned early because the run was paused or cancelled leaves
 * its task in whatever step it reached; nothing is working on it any more, so
 * it must not keep reading as in progress. A task another writer already
 * settled (an owner's cancel, a repair that closed it) is left as it is.
 */
async function settleStoppedTask(store: KnowledgeStore, taskId: string, why: string): Promise<void> {
  const current = store.getRefinementTask(taskId);
  if (!current || !(ACTIVE_REFINEMENT_STATES.has(current.state) || current.state === 'verified')) return;
  await updateRefinementTask(store, current, 'blocked', `Repair stopped because ${why}; it can be retried.`, { stopped: why, retryable: true });
}

/**
 * One write per cancelled run, best effort: a store that is already closing
 * keeps the task as it was, and the next run's stale-task recovery settles it.
 */
async function settleCancelledTask(store: KnowledgeStore, taskId: string): Promise<void> {
  try { await settleStoppedTask(store, taskId, 'the run was cancelled'); }
  catch (error) {
    logger.warn('Knowledge refinement: a cancelled run could not settle its task; the next run settles it', { taskId, error: summarizeError(error) });
  }
}

function createSelfImproveRunPlan(
  candidates: readonly KnowledgeNodeRecord[],
  input: KnowledgeSemanticSelfImproveInput,
): SelfImproveRunPlan {
  const requestedLimit = input.limit !== undefined && input.limit > 0 ? Math.floor(input.limit) : candidates.length;
  // No platform cap: a caller that omits `limit` asks for every candidate. A
  // zero or negative limit reads as omitted (background producers rely on it).
  const cappedLimit = requestedLimit;
  const gaps = candidates.slice(0, cappedLimit);
  return {
    candidates,
    gaps,
    requestedLimit,
    cappedLimit,
    effectiveLimit: gaps.length,
    maxRunMs: input.maxRunMs !== undefined && input.maxRunMs > 0 ? timerBudgetMs(input.maxRunMs) : Infinity,
    startedAt: Date.now(),
    trigger: input.reason ?? 'manual',
  };
}

function createSelfImproveRunState(plan: SelfImproveRunPlan): SelfImproveRunState {
  return {
    truncated: plan.candidates.length > plan.gaps.length || plan.requestedLimit > plan.cappedLimit,
    budgetExhausted: false,
    processedGaps: 0,
    repairableGaps: 0,
    suppressedGaps: 0,
    skippedGaps: 0,
    blockedGaps: 0,
    closedGaps: 0,
    queuedTasks: 0,
    searched: 0,
    ingestedSources: 0,
    linkedRepairs: 0,
    promotedFactCount: 0,
    taskIds: [],
    ingestedSourceIds: [],
    acceptedSourceIds: [],
    errors: [],
  };
}

/** Only the run's own time budget (or a repair's report of it) exhausts it; a stop or pause only truncates. */
function markRunBudgetExhausted(state: SelfImproveRunState): void {
  state.truncated = true;
  state.budgetExhausted = true;
}

function applyRepairOutcome(state: SelfImproveRunState, repair: GapRepairOutcome): void {
  if (repair.budgetExhausted) markRunBudgetExhausted(state);
  state.repairableGaps += repair.repairableGaps;
  state.skippedGaps += repair.skippedGaps;
  state.blockedGaps += repair.blockedGaps;
  state.closedGaps += repair.closedGaps;
  state.queuedTasks += repair.queuedTasks;
  state.searched += repair.searched;
  state.ingestedSources += repair.ingestedSources;
  state.linkedRepairs += repair.linkedRepairs;
  state.promotedFactCount += repair.promotedFactCount;
  state.ingestedSourceIds.push(...repair.ingestedSourceIds);
  state.acceptedSourceIds.push(...repair.acceptedSourceIds);
  state.errors.push(...repair.errors);
  state.nextRepairAttemptAt = repair.nextRepairAttemptAt ?? state.nextRepairAttemptAt;
}

async function markNoRepairer(
  store: KnowledgeStore,
  spaceId: string,
  gap: KnowledgeNodeRecord,
  task: KnowledgeRefinementTaskRecord,
  assertCurrent?: () => void,
): Promise<void> {
  await updateRefinementTask(store, task, 'blocked', NO_REPAIRER_REASON, { blockedKind: NO_REPAIRER_BLOCK }, assertCurrent);
  // Already recorded: rewriting it each run would only append node revisions.
  if (readString(gap.metadata.repairStatus) === NO_REPAIRER_BLOCK) return;
  await markGapRepairAttempt(store, gap, spaceId, {
    assertCurrent,
    status: NO_REPAIRER_BLOCK,
    reason: NO_REPAIRER_REASON,
  });
}

function buildSelfImproveResult(
  plan: SelfImproveRunPlan,
  state: SelfImproveRunState,
  createdGaps: number,
): KnowledgeSemanticSelfImproveResult {
  return {
    scannedGaps: plan.gaps.length,
    candidateGaps: plan.candidates.length,
    processedGaps: state.processedGaps,
    createdGaps,
    repairableGaps: state.repairableGaps,
    suppressedGaps: state.suppressedGaps,
    skippedGaps: state.skippedGaps,
    searched: state.searched,
    ingestedSources: state.ingestedSources,
    linkedRepairs: state.linkedRepairs,
    blockedGaps: state.blockedGaps,
    closedGaps: state.closedGaps,
    queuedTasks: state.queuedTasks,
    requestedLimit: plan.requestedLimit,
    effectiveLimit: plan.effectiveLimit,
    truncated: state.truncated,
    budgetExhausted: state.budgetExhausted,
    taskIds: uniqueStrings(state.taskIds),
    ingestedSourceIds: uniqueStrings(state.ingestedSourceIds),
    acceptedSourceIds: uniqueStrings(state.acceptedSourceIds),
    promotedFactCount: state.promotedFactCount,
    ...(state.nextRepairAttemptAt ? { nextRepairAttemptAt: state.nextRepairAttemptAt } : {}),
    errors: state.errors,
  };
}

function emptySelfImproveResult(
  spaceId: string,
  reason: string,
): KnowledgeSemanticSelfImproveResult {
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
    truncated: true,
    budgetExhausted: false,
    taskIds: [],
    ingestedSourceIds: [],
    acceptedSourceIds: [],
    promotedFactCount: 0,
    errors: [{ gapId: spaceId, error: reason }],
  };
}

async function repairCandidateGap(options: {
  readonly context: SelfImproveContext;
  readonly input: KnowledgeSemanticSelfImproveInput;
  readonly spaceId: string;
  readonly objectProfiles: readonly KnowledgeObjectProfilePolicy[];
  readonly gap: KnowledgeNodeRecord;
  readonly gapContext: Awaited<ReturnType<typeof buildGapContext>>;
  readonly task: KnowledgeRefinementTaskRecord;
  readonly startedAt: number;
  readonly maxRunMs: number;
  readonly shouldStop: () => boolean;
}): Promise<GapRepairOutcome> {
  const { context, spaceId, gap } = options;
  const repairKey = `${spaceId}:${gap.id}`;
  if (context.activeGapRepairs.has(repairKey)) {
    await updateRefinementTask(context.store, options.task, 'queued', 'Gap repair is already active.');
    return emptyRepairOutcome({ skippedGaps: 1 });
  }
  context.activeGapRepairs.add(repairKey);
  let failureTaskSnapshot: string | undefined;
  const failureStopped = () => options.shouldStop() || (failureTaskSnapshot !== undefined
    && JSON.stringify(context.store.getRefinementTask(options.task.id)) !== failureTaskSnapshot);
  const readFailure = captureRepairFailureReader({ signal: options.input.signal,
    deadlineAt: options.startedAt + options.maxRunMs, shouldStop: failureStopped,
    ownerStopped: () => context.shouldStop?.() === true });
  try {
    return await executeGapRepair({
      ...options,
      gapRepairer: context.gapRepairer!,
    });
  } catch (error) {
    if (options.shouldStop()) return emptyRepairOutcome({ skippedGaps: 1 });
    const reason = error instanceof Error ? error.message : String(error);
    // Classification introduces a yield after execution failed. A newer attempt
    // of this same nonterminal task must not inherit the old failure's decision.
    const failureTask = context.store.getRefinementTask(options.task.id);
    if (!failureTask) return emptyRepairOutcome({ skippedGaps: 1 });
    failureTaskSnapshot = JSON.stringify(failureTask);
    const failure = await readFailure(error);
    if (options.shouldStop() || !failure.isCurrent()) return emptyRepairOutcome({ skippedGaps: 1 });
    return await persistGapRepairFailure(context, gap, failureTask, spaceId, reason, failure);
  } finally {
    context.activeGapRepairs.delete(repairKey);
    context.repairSettled?.();
  }
}

async function persistGapRepairFailure(context: SelfImproveContext, gap: KnowledgeNodeRecord,
  task: KnowledgeRefinementTaskRecord, spaceId: string, reason: string,
  failure: RepairFailureConclusion): Promise<GapRepairOutcome> {
  const owner = captureRepairFailureWrites(context.store, gap, task, failure.isOwnerCurrent);
  const { isCurrent: _isCurrent, isOwnerCurrent: _isOwnerCurrent, ...failureCause } = failure;
  const deferRetry = failure.cause === 'run_budget' || failure.cause === 'request_timeout';
  try {
    owner.assertCurrent();
    if (deferRetry) {
      // The gap writer owns the retry stamp. Reuse its numeric public view for
      // task scheduling rather than passing an unowned numeric clock into it.
      const deferredGap = await markGapRepairAttempt(context.store, gap, spaceId, {
        status: 'deferred', reason, assertCurrent: owner.assertCurrent,
      });
      owner.acceptGap(deferredGap);
      const nextRepairAttemptAt = gapRetryAt(deferredGap.metadata);
      owner.acceptTask(await updateRefinementTask(context.store, task, 'blocked', failure.cause === 'run_budget'
        ? 'Repair was deferred after exhausting the current run budget.'
        : 'Repair was deferred after a request timed out.', {
        failureCause, retryable: true, nextRepairAttemptAt, error: reason,
      }, owner.assertCurrent));
      owner.assertCurrent();
      return emptyRepairOutcome({ repairableGaps: 1, queuedTasks: 1, blockedGaps: 1,
        budgetExhausted: failure.cause === 'run_budget', nextRepairAttemptAt, errors: [{ gapId: gap.id, error: reason }] });
    }
    owner.acceptTask(await updateRefinementTask(context.store, task, 'failed', reason,
      { failureCause }, owner.assertCurrent));
    owner.acceptGap(await markGapRepairAttempt(context.store, gap, spaceId, {
      status: 'failed', reason, assertCurrent: owner.assertCurrent,
    }));
    owner.assertCurrent();
    return emptyRepairOutcome({ repairableGaps: 1, queuedTasks: 1, errors: [{ gapId: gap.id, error: reason }] });
  } catch (error) {
    if (error instanceof KnowledgeRepairFailureWriteStaleError
      || (error instanceof KnowledgeNodeActivationHeldError && (error.reason === 'stale' || error.reason === 'aborted'))) {
      return emptyRepairOutcome({ skippedGaps: 1 });
    }
    throw error;
  }
}

async function executeGapRepair(options: {
  readonly context: SelfImproveContext;
  readonly input: KnowledgeSemanticSelfImproveInput;
  readonly spaceId: string;
  readonly objectProfiles: readonly KnowledgeObjectProfilePolicy[];
  readonly gap: KnowledgeNodeRecord;
  readonly gapContext: Awaited<ReturnType<typeof buildGapContext>>;
  readonly task: KnowledgeRefinementTaskRecord;
  readonly startedAt: number;
  readonly maxRunMs: number;
  readonly gapRepairer: KnowledgeSemanticGapRepairer;
  readonly shouldStop: () => boolean;
}): Promise<GapRepairOutcome> {
  const { context, input, spaceId, objectProfiles, gap, gapContext, startedAt, maxRunMs, gapRepairer } = options;
  if (options.shouldStop()) return emptyRepairOutcome({ skippedGaps: 1 });
  let task = await updateRefinementTask(context.store, options.task, 'searching', 'Searching for source-backed repair evidence.', { query: gap.title });
  if (options.shouldStop()) return emptyRepairOutcome({ skippedGaps: 1 });
  const remainingMs = Math.max(0, startedAt + maxRunMs - Date.now());
  const repairerRetired = () => context.currentGapRepairer !== undefined && context.currentGapRepairer() !== gapRepairer;
  const result = await runGapRepairerWithBudget({
    input,
    spaceId,
    gap,
    gapContext,
    gapRepairer,
    remainingMs,
    store: context.store,
    assertCurrent: () => { if (options.shouldStop() || repairerRetired()) throw new Error('Gap repair caller retired'); },
  });
  // A repairer replaced or removed mid-run no longer speaks for this service: its answer is not recorded.
  if (options.shouldStop() || repairerRetired()) return emptyRepairOutcome({ skippedGaps: 1 });
  const assessment = await recordGapRepairAssessment(context.store, task, gap, result);
  task = assessment.task;
  if (options.shouldStop()) return emptyRepairOutcome({ skippedGaps: 1 });
  if (assessment.acceptedSourceIds.length) {
    task = await updateRefinementTask(context.store, task, 'applying', 'Linking accepted repair sources into the graph.', {}, () => assertWebGapRepairResultCurrent(result));
  }
  return applyGapRepairEvidence({
    context,
    objectProfiles,
    spaceId,
    gap,
    task,
    result,
    acceptedSourceIds: assessment.acceptedSourceIds,
    ingestedSourceIds: assessment.ingestedSourceIds,
    deadlineAt: startedAt + maxRunMs,
    signal: input.signal,
    shouldStop: () => { assertWebGapRepairResultCurrent(result); return options.shouldStop(); },
  });
}

async function runGapRepairerWithBudget(input: {
  readonly input: KnowledgeSemanticSelfImproveInput;
  readonly spaceId: string;
  readonly gap: KnowledgeNodeRecord;
  readonly gapContext: Awaited<ReturnType<typeof buildGapContext>>;
  readonly gapRepairer: KnowledgeSemanticGapRepairer;
  readonly remainingMs: number;
  readonly store: KnowledgeStore;
  readonly assertCurrent: () => void;
}): Promise<GapRepairerResult> {
  const { input: runInput, spaceId, gap, gapContext, gapRepairer, remainingMs } = input;
  return runWithBudget((signal) => gapRepairer(bindWebGapRepairInvocation(input.store, gapRepairer, {
    spaceId,
    query: gap.title,
    gaps: [gap],
    sources: gapContext.sources,
    linkedObjects: gapContext.linkedObjects,
    facts: gapContext.facts,
    ...(Number.isFinite(remainingMs) ? { deadlineAt: Date.now() + remainingMs } : {}),
    signal,
  }, input.assertCurrent)), remainingMs, runInput.signal);
}

async function recordGapRepairAssessment(
  store: KnowledgeStore,
  task: KnowledgeRefinementTaskRecord,
  gap: KnowledgeNodeRecord,
  result: GapRepairerResult,
): Promise<{
  readonly task: KnowledgeRefinementTaskRecord;
  readonly ingestedSourceIds: readonly string[];
  readonly acceptedSourceIds: readonly string[];
}> {
  assertWebGapRepairResultCurrent(result);
  const ingestedSourceIds = result?.ingestedSourceIds ?? [];
  const acceptedSourceIds = uniqueStrings([...(result?.acceptedSourceIds ?? []), ...ingestedSourceIds]);
  const updatedTask = await updateRefinementTask(store, task, 'evaluating', result?.reason ?? 'Source discovery completed.', {
    query: result?.query ?? gap.title,
    sourceAssessments: result?.sourceAssessments ?? [],
    ingestedSourceIds,
    acceptedSourceIds,
    skippedUrls: result?.skippedUrls ?? [],
  }, () => assertWebGapRepairResultCurrent(result));
  return { task: updatedTask, ingestedSourceIds, acceptedSourceIds };
}

async function applyGapRepairEvidence(input: {
  readonly context: SelfImproveContext;
  readonly objectProfiles: readonly KnowledgeObjectProfilePolicy[];
  readonly spaceId: string;
  readonly gap: KnowledgeNodeRecord;
  readonly task: KnowledgeRefinementTaskRecord;
  readonly result: GapRepairerResult;
  readonly acceptedSourceIds: readonly string[];
  readonly ingestedSourceIds: readonly string[];
  readonly deadlineAt: number;
  readonly signal?: AbortSignal | undefined;
  readonly shouldStop: () => boolean;
}): Promise<GapRepairOutcome> {
  const { context, objectProfiles, spaceId, gap, task, result, acceptedSourceIds, ingestedSourceIds, deadlineAt } = input;
  if (input.shouldStop()) return emptyRepairOutcome({ skippedGaps: 1 });
  const linkedRepairs = await linkRepairSources(context.store, spaceId, gap, acceptedSourceIds, result?.query ?? gap.title, objectProfiles, input.shouldStop, input.signal);
  if (input.shouldStop()) return emptyRepairOutcome({ skippedGaps: 1 });
  let promotedFactCount = 0;
  let repairComplete = false;
  if (acceptedSourceIds.length > 0) {
    const promotion = await promoteRepairSources({ ...context, objectProfiles, shouldStop: input.shouldStop }, spaceId, gap, acceptedSourceIds, task, deadlineAt);
    promotedFactCount = promotion.promotedFactCount;
    repairComplete = promotion.repairComplete;
  }

  if (input.shouldStop()) return emptyRepairOutcome({ skippedGaps: 1 });
  const evidenceSufficient = result?.evidenceSufficient !== false && acceptedSourceIds.length > 0 && repairComplete;
  await markGapRepairAttempt(context.store, gap, spaceId, {
    status: evidenceSufficient ? 'repaired' : acceptedSourceIds.length ? 'deferred' : 'searched_no_sources',
    reason: result?.reason,
    query: result?.query,
    acceptedSourceIds,
    promotedFactCount,
  });

  if (evidenceSufficient) {
    await updateRefinementTask(context.store, task, 'closed', 'Repair sources were accepted and linked to the gap.', {
      acceptedSourceIds,
      ingestedSourceIds,
      promotedFactCount,
    });
    return emptyRepairOutcome({
      repairableGaps: 1,
      queuedTasks: 1,
      searched: result?.searched ? 1 : 0,
      ingestedSources: ingestedSourceIds.length,
      linkedRepairs,
      promotedFactCount,
      ingestedSourceIds,
      acceptedSourceIds,
      closedGaps: 1,
    });
  }

  if (acceptedSourceIds.length > 0) {
    const nextRepairAttemptAt = Date.now() + SELF_IMPROVEMENT_RETRY_DELAY_MS;
    await updateRefinementTask(context.store, task, 'blocked', result?.reason ?? 'Accepted source evidence was linked, but the gap still needs corroboration.', {
      acceptedSourceIds,
      promotedFactCount,
      retryable: true,
      nextRepairAttemptAt,
    });
    return emptyRepairOutcome({
      repairableGaps: 1,
      queuedTasks: 1,
      searched: result?.searched ? 1 : 0,
      ingestedSources: ingestedSourceIds.length,
      linkedRepairs,
      promotedFactCount,
      ingestedSourceIds,
      acceptedSourceIds,
      blockedGaps: 1,
      nextRepairAttemptAt,
    });
  }

  await updateRefinementTask(context.store, task, 'blocked', result?.reason ?? 'No acceptable repair sources were found.');
  return emptyRepairOutcome({
    repairableGaps: 1,
    queuedTasks: 1,
    searched: result?.searched ? 1 : 0,
    blockedGaps: 1,
  });
}

function emptyRepairOutcome(overrides: Partial<GapRepairOutcome> = {}): GapRepairOutcome {
  return {
    repairableGaps: 0,
    skippedGaps: 0,
    blockedGaps: 0,
    closedGaps: 0,
    queuedTasks: 0,
    searched: 0,
    ingestedSources: 0,
    linkedRepairs: 0,
    promotedFactCount: 0,
    ingestedSourceIds: [],
    acceptedSourceIds: [],
    errors: [],
    ...overrides,
  };
}

function resolveSelfImproveSpace(store: KnowledgeStore, input: KnowledgeSemanticSelfImproveInput): string {
  if (input.knowledgeSpaceId) return normalizeKnowledgeSpaceId(input.knowledgeSpaceId);
  const firstSource = input.sourceIds?.map((id) => store.getSource(id)).find((source): source is KnowledgeSourceRecord => Boolean(source));
  if (firstSource) return sourceKnowledgeSpace(firstSource);
  const firstGap = input.gapIds?.map((id) => store.getNode(id)).find((node): node is KnowledgeNodeRecord => Boolean(node));
  return normalizeKnowledgeSpaceId(firstGap ? getKnowledgeSpaceId(firstGap) : undefined);
}
