/**
 * UnifiedTaskManager, central task lifecycle management for all subsystem
 * task kinds (exec, agent, acp, scheduler, daemon, mcp, plugin, integration).
 *
 * Responsibilities:
 * - Create tasks with type-safe params
 * - Enforce lifecycle state machine transitions
 * - Track parent/child relationships
 * - Emit TaskEvents via RuntimeEventBus at each transition
 * - Update RuntimeState.tasks domain via Zustand store
 * - Track per-kind concurrency
 * - Route operator verbs (cancel, pause, resume, retry) to the task's owner
 *
 * A task row mirrors work owned elsewhere (an agent, an ACP subagent, a
 * caller of the ops API). A verb changes the row only after the owner acted
 * on it; a verb the owner does not implement is refused with that reason.
 */

import { GoodVibesError } from '@goodvibes-jev/engine/errors';
import { createDomainDispatch } from '../store/index.js';
import type { RuntimeStore, DomainDispatch } from '../store/index.js';
import type { RuntimeEventBus } from '../events/index.js';
import type { RuntimeTask, TaskKind, TaskLifecycleState } from '../store/domains/tasks.js';
import type { EmitterContext } from '../emitters/index.js';
import type {
  TaskManager,
  TaskCreateParams,
  TaskUpdateParams,
  TaskCancelParams,
  TaskFailParams,
} from './types.js';
import { canRetry, canTransition, describeTaskMoves } from './lifecycle.js';
import {
  emitTaskCreated,
  emitTaskStarted,
  emitTaskBlocked,
  emitTaskCompleted,
  emitTaskFailed,
  emitTaskCancelled,
} from '../emitters/tasks.js';
import type { FeatureFlagReader } from '../feature-flags/index.js';
import { isFeatureGateEnabled, requireFeatureGate } from '../feature-flags/index.js';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Thrown when a requested task lifecycle transition is not permitted. */
export class TaskTransitionError extends GoodVibesError {
  declare readonly code: 'TASK_TRANSITION_ERROR';
  public readonly taskId: string;
  public readonly from: TaskLifecycleState;
  public readonly to: TaskLifecycleState;

  public constructor(
    taskId: string,
    from: TaskLifecycleState,
    to: TaskLifecycleState
  ) {
    super(
      `[TaskManager] Task ${taskId} is ${from} and cannot become ${to}; ${describeTaskMoves(from)}.`,
      { code: 'TASK_TRANSITION_ERROR', category: 'bad_request', source: 'runtime', recoverable: false },
    );
    this.name = 'TaskTransitionError';
    this.taskId = taskId;
    this.from = from;
    this.to = to;
  }
}

/** Thrown when a task ID cannot be found in the registry. */
export class TaskNotFoundError extends GoodVibesError {
  declare readonly code: 'TASK_NOT_FOUND';
  public readonly taskId: string;

  public constructor(taskId: string) {
    super(
      `[TaskManager] Task not found: ${taskId}`,
      { code: 'TASK_NOT_FOUND', category: 'not_found', source: 'runtime', recoverable: false },
    );
    this.name = 'TaskNotFoundError';
    this.taskId = taskId;
  }
}

/** Thrown when cancellation is attempted on a non-cancellable task. */
export class TaskNotCancellableError extends GoodVibesError {
  declare readonly code: 'TASK_NOT_CANCELLABLE';
  public readonly taskId: string;

  public constructor(taskId: string) {
    super(
      `[TaskManager] Task ${taskId} is not cancellable`,
      { code: 'TASK_NOT_CANCELLABLE', category: 'internal', source: 'runtime', recoverable: false },
    );
    this.name = 'TaskNotCancellableError';
    this.taskId = taskId;
  }
}

/** The operator verbs a task's owner may implement. */
export type TaskVerb = 'cancel' | 'pause' | 'resume' | 'retry';

/**
 * What the owner of a task's work can do to it. Only the verbs the owner
 * implements are present; the manager refuses the others.
 */
export interface TaskController {
  cancel?(reason?: string): void | Promise<void>;
  pause?(): void | Promise<void>;
  resume?(): void | Promise<void>;
  retry?(): void | Promise<void>;
}

/** Finds the controller for a task from what the row records (its kind and owner). */
export type TaskControllerResolver = (task: RuntimeTask) => TaskController | undefined;

/**
 * A task recorded through this manager's createTask has no runner behind it:
 * the row is the whole record and the operator drives it, so every verb is
 * bookkeeping on the row.
 */
