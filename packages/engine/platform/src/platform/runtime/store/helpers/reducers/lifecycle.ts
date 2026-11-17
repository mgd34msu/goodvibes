import type { CompactionEvent, GateEvent, AgentEvent } from '../events.js';
import type { SessionDomainState } from '../../domains/session.js';
import type {
  PermissionDomainState,
  PermissionDecision,
} from '../../domains/permissions.js';
import {
  isPermissionCategory,
  isPermissionDecisionReasonCode,
  isPermissionDecisionSource,
  isPermissionRiskLevel,
} from '../../../../permissions/types.js';
import type { TaskDomainState, RuntimeTask, TaskLifecycleState } from '../../domains/tasks.js';
import type { AgentDomainState, RuntimeAgent, AgentLifecycleState } from '../../domains/agents.js';
import { now, updateDomainMetadata, isTerminalLifecycleState, computeActiveIds, evictOldestEnded } from './shared.js';
import { logger } from '../../../../utils/logger.js';
import { canMirror } from '../../../tasks/lifecycle.js';

export function updateSessionState(
  domain: SessionDomainState,
  event: CompactionEvent,
): SessionDomainState {
  const base = updateDomainMetadata(domain, event.type);
  switch (event.type) {
    case 'COMPACTION_CHECK':
      // The manager answers a below-threshold auto check with done -> idle and
      // emits nothing further, so a check under the threshold must not leave the
      // mirror reading "running". A manual or prompt-too-long run under the
      // threshold goes on to emit its strategy event straight away.
      return { ...base, compactionState: event.tokenCount < event.threshold ? 'idle' : 'checking_threshold' };
    case 'COMPACTION_MICROCOMPACT':
      return { ...base, compactionState: 'microcompact' };
    case 'COMPACTION_COLLAPSE':
      return { ...base, compactionState: 'collapse', compactionMessageCount: event.messageCount };
    case 'COMPACTION_AUTOCOMPACT':
      return { ...base, compactionState: 'autocompact' };
    case 'COMPACTION_REACTIVE':
      return { ...base, compactionState: 'reactive_compact' };
    case 'COMPACTION_BOUNDARY_COMMIT':
      return { ...base, compactionState: 'boundary_commit' };
    case 'COMPACTION_DONE':
      // The manager moves done -> idle in the same breath; the mirror settles
      // with it. `failed` is deliberately NOT settled: it stays until the next
      // compaction begins, which is how session-maintenance reports the failure.
      return { ...base, compactionState: 'idle', lastCompactedAt: now(), compactionError: undefined };
    case 'COMPACTION_FAILED':
      return { ...base, compactionState: 'failed', compactionError: event.error };
    case 'COMPACTION_RECEIPT':
      // Record the completed compaction only when the compacted context was
      // actually applied; a kept-original/failed receipt leaves the
      // conversation (and compaction state) untouched.
      return event.outcome === 'applied'
        ? { ...base, compactionState: 'idle', lastCompactedAt: now(), compactionError: undefined }
        : base;
  }
}

/**
 * The decision of one call. The bridge forwards only DECISION_EMITTED: the
 * gate's intermediate steps carry nothing a reader uses, and the execution
 * mode is read from the configuration by whoever shows it.
 */
export function updatePermissionState(
  domain: PermissionDomainState,
  event: GateEvent,
): PermissionDomainState {
  if (event.type !== 'DECISION_EMITTED') return domain;
  return {
    ...updateDomainMetadata(domain, event.type),
    approvalCount: domain.approvalCount + (event.approved ? 1 : 0),
    denialCount: domain.denialCount + (event.approved ? 0 : 1),
    promptCount: domain.promptCount + ((event.sourceLayer ?? event.source) === 'user_prompt' ? 1 : 0),
    totalChecks: domain.totalChecks + 1,
    lastDecision: decisionRecord(event),
  };
}

/**
 * The record of a decision event, read through the gate's own lists. An event
 * whose category, layer or reason this runtime does not know (a newer peer)
 * clears the last decision rather than reporting it under a wrong name.
 */
function decisionRecord(event: Extract<GateEvent, { type: 'DECISION_EMITTED' }>): PermissionDecision | undefined {
  const reason = event.reasonCode === undefined ? (event.approved ? 'user_approved' : 'user_denied') : event.reasonCode;
  const sourceLayer = event.sourceLayer ?? event.source;
  if (!isPermissionCategory(event.category) || !isPermissionDecisionReasonCode(reason) || !isPermissionDecisionSource(sourceLayer)) return undefined;
  return {
    callId: event.callId,
    toolName: event.tool,
    category: event.category,
    machineState: 'decision_emitted',
    outcome: event.approved ? 'approved' : 'denied',
    reason,
    sourceLayer,
    persisted: event.persisted ?? false,
    ...(event.classification !== undefined ? { classification: event.classification } : {}),
    ...(isPermissionRiskLevel(event.riskLevel) ? { riskLevel: event.riskLevel } : {}),
    ...(event.summary !== undefined ? { summary: event.summary } : {}),
    decidedAt: now(),
  };
}

