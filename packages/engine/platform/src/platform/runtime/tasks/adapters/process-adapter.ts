/**
 * ProcessTaskAdapter, bridges ProcessManager background processes into the
 * unified RuntimeTask registry.
 *
 * Each spawned background process gets a corresponding RuntimeTask of kind
 * 'exec'. `attach()` observes the manager, so a process becomes a task when it
 * starts and reaches its terminal state when it exits or is stopped; the task
 * surface cancels one through `controllerFor`.
 *
 * NOTE: This adapter writes directly to the runtime store, bypassing
 * TaskManager. This is intentional, adapters are authoritative sources for
 * their subsystem.
 */

import { randomUUID } from 'node:crypto';
import { createDomainDispatch } from '../../store/index.js';
import type { RuntimeStore, DomainDispatch } from '../../store/index.js';
import type { RuntimeTask } from '../../store/domains/tasks.js';
import { isTerminalStatus } from '../lifecycle.js';
import type { TaskController } from '../manager.js';
import type { ProcessManager, ProcessLifecycleEvent } from '../../../tools/shared/process-manager.js';

/** Owner context supplied when wrapping a process. */
export interface ProcessOwner {
  /** Session ID that spawned this process. */
  sessionId: string;
  /** Optional agent ID that owns this process. */
  agentId?: string | undefined;
}

type ProcessOutcome = { readonly status: 'completed' | 'failed'; readonly exitCode?: number | undefined; readonly error?: string | undefined };

/** What a finished process means for its task: exit 0 completes it, anything else fails it with the reason. */
function outcomeOf(exitCode: number | null, signal: string | null, timedOut: boolean): ProcessOutcome {
  if (exitCode === 0 && !timedOut) return { status: 'completed', exitCode: 0 };
  const reason = timedOut
    ? `Process ran past its timeout${signal ? ` and was ended by ${signal}` : ''}`
    : signal ? `Process was ended by ${signal}` : exitCode === null ? 'Process ended without an exit code' : `Process exited with code ${exitCode}`;
  return { status: 'failed', ...(exitCode === null ? {} : { exitCode }), error: reason };
}

/**
 * Bridges ProcessManager background processes into the RuntimeTask registry.
 *
 * @example
 * ```ts
 * const adapter = new ProcessTaskAdapter(store, processManager);
 * const detach = adapter.attach({ sessionId });
 * // ... a cancel from the task surface: adapter.controllerFor(taskId)?.cancel?.()
 * detach();
 * ```
 */
export class ProcessTaskAdapter {
  /** Maps opaque ProcessManager handle (bg_ prefix) → task ID. */
  private readonly _idToTask = new Map<string, string>();
  /** Maps task ID → process internal ID. */
  private readonly _taskToId = new Map<string, string>();
  /** Maps pid → process internal ID (for exit handling). */
  private readonly _pidToId = new Map<number, string>();

  private readonly _manager: ProcessManager;
  private readonly _dispatch: DomainDispatch;

  constructor(
    private readonly _store: RuntimeStore,
    manager: ProcessManager,
  ) {
    this._manager = manager;
    this._dispatch = createDomainDispatch(_store);
  }

  // ── Core API ────────────────────────────────────────────────────────────────

  /**
   * Keep the task list in step with the manager: processes already running
   * become tasks now, later ones when they start, and each reaches its
   * terminal state when it exits or is stopped. Returns the detach function.
   * Cost: one store write when a process starts and one when it ends.
   */
  attach(owner: ProcessOwner = { sessionId: 'system' }): () => void {
    this.sync(owner);
    return this._manager.observeLifecycle((event) => this._onLifecycle(event, owner));
  }

  /**
   * The task surface's controller for a process task this adapter owns. Its
   * cancel stops the process and leaves the task's transition to the task
   * manager that asked, so the row moves once.
   */
  controllerFor(taskId: string): TaskController | undefined {
    if (!this._taskToId.has(taskId)) return undefined;
    return {
      cancel: () => {
        const processId = this._taskToId.get(taskId);
        if (processId === undefined) return;
        this._release(processId);
        this._manager.stop(processId);
      },
    };
  }

  /**
   * Wrap a spawned process as a RuntimeTask.
   *
   * @param processId - The ProcessManager internal ID (process_id from spawn result).
   * @param pid - OS process ID.
   * @param command - The shell command string for display.
   * @param owner - Session/agent that owns this process.
   * @returns The new task ID.
   */
  wrapProcess(
    processId: string,
    pid: number,
    command: string,
    owner: ProcessOwner,
  ): string {
    // Idempotent: if already wrapped, return existing task ID
    const existing = this._idToTask.get(processId);
    if (existing !== undefined) return existing;

    const taskId = randomUUID();
    const now = Date.now();

    const task: RuntimeTask = {
      id: taskId,
      kind: 'exec',
      title: command.length > 80 ? `${command.slice(0, 77)}...` : command,
      description: command,
      status: 'running',
      owner: owner.agentId ?? owner.sessionId,
      cancellable: true,
      childTaskIds: [],
      queuedAt: now,
      startedAt: now,
      correlationId: owner.sessionId,
      turnId: owner.agentId,
    };

    this._idToTask.set(processId, taskId);
    this._taskToId.set(taskId, processId);
    this._pidToId.set(pid, processId);

    this._upsertTask(task);
    return taskId;
  }