const RECORD_ONLY_CONTROLLER: TaskController = {
  cancel: () => undefined,
  pause: () => undefined,
  resume: () => undefined,
  retry: () => undefined,
};

/** Thrown when a verb is asked of a task whose owner does not implement it. */
export class TaskVerbUnsupportedError extends GoodVibesError {
  declare readonly code: 'TASK_VERB_UNSUPPORTED';
  public readonly taskId: string;
  public readonly verb: TaskVerb;

  public constructor(task: RuntimeTask, verb: TaskVerb) {
    super(
      `[TaskManager] Task ${task.id} (${task.kind}, owned by ${task.owner}) was not ${verb === 'retry' ? 'retried' : `${verb === 'pause' ? 'paused' : verb === 'resume' ? 'resumed' : 'cancelled'}`}: `
        + `its owner does not support ${verb} from here, so the task is unchanged. Act on it where it runs (its owner, ${task.owner}).`,
      { code: 'TASK_VERB_UNSUPPORTED', category: 'bad_request', source: 'runtime', recoverable: false },
    );
    this.name = 'TaskVerbUnsupportedError';
    this.taskId = task.id;
    this.verb = verb;
  }
}

// ---------------------------------------------------------------------------
// UnifiedTaskManager
// ---------------------------------------------------------------------------

/**
 * UnifiedTaskManager, implements TaskManager over the runtime store (the one
 * copy of every task) and the RuntimeEventBus for event emission.
 */
export class UnifiedTaskManager implements TaskManager {
  private readonly _store: RuntimeStore;
  private readonly _dispatch: DomainDispatch;
  private readonly _bus: RuntimeEventBus;
  /** Session ID for emitter context. */
  private readonly _sessionId: string;
  private readonly _featureFlags: FeatureFlagReader;
  private readonly _controllers: TaskControllerResolver;
  /** Ids of the tasks createTask recorded; see RECORD_ONLY_CONTROLLER. */
  private readonly _recordOnly = new Set<string>();

  /**
   * @param store - The Zustand runtime store to dispatch state updates to.
   * @param bus - The RuntimeEventBus to emit task lifecycle events on.
   * @param sessionId - The current session identifier for emitter context.
   * @param controllers - Finds the owner's controller for a task; without one every verb is refused.
   */
  public constructor(
    store: RuntimeStore,
    bus: RuntimeEventBus,
    sessionId: string,
    featureFlags?: FeatureFlagReader,
    controllers?: TaskControllerResolver,
  ) {
    this._store = store;
    this._dispatch = createDomainDispatch(store);
    this._bus = bus;
    this._sessionId = sessionId;
    this._featureFlags = featureFlags ?? null;
    this._controllers = controllers ?? (() => undefined);
  }

  /** The owner's implementation of `verb` for `task`, or a refusal naming why the row is unchanged. */
  private _requireVerb<V extends TaskVerb>(task: RuntimeTask, verb: V): NonNullable<TaskController[V]> {
    const controller = this._controllers(task) ?? (this._recordOnly.has(task.id) ? RECORD_ONLY_CONTROLLER : undefined);
    const action = controller?.[verb];
    if (!action) throw new TaskVerbUnsupportedError(task, verb);
    return action as NonNullable<TaskController[V]>;
  }

  /** Run the owner's verb; a failure it reports leaves the row as it was. */
  private _runVerb(action: () => void | Promise<void>): void {
    const result = action();
    // An owner that acts asynchronously reports its outcome through its own task events.
    if (result instanceof Promise) result.catch(() => undefined);
  }

  private _isEnabled(): boolean {
    return isFeatureGateEnabled(this._featureFlags, 'unified-runtime-task');
  }

  private _requireEnabled(operation: string): void {
    requireFeatureGate(this._featureFlags, 'unified-runtime-task', operation);
  }

  // ── TaskManager interface ────────────────────────────────────────────────

  public createTask(params: TaskCreateParams): RuntimeTask {
    this._requireEnabled('create runtime task');
    const now = Date.now();
    const id = crypto.randomUUID();

    const task: RuntimeTask = {
      id,
      kind: params.kind,
      title: params.title,
      description: params.description,
      status: 'queued',
      owner: params.owner,
      cancellable: params.cancellable ?? true,
      parentTaskId: params.parentTaskId,
      childTaskIds: [],
      queuedAt: now,
      retryPolicy: params.retryPolicy,
      correlationId: params.correlationId,
      turnId: params.turnId,
    };

    // If this task has a parent, add to parent's childTaskIds
    if (params.parentTaskId) {
      this._patchChildIds(params.parentTaskId, id);
    }

    // Persist to store
    this._dispatchCreated(task);
    this._recordOnly.add(id);

    // Emit event
    emitTaskCreated(this._bus, this._makeCtx(id), {
      taskId: id,
      description: params.title,
      priority: 0,
    });

    return task;
  }