function updateTaskIndexes(tasks: Map<string, RuntimeTask>) {
  const queuedIds: string[] = [];
  const runningIds: string[] = [];
  const blockedIds: string[] = [];
  for (const [taskId, task] of tasks.entries()) {
    if (task.status === 'queued') queuedIds.push(taskId);
    if (task.status === 'running') runningIds.push(taskId);
    if (task.status === 'blocked') blockedIds.push(taskId);
  }
  return { queuedIds, runningIds, blockedIds };
}

function isTerminalTaskStatus(status: TaskLifecycleState): boolean {
  return isTerminalLifecycleState(status);
}

function countTaskTransition(
  domain: TaskDomainState,
  previous: RuntimeTask | undefined,
  task: RuntimeTask,
): Pick<TaskDomainState, 'totalCreated' | 'totalCompleted' | 'totalFailed' | 'totalCancelled'> {
  let { totalCreated, totalCompleted, totalFailed, totalCancelled } = domain;
  if (!previous) totalCreated += 1;
  if (previous?.status !== task.status) {
    if (task.status === 'completed') totalCompleted += 1;
    else if (task.status === 'failed') totalFailed += 1;
    else if (task.status === 'cancelled') totalCancelled += 1;
  }
  return { totalCreated, totalCompleted, totalFailed, totalCancelled };
}

function updateTaskDomainFromRecord(domain: TaskDomainState, task: RuntimeTask, source: string): TaskDomainState {
  const tasks = new Map(domain.tasks);
  const previous = tasks.get(task.id);
  tasks.set(task.id, task);
  evictOldestEnded(tasks, (record) => isTerminalTaskStatus(record.status), (record) => record.endedAt ?? record.queuedAt);
  const indexes = updateTaskIndexes(tasks);
  const counts = countTaskTransition(domain, previous, task);

  return { ...updateDomainMetadata(domain, source), tasks, ...indexes, ...counts };
}

function transitionTaskDomainRecord(
  domain: TaskDomainState,
  taskId: string,
  status: TaskLifecycleState,
  patch: Partial<RuntimeTask> | undefined,
  source: string,
): TaskDomainState {
  const existing = domain.tasks.get(taskId);
  if (!existing) return domain;
  if (!canMirror(existing.status, status)) {
    // A refused move is logged and leaves the store as it was; it never throws.
    logger.warn('[task-store] illegal task transition refused', { taskId, from: existing.status, to: status, source });
    return domain;
  }
  return updateTaskDomainFromRecord(domain, { ...existing, ...patch, status }, source);
}

function agentStatusForEvent(event: AgentEvent, existing?: AgentLifecycleState): AgentLifecycleState {
  switch (event.type) {
    case 'AGENT_SPAWNING':
      return 'spawning';
    case 'AGENT_RUNNING':
      return 'running';
    case 'AGENT_PROGRESS':
    case 'AGENT_STREAM_DELTA':
      // Output and progress carry data, not a state change: they must not clear
      // a wait the agent is in (`awaiting_tool`, `awaiting_message`,
      // `finalizing`); only an explicit event moves it out of one.
      return existing === 'awaiting_tool' || existing === 'awaiting_message' || existing === 'finalizing'
        ? existing
        : 'running';
    case 'AGENT_AWAITING_MESSAGE':
      return 'awaiting_message';
    case 'AGENT_AWAITING_TOOL':
      return 'awaiting_tool';
    case 'AGENT_COMPLETED':
      return 'completed';
    case 'AGENT_FAILED':
      return 'failed';
    case 'AGENT_CANCELLED':
      return 'cancelled';
  }
  return assertNeverAgentEvent(event);
}

function assertNeverAgentEvent(event: never): never {
  throw new Error(`Unhandled agent event type: ${String((event as { type?: unknown }).type)}`);
}

function isTerminalAgentStatus(status: AgentLifecycleState): boolean {
  return isTerminalLifecycleState(status);
}

function isContractOwnerRevivalEvent(event: AgentEvent): boolean {
  return (
    (event.type === 'AGENT_RUNNING' || event.type === 'AGENT_PROGRESS')
    && event.contractRole === 'owner'
    && typeof event.contractId === 'string'
    && event.contractId.length > 0
  );
}

/**
 * A failed or completed run that its manager woke again (a steer or a contract
 * nudge): only its AGENT_RUNNING carrying the wake marker revives it. Any other
 * late event for a finished run, and anything for a cancelled one, stays dropped.
 */
function isWakeRevivalEvent(status: AgentLifecycleState, event: AgentEvent): boolean {
  return (status === 'failed' || status === 'completed')
    && event.type === 'AGENT_RUNNING' && event.wake === true;
}

