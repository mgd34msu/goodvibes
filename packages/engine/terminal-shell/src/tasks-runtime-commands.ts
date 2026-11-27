/**
 * Tasks in the terminal programs: the runtime tasks of this program (the
 * exec, agent and ACP work its loop started) together with the daemon's
 * (scheduled work, channel-driven runs, tasks other surfaces submitted). The
 * capabilities are defined once in the platform (capabilities/builtin/tasks.ts)
 * and shown in the Work place; here is how one program reads and changes them,
 * given by its policy: the terminal app starts, finishes, pauses and cancels its
 * own tasks; the Agent only reads, and says why when asked to change one.
 */
import {
  createTasksClient,
  type LocalTaskSource,
  type DaemonVerbCaller,
  type UnionTask,
} from '@goodvibes/engine/platform/platform/runtime/client';
import type { OpsApi } from '@goodvibes/engine/platform/platform/runtime/bootstrap';
import type { TaskKind } from '@goodvibes/engine/platform/platform/runtime/state';
import { ENDED_TASKS_LIST, OPEN_TASKS_LIST, TASKS_LIST, type TasksCapabilityServices } from '@goodvibes/engine/platform/platform/capabilities';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import { readRefusal } from '@goodvibes/engine/errors';
import { sortUnionTasks } from './task-presentation.js';
import { commandRefusal } from './command-confirmation.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { CommandActionContext } from './command-actions/types.js';

/** Where one program reads its tasks and what it may do to them. */
export interface TasksPolicy<Context> {
  readonly listTitle: string;
  readonly local: (context: Context) => LocalTaskSource;
  readonly verbs: (context: Context) => DaemonVerbCaller;
  /** The program's own task registry. */
  readonly mutations: (context: Context) => Pick<OpsApi, 'tasks'>;
  readonly row: (entry: UnionTask) => string;
  readonly detail: (context: Context, entry: UnionTask) => string[];
  /** The commands running in the background here and what they take (the Agent; the terminal app shows them in its process monitor). */
  readonly processes?: ((context: Context) => string) | undefined;
}

let installed: TasksPolicy<CommandActionContext> | undefined;
function policyOf(): TasksPolicy<CommandActionContext> {
  if (!installed) throw commandRefusal('Tasks are not available in this session.');
  return installed;
}

function clientOf(ctx: CommandActionContext) {
  const policy = policyOf();
  return createTasksClient({ local: policy.local(ctx), verbs: policy.verbs(ctx) });
}

/** A task missing because the daemon could not answer is not an unknown task. */
function missingTask(taskId: string, daemonUnavailable: string | null): string {
  return daemonUnavailable
    ? `Task ${taskId} is not in this program, and the daemon could not be asked: ${daemonUnavailable.replace(/\.+$/, '')}. Try again when it is reachable.`
    : `No task ${taskId}.`;
}

async function findTask(ctx: CommandActionContext, taskId: string): Promise<UnionTask> {
  const { found, daemonUnavailable } = await clientOf(ctx).lookup(taskId);
  if (!found) throw commandRefusal(missingTask(taskId, daemonUnavailable), 'Work, in the menu, lists the tasks.');
  return found;
}

function taskRow(entry: UnionTask): ListRow {
  return { value: entry.task.id, label: entry.task.title, detail: `${entry.task.kind} · ${entry.task.owner}${entry.origin === 'daemon' ? ' · on the daemon' : ''}`, state: entry.task.status };
}

async function listRows(ctx: CommandActionContext, keep: (entry: UnionTask) => boolean): Promise<readonly ListRow[]> {
  if (!installed) return [];
  const { tasks } = await clientOf(ctx).list(500);
  return sortUnionTasks(tasks).filter(keep).map(taskRow);
}

defineList<CommandActionContext>({
  name: TASKS_LIST,
  read: (ctx) => listRows(ctx, () => true),
  operator: { method: 'tasks.list', input: {}, rows: { from: 'tasks', value: 'id', label: 'title', detail: 'kind', state: 'status' } },
});
defineList<CommandActionContext>({
  name: OPEN_TASKS_LIST,
  read: (ctx) => listRows(ctx, (entry) => entry.task.status === 'queued' || entry.task.status === 'running' || entry.task.status === 'blocked'),
  operator: { terminalOnly: 'A task that is not finished is changed from the program that runs it.' },
});
defineList<CommandActionContext>({
  name: ENDED_TASKS_LIST,
  read: (ctx) => listRows(ctx, (entry) => entry.task.status === 'failed' || entry.task.status === 'cancelled'),
  operator: { terminalOnly: 'A task this program runs is retried from it.' },
});

/** The program's task registry. */
function mutationsOf(ctx: CommandActionContext): Pick<OpsApi, 'tasks'> {
  return policyOf().mutations(ctx);
}

/**
 * A change to one task. Which registry owns the id decides what may be done:
 * the daemon's tasks take only cancel and retry over the wire; an act the
 * daemon has no method for is refused by name rather than applied to a local
 * record that does not exist (which would report success and change nothing).
 */
