import { RefusalError, refusal } from '@goodvibes/engine/errors';
import type { KnowledgeSemanticService } from '../semantic/index.js';
import type { KnowledgeStore } from '../store.js';
import { knowledgeRefinementTaskLifecycle, type KnowledgeRefinementTaskRecord } from '../types.js';
import { resolveReadableHomeGraphSpace } from './space-selection.js';
import { guardKnowledgeRefinementTaskInput } from '../store-refinement.js';
import {
  runHomeGraphIssueTriage,
  type HomeGraphTriageOptions,
  type HomeGraphTriageResult,
} from './triage.js';
import type { HomeGraphSpaceInput } from './types.js';

export async function listHomeGraphRefinementTasks(input: HomeGraphSpaceInput & {
  readonly store: KnowledgeStore;
  readonly limit?: number | undefined;
  readonly state?: string | undefined;
  readonly subjectId?: string | undefined;
  readonly gapId?: string | undefined;
}): Promise<{ readonly ok: true; readonly spaceId: string; readonly tasks: readonly KnowledgeRefinementTaskRecord[] }> {
  await input.store.init();
  const { spaceId } = resolveReadableHomeGraphSpace(input.store, input);
  return {
    ok: true,
    spaceId,
    tasks: input.store.listRefinementTasks(input.limit ?? 100, {
      spaceId,
      state: input.state,
      subjectKind: input.subjectId ? 'node' : undefined,
      subjectId: input.subjectId,
      gapId: input.gapId,
    }),
  };
}

export async function getHomeGraphRefinementTask(input: HomeGraphSpaceInput & {
  readonly store: KnowledgeStore;
  readonly taskId: string;
}): Promise<{ readonly ok: true; readonly spaceId: string; readonly task: KnowledgeRefinementTaskRecord | null }> {
  await input.store.init();
  const { spaceId } = resolveReadableHomeGraphSpace(input.store, input);
  const task = input.store.getRefinementTask(input.taskId);
  return { ok: true, spaceId, task: task?.spaceId === spaceId ? task : null };
}

export async function runHomeGraphRefinement(input: HomeGraphSpaceInput & {
  readonly store: KnowledgeStore;
  readonly semanticService?: KnowledgeSemanticService | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly gapIds?: readonly string[] | undefined;
  readonly sourceIds?: readonly string[] | undefined;
  readonly limit?: number | undefined;
  readonly maxRunMs?: number | undefined;
  readonly force?: boolean | undefined;
  /**
   * Run the LLM issue-triage pass over open device-quality issues. `true` uses
   * defaults; an object customizes thresholds/limits/rules. Omitted → unchanged
   * gap-refinement behavior for existing callers.
   */
  readonly triage?: HomeGraphTriageOptions | boolean | undefined;
  /** Skip the gap self-improvement pass (e.g. a triage-only run). */
  readonly skipGapRefinement?: boolean | undefined;
}): Promise<{
  readonly ok: boolean;
  readonly spaceId: string;
  readonly error?: string | undefined;
  readonly result?: Awaited<ReturnType<KnowledgeSemanticService['selfImprove']>> | undefined;
  readonly triage?: HomeGraphTriageResult | undefined;
}> {
  const signal = input.signal;
  // The refinement runner reads 0 or a negative limit as "no limit" and would
  // spend a model request on every candidate; a caller who wrote 0 meant none.
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) {
    throw new RefusalError(refusal({
      code: 'HOMEGRAPH_REFINEMENT_LIMIT', status: 400,
      state: 'nothing was refined',
      reason: `Refinement limit must be a whole number of at least 1 (got ${String(input.limit)})`,
      next: ['Send a limit of 1 or more, or omit limit to refine every candidate'],
    }), { category: 'bad_request', source: 'runtime' });
  }
  signal?.throwIfAborted();
  // Without a decision model triage lists the open issues for review and gap
  // refinement reports that it did not run; neither changes anything.
  await input.store.init();
  signal?.throwIfAborted();
  const { spaceId } = resolveReadableHomeGraphSpace(input.store, input);

  const triageRequested = input.triage !== undefined && input.triage !== false;
  const triage = triageRequested
    ? await runHomeGraphIssueTriage({
        store: input.store,
        ...(input.semanticService ? { semanticService: input.semanticService } : {}),
        // Resolved once above so triage and gap refinement act on one space.
        knowledgeSpaceId: spaceId,
        signal,
        options: typeof input.triage === 'object' ? input.triage : {},
      })
    : undefined;
  signal?.throwIfAborted();

  if (input.skipGapRefinement === true) {
    // A triage-only run that was held did nothing; do not report it as done.
    if (triage?.reason?.startsWith('triage-held-') || triage?.reason === 'triage-judgment-not-configured') {
      return { ok: false, spaceId, error: `Triage did not run: ${triage.reason}.`, triage };
    }
    return { ok: true, spaceId, ...(triage ? { triage } : {}) };
  }

  if (!input.semanticService) {
    return { ok: false, spaceId, error: 'Semantic refinement is not configured.', ...(triage ? { triage } : {}) };
  }
  const result = await input.semanticService.selfImprove({
    knowledgeSpaceId: spaceId,
    gapIds: input.gapIds,
    sourceIds: input.sourceIds,
    limit: input.limit,
    maxRunMs: input.maxRunMs,
    force: input.force,
    reason: 'manual',
    signal,
  });
  signal?.throwIfAborted();
  return { ok: true, spaceId, result, ...(triage ? { triage } : {}) };
}

