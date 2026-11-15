import { knowledgeRawRepresentation } from '../store-record-representation.js';
import { upsertObservedKnowledgeNode } from '../store-node-observation.js';
import { getKnowledgeSpaceId } from '../spaces.js';
import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeRefinementTaskRecord,
  KnowledgeRefinementTaskState,
} from '../types.js';
import { readString } from './utils.js';
import { ACTIVE_REFINEMENT_STATES, STALE_ACTIVE_TASK_MS } from '../types.js';

/** Task metadata kind and gap `repairStatus` of work blocked for want of a repairer. */
export const NO_REPAIRER_BLOCK = 'no_repairer';
export const NO_REPAIRER_REASON = 'No semantic gap repairer is configured.';

function isNoRepairerBlock(task: KnowledgeRefinementTaskRecord): boolean {
  // Older tasks carry only the wording, so it still matches.
  return task.metadata.blockedKind === NO_REPAIRER_BLOCK || task.blockedReason === NO_REPAIRER_REASON;
}

export async function recoverStaleActiveTasks(store: KnowledgeStore, spaceId: string,
  inFlight: (task: KnowledgeRefinementTaskRecord) => boolean = () => false, now: number = Date.now()): Promise<void> {
  const staleTasks = store.listRefinementTasks(10_000, { spaceId })
    .filter((task) => ACTIVE_REFINEMENT_STATES.has(task.state))
    .filter((task) => now - task.updatedAt >= STALE_ACTIVE_TASK_MS)
    .filter((task) => !inFlight(task));
  await store.batch(async () => {
    for (const listed of staleTasks) {
      // The list is a snapshot: an owner that wrote the task since is not stale.
      const task = store.getRefinementTask(listed.id);
      if (!task || !ACTIVE_REFINEMENT_STATES.has(task.state) || now - task.updatedAt < STALE_ACTIVE_TASK_MS || inFlight(task)) continue;
      await upsertRecoveredTask(
        store,
        task,
        'blocked',
        'Refinement task was interrupted or exceeded the active window; it can be retried.',
        { recoveredFrom: 'stale_active' },
      );
    }
  });
}

export async function recoverNoRepairerTasks(store: KnowledgeStore, spaceId: string): Promise<void> {
  const tasks = store.listRefinementTasks(10_000, { spaceId })
    .filter((task) => task.state === 'blocked')
    .filter(isNoRepairerBlock);
  for (const listed of tasks) {
    await store.batch(async () => {
      const task = store.getRefinementTask(listed.id);
      if (!task || task.state !== 'blocked' || !isNoRepairerBlock(task)) return;
      if (task.gapId) {
        const gap = store.getNode(task.gapId);
        if (gap && getKnowledgeSpaceId(gap) === spaceId && readString(gap.metadata.repairStatus) === NO_REPAIRER_BLOCK) {
          await upsertObservedKnowledgeNode(store, {
            id: gap.id,
            kind: gap.kind,
            slug: gap.slug,
            title: gap.title,
            summary: gap.summary,
            aliases: gap.aliases,
            status: gap.status,
            confidence: gap.confidence,
            sourceId: gap.sourceId,
            metadata: {
              ...knowledgeRawRepresentation(gap.metadata),
              repairStatus: 'open',
              repairReason: 'Semantic gap repairer is now configured; retry is allowed.',
              nextRepairAttemptAt: undefined,
              knowledgeSpaceId: spaceId,
            },
          }, 'research-task', gap, () => store.getNode(gap.id));
        }
      }
      await upsertRecoveredTask(
        store,
        task,
        'detected',
        'Semantic gap repairer is now configured; task can be retried.',
        { recoveredFrom: NO_REPAIRER_BLOCK },
        { repairStatus: 'open', recoveredFrom: NO_REPAIRER_BLOCK, recoveredAt: Date.now(), blockedKind: null },
      );
    });
  }
}

async function upsertRecoveredTask(
  store: KnowledgeStore,
  task: KnowledgeRefinementTaskRecord,
  state: KnowledgeRefinementTaskState,
  message: string,
  data: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await store.upsertRefinementTask({
    id: task.id,
    spaceId: task.spaceId,
    subjectKind: task.subjectKind,
    subjectId: task.subjectId,
    subjectTitle: task.subjectTitle,
    subjectType: task.subjectType,
    gapId: task.gapId,
    issueId: task.issueId,
    state,
    priority: task.priority,
    trigger: task.trigger,
    budget: task.budget,
    attemptCount: task.attemptCount,
    ...(state === 'blocked' ? { blockedReason: message } : {}),
    appendTrace: [{ at: Date.now(), state, message, data }],
    metadata: { ...task.metadata, ...metadata },
  });
}
