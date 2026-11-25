/**
 * Tasks: what runs in the background, here and on the daemon (a command, an
 * agent, a hosted coding agent, a scheduled run, a tool server call). The
 * program holding the conversation runs its own and reads the daemon's, so
 * these run there (home `session`): a task of this program changes in its own
 * registry; a daemon task takes only cancel and run-again, through the
 * daemon's own methods (`tasks.cancel`, `tasks.retry`), and a change the daemon
 * has no method for is refused by name. The Agent reads tasks and changes none.
 */
import { CapabilityRefusal, type CapabilityDefinition, type FixedChoice, type InputDescription, type ListName } from '../types.js';

/** What the task capabilities need: this program's tasks and the daemon's, each act in words. */
export interface TasksCapabilityServices {
  readonly tasks?: {
    list(filter: { readonly status?: string | undefined; readonly kind?: string | undefined }): Promise<string>;
    show(task: string): Promise<string>;
    output(task: string): Promise<string>;
    processes(): Promise<string>;
    create(kind: string, owner: string, title: string): Promise<string>;
    start(task: string): Promise<string>;
    update(task: string, field: string, value: string): Promise<string>;
    complete(task: string, result: string): Promise<string>;
    fail(task: string, error: string): Promise<string>;
    pause(task: string, note: string): Promise<string>;
    resume(task: string, note: string): Promise<string>;
    cancel(task: string, note: string): Promise<string>;
    retry(task: string, note: string): Promise<string>;
  } | undefined;
}

/** The lists the task inputs choose from (registered in terminal-shell, tasks-runtime-commands.ts). */
export const TASKS_LIST = 'tasks' as ListName;
export const OPEN_TASKS_LIST = 'tasks.open' as ListName;
export const ENDED_TASKS_LIST = 'tasks.ended' as ListName;

const STATUSES: readonly FixedChoice[] = [
  { value: 'queued', label: 'Waiting to start' }, { value: 'running', label: 'Running' }, { value: 'blocked', label: 'Paused or blocked' },
  { value: 'completed', label: 'Done' }, { value: 'failed', label: 'Failed' }, { value: 'cancelled', label: 'Cancelled' },
];
const KINDS: readonly FixedChoice[] = [
  { value: 'exec', label: 'A command' }, { value: 'agent', label: 'An agent' }, { value: 'acp', label: 'A hosted coding agent' },
  { value: 'scheduler', label: 'A scheduled run' }, { value: 'daemon', label: 'Daemon work' }, { value: 'mcp', label: 'A tool server call' },
  { value: 'plugin', label: 'A plugin' }, { value: 'integration', label: 'An integration' },
];

const task = (list: ListName, help: string): InputDescription => ({
  id: 'task', label: 'Task', help, kind: 'choice', choices: { list, allowOther: { reason: 'a task id' } }, required: true, typed: { position: 1 },
});
const ANY = task(TASKS_LIST, 'Tasks here and on the daemon, newest first');
const OPEN = task(OPEN_TASKS_LIST, 'Tasks that have not finished');
const ENDED = task(ENDED_TASKS_LIST, 'Tasks that failed or were cancelled');
const NOTE: InputDescription = { id: 'note', label: 'Note', help: 'Why, kept with the task', kind: 'long-text', freeTextReason: 'your own words', required: { default: '', defaultMeans: 'no note' }, typed: { tail: true } };

function servicesOf(services: TasksCapabilityServices): NonNullable<TasksCapabilityServices['tasks']> {
  if (!services.tasks) throw new CapabilityRefusal('Tasks are not available in this session.');
  return services.tasks;
}

type Tasks = CapabilityDefinition<TasksCapabilityServices>;

function read(id: string, actionId: string, label: string, sentence: string, inputs: readonly InputDescription[], example: Record<string, string>,
  run: (tasks: NonNullable<TasksCapabilityServices['tasks']>, values: Readonly<Record<string, string>>) => Promise<string>): Tasks {
  return {
    capability: { id, group: 'work', home: 'session', repeat: 'safe' }, actionId, label, word: actionId, inputs, sentence, done: '',
    touches: 'reads', lasts: 'not-a-change', risk: 'none', example,
    async run(values, services) { return { text: await run(servicesOf(services), values) }; },
  };
}

function change(id: string, actionId: string, label: string, sentence: string, inputs: readonly InputDescription[], example: Record<string, string>,
  run: (tasks: NonNullable<TasksCapabilityServices['tasks']>, values: Readonly<Record<string, string>>) => Promise<string>,
  extra: Partial<Pick<Tasks, 'risk' | 'undoneBy'>> & { readonly repeat?: 'safe' | 'unsafe' } = {}): Tasks {
  const { repeat, ...rest } = extra;
  return {
    capability: { id, group: 'work', home: 'session', repeat: repeat ?? 'safe' }, actionId, label, word: actionId, inputs, sentence, done: '',
    touches: 'this-machine', lasts: 'kept', risk: 'none', example, ...rest,
    async run(values, services) { return { text: await run(servicesOf(services), values) }; },
  };
}

