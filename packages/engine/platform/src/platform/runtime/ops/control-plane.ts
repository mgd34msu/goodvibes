/**
 * OpsControlPlane, central dispatch point for all operator interventions.
 *
 * All task and agent control actions flow through this class. It:
 * - Validates that the requested action is legal given the current state
 * - Dispatches through the TaskManager (for task ops) or store (for agent ops)
 * - Emits typed audit events via the RuntimeEventBus for every intervention
 *
 * This is the single integration point for the /ops commands and Ctrl+O panel.
 */
import { randomUUID } from 'node:crypto';
import { GoodVibesError } from '@goodvibes-jev/engine/errors';
import type { TaskManager } from '../tasks/types.js';
import type { RuntimeEventBus } from '../events/index.js';
import type { RuntimeStore } from '../store/index.js';
import type { TaskLifecycleState } from '../store/domains/tasks.js';
import type { AgentLifecycleState } from '../store/domains/agents.js';
import { canRetry, canTransition, describeTaskMoves } from '../tasks/lifecycle.js';
import {
  emitOpsTaskCancelled,
  emitOpsTaskPaused,
  emitOpsTaskResumed,
  emitOpsTaskRetried,
  emitOpsAgentCancelled,
} from '../emitters/ops.js';
import type { OpsInterventionReason } from '../../../events/ops.js';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Thrown when an ops action is rejected because the state machine disallows it. */
export class OpsIllegalActionError extends GoodVibesError {
  declare readonly code: 'OPS_ILLEGAL_ACTION';
  public readonly targetId: string;
  public readonly action: string;
  public readonly currentState: string;

  /** @param next - What can be done from `currentState` instead, in words. */
  public constructor(targetId: string, action: string, currentState: string, next?: string) {
    super(
      `[OpsControlPlane] Action '${action}' is illegal for ${targetId} in state '${currentState}'${next ? `; ${next}` : ''}`,
      { code: 'OPS_ILLEGAL_ACTION', category: 'permission', source: 'runtime', recoverable: false },
    );
    this.name = 'OpsIllegalActionError';
    this.targetId = targetId;
    this.action = action;
    this.currentState = currentState;
  }
}

/** Thrown when an ops action cannot be carried out by this control plane at all. */
export class OpsActionUnavailableError extends GoodVibesError {
  declare readonly code: 'OPS_ACTION_UNAVAILABLE';
  public readonly targetId: string;
  public readonly action: string;

  public constructor(targetId: string, action: string, why: string) {
    super(
      `[OpsControlPlane] Action '${action}' is unavailable for ${targetId}: ${why}`,
      { code: 'OPS_ACTION_UNAVAILABLE', category: 'permission', source: 'runtime', recoverable: false },
    );
    this.name = 'OpsActionUnavailableError';
    this.targetId = targetId;
    this.action = action;
  }
}

/** What stops an agent's run: the agent manager's cancel (it publishes AGENT_CANCELLED, which updates the store). */
export interface OpsAgentCanceller {
  cancel(agentId: string, kind?: 'interrupt' | 'kill'): boolean;
}

/** Thrown when the target task or agent is not found. */
export class OpsTargetNotFoundError extends GoodVibesError {
  declare readonly code: 'OPS_TARGET_NOT_FOUND';
  public readonly targetId: string;
  public readonly targetKind: 'task' | 'agent';

  public constructor(targetId: string, targetKind: 'task' | 'agent') {
    super(
      `[OpsControlPlane] ${targetKind} not found: ${targetId}`,
      { code: 'OPS_TARGET_NOT_FOUND', category: 'not_found', source: 'runtime', recoverable: false },
    );
    this.name = 'OpsTargetNotFoundError';
    this.targetId = targetId;
    this.targetKind = targetKind;
  }
}

// ---------------------------------------------------------------------------
// OpsControlPlane
// ---------------------------------------------------------------------------

/**
 * Terminal agent lifecycle states, agents in these states cannot be cancelled.
 */
const TERMINAL_AGENT_STATES: ReadonlySet<AgentLifecycleState> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

/**
 * Agent states from which cancellation is permitted.
 */
