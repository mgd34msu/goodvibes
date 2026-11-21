/**
 * tasks-client.ts, a task list shows every runtime task, not just this
 * surface's.
 *
 * ── What a task list used to read ─────────────────────────────────────────
 *
 * The operator client's `tasks.list(500)`, a DirectTransport call straight into
 * this process's own task read model, answered synchronously because there was
 * no wire to cross. While the surface hosted a daemon, that model held every
 * task on the machine.
 *
 * Now it holds this surface's own: the exec, agent and ACP tasks the loop here
 * spawned. The daemon holds its own set, scheduled work, channel-driven runs,
 * tasks other surfaces submitted, and a list that showed only the local half
 * would read as complete while omitting most of it.
 *
 * ── The union, and who wins ───────────────────────────────────────────────
 *
 * Local rows are AUTHORITATIVE for tasks this surface owns: they are live, and
 * the lifecycle acts below (`update`, `complete`, `fail`, `pause`, `resume`)
 * reach a registry that is genuinely here. The daemon's rows fill in the rest.
 * A task carried by both, an id the local registry knows AND the daemon lists
 *, is shown from the local copy, which is the fresher one.
 *
 * ── Reading is allowed to be optimistic; writing is not ───────────────────
 *
 * A read that cannot reach the daemon degrades to the local half and says so
 * once, because a partial list of real tasks is more useful than an error page.
 * A WRITE against a task this surface does not own must not be attempted
 * locally: it would look like it worked and change nothing on the daemon that
 * actually runs the task. Those route to the daemon's verb where one exists
 * (`tasks.cancel`, `tasks.retry`) and refuse by name where one does not.
 *
 * The contract carries six task verbs, create, get, list, status, cancel,
 * retry. There is no wire verb for update/complete/fail/pause/resume, so those
 * are honestly refused for a daemon-owned task rather than silently applied to
 * a local record that does not exist.
 */
import { logger, summarizeError } from '../../utils/index.js';
import type { RuntimeTask } from '../store/index.js';
import type { DaemonVerbCaller } from './daemon-verbs.js';

/** Where a task record came from, which decides what may be done to it. */
export type TaskOrigin = 'local' | 'daemon';

export interface UnionTask {
  readonly task: RuntimeTask;
  readonly origin: TaskOrigin;
}

export interface TasksUnionResult {
  readonly tasks: readonly UnionTask[];
  /**
   * Why the daemon's half is missing, when it is. `null` means the union is
   * complete, either the daemon answered, or none is configured and the local
   * set genuinely IS every task.
   */
  readonly daemonUnavailable: string | null;
}

/** The narrow local source: whatever already answers this surface's own tasks. */
export interface LocalTaskSource {
  list(limit: number): readonly RuntimeTask[];
  get(taskId: string): RuntimeTask | null;
}

export interface TasksClient {
  /** Local rows union the daemon's, deduped by id with local winning, at most `limit` rows (local first). */
  list(limit?: number): Promise<TasksUnionResult>;
  /** One task, local first, then the daemon. Null when neither has it, or when the daemon could not answer (see `lookup`). */
  get(taskId: string): Promise<UnionTask | null>;
  /**
   * Like `get`, and says why a missing task is missing: `daemonUnavailable` is
   * set when the daemon could not be asked or failed to answer, so "no such
   * task" and "could not look" stay different answers.
   */
  lookup(taskId: string): Promise<{ readonly found: UnionTask | null; readonly daemonUnavailable: string | null }>;
  /** Cancel a daemon-owned task over `tasks.cancel`. Rejects with the daemon's refusal, named plainly for a task only this surface runs. */
  cancel(taskId: string): Promise<void>;
  /** Re-queue a daemon-owned task over `tasks.retry`. Rejects with the daemon's refusal, named plainly for a task only this surface runs. */
  retry(taskId: string): Promise<void>;
}

/** The sentence for an answer that lacks the field its verb promises. */
function unexpectedAnswer(verb: 'tasks.list' | 'tasks.get', field: 'tasks' | 'task'): string {
  return `${verb} answered without ${field}; the daemon may be a different version than this surface`;
}