  /**
   * Update task status when a process exits.
   *
   * @param pid - OS process ID that exited.
   * @param exitCode - Process exit code (0 = success).
   */
  handleProcessExit(pid: number, exitCode: number): void {
    const processId = this._pidToId.get(pid);
    if (processId === undefined) return;
    this._settle(processId, outcomeOf(exitCode, null, false));
  }

  /**
   * Cancel a process task by task ID.
   * Stops the underlying process via ProcessManager and marks the task cancelled.
   *
   * @param taskId - The RuntimeTask ID to cancel.
   */
  cancelProcess(taskId: string): void {
    const processId = this._taskToId.get(taskId);
    if (processId === undefined) return;
    // Released first, so the stop the manager publishes finds no task to settle.
    this._release(processId);
    this._manager.stop(processId);
    if (!this._isTerminal(taskId)) this._transitionTask(taskId, 'cancelled', {});
  }

  /**
   * Reconcile adapter state with the RuntimeTask registry.
   *
   * Scans all ProcessManager processes:
   * - Wraps any un-tracked processes as new tasks (with a derived owner).
   * - Marks completed (done) processes as completed or failed in the task store.
   * - Removes task mappings for processes that have been cleaned up.
   *
   * @param defaultOwner - Owner context used when auto-wrapping unknown processes.
   */
  sync(defaultOwner: ProcessOwner = { sessionId: 'system' }): void {
    const liveProcesses = this._manager.list();
    const liveIds = new Set(liveProcesses.map((p) => p.id));

    for (const proc of liveProcesses) {
      const entry = this._manager.getStatus(proc.id);
      if (!this._idToTask.has(proc.id)) {
        // A process that already finished before it was ever seen is not a task to show.
        if (entry?.done) continue;
        this.wrapProcess(proc.id, proc.pid, proc.cmd, { sessionId: defaultOwner.sessionId, agentId: proc.startedBy ?? defaultOwner.agentId });
      }
      if (entry?.done) this._settle(proc.id, outcomeOf(entry.exitCode, entry.signal ?? null, entry.timedOut === true));
    }

    // A process the manager no longer lists was stopped or expired; its task ends as cancelled if still open.
    for (const processId of [...this._idToTask.keys()]) {
      if (!liveIds.has(processId)) this._settleStopped(processId);
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private _onLifecycle(event: ProcessLifecycleEvent, owner: ProcessOwner): void {
    if (event.kind === 'started') {
      this.wrapProcess(event.id, event.pid, event.cmd, { sessionId: owner.sessionId, agentId: event.startedBy ?? owner.agentId });
    } else if (event.kind === 'finished') {
      this._settle(event.id, outcomeOf(event.exitCode, event.signal, event.timedOut));
    } else {
      this._settleStopped(event.id);
    }
  }

  /** Apply a finished process's outcome once: a task already terminal (cancelled, say) is left as it is. */
  private _settle(processId: string, outcome: ProcessOutcome): void {
    const taskId = this._idToTask.get(processId);
    if (taskId === undefined) return;
    this._release(processId);
    if (this._isTerminal(taskId)) return;
    this._transitionTask(taskId, outcome.status, { exitCode: outcome.exitCode, error: outcome.error });
  }

  private _settleStopped(processId: string): void {
    const taskId = this._idToTask.get(processId);
    if (taskId === undefined) return;
    this._release(processId);
    if (this._isTerminal(taskId)) return;
    this._transitionTask(taskId, 'cancelled', {});
  }

  /** Forget a process whose task has reached its end, so the maps hold only open tasks. */
  private _release(processId: string): void {
    const taskId = this._idToTask.get(processId);
    this._idToTask.delete(processId);
    if (taskId !== undefined) this._taskToId.delete(taskId);
    for (const [pid, id] of this._pidToId) {
      if (id === processId) { this._pidToId.delete(pid); break; }
    }
  }

  private _isTerminal(taskId: string): boolean {
    const current = this._store.getState().tasks.tasks.get(taskId);
    return current === undefined || isTerminalStatus(current.status);
  }

  private _upsertTask(task: RuntimeTask): void {
    this._dispatch.syncRuntimeTask(task, 'process-adapter');
  }

  private _transitionTask(
    taskId: string,
    status: 'completed' | 'failed' | 'cancelled',
    extras: { exitCode?: number | undefined; error?: string | undefined },
  ): void {
    this._dispatch.transitionRuntimeTask(
      taskId,
      status,
      {
        endedAt: Date.now(),
        exitCode: extras.exitCode,
        error: extras.error,
      },
      'process-adapter',
    );
  }
}