const CANCELLABLE_AGENT_STATES: ReadonlySet<AgentLifecycleState> = new Set([
  'spawning',
  'running',
  'awaiting_message',
  'awaiting_tool',
  'finalizing',
]);

export class OpsControlPlane {
  private readonly _taskManager: TaskManager;
  private readonly _bus: RuntimeEventBus;
  private readonly _store: RuntimeStore;
  private readonly _sessionId: string;
  private readonly _agentCanceller: OpsAgentCanceller | undefined;

  public constructor(
    taskManager: TaskManager,
    bus: RuntimeEventBus,
    store: RuntimeStore,
    sessionId: string,
    agentCanceller?: OpsAgentCanceller,
  ) {
    this._taskManager = taskManager;
    this._bus = bus;
    this._store = store;
    this._sessionId = sessionId;
    this._agentCanceller = agentCanceller;
  }

  // ── Task actions ──────────────────────────────────────────────────────────

  /**
   * Cancel a task. Only legal from states that allow → cancelled transition.
   *
   * @param taskId - Target task ID.
   * @param note - Optional operator note for the audit log.
   * @throws {OpsTargetNotFoundError} if the task doesn't exist.
   * @throws {OpsIllegalActionError} if the task is in a terminal state.
   */
  public cancelTask(taskId: string, note?: string): void | Promise<void> {
    const task = this._taskManager.getTask(taskId);
    if (!task) {
      throw new OpsTargetNotFoundError(taskId, 'task');
    }

    if (!task.cancellable || !canTransition(task.status, 'cancelled')) {
      const err = new OpsIllegalActionError(taskId, 'cancel', task.status, describeTaskMoves(task.status));
      emitOpsTaskCancelled(this._bus, this._makeCtx(taskId), {
        taskId,
        reason: 'ops_cancel',
        note,
        outcome: 'rejected',
        errorMessage: err.message,
      });
      throw err;
    }

    this._audited(
      () => this._taskManager.cancelTask(taskId, { reason: note ?? 'operator-cancel' }),
      (errorMessage) => emitOpsTaskCancelled(this._bus, this._makeCtx(taskId), {
        taskId, reason: 'ops_cancel', note, outcome: 'error', errorMessage,
      }),
    );

    return this._afterOwner(taskId, (errorMessage) => emitOpsTaskCancelled(this._bus, this._makeCtx(taskId), errorMessage === undefined
      ? { taskId, reason: 'ops_cancel', note, outcome: 'success' }
      : { taskId, reason: 'ops_cancel', note, outcome: 'error', errorMessage }));
  }

  /**
   * Pause a running task (transitions running → blocked).
   *
   * Only legal from the 'running' state.
   *
   * @param taskId - Target task ID.
   * @param note - Optional operator note for the audit log.
   * @throws {OpsTargetNotFoundError} if the task doesn't exist.
   * @throws {OpsIllegalActionError} if the task is not running.
   */
  public pauseTask(taskId: string, note?: string): void | Promise<void> {
    const task = this._taskManager.getTask(taskId);
    if (!task) {
      throw new OpsTargetNotFoundError(taskId, 'task');
    }

    if (!canTransition(task.status, 'blocked')) {
      const err = new OpsIllegalActionError(taskId, 'pause', task.status, describeTaskMoves(task.status));
      emitOpsTaskPaused(this._bus, this._makeCtx(taskId), {
        taskId,
        reason: 'ops_pause',
        note,
        outcome: 'rejected',
        errorMessage: err.message,
      });
      throw err;
    }

    this._audited(
      () => this._taskManager.blockTask(taskId, note ?? 'operator-pause'),
      (errorMessage) => emitOpsTaskPaused(this._bus, this._makeCtx(taskId), {
        taskId, reason: 'ops_pause', note, outcome: 'error', errorMessage,
      }),
    );

    return this._afterOwner(taskId, (errorMessage) => emitOpsTaskPaused(this._bus, this._makeCtx(taskId), errorMessage === undefined
      ? { taskId, reason: 'ops_pause', note, outcome: 'success' }
      : { taskId, reason: 'ops_pause', note, outcome: 'error', errorMessage }));
  }