/** The task array `tasks.list` answers beside its counters, or null when the answer carries none. */
function readTasks(payload: unknown): readonly RuntimeTask[] | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)['tasks'];
  return Array.isArray(value) ? value as readonly RuntimeTask[] : null;
}

/** The task `tasks.get` answers as `{ task }`, or null when the answer carries none. */
function readTask(payload: unknown): RuntimeTask | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const nested = (payload as Record<string, unknown>)['task'];
  return nested && typeof nested === 'object' && !Array.isArray(nested) ? nested as RuntimeTask : null;
}

export function createTasksClient(deps: {
  readonly local: LocalTaskSource;
  readonly verbs: DaemonVerbCaller;
}): TasksClient {
  /**
   * Send a lifecycle act to the daemon. The daemon's own answer says whether it
   * carries the task, so nothing is read first; a "no such task" for an id this
   * surface runs is reworded to say where the task lives.
   */
  const actOnDaemonTask = async (verb: 'tasks.cancel' | 'tasks.retry', taskId: string): Promise<void> => {
    const probe = deps.verbs.probe();
    if (!probe.available) {
      throw new Error(`${taskId} is not a task this surface owns, and ${probe.reason}`);
    }
    try {
      await deps.verbs.invoke(verb, { taskId });
    } catch (error) {
      const status = (error as { status?: unknown } | null)?.status;
      if (status === 404 && deps.local.get(taskId)) {
        throw new Error(`${taskId} is a task this surface runs itself and the daemon does not carry it; cancel and retry here reach only the daemon's tasks.`);
      }
      throw error;
    }
  };

  const lookup = async (taskId: string): Promise<{ found: UnionTask | null; daemonUnavailable: string | null }> => {
    const localTask = deps.local.get(taskId);
    if (localTask) return { found: { task: localTask, origin: 'local' }, daemonUnavailable: null };
    const probe = deps.verbs.probe();
    if (!probe.available) return { found: null, daemonUnavailable: probe.reason };
    try {
      const task = readTask(await deps.verbs.invoke('tasks.get', { taskId }));
      if (!task) return { found: null, daemonUnavailable: unexpectedAnswer('tasks.get', 'task') };
      return { found: { task, origin: 'daemon' }, daemonUnavailable: null };
    } catch (error) {
      // The daemon answered that it holds no such task: a real "not found", not a failure to ask.
      if ((error as { status?: unknown } | null)?.status === 404) return { found: null, daemonUnavailable: null };
      const reason = summarizeError(error);
      logger.debug('[tasks] the daemon could not answer for this task', { taskId, error: reason });
      return { found: null, daemonUnavailable: reason };
    }
  };

  return {
    list: async (limit = 500) => {
      const localTasks = [...deps.local.list(limit)];
      const owned = new Set(localTasks.map((task) => task.id));
      const local: UnionTask[] = localTasks.map((task) => ({ task, origin: 'local' as const }));

      const probe = deps.verbs.probe();
      if (!probe.available) return { tasks: local, daemonUnavailable: probe.reason };
      try {
        // The daemon sends only its newest `limit`; the union keeps the same cap.
        const daemonTasks = readTasks(await deps.verbs.invoke('tasks.list', { limit: Math.max(1, limit) }));
        if (daemonTasks === null) return { tasks: local, daemonUnavailable: unexpectedAnswer('tasks.list', 'tasks') };
        return {
          tasks: [
            ...local,
            ...daemonTasks.filter((task) => !owned.has(task.id)).map((task) => ({ task, origin: 'daemon' as const })),
          ].slice(0, Math.max(1, limit)),
          daemonUnavailable: null,
        };
      } catch (error) {
        const reason = summarizeError(error);
        logger.debug('[tasks] the daemon\'s tasks could not be read', { error: reason });
        return { tasks: local, daemonUnavailable: reason };
      }
    },

    get: async (taskId) => (await lookup(taskId)).found,
    lookup,

    cancel: (taskId) => actOnDaemonTask('tasks.cancel', taskId),
    retry: (taskId) => actOnDaemonTask('tasks.retry', taskId),
  };
}
