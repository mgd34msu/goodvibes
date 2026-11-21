import type { RuntimeServices } from './services.js';
import type { RuntimeTask } from './store/domains/tasks.js';
import type { RuntimeAgent } from './store/domains/agents.js';
import type { SessionDomainState } from './store/domains/session.js';
import type { TurnState } from './store/domains/conversation.js';
import { combineSubscriptions, createStoreBackedReadModel, listProviderIds, projectRecords, projectValues } from './ui-read-model-helpers.js';
import type { UiReadModel } from './ui-read-models-base.js';
import { deriveContextUsage } from './context-usage.js';
import { readCurrentContextWindow } from '../providers/context-window-reading.js';
import { isOpenApprovalStatus } from '../control-plane/approval-lifecycle.js';

/** How many approvals the broker holds that are pending or claimed: raised, and not yet decided, cancelled or expired. */
export function countUndecidedApprovals(broker: Pick<RuntimeServices['approvalBroker'], 'listApprovals'>): number {
  return broker.listApprovals(Number.MAX_SAFE_INTEGER)
    .filter((approval) => isOpenApprovalStatus(approval.status)).length;
}

/** The id of the oldest approval the broker holds that is pending or claimed, or undefined when none is waiting. */
export function oldestUndecidedApprovalId(broker: Pick<RuntimeServices['approvalBroker'], 'listApprovals'>): string | undefined {
  let oldest: { readonly id: string; readonly createdAt: number } | undefined;
  for (const approval of broker.listApprovals(Number.MAX_SAFE_INTEGER)) {
    if (!isOpenApprovalStatus(approval.status)) continue;
    if (!oldest || approval.createdAt < oldest.createdAt) oldest = approval;
  }
  return oldest?.id;
}

/** Fraction of the model context window at which the context-warning flag activates. */
const CONTEXT_WARNING_THRESHOLD = 0.85;

export interface UiProvidersSnapshot {
  readonly providerIds: readonly string[];
}

export interface UiSessionSnapshot {
  readonly session: SessionDomainState;
  readonly totalTurns: number;
  readonly messageCount: number;
  readonly estimatedContextTokens: number;
  readonly contextWindow: number | null;
  /** Context usage as a 0–100 percentage (null when the window is unknown). Cheap readable for a live context chip. */
  readonly contextUsagePct: number | null;
  /** Tokens remaining before the context window is full (null when unknown). */
  readonly contextRemainingTokens: number | null;
  readonly turnState: TurnState;
  readonly streamToolPreview?: string | undefined;
  readonly contextWarningActive: boolean;
  /** True while the approval broker holds an approval that is pending or claimed. */
  readonly pendingApproval: boolean;
  /** The oldest approval that is pending or claimed, so a reader can tell one waiting approval from the next. */
  readonly pendingApprovalId?: string | undefined;
  readonly denialCount: number;
}

export interface UiAgentsSnapshot {
  readonly active: readonly RuntimeAgent[];
  readonly totalSpawned: number;
  readonly totalCompleted: number;
  readonly totalFailed: number;
}

export interface UiTasksSnapshot {
  readonly tasks: readonly RuntimeTask[];
}

export interface UiCoreReadModels {
  readonly providers: UiReadModel<UiProvidersSnapshot>;
  readonly session: UiReadModel<UiSessionSnapshot>;
  readonly agents: UiReadModel<UiAgentsSnapshot>;
  readonly tasks: UiReadModel<UiTasksSnapshot>;
}

export function createCoreReadModels(
  runtimeServices: Pick<RuntimeServices, 'runtimeStore' | 'runtimeBus' | 'providerRegistry'>
    & Partial<Pick<RuntimeServices, 'approvalBroker'>>,
): UiCoreReadModels {
  const { runtimeStore } = runtimeServices;
  const approvalBroker = runtimeServices.approvalBroker;

  return {
    providers: {
      getSnapshot() {
        return {
          providerIds: listProviderIds(runtimeServices),
        };
      },
      subscribe(listener) {
        return runtimeServices.runtimeBus.on('PROVIDERS_CHANGED', listener);
      },
    },
    session: {
      getSnapshot() {
        const state = runtimeStore.getState();
        const usedTokens = state.conversation.estimatedContextTokens;
        const window = readCurrentContextWindow(runtimeServices.providerRegistry)?.knownContextWindow ?? null;
        const usage = deriveContextUsage(usedTokens, window);
        const pendingApprovalId = approvalBroker ? oldestUndecidedApprovalId(approvalBroker) : undefined;
        return {
          session: state.session,
          totalTurns: state.conversation.totalTurns,
          messageCount: state.conversation.messageCount,
          estimatedContextTokens: usedTokens,
          contextWindow: window,
          contextUsagePct: usage.contextUsagePct,
          contextRemainingTokens: usage.contextRemainingTokens,
          turnState: state.conversation.turnState,
          streamToolPreview: state.conversation.stream.partialToolPreview,
          contextWarningActive:
            window !== null && usedTokens >= window * CONTEXT_WARNING_THRESHOLD,
          // The gate reports its request only after the decision, so the
          // store flag never reads true while a prompt is open; the broker
          // holds the request for as long as it is undecided.
          pendingApproval: pendingApprovalId !== undefined,
          pendingApprovalId,
          denialCount: state.permissions.denialCount,
        };
      },
      subscribe(listener) {
        return combineSubscriptions(
          runtimeStore.subscribe(listener),
          runtimeServices.runtimeBus.onDomain('providers', listener),
          ...(approvalBroker ? [approvalBroker.subscribe(() => listener())] : []),
        );
      },
    },
    agents: createStoreBackedReadModel(runtimeServices, () => {
      const state = runtimeStore.getState().agents;
      const active = projectRecords(state.activeAgentIds, state.agents);
      return {
        active,
        totalSpawned: state.totalSpawned,
        totalCompleted: state.totalCompleted,
        totalFailed: state.totalFailed,
      };
    }),
    tasks: createStoreBackedReadModel(runtimeServices, () => {
      const tasksState = runtimeStore.getState().tasks;
      const tasks = projectValues(tasksState.tasks, (a, b) => {
        const aTime = a.startedAt ?? a.queuedAt;
        const bTime = b.startedAt ?? b.queuedAt;
        return bTime - aTime || a.title.localeCompare(b.title);
      });
      return { tasks };
    }),
  };
}