export const TASKS_CAPABILITIES: readonly Tasks[] = [
  read('work.tasks', 'tasks', 'See your tasks',
    'Shows the tasks here and on the daemon, newest first, with their state, kind and owner.',
    [
      { id: 'status', label: 'Only', help: 'Tasks in one state', kind: 'choice', choices: STATUSES, required: { default: '', defaultMeans: 'every state' }, typed: { flag: '--status' } },
      { id: 'kind', label: 'Kind', help: 'Tasks of one kind', kind: 'choice', choices: KINDS, required: { default: '', defaultMeans: 'every kind' }, typed: { flag: '--kind' } },
    ], { status: 'running' }, (tasks, values) => tasks.list({ status: values.status || undefined, kind: values.kind || undefined })),
  read('work.task', 'task', 'See one task', 'Shows task {task}: its state, owner, times, parent and children, and where it runs.', [ANY], { task: 'task-1a2b' },
    (tasks, values) => tasks.show(values.task!)),
  read('work.task-output', 'task-output', 'See what a task produced', 'Shows the result of task {task}, or its error.', [ANY], { task: 'task-1a2b' },
    (tasks, values) => tasks.output(values.task!)),
  read('work.processes', 'processes', 'See commands running in the background',
    'Lists the commands running in the background here, which have finished, and whether a running one can be given input, a terminal, or sudo.', [], {},
    (tasks) => tasks.processes()),
  change('work.task-add', 'task-add', 'Add a task to run here',
    'Task {title} ({kind}, for {owner}) is added to this program and waits to be started, until you change it.',
    [
      { id: 'kind', label: 'Kind', help: 'What runs it', kind: 'choice', choices: KINDS, required: true, typed: { position: 1 } },
      { id: 'owner', label: 'Owner', help: 'Who or what it belongs to, such as engineer', kind: 'text', freeTextReason: 'a name you choose', required: true, typed: { position: 2 } },
      { id: 'title', label: 'Title', help: 'What it is', kind: 'text', freeTextReason: 'your own words', required: true, typed: { tail: true } },
    ], { kind: 'exec', owner: 'engineer', title: 'run the migrations' },
    (tasks, values) => tasks.create(values.kind!, values.owner!, values.title!), { repeat: 'unsafe', undoneBy: 'task-cancel' }),
  change('work.task-start', 'task-start', 'Start a waiting task', 'Task {task} starts now, until you change it.', [OPEN], { task: 'task-1a2b' },
    (tasks, values) => tasks.start(values.task!), { undoneBy: 'task-pause' }),
  change('work.task-change', 'task-change', 'Change a task\'s title, description or result', 'The {field} of task {task} becomes "{value}", until you change it.',
    [
      ANY,
      { id: 'field', label: 'What changes', help: 'Which part of the task', kind: 'choice', choices: [{ value: 'title', label: 'Its title' }, { value: 'description', label: 'Its description' }, { value: 'result', label: 'Its result' }], required: true, typed: { position: 2 } },
      { id: 'value', label: 'New text', help: 'What it says now', kind: 'long-text', freeTextReason: 'your own words', required: true, typed: { tail: true } },
    ], { task: 'task-1a2b', field: 'title', value: 'run the migrations again' }, (tasks, values) => tasks.update(values.task!, values.field!, values.value!)),
  change('work.task-done', 'task-done', 'Mark a task done', 'Task {task} is marked done, until you change it.',
    [OPEN, { ...NOTE, id: 'result', label: 'Result', help: 'What it produced', required: { default: '', defaultMeans: 'no result' } }], { task: 'task-1a2b' },
    (tasks, values) => tasks.complete(values.task!, values.result ?? '')),
  change('work.task-failed', 'task-failed', 'Mark a task failed', 'Task {task} is marked failed with "{error}", until you change it.',
    [OPEN, { id: 'error', label: 'What went wrong', help: 'Kept as its error', kind: 'long-text', freeTextReason: 'your own words', required: true, typed: { tail: true } }],
    { task: 'task-1a2b', error: 'the build broke' }, (tasks, values) => tasks.fail(values.task!, values.error!), { undoneBy: 'task-retry' }),
  change('work.task-pause', 'task-pause', 'Pause a task', 'Task {task} waits where it is, until you change it.', [OPEN, NOTE], { task: 'task-1a2b' },
    (tasks, values) => tasks.pause(values.task!, values.note ?? ''), { undoneBy: 'task-resume' }),
  change('work.task-resume', 'task-resume', 'Resume a paused task', 'Task {task} goes on from where it waited, until you change it.', [OPEN, NOTE], { task: 'task-1a2b' },
    (tasks, values) => tasks.resume(values.task!, values.note ?? ''), { undoneBy: 'task-pause' }),
  change('work.task-cancel', 'task-cancel', 'Cancel a task', 'Task {task} is stopped and marked cancelled.', [OPEN, NOTE], { task: 'task-1a2b' },
    (tasks, values) => tasks.cancel(values.task!, values.note ?? ''), { risk: 'cannot-be-undone' }),
  change('work.task-retry', 'task-retry', 'Run a failed task again', 'Task {task} is queued to run again, until you change it.', [ENDED, NOTE], { task: 'task-1a2b' },
    (tasks, values) => tasks.retry(values.task!, values.note ?? ''), { repeat: 'unsafe' }),
];