export async function cancelHomeGraphRefinementTask(input: HomeGraphSpaceInput & {
  readonly store: KnowledgeStore;
  readonly taskId: string;
}) {
  await input.store.init();
  const { spaceId } = resolveReadableHomeGraphSpace(input.store, input);
  const task = input.store.getRefinementTask(input.taskId);
  if (!task || task.spaceId !== spaceId) return { ok: false, spaceId, error: 'Unknown Home Graph refinement task.' };
  if (task.state === 'cancelled') return { ok: true, spaceId, task };
  const move = knowledgeRefinementTaskLifecycle.check(task.state, 'cancelled');
  // A closed or suppressed task is already decided; the store would keep it unchanged, so say so.
  if (!move.ok) return { ok: false, spaceId, error: `${move.reason}. Nothing was changed.`, task };
  // The cancel applies only to the task as read: a reset or delete that removed it, or a run that moved it,
  // before the write wins, and the cancel writes nothing (checked with no await before the write).
  const changed = (): void => {
    if (input.store.getRefinementTask(task.id) !== task) throw new RefinementTaskChangedError(task.id);
  };
  const cancelled = await input.store.upsertRefinementTask(guardKnowledgeRefinementTaskInput({
    id: task.id,
    spaceId: task.spaceId,
    subjectKind: task.subjectKind,
    subjectId: task.subjectId,
    subjectTitle: task.subjectTitle,
    subjectType: task.subjectType,
    gapId: task.gapId,
    issueId: task.issueId,
    state: 'cancelled',
    priority: task.priority,
    trigger: task.trigger,
    budget: task.budget,
    attemptCount: task.attemptCount,
    appendTrace: [{ at: Date.now(), state: 'cancelled', message: 'Home Graph refinement task was cancelled by request.' }],
    metadata: task.metadata,
  }, changed)).catch((error: unknown) => {
    if (error instanceof RefinementTaskChangedError) return null;
    throw error;
  });
  if (cancelled === null) {
    const now = input.store.getRefinementTask(task.id);
    return now === null
      ? { ok: false, spaceId, error: 'The refinement task was removed (its space was reset or its subject deleted) while it was being cancelled. Nothing was changed.' }
      : { ok: false, spaceId, error: `The refinement task changed to ${now.state} while it was being cancelled. Nothing was changed; read it again.`, task: now };
  }
  return { ok: true, spaceId, task: cancelled };
}

/** The task a cancel read is no longer the stored one. */
class RefinementTaskChangedError extends Error {
  constructor(taskId: string) { super(`Refinement task ${taskId} changed before the cancel was written`); this.name = 'RefinementTaskChangedError'; }
}