  /**
   * Resume a blocked task (transitions blocked → running).
   *
   * Only legal from the 'blocked' state.
   *
   * @param taskId - Target task ID.
   * @param note - Optional operator note for the audit log.
   * @throws {OpsTargetNotFoundError} if the task doesn't exist.
   * @throws {OpsIllegalActionError} if the task is not blocked.
   */
  public resumeTask(taskId: string, note?: string): void | Promise<void> {
    const task = this._taskManager.getTask(taskId);
    if (!task) {
      throw new OpsTargetNotFoundError(taskId, 'task');
    }

    if (task.status !== 'blocked' || !canTransition(task.status, 'running')) {
      const err = new OpsIllegalActionError(taskId, 'resume', task.status, describeTaskMoves(task.status));
      emitOpsTaskResumed(this._bus, this._makeCtx(taskId), {
        taskId,
        reason: 'ops_resume',
        note,
        outcome: 'rejected',
        errorMessage: err.message,
      });
      throw err;
    }

    this._audited(
      () => this._taskManager.resumeTask(taskId),
      (errorMessage) => emitOpsTaskResumed(this._bus, this._makeCtx(taskId), {
        taskId, reason: 'ops_resume', note, outcome: 'error', errorMessage,
      }),
    );

    return this._afterOwner(taskId, (errorMessage) => emitOpsTaskResumed(this._bus, this._makeCtx(taskId), errorMessage === undefined
      ? { taskId, reason: 'ops_resume', note, outcome: 'success' }
      : { taskId, reason: 'ops_resume', note, outcome: 'error', errorMessage }));
  }

  /**
   * Retry a failed task (transitions failed → queued by re-creating as queued).
   *
   * Re-queues the task via TaskManager, which clears terminal-state fields
   * and transitions it back to 'queued'.
   * This is only permitted from 'failed' or 'cancelled' states.
   *
   * @param taskId - Target task ID.
   * @param note - Optional operator note for the audit log.
   * @throws {OpsTargetNotFoundError} if the task doesn't exist.
   * @throws {OpsIllegalActionError} if the task is not in a retryable state.
   */
  public retryTask(taskId: string, note?: string): void | Promise<void> {
    const task = this._taskManager.getTask(taskId);
    if (!task) {
      throw new OpsTargetNotFoundError(taskId, 'task');
    }

    if (!canRetry(task.status)) {
      const err = new OpsIllegalActionError(taskId, 'retry', task.status, describeTaskMoves(task.status));
      emitOpsTaskRetried(this._bus, this._makeCtx(taskId), {
        taskId,
        reason: 'ops_retry',
        note,
        outcome: 'rejected',
        errorMessage: err.message,
      });
      throw err;
    }

    // Route retry through TaskManager for consistent state management and event emission.
    this._audited(
      () => this._taskManager.retryTask(taskId),
      (errorMessage) => emitOpsTaskRetried(this._bus, this._makeCtx(taskId), {
        taskId, reason: 'ops_retry', note, outcome: 'error', errorMessage,
      }),
    );

    return this._afterOwner(taskId, (errorMessage) => emitOpsTaskRetried(this._bus, this._makeCtx(taskId), errorMessage === undefined
      ? { taskId, reason: 'ops_retry', note, outcome: 'success' }
      : { taskId, reason: 'ops_retry', note, outcome: 'error', errorMessage }));
  }

  // ── Agent actions ─────────────────────────────────────────────────────────

