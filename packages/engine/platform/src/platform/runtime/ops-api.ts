import type { RuntimeTask } from './store/domains/tasks.js';
import type { UiTasksSnapshot } from './ui-read-models.js';
import type { TaskCreateParams, TaskFailParams, TaskUpdateParams } from './tasks/types.js';

export interface OpsTaskApi {
  snapshot(): UiTasksSnapshot;
  list(limit?: number): readonly RuntimeTask[];
  get(taskId: string): RuntimeTask | null;
  running(): readonly RuntimeTask[];
  create(input: TaskCreateParams): RuntimeTask;
  /** Reports a queued task as running (a paused one is resumed). */
  start(taskId: string): RuntimeTask;
  update(taskId: string, input: TaskUpdateParams): RuntimeTask;
  complete(taskId: string, result?: unknown): RuntimeTask;
  fail(taskId: string, input: TaskFailParams): RuntimeTask;
  /**
   * The verbs return a promise when the task's owner acts asynchronously: it
   * settles once the owner did (or failed to do) what was asked.
   */
  cancel(taskId: string, note?: string): void | Promise<void>;
  pause(taskId: string, note?: string): void | Promise<void>;
  resume(taskId: string, note?: string): void | Promise<void>;
  retry(taskId: string, note?: string): void | Promise<void>;
}

export interface OpsAgentApi {
  cancel(agentId: string, note?: string): void;
}

export interface OpsApi {
  readonly tasks: OpsTaskApi;
  readonly agents: OpsAgentApi;
}