function applyAgentDomainAggregates(
  domain: AgentDomainState,
  agents: Map<string, RuntimeAgent>,
  prevStatus: AgentLifecycleState | undefined,
  nextStatus: AgentLifecycleState,
  completedCorrection: number,
  failedCorrection: number,
): Pick<AgentDomainState, 'activeAgentIds' | 'totalCompleted' | 'totalFailed' | 'peakConcurrency'> {
  const activeAgentIds = computeActiveIds(agents);
  return {
    activeAgentIds,
    totalCompleted: Math.max(
      0,
      domain.totalCompleted + completedCorrection + (prevStatus !== 'completed' && nextStatus === 'completed' ? 1 : 0),
    ),
    totalFailed: Math.max(
      0,
      domain.totalFailed + failedCorrection + (prevStatus !== 'failed' && nextStatus === 'failed' ? 1 : 0),
    ),
    peakConcurrency: Math.max(domain.peakConcurrency, activeAgentIds.length),
  };
}

export function updateAgentState(domain: AgentDomainState, event: AgentEvent): AgentDomainState {
  const agents = new Map(domain.agents);
  const timestamp = now();
  const existing = agents.get(event.agentId);
  if (!existing && event.type !== 'AGENT_SPAWNING') return domain;

  const nextStatus = agentStatusForEvent(event, existing?.status);
  // A cancelled run stays cancelled: an owner's late progress or running event
  // does not bring it back, only a failed or completed one is revived.
  const revived = Boolean(existing && isTerminalAgentStatus(existing.status)
    && ((existing.status !== 'cancelled' && isContractOwnerRevivalEvent(event)) || isWakeRevivalEvent(existing.status, event)));
  // A finished run keeps its first outcome: a late or repeated event, including
  // a second terminal event of the same kind, must not rewrite `endedAt`/`result`.
  if (existing && isTerminalAgentStatus(existing.status) && !revived) {
    return domain;
  }

  const agent: RuntimeAgent =
    existing ??
    {
      id: event.agentId,
      label: 'task' in event ? event.task : event.agentId,
      status: nextStatus,
      taskId: event.taskId,
      toolCallCount: 0,
      latestOutput: '',
      spawnedAt: timestamp,
    };
  agents.set(event.agentId, {
    ...agent,
    status: nextStatus,
    parentAgentId: 'parentAgentId' in event ? event.parentAgentId ?? agent.parentAgentId : agent.parentAgentId,
    contractRef: 'contractId' in event && event.contractId
      ? {
          contractId: event.contractId,
          contractRole: event.contractRole ?? agent.contractRef?.contractRole ?? 'unit',
          contractUnitId: event.contractUnitId ?? agent.contractRef?.contractUnitId,
        }
      : agent.contractRef,
    taskId: event.taskId ?? agent.taskId,
    latestProgress:
      event.type === 'AGENT_PROGRESS'
        ? event.progress
        : event.type === 'AGENT_AWAITING_TOOL'
          ? `${event.tool}:${event.callId}`
          : agent.latestProgress,
    latestOutput:
      event.type === 'AGENT_STREAM_DELTA'
        ? event.accumulated
        : event.type === 'AGENT_COMPLETED' && event.output !== undefined
          ? event.output
          : agent.latestOutput,
    endedAt:
      event.type === 'AGENT_COMPLETED' || event.type === 'AGENT_FAILED' || event.type === 'AGENT_CANCELLED'
        ? timestamp
        : revived
          ? undefined
          : agent.endedAt,
    error: event.type === 'AGENT_FAILED' ? event.error : revived ? undefined : agent.error,
    toolCallCount:
      event.type === 'AGENT_COMPLETED' && event.toolCallsMade !== undefined
        ? event.toolCallsMade
        : agent.toolCallCount,
    usage:
      event.type === 'AGENT_COMPLETED' && event.usage !== undefined
        ? event.usage
        : agent.usage,
    result:
      event.type === 'AGENT_COMPLETED'
        ? {
            durationMs: event.durationMs,
            ...(event.output !== undefined ? { output: event.output } : {}),
            ...(event.toolCallsMade !== undefined ? { toolCallsMade: event.toolCallsMade } : {}),
          }
        : revived ? undefined : agent.result,
  });
  evictOldestEnded(agents, (record) => isTerminalAgentStatus(record.status), (record) => record.endedAt ?? record.spawnedAt);
  const completedCorrection = revived && existing?.status === 'completed' ? -1 : 0;
  const failedCorrection = revived && existing?.status === 'failed' ? -1 : 0;
  return {
    ...updateDomainMetadata(domain, event.type),
    agents,
    totalSpawned: domain.totalSpawned + (!existing && event.type === 'AGENT_SPAWNING' ? 1 : 0),
    ...applyAgentDomainAggregates(domain, agents, existing?.status, nextStatus, completedCorrection, failedCorrection),
  };
}

export { updateTaskDomainFromRecord, transitionTaskDomainRecord };