  /** Queued → running: the owner reporting a start. A paused task is resumed instead (resumeTask). */
  public startTask(taskId: string): RuntimeTask {
    this._requireEnabled('start runtime task');
    const task = this._requireTask(taskId);
    if (task.status === 'blocked') return this.resumeTask(taskId);

    const updated = this._applyTransition(task, 'running', {
      startedAt: Date.now(),
    });

    emitTaskStarted(this._bus, this._makeCtx(taskId), { taskId });
    return updated;
  }

  /** Blocked → running, performed by the task's owner; the task keeps its start time. */
  public resumeTask(taskId: string): RuntimeTask {
    this._requireEnabled('resume runtime task');
    const task = this._requireTask(taskId);
    // Checked before the owner acts, so a refused move never reaches the owner.
    this._requireTransition(task, 'running');
    if (task.status !== 'blocked') throw new TaskTransitionError(task.id, task.status, 'running');
    const resume = this._requireVerb(task, 'resume');
    this._runVerb(() => resume());
    return this._applyTransition(task, 'running', {});
  }

  public blockTask(taskId: string, reason: string): RuntimeTask {
    this._requireEnabled('block runtime task');
    const task = this._requireTask(taskId);
    // Checked before the owner acts, so a refused move never reaches the owner.
    this._requireTransition(task, 'blocked');
    const pause = this._requireVerb(task, 'pause');
    this._runVerb(() => pause());

    const updated = this._applyTransition(task, 'blocked', {});

    emitTaskBlocked(this._bus, this._makeCtx(taskId), { taskId, reason });
    return updated;
  }

  public completeTask(taskId: string, result?: unknown): RuntimeTask {
    this._requireEnabled('complete runtime task');
    const task = this._requireTask(taskId);

    const now = Date.now();
    const durationMs = task.startedAt !== undefined ? now - task.startedAt : 0;

    const updated = this._applyTransition(task, 'completed', {
      endedAt: now,
      result,
    });

    emitTaskCompleted(this._bus, this._makeCtx(taskId), { taskId, durationMs });
    return updated;
  }

  public failTask(taskId: string, params: TaskFailParams): RuntimeTask {
    this._requireEnabled('fail runtime task');
    const task = this._requireTask(taskId);

    const now = Date.now();
    const durationMs = task.startedAt !== undefined ? now - task.startedAt : 0;

    // A retry is the owner's act (retryTask), never an automatic re-queue: nothing
    // here would run a re-queued task.
    const updated = this._applyTransition(task, 'failed', {
      endedAt: now,
      error: params.error,
      exitCode: params.exitCode,
    });

    emitTaskFailed(this._bus, this._makeCtx(taskId), {
      taskId,
      error: params.error,
      durationMs,
    });

    return updated;
  }

  public cancelTask(taskId: string, params?: TaskCancelParams): RuntimeTask {
    this._requireEnabled('cancel runtime task');
    const task = this._requireTask(taskId);

    if (!task.cancellable) {
      throw new TaskNotCancellableError(taskId);
    }

    // Checked before the owner acts, so a refused move never reaches the owner.
    this._requireTransition(task, 'cancelled');
    const cancel = this._requireVerb(task, 'cancel');
    this._runVerb(() => cancel(params?.reason));

    const now = Date.now();
    const updated = this._applyTransition(task, 'cancelled', {
      endedAt: now,
    });

    emitTaskCancelled(this._bus, this._makeCtx(taskId), {
      taskId,
      reason: params?.reason,
    });

    return updated;
  }