async function changeTask(ctx: CommandActionContext, taskId: string, act: 'start' | 'update' | 'complete' | 'fail' | 'cancel' | 'pause' | 'resume' | 'retry', apply: (tasks: Pick<OpsApi, 'tasks'>['tasks']) => Promise<string> | string, note?: string): Promise<string> {
  const mutations = mutationsOf(ctx);
  const found = await findTask(ctx, taskId);
  try {
    if (found.origin === 'daemon') {
      const client = clientOf(ctx);
      // The daemon's cancel and retry take only the task id.
      const noteDropped = note ? ' The daemon keeps no note with its tasks, so your note was not saved.' : '';
      if (act === 'cancel') { await client.cancel(taskId); return `Cancelled "${found.task.title}" on the daemon.${noteDropped}`; }
      if (act === 'retry') { await client.retry(taskId); return `"${found.task.title}" runs again on the daemon.${noteDropped}`; }
      throw commandRefusal(`"${found.task.title}" runs on the daemon, and the daemon takes no ${act} for a task. Cancel and run again reach it; the rest act on this program's own tasks.`);
    }
    return await apply(mutations.tasks);
  } catch (error) {
    if (readRefusal(error)) throw error;
    throw commandRefusal(summarizeError(error), undefined, 'COMMAND_FAILED');
  }
}

/** This program's own tasks, newest first, as the Work place lists them (undefined before the policy is installed). */
export function localTasks(ctx: CommandActionContext): readonly unknown[] | undefined {
  if (!installed) return undefined;
  return installed.local(ctx).list(200);
}

/** Install this program's task policy (its tasks-runtime.ts), once at start. */
export function installTasksPolicy<Context extends CommandActionContext>(policy: TasksPolicy<Context>): void {
  installed = policy as unknown as TasksPolicy<CommandActionContext>;
}

/** The task capabilities' services over this program's policy, for one command context. */
export function tasksServices(ctx: CommandActionContext): NonNullable<TasksCapabilityServices['tasks']> | undefined {
  if (!installed) return undefined;
  const title = async (id: string): Promise<string> => (await findTask(ctx, id)).task.title;
  return {
    async list(filter) {
      const policy = policyOf();
      const { tasks: union, daemonUnavailable } = await clientOf(ctx).list(500);
      const filtered = sortUnionTasks(union).filter((entry) => (!filter.status || entry.task.status === filter.status) && (!filter.kind || entry.task.kind === filter.kind));
      const daemonNote = daemonUnavailable ? [`  (the daemon's tasks are not included: ${daemonUnavailable})`] : [];
      if (filtered.length === 0) return [filter.status || filter.kind ? 'No tasks match.' : 'No tasks recorded yet.', ...daemonNote].join('\n');
      return [`${policy.listTitle} (${filtered.length})`, ...filtered.map(policy.row), ...daemonNote].join('\n');
    },
    async show(id) { return policyOf().detail(ctx, await findTask(ctx, id)).join('\n'); },
    async output(id) {
      const { task } = await findTask(ctx, id);
      // Its result, else its error; with neither, said so (its own description or title read as if it were output).
      return typeof task.result === 'string' ? task.result
        : task.result !== undefined ? JSON.stringify(task.result, null, 2)
          : task.error ?? `"${task.title}" has produced nothing yet${task.status === 'running' || task.status === 'queued' || task.status === 'blocked' ? '' : ': it ended with no result'}.`;
    },
    async processes() {
      const policy = policyOf();
      if (!policy.processes) throw commandRefusal('The terminal app shows background commands in Your agents (F2).');
      return policy.processes(ctx);
    },
    async create(kind, owner, titleText) {
      const task = mutationsOf(ctx).tasks.create({ kind: kind as TaskKind, owner, title: titleText, description: titleText });
      return `Added "${task.title}" (${task.kind}) for ${task.owner}; it waits until it is started.`;
    },
    start: (id) => changeTask(ctx, id, 'start', async (tasks) => `"${await title(id)}" is ${tasks.start(id).status}.`),
    update: (id, field, value) => changeTask(ctx, id, 'update', async (tasks) => {
      // The part named as its choice reads it ("The title"); the record's field is its last word.
      const part = field.trim().toLowerCase().replace(/^(?:its|the)\s+/u, '');
      tasks.update(id, part === 'result' ? { result: value } : { [part]: value });
      return `Changed the ${part} of "${await title(id)}".`;
    }),
    complete: (id, result) => changeTask(ctx, id, 'complete', async (tasks) => { tasks.complete(id, result || undefined); return `"${await title(id)}" is done.`; }),
    fail: (id, error) => changeTask(ctx, id, 'fail', async (tasks) => { tasks.fail(id, { error }); return `"${await title(id)}" is marked failed.`; }),
    pause: (id, note) => changeTask(ctx, id, 'pause', async (tasks) => { await tasks.pause(id, note || undefined); return `Paused "${await title(id)}".`; }),
    resume: (id, note) => changeTask(ctx, id, 'resume', async (tasks) => { await tasks.resume(id, note || undefined); return `"${await title(id)}" goes on.`; }),
    cancel: (id, note) => changeTask(ctx, id, 'cancel', async (tasks) => { await tasks.cancel(id, note || undefined); return `Cancelled "${await title(id)}".`; }, note || undefined),
    // A task of this program run again waits to be started, as a new one does: said as it is.
    retry: (id, note) => changeTask(ctx, id, 'retry', async (tasks) => { await tasks.retry(id, note || undefined); return `"${await title(id)}" is set to run again; it waits until it is started (s).`; }, note || undefined),
  };
}