  /**
   * Cancel a running agent.
   *
   * Only legal for agents in non-terminal states (spawning, running,
   * awaiting_message, awaiting_tool, finalizing). The cancel goes to the agent
   * manager, which stops the run and publishes AGENT_CANCELLED; that event,
   * not this method, moves the store record, so the store never reads
   * cancelled for an agent that is still working.
   *
   * @param agentId - Target agent ID.
   * @param note - Optional operator note for the audit log.
   * @throws {OpsTargetNotFoundError} if the agent doesn't exist.
   * @throws {OpsIllegalActionError} if the agent is already in a terminal state.
   * @throws {OpsActionUnavailableError} if no agent manager is wired, or it does not run this agent.
   */
  public cancelAgent(agentId: string, note?: string): void {
    const state = this._store.getState();
    const agent = state.agents.agents.get(agentId);

    if (!agent) {
      throw new OpsTargetNotFoundError(agentId, 'agent');
    }

    if (!CANCELLABLE_AGENT_STATES.has(agent.status)) {
      const err = new OpsIllegalActionError(agentId, 'cancel', agent.status);
      emitOpsAgentCancelled(this._bus, this._makeCtx(undefined, agentId), {
        agentId,
        reason: 'ops_agent_cancel',
        note,
        outcome: 'rejected',
        errorMessage: err.message,
      });
      throw err;
    }

    const refuse = (why: string): never => {
      const err = new OpsActionUnavailableError(agentId, 'cancel', why);
      emitOpsAgentCancelled(this._bus, this._makeCtx(undefined, agentId), {
        agentId,
        reason: 'ops_agent_cancel',
        note,
        outcome: 'rejected',
        errorMessage: err.message,
      });
      throw err;
    };
    if (this._agentCanceller === undefined) {
      refuse(`no agent manager is connected to this control plane, so nothing can stop the run; the agent is still ${agent.status}`);
    }
    const canceller = this._agentCanceller;
    const cancelled = this._audited(
      () => canceller?.cancel(agentId, 'kill'),
      (errorMessage) => emitOpsAgentCancelled(this._bus, this._makeCtx(undefined, agentId), {
        agentId, reason: 'ops_agent_cancel', note, outcome: 'error', errorMessage,
      }),
    );
    if (cancelled === false) {
      refuse(`the agent manager does not run this agent; it is ${agent.status} in the runtime store only`);
    }

    emitOpsAgentCancelled(this._bus, this._makeCtx(undefined, agentId), {
      agentId,
      reason: 'ops_agent_cancel',
      note,
      outcome: 'success',
    });
  }

  // ── Query helpers ─────────────────────────────────────────────────────────

  /**
   * Returns whether a task action is currently legal given its state.
   * Used by the UI to conditionally render action controls.
   */
  public canCancelTask(taskId: string): boolean {
    const task = this._taskManager.getTask(taskId);
    return task != null && task.cancellable && canTransition(task.status, 'cancelled');
  }

  public canPauseTask(taskId: string): boolean {
    const task = this._taskManager.getTask(taskId);
    return task != null && canTransition(task.status, 'blocked');
  }

  public canResumeTask(taskId: string): boolean {
    const task = this._taskManager.getTask(taskId);
    return task != null && task.status === 'blocked' && canTransition(task.status, 'running');
  }

  public canRetryTask(taskId: string): boolean {
    const task = this._taskManager.getTask(taskId);
    if (!task) return false;
    return task.status === 'failed' || task.status === 'cancelled';
  }

  public canCancelAgent(agentId: string): boolean {
    const state = this._store.getState();
    const agent = state.agents.agents.get(agentId);
    return agent != null && CANCELLABLE_AGENT_STATES.has(agent.status);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Report a task verb's outcome once its owner acted: at once when the owner
   * acted synchronously, when its promise settles when it acts asynchronously
   * (the returned promise rejects with the owner's error).
   */
  private _afterOwner(taskId: string, report: (errorMessage?: string) => void): void | Promise<void> {
    const acting = this._taskManager.whenOwnerActed?.(taskId);
    if (!acting) {
      report();
      return;
    }
    return acting.then(() => report(), (error: unknown) => {
      report(error instanceof Error ? error.message : String(error));
      throw error;
    });
  }

  /** Runs a mutation; if it throws, records the failure in the audit log and rethrows. */
  private _audited<T>(run: () => T, recordFailure: (errorMessage: string) => void): T {
    try {
      return run();
    } catch (error) {
      recordFailure(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private _makeCtx(taskId?: string, agentId?: string) {
    return {
      sessionId: this._sessionId,
      source: 'ops-control-plane',
      traceId: randomUUID(),
      ...(taskId !== undefined ? { taskId } : {}),
      ...(agentId !== undefined ? { agentId } : {}),
    };
  }
}