  public updateTask(taskId: string, params: TaskUpdateParams): RuntimeTask {
    this._requireEnabled('update runtime task');
    const task = this._requireTask(taskId);

    const updated: RuntimeTask = {
      ...task,
      ...(params.title !== undefined ? { title: params.title } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
      ...(params.exitCode !== undefined ? { exitCode: params.exitCode } : {}),
      ...(params.result !== undefined ? { result: params.result } : {}),
    };

    this._syncTaskToStore(updated);
    return updated;
  }

  public getTask(taskId: string): RuntimeTask | undefined {
    if (!this._isEnabled()) return undefined;
    return this._current(taskId);
  }

  public getTasksByKind(kind: TaskKind): RuntimeTask[] {
    if (!this._isEnabled()) return [];
    return this._tasks().filter((t) => t.kind === kind);
  }

  public getRunningTasks(): RuntimeTask[] {
    if (!this._isEnabled()) return [];
    return this._tasks().filter((t) => t.status === 'running');
  }

  public getRunningCount(kind: TaskKind): number {
    if (!this._isEnabled()) return 0;
    return this._tasks().filter((t) => t.kind === kind && t.status === 'running').length;
  }

  public getChildTasks(parentTaskId: string): RuntimeTask[] {
    if (!this._isEnabled()) return [];
    return this._tasks().filter((t) => t.parentTaskId === parentTaskId);
  }

  public getTaskStatus(taskId: string): TaskLifecycleState | undefined {
    if (!this._isEnabled()) return undefined;
    return this._current(taskId)?.status;
  }

  public retryTask(taskId: string): RuntimeTask {
    this._requireEnabled('retry runtime task');
    const task = this._requireTask(taskId);

    if (!canRetry(task.status)) {
      throw new TaskTransitionError(task.id, task.status, 'queued');
    }
    const retry = this._requireVerb(task, 'retry');
    this._runVerb(() => retry());

    return this._applyTransition(task, 'queued', {
      startedAt: undefined,
      endedAt: undefined,
      error: undefined,
      exitCode: undefined,
      retryAt: undefined,
      retryDelayMs: undefined,
      queuedAt: Date.now(),
    });
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /**
   * Returns a task or throws TaskNotFoundError.
   */
  private _requireTask(taskId: string): RuntimeTask {
    const task = this._current(taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }
    return task;
  }

  /**
   * The task as the store holds it. The store is what every writer (the ops
   * control plane, adapters, agent sync) changes, so it is the only copy read.
   */
  private _current(taskId: string): RuntimeTask | undefined {
    return this._store.getState().tasks.tasks.get(taskId);
  }

  private _tasks(): RuntimeTask[] {
    return [...this._store.getState().tasks.tasks.values()];
  }

  /**
   * Refuses a move the table does not allow. Only the verbs that make the
   * owner act call it; a plain report goes straight to the store, which
   * refuses a move by the same table (see _applyTransition).
   */
  private _requireTransition(
    task: RuntimeTask,
    to: TaskLifecycleState
  ): void {
    if (!canTransition(task.status, to)) {
      throw new TaskTransitionError(task.id, task.status, to);
    }
  }

  /**
   * Applies a state transition to a task, updates registry and store.
   */
  private _applyTransition(
    task: RuntimeTask,
    to: TaskLifecycleState,
    patch: Partial<RuntimeTask>
  ): RuntimeTask {
    this._dispatch.transitionRuntimeTask(task.id, to, patch, 'task-manager');
    const updated = this._current(task.id);
    // The store refuses a move its table does not allow; say so rather than report a transition that did not happen.
    if (updated === undefined || updated.status !== to) {
      throw new TaskTransitionError(task.id, updated?.status ?? task.status, to);
    }
    return updated;
  }

  /**
   * Adds a child task ID to a parent task's childTaskIds array.
   */
  private _patchChildIds(parentId: string, childId: string): void {
    const parent = this._current(parentId);
    if (!parent) return;
    const updated: RuntimeTask = {
      ...parent,
      childTaskIds: [...parent.childTaskIds, childId],
    };
    this._syncTaskToStore(updated);
  }

  /**
   * Constructs a minimal EmitterContext for a given task.
   */
  private _makeCtx(taskId: string): EmitterContext {
    return {
      sessionId: this._sessionId,
      source: 'task-manager',
      traceId: crypto.randomUUID(),
      taskId,
    };
  }

  /**
   * Dispatches TASK_CREATED state update to the Zustand store.
   */
  private _dispatchCreated(task: RuntimeTask): void {
    this._dispatch.syncRuntimeTask(task, 'task-manager');
  }

  /**
   * Syncs an updated task to the Zustand store, adjusting status index arrays.
   */
  private _syncTaskToStore(task: RuntimeTask): void {
    this._dispatch.syncRuntimeTask(task, 'task-manager');
  }
}
