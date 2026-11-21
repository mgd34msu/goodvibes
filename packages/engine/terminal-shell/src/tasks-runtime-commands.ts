/**
 * `/tasks`, described once (command-actions/) for both terminal apps: the
 * runtime tasks of this app (the exec, agent and ACP work its loop started)
 * together with the daemon's (scheduled work, channel-driven runs, tasks
 * other surfaces submitted). Each app installs where it reads them, how it
 * opens its task view, and whether it may change them: the terminal app
 * starts, finishes, pauses and cancels its own tasks; the Agent only reads,
 * and says why when asked to change one.
 */
import {
  createTasksClient,
  type LocalTaskSource,
  type DaemonVerbCaller,
  type UnionTask,
} from '@goodvibes/engine/platform/platform/runtime/client';
import type { OpsApi } from '@goodvibes/engine/platform/platform/runtime/bootstrap';
import type { TaskKind } from '@goodvibes/engine/platform/platform/runtime/state';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import { readRefusal } from '@goodvibes/engine/errors';
import { sortUnionTasks } from './task-presentation.js';
import type { TerminalCommandRegistry } from './command-registry.js';
import { commandRefusal } from './command-confirmation.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { ActionDescription, CommandActionContext, CommandDescription, FixedChoice, InputDescription } from './command-actions/types.js';
import { choiceInput, doAction, listInput, readAction, textInput } from './described-command-kit.js';

/** Where one app reads its tasks and what it may do to them. */
export interface TasksPolicy<Context> {
  readonly listTitle: string;
  readonly local: (context: Context) => LocalTaskSource;
  readonly verbs: (context: Context) => DaemonVerbCaller;
  /** The app's own task registry; absent where tasks are read only (with the reason). */
  readonly mutations: ((context: Context) => Pick<OpsApi, 'tasks'>) | { readonly readOnly: string };
  /** Open the app's task view; throws a refusal when it cannot. */
  readonly open: (context: Context) => void;
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
    ? `Task ${taskId} is not on this terminal, and the daemon could not be asked: ${daemonUnavailable.replace(/\.+$/, '')}. Try again when it is reachable.`
    : `No task ${taskId}.`;
}

async function findTask(ctx: CommandActionContext, taskId: string): Promise<UnionTask> {
  const { found, daemonUnavailable } = await clientOf(ctx).lookup(taskId);
  if (!found) throw commandRefusal(missingTask(taskId, daemonUnavailable), '/tasks list shows them.');
  return found;
}

function taskRow(entry: UnionTask): ListRow {
  return { value: entry.task.id, label: entry.task.title, detail: `${entry.task.kind} · ${entry.task.owner}${entry.origin === 'daemon' ? ' · on the daemon' : ''}`, state: entry.task.status };
}

async function listRows(ctx: CommandActionContext, keep: (entry: UnionTask) => boolean): Promise<readonly ListRow[]> {
  const { tasks } = await clientOf(ctx).list(500);
  return sortUnionTasks(tasks).filter(keep).map(taskRow);
}

const ALL_TASKS = defineList<CommandActionContext>({
  name: 'tasks',
  read: (ctx) => listRows(ctx, () => true),
  operator: { method: 'tasks.list', input: {}, rows: { from: 'tasks', value: 'id', label: 'title', detail: 'kind', state: 'status' } },
});
const OPEN_TASKS = defineList<CommandActionContext>({
  name: 'tasks.open',
  read: (ctx) => listRows(ctx, (entry) => entry.task.status === 'queued' || entry.task.status === 'running' || entry.task.status === 'blocked'),
  operator: { terminalOnly: 'A task that is not finished is changed from the terminal app that runs it.' },
});
const ENDED_TASKS = defineList<CommandActionContext>({
  name: 'tasks.ended',
  read: (ctx) => listRows(ctx, (entry) => entry.task.status === 'failed' || entry.task.status === 'cancelled'),
  operator: { method: 'tasks.list', input: {}, rows: { from: 'tasks', where: { field: 'status', equals: 'failed' }, value: 'id', label: 'title', state: 'status' } },
});

const STATUSES: readonly FixedChoice[] = [
  { value: 'queued', label: 'Waiting to start' },
  { value: 'running', label: 'Running' },
  { value: 'blocked', label: 'Paused or blocked' },
  { value: 'completed', label: 'Done' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];
const KINDS: readonly FixedChoice[] = [
  { value: 'exec', label: 'A command' },
  { value: 'agent', label: 'An agent' },
  { value: 'acp', label: 'A hosted coding agent' },
  { value: 'scheduler', label: 'A scheduled run' },
  { value: 'daemon', label: 'Daemon work' },
  { value: 'mcp', label: 'A tool server call' },
  { value: 'plugin', label: 'A plugin' },
  { value: 'integration', label: 'An integration' },
];

const TASK: InputDescription = listInput({ id: 'task', label: 'Task', help: 'Tasks here and on the daemon, newest first', list: ALL_TASKS, other: 'a task id' });
const OPEN_TASK: InputDescription = listInput({ id: 'task', label: 'Task', help: 'Tasks that have not finished', list: OPEN_TASKS, other: 'a task id' });
const NOTE: InputDescription = textInput({ id: 'note', label: 'Note', help: 'Why, kept with the task', why: 'your own words', kind: 'long-text', typed: { tail: true }, optional: { default: '', means: 'no note' } });

/** The app's task registry, or a refusal naming why this app only reads tasks. */
function mutationsOf(ctx: CommandActionContext): Pick<OpsApi, 'tasks'> {
  const mutations = policyOf().mutations;
  if (typeof mutations !== 'function') throw commandRefusal(mutations.readOnly);
  return mutations(ctx);
}

/**
 * A change to one task. Which registry owns the id decides what may be done:
 * the daemon's tasks take only cancel and retry over the wire; an act the
 * contract has no verb for is refused by name rather than applied to a local
 * record that does not exist (which would report success and change nothing).
 */
async function changeTask(ctx: CommandActionContext, taskId: string, act: 'start' | 'update' | 'complete' | 'fail' | 'cancel' | 'pause' | 'resume' | 'retry', apply: (tasks: Pick<OpsApi, 'tasks'>['tasks']) => Promise<string> | string): Promise<string> {
  const mutations = mutationsOf(ctx);
  const found = await findTask(ctx, taskId);
  try {
    if (found.origin === 'daemon') {
      const client = clientOf(ctx);
      if (act === 'cancel') { await client.cancel(taskId); return `Cancelled task ${taskId} on the daemon.`; }
      if (act === 'retry') { await client.retry(taskId); return `Re-queued task ${taskId} on the daemon.`; }
      throw commandRefusal(`${taskId} runs on the daemon, and the daemon takes no ${act} for a task. Cancel and retry reach it; the rest act on this terminal's own tasks.`);
    }
    return await apply(mutations.tasks);
  } catch (error) {
    if (readRefusal(error)) throw error;
    throw commandRefusal(summarizeError(error), undefined, 'COMMAND_FAILED');
  }
}

type TaskAction = ActionDescription<CommandActionContext>;

function change(fields: Pick<TaskAction, 'id' | 'label' | 'word' | 'inputs' | 'sentence' | 'example' | 'run'> & Partial<Pick<TaskAction, 'risk' | 'undoneBy' | 'lasts' | 'operator'>>): TaskAction {
  return {
    done: '', touches: 'this-machine', lasts: 'kept', risk: 'none',
    operator: { terminalOnly: 'A task this terminal runs is changed from it.' },
    ...fields,
  };
}

export const TASKS_COMMAND: CommandDescription<CommandActionContext> = {
  name: 'tasks',
  // --yes confirms only right after the action word: the same word in the text is text.
  leadingFlagsOnly: true,
  title: 'Tasks',
  summary: 'The work running here and on the daemon: see it, start it, finish it, pause or cancel it',
  group: 'Agents and work',
  report: 'list',
  firstScreenRows: [
    'list', 'open', 'show', 'output', 'processes',
    { label: 'Add or start a task…', actions: ['create', 'start', 'update'] },
    { label: 'Finish, pause or stop a task…', actions: ['complete', 'fail', 'pause', 'resume', 'cancel', 'retry'] },
  ],
  actions: [
    readAction<CommandActionContext>({
      id: 'list', label: 'See your tasks', word: 'list',
      inputs: [
        choiceInput({ id: 'status', label: 'Only', help: 'Tasks in one state', choices: STATUSES, typed: { flag: '--status' }, optional: { default: '', means: 'every state' } }),
        choiceInput({ id: 'kind', label: 'Kind', help: 'Tasks of one kind', choices: KINDS, typed: { flag: '--kind' }, optional: { default: '', means: 'every kind' } }),
      ],
      sentence: 'Shows the tasks here and on the daemon, newest first, with their state, kind and owner.', example: { status: 'running' },
      operator: { method: 'tasks.list', fields: {} },
      async rowValue(ctx) {
        const { tasks } = await clientOf(ctx).list(500);
        const running = tasks.filter((entry) => entry.task.status === 'running').length;
        return tasks.length === 0 ? 'none yet' : `${tasks.length} task${tasks.length === 1 ? '' : 's'}${running > 0 ? `, ${running} running` : ''}`;
      },
      async run(values, ctx) {
        const policy = policyOf();
        const { tasks: union, daemonUnavailable } = await clientOf(ctx).list(500);
        const filtered = sortUnionTasks(union).filter((entry) => (!values.status || entry.task.status === values.status) && (!values.kind || entry.task.kind === values.kind));
        // The daemon note rides beside what was found: the local half is real work.
        const daemonNote = daemonUnavailable ? [`  (the daemon's tasks are not included: ${daemonUnavailable})`] : [];
        if (filtered.length === 0) return [values.status || values.kind ? 'No tasks match.' : 'No tasks recorded yet.', ...daemonNote].join('\n');
        // Every task read is printed: the transcript scrolls back through them all.
        return [
          `${policy.listTitle} (${filtered.length})`,
          ...filtered.map(policy.row),
          ...daemonNote,
        ].join('\n');
      },
    }),
    readAction<CommandActionContext>({
      id: 'processes', label: 'See commands running in the background', word: 'processes',
      sentence: 'Lists the commands running in the background here, which have finished, and whether a running one can be given input, a terminal, or sudo.',
      operator: { terminalOnly: 'Background commands run in this terminal.' },
      async run(_values, ctx) {
        const policy = policyOf();
        if (!policy.processes) throw commandRefusal('The terminal app shows background commands in Your agents (F2).');
        return policy.processes(ctx);
      },
    }),
    doAction<CommandActionContext>({
      id: 'open', label: 'Open the tasks view', word: 'open', touches: 'reads',
      sentence: 'Opens the live view of tasks and agents.',
      operator: { terminalOnly: 'It is a terminal screen.' },
      async run(_values, ctx) { policyOf().open(ctx); },
    }),
    readAction<CommandActionContext>({
      id: 'show', label: 'See one task', word: 'show', inputs: [TASK],
      sentence: 'Shows task {task}: its state, owner, times, parent and children, and where it runs.', example: { task: 'task-1a2b' },
      operator: { method: 'tasks.get', fields: { taskId: 'task' } },
      async run(values, ctx) { return policyOf().detail(ctx, await findTask(ctx, values.task!)).join('\n'); },
    }),
    readAction<CommandActionContext>({
      id: 'output', label: 'See what a task produced', word: 'output', inputs: [TASK],
      sentence: 'Shows the result of task {task}, or its error.', example: { task: 'task-1a2b' },
      operator: { method: 'tasks.get', fields: { taskId: 'task' } },
      async run(values, ctx) {
        const { task } = await findTask(ctx, values.task!);
        return typeof task.result === 'string'
          ? task.result
          : task.result !== undefined ? JSON.stringify(task.result, null, 2) : (task.error ?? task.description ?? task.title);
      },
    }),
    change({
      id: 'create', label: 'Add a task to run here', word: 'create',
      inputs: [
        choiceInput({ id: 'kind', label: 'Kind', help: 'What runs it', choices: KINDS, typed: { position: 1 } }),
        textInput({ id: 'owner', label: 'Owner', help: 'Who or what it belongs to, such as engineer', why: 'a name you choose', typed: { position: 2 } }),
        textInput({ id: 'title', label: 'Title', help: 'What it is', why: 'your own words', typed: { tail: true } }),
      ],
      sentence: 'Task {title} ({kind}, for {owner}) is added to this terminal and waits to be started, until you change it.', example: { kind: 'exec', owner: 'engineer', title: 'run the migrations' },
      undoneBy: 'cancel',
      async run(values, ctx) {
        // Created here on purpose: a task this command creates is a record the
        // owner drives in this terminal. Submitting work to the daemon is what
        // /schedule and the channel surfaces do.
        const task = mutationsOf(ctx).tasks.create({ kind: values.kind as TaskKind, owner: values.owner!, title: values.title!, description: values.title! });
        return `Created task ${task.id} (${task.kind}) for ${task.owner}; it waits until /tasks start ${task.id}.`;
      },
    }),
    change({
      id: 'start', label: 'Start a waiting task', word: 'start', inputs: [OPEN_TASK],
      sentence: 'Task {task} starts now, until you change it.', example: { task: 'task-1a2b' }, undoneBy: 'pause',
      run: (values, ctx) => changeTask(ctx, values.task!, 'start', (tasks) => `Task ${values.task} is ${tasks.start(values.task!).status}.`),
    }),
    change({
      id: 'update', label: 'Change a task\'s title, description or result', word: 'update',
      inputs: [
        TASK,
        choiceInput({ id: 'field', label: 'What changes', help: 'Which part of the task', choices: [{ value: 'title', label: 'Its title' }, { value: 'description', label: 'Its description' }, { value: 'result', label: 'Its result' }], typed: { position: 2 } }),
        textInput({ id: 'value', label: 'New text', help: 'What it says now', why: 'your own words', kind: 'long-text', typed: { tail: true } }),
      ],
      sentence: 'The {field} of task {task} becomes "{value}", until you change it.', example: { task: 'task-1a2b', field: 'title', value: 'run the migrations again' },
      run: (values, ctx) => changeTask(ctx, values.task!, 'update', (tasks) => {
        tasks.update(values.task!, values.field === 'result' ? { result: values.value! } : { [values.field!]: values.value! });
        return `Updated the ${values.field} of task ${values.task}.`;
      }),
    }),
    change({
      id: 'complete', label: 'Mark a task done', word: 'complete',
      inputs: [OPEN_TASK, { ...NOTE, id: 'result', label: 'Result', help: 'What it produced', required: { default: '', defaultMeans: 'no result' } }],
      sentence: 'Task {task} is marked done, until you change it.', example: { task: 'task-1a2b' },
      run: (values, ctx) => changeTask(ctx, values.task!, 'complete', (tasks) => { tasks.complete(values.task!, values.result || undefined); return `Completed task ${values.task}.`; }),
    }),
    change({
      id: 'fail', label: 'Mark a task failed', word: 'fail',
      inputs: [OPEN_TASK, textInput({ id: 'error', label: 'What went wrong', help: 'Kept as its error', why: 'your own words', kind: 'long-text', typed: { tail: true } })],
      sentence: 'Task {task} is marked failed with "{error}", until you change it.', example: { task: 'task-1a2b', error: 'the build broke' },
      undoneBy: 'retry',
      run: (values, ctx) => changeTask(ctx, values.task!, 'fail', (tasks) => { tasks.fail(values.task!, { error: values.error! }); return `Marked task ${values.task} failed.`; }),
    }),
    change({
      id: 'pause', label: 'Pause a task', word: 'pause', inputs: [OPEN_TASK, NOTE],
      sentence: 'Task {task} waits where it is, until you change it.', example: { task: 'task-1a2b' }, undoneBy: 'resume',
      run: (values, ctx) => changeTask(ctx, values.task!, 'pause', async (tasks) => { await tasks.pause(values.task!, values.note || undefined); return `Paused task ${values.task}.`; }),
    }),
    change({
      id: 'resume', label: 'Resume a paused task', word: 'resume', inputs: [OPEN_TASK, NOTE],
      sentence: 'Task {task} goes on from where it waited, until you change it.', example: { task: 'task-1a2b' }, undoneBy: 'pause',
      run: (values, ctx) => changeTask(ctx, values.task!, 'resume', async (tasks) => { await tasks.resume(values.task!, values.note || undefined); return `Resumed task ${values.task}.`; }),
    }),
    change({
      id: 'cancel', label: 'Cancel a task', word: 'cancel', inputs: [OPEN_TASK, NOTE],
      sentence: 'Task {task} is stopped and marked cancelled.', example: { task: 'task-1a2b' }, risk: 'cannot-be-undone',
      run: (values, ctx) => changeTask(ctx, values.task!, 'cancel', async (tasks) => { await tasks.cancel(values.task!, values.note || undefined); return `Cancelled task ${values.task}.`; }),
    }),
    change({
      id: 'retry', label: 'Run a failed task again', word: 'retry',
      inputs: [listInput({ id: 'task', label: 'Task', help: 'Tasks that failed or were cancelled', list: ENDED_TASKS, other: 'a task id' }), NOTE],
      sentence: 'Task {task} is queued to run again, until you change it.', example: { task: 'task-1a2b' },
      run: (values, ctx) => changeTask(ctx, values.task!, 'retry', async (tasks) => { await tasks.retry(values.task!, values.note || undefined); return `Re-queued task ${values.task}.`; }),
    }),
  ],
};

const TASKS_SLASH_COMMAND = defineCommand(TASKS_COMMAND);

/** `/tasks` for one app: the one description, reading and changing tasks through this app's policy. */
export function createTasksRuntimeCommands<Context extends CommandActionContext>(policy: TasksPolicy<Context>) {
  function registerTasksRuntimeCommands(registry: Pick<TerminalCommandRegistry<Context>, 'register'>): void {
    installed = policy as unknown as TasksPolicy<CommandActionContext>;
    registry.register(TASKS_SLASH_COMMAND as never);
  }
  return { registerTasksRuntimeCommands };
}

