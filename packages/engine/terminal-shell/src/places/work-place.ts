/**
 * work-place.ts, the Work place (group "Work and agents"): your work, each
 * piece with what you asked for, what done means, where it stands, its plan
 * (its steps and what each waits on) and its results; a plan that waits for
 * you before it runs; past work, finished, stopped or brought in from old
 * records; the project's checklist; and the tasks running in the background,
 * here and on the daemon.
 *
 * Work is read from the daemon (`work.list`: the ledger, its one runner and
 * the plans that wait, one call) and read again on every change to a request,
 * the ledger or a run (`workspace` frames, NATIVE_REQUEST_CHANGED), a run's
 * progress (`contracts`) and a plan's change (LIST_CHANGED `work`). The
 * checklist is the program's own view of the shared file (session source
 * `checklist`), told of every commit from any program; this program's own
 * tasks are its session source `tasks-here`. The remote runners, their pools
 * and what they hand back are the second engineer's lists
 * (work-agents-entries.ts), in the same place.
 *
 * Everything is declared as lists, rows, detail lines and actions: a work's
 * plan and what each step waits on are detail lines, so a web renderer draws
 * the same declaration with nothing of its own.
 */
import { WORK_AGENT_ACTIONS, WORK_AGENT_LISTS, type WorkAgentItem } from './work-agents-entries.js';
import { definePlace, type PlaceAction, type PlaceDetailLine, type PlaceFollow, type PlaceItem, type PlaceList } from './place-types.js';

type WorkState = 'not-started' | 'plan-waiting' | 'starting' | 'running' | 'needs-you' | 'done' | 'failed' | 'stopped';

interface WorkStep { readonly id: string; readonly title: string; readonly status: string; readonly dependsOn: readonly string[] }
interface WorkItem extends PlaceItem {
  readonly kind: 'work';
  readonly state: WorkState;
  readonly title: string;
  readonly goal: string;
  readonly criteria: readonly string[];
  readonly imported: boolean;
  readonly verification: string;
  readonly attention: readonly string[];
  readonly report?: string | undefined;
  readonly blocker?: string | undefined;
  readonly steps: readonly WorkStep[];
  readonly results: readonly { readonly text: string; readonly status: string }[];
  readonly questions: readonly string[];
  readonly statusLine?: string | undefined;
  readonly budget?: string | undefined;
  /** Its plan before it runs, while one is held. */
  readonly plan?: { readonly state: string; readonly how: string; readonly reason?: string | undefined; readonly steps: readonly WorkStep[] } | undefined;
}

interface ChecklistItem extends PlaceItem {
  readonly kind: 'checklist';
  readonly title: string;
  readonly owner?: string | undefined;
  readonly notes?: string | undefined;
}

interface TaskItem extends PlaceItem {
  readonly kind: 'task';
  readonly title: string;
  readonly taskKind: string;
  readonly owner: string;
  readonly error?: string | undefined;
}

type Item = WorkItem | ChecklistItem | TaskItem | WorkAgentItem;

/** Text from another process, shown on one line: control characters out. */
const plain = (value: unknown): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').trim() : '';
const record = (value: unknown): Readonly<Record<string, unknown>> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : [];

const STATES = new Set<WorkState>(['not-started', 'plan-waiting', 'starting', 'running', 'needs-you', 'done', 'failed', 'stopped']);

const STATE_WORDS: Readonly<Record<WorkState, string>> = {
  'not-started': 'not started', 'plan-waiting': 'its plan waits for you', starting: 'starting', running: 'running', 'needs-you': 'needs you',
  done: 'done', failed: 'failed', stopped: 'stopped',
};

const STEP_WORDS: Readonly<Record<string, string>> = {
  pending: 'waiting', blocked: 'waiting on another step', running: 'running', checking: 'being checked', held: 'held', nudged: 'running',
  fixing: 'being fixed', 'awaiting-owner': 'needs you', 'held-merge': 'done, waiting to merge', passed: 'done', failed: 'failed', cancelled: 'stopped',
};

const RESULT_WORDS: Readonly<Record<string, string>> = { met: 'met', unmet: 'not met', unshown: 'not shown yet' };

function budgetWords(value: unknown): string | undefined {
  const budget = record(value);
  const cost = typeof budget['maxCostUsd'] === 'number' ? `$${budget['maxCostUsd']}` : '';
  const tokens = typeof budget['maxTokens'] === 'number' ? `${budget['maxTokens']} tokens` : '';
  return [cost, tokens].filter(Boolean).join(', ') || undefined;
}

const stepsOf = (value: unknown): readonly WorkStep[] => list(value).map(record).map((step) => ({
  id: plain(step['id']), title: plain(step['title']) || plain(step['id']), status: plain(step['status']), dependsOn: list(step['dependsOn']).map(plain).filter(Boolean),
}));

function works(output: unknown): readonly WorkItem[] {
  return list(record(output)['works']).map(record).filter((work) => plain(work['id'])).map((work): WorkItem => {
    const run = work['run'] === null ? {} : record(work['run']);
    const attempt = work['attempt'] === null ? {} : record(work['attempt']);
    const plan = work['plan'] === null || work['plan'] === undefined ? undefined : record(work['plan']);
    const state = STATES.has(work['state'] as WorkState) ? work['state'] as WorkState : 'not-started';
    return {
      kind: 'work',
      id: plain(work['id']),
      state,
      title: plain(work['title']) || plain(work['id']),
      goal: plain(work['goal']),
      criteria: list(work['criteria']).map(plain).filter(Boolean),
      imported: work['imported'] === true,
      verification: plain(record(work['verification'])['reason']),
      attention: list(work['attention']).map(plain).filter(Boolean),
      ...(plain(attempt['report']) ? { report: plain(attempt['report']) } : {}),
      ...(plain(attempt['blocker']) ? { blocker: plain(attempt['blocker']) } : {}),
      steps: stepsOf(run['steps']),
      results: list(run['results']).map(record).map((result) => ({ text: plain(result['text']), status: plain(result['status']) })),
      questions: list(run['questions']).map(record).map((question) => plain(question['question'])).filter(Boolean),
      ...(plain(run['statusLine']) ? { statusLine: plain(run['statusLine']) } : {}),
      ...(budgetWords(run['budget']) ? { budget: budgetWords(run['budget']) } : {}),
      ...(plan ? { plan: { state: plain(plan['state']), how: plain(plan['how']), ...(plain(plan['reason']) ? { reason: plain(plan['reason']) } : {}), steps: stepsOf(plan['steps']) } } : {}),
    };
  });
}

const PAST: ReadonlySet<WorkState> = new Set(['done', 'stopped']);
// Read through `capabilities.run` (`work.list`), whose answer carries the list in `data`.
const liveWorks = (output: unknown): readonly WorkItem[] => works(record(output)['data']).filter((work) => !work.imported && !PAST.has(work.state));
const pastWorks = (output: unknown): readonly WorkItem[] => works(record(output)['data']).filter((work) => work.imported || PAST.has(work.state));

function checklist(raw: unknown): readonly ChecklistItem[] {
  return list(raw).map(record).filter((task) => plain(task['taskId'])).map((task): ChecklistItem => ({
    kind: 'checklist',
    id: plain(task['taskId']),
    state: plain(task['status']) || 'pending',
    title: plain(task['title']) || plain(task['taskId']),
    ...(plain(task['owner']) ? { owner: plain(task['owner']) } : {}),
    ...(plain(task['notes']) ? { notes: plain(task['notes']) } : {}),
  }));
}

function tasks(raw: unknown): readonly TaskItem[] {
  return list(raw).map(record).filter((task) => plain(task['id'])).map((task): TaskItem => ({
    kind: 'task', id: plain(task['id']), state: plain(task['status']) || 'queued', title: plain(task['title']) || plain(task['id']),
    taskKind: plain(task['kind']), owner: plain(task['owner']), ...(plain(task['error']) ? { error: plain(task['error']) } : {}),
  }));
}
const daemonTasks = (output: unknown): readonly TaskItem[] => tasks(record(output)['tasks']);

/** A request, the ledger or a run changed (workspace), a run moved on (contracts), or a plan changed (the `work` list). */
const WORK_EVENTS: PlaceFollow = { domains: ['workspace', 'contracts'], events: ['workspace', 'contracts'], lists: ['work'] };
const TASK_EVENTS: PlaceFollow = { domains: ['tasks'], events: ['tasks'] };

const CHECKLIST_WORDS: Readonly<Record<string, string>> = {
  pending: 'not started', in_progress: 'in progress', blocked: 'blocked', done: 'done', failed: 'failed', cancelled: 'cancelled',
};
const TASK_WORDS: Readonly<Record<string, string>> = {
  queued: 'waiting to start', running: 'running', blocked: 'paused', completed: 'done', failed: 'failed', cancelled: 'cancelled',
};

/** A plan's steps, each with what it waits on: the plan as a graph, in lines. */
function planLines(label: string, steps: readonly WorkStep[]): PlaceDetailLine[] {
  const number = new Map(steps.map((step, index) => [step.id, index + 1]));
  return steps.map((step, index) => {
    const after = step.dependsOn.map((id) => number.get(id)).filter((value): value is number => value !== undefined);
    const state = step.status ? `: ${STEP_WORDS[step.status] ?? step.status}` : '';
    return { label: index === 0 ? label : '', text: `${index + 1}. ${step.title}${state}${after.length > 0 ? ` (after ${after.join(', ')})` : ''}` };
  });
}

function workDetail(item: Item): readonly PlaceDetailLine[] {
  const work = item as WorkItem;
  const lines: PlaceDetailLine[] = [
    { label: 'Where it stands', text: work.imported ? 'brought in from old planning records' : STATE_WORDS[work.state] },
    ...(work.statusLine ? [{ label: 'Now', text: work.statusLine }] : []),
    ...work.questions.map((question) => ({ label: 'It asks', text: question, tone: 'warning' as const })),
    ...(work.blocker ? [{ label: 'Held up by', text: work.blocker, tone: 'warning' as const }] : []),
    ...work.attention.map((reason) => ({ label: 'Needs a look', text: reason, tone: 'warning' as const })),
    ...(work.budget ? [{ label: 'May spend', text: work.budget }] : []),
    { text: '' },
    { label: 'What you asked for', text: work.goal || work.title },
    ...work.criteria.map((criterion, index) => ({ label: index === 0 ? 'Done when' : '', text: criterion })),
    { text: '' },
  ];
  if (work.steps.length > 0) lines.push(...planLines('Plan', work.steps));
  else if (work.plan) {
    if (work.plan.state === 'writing') lines.push({ label: 'Plan', text: 'being written', tone: 'muted' });
    else if (work.plan.state === 'failed') lines.push({ label: 'Plan', text: work.plan.reason ?? 'could not be written', tone: 'warning' });
    else {
      lines.push(...planLines(work.plan.state === 'approved' ? 'Plan (approved)' : 'Plan (waits for you)', work.plan.steps));
      if (work.plan.how) lines.push({ label: '', text: work.plan.how, tone: 'muted' });
    }
  } else lines.push({ label: 'Plan', text: work.state === 'not-started' ? 'written when it starts' : work.state === 'starting' ? 'being written' : 'no steps recorded', tone: 'muted' });
  if (work.results.length > 0) {
    lines.push({ text: '' });
    work.results.forEach((result, index) => lines.push({ label: index === 0 ? 'Results' : '', text: `${result.text}: ${RESULT_WORDS[result.status] ?? result.status}` }));
  }
  if (work.report) lines.push({ text: '' }, { label: 'Report', text: work.report });
  if (work.verification) lines.push({ label: 'Checked', text: work.verification, tone: 'muted' });
  return lines;
}

function workRow(item: Item) {
  const work = item as WorkItem;
  return {
    title: work.title,
    ...(work.state === 'running' ? {} : { right: work.imported ? 'brought in' : STATE_WORDS[work.state] }),
    mark: work.state === 'needs-you' || work.state === 'plan-waiting' ? 'waiting' as const : work.state === 'failed' ? 'attention' as const
      : work.state === 'running' || work.state === 'starting' ? 'running' as const : work.state === 'stopped' || work.state === 'not-started' ? 'paused' as const : 'ok' as const,
  };
}

const workList: PlaceList<Item> = {
  id: 'work',
  label: 'Work',
  noun: 'your work',
  source: { kind: 'daemon', method: 'capabilities.run', input: { id: 'work.list' }, items: liveWorks },
  follows: WORK_EVENTS,
  empty: 'No work going on. Say what you want done in the conversation, or ask for new work here.',
  row: workRow,
  detail: workDetail,
};

const historyList: PlaceList<Item> = {
  id: 'history',
  label: 'History',
  noun: 'your past work',
  source: { kind: 'daemon', method: 'capabilities.run', input: { id: 'work.list' }, items: pastWorks },
  follows: WORK_EVENTS,
  empty: 'No past work yet: finished, stopped and brought-in work is kept here.',
  row: workRow,
  detail: workDetail,
};

const checklistList: PlaceList<Item> = {
  id: 'checklist',
  label: 'Checklist',
  noun: 'this project\'s checklist',
  source: { kind: 'session', name: 'checklist', items: checklist },
  empty: 'The checklist is empty: the model adds to it while it works, and so can you.',
  row: (item) => {
    const entry = item as ChecklistItem;
    return {
      title: entry.title,
      ...(entry.state === 'pending' ? {} : { right: CHECKLIST_WORDS[entry.state] ?? entry.state }),
      mark: entry.state === 'done' ? 'ok' : entry.state === 'blocked' || entry.state === 'failed' ? 'attention' : entry.state === 'in_progress' ? 'running' : 'paused',
    };
  },
  detail: (item) => {
    const entry = item as ChecklistItem;
    return [
      { label: 'State', text: CHECKLIST_WORDS[entry.state] ?? entry.state },
      ...(entry.owner ? [{ label: 'For', text: entry.owner }] : []),
      ...(entry.notes ? [{ label: 'Notes', text: entry.notes }] : []),
    ];
  },
};

function taskRow(item: Item) {
  const task = item as TaskItem;
  return {
    title: task.title, right: TASK_WORDS[task.state] ?? task.state,
    mark: task.state === 'failed' ? 'attention' as const : task.state === 'running' || task.state === 'queued' ? 'running' as const : task.state === 'blocked' ? 'paused' as const : 'ok' as const,
  };
}
function taskDetail(item: Item): readonly PlaceDetailLine[] {
  const task = item as TaskItem;
  return [
    { label: 'State', text: TASK_WORDS[task.state] ?? task.state },
    { label: 'Kind', text: task.taskKind || 'not said' },
    { label: 'For', text: task.owner || 'not said' },
    ...(task.error ? [{ label: 'What went wrong', text: task.error, tone: 'warning' as const }] : []),
  ];
}

const tasksHereList: PlaceList<Item> = {
  id: 'tasks-here',
  label: 'Tasks here',
  noun: 'this program\'s tasks',
  source: { kind: 'session', name: 'tasks-here', items: tasks },
  empty: 'Nothing runs in the background here.',
  row: taskRow,
  detail: taskDetail,
};

const daemonTasksList: PlaceList<Item> = {
  id: 'daemon-tasks',
  label: 'Daemon tasks',
  noun: 'the daemon\'s tasks',
  source: { kind: 'daemon', method: 'tasks.list', input: {}, items: daemonTasks },
  follows: TASK_EVENTS,
  empty: 'Nothing runs in the background on the daemon.',
  row: taskRow,
  detail: taskDetail,
};

const LIVE: readonly WorkState[] = ['starting', 'running', 'needs-you'];
const OPEN_TASK = ['queued', 'running', 'blocked'];

const WORK_ACTIONS: readonly PlaceAction<Item>[] = [
  // Asking for work: a goal and what done means, your own words, a file; and a task of this program.
  { key: 'n', id: 'new-work', capability: 'work.new', label: 'new work' },
  { key: 'y', id: 'ask', capability: 'work.request', label: 'ask in your own words' },
  { key: 'f', id: 'from-a-file', capability: 'work.submit-file', label: 'work from a file' },
  // One piece of work, by where it stands.
  { key: 's', id: 'start', list: 'work', states: ['not-started'], capability: 'work.start', label: 'start', fill: { work: 'id' } },
  { key: 'x', id: 'stop', list: 'work', states: [...LIVE], capability: 'work.cancel', label: 'stop', fill: { work: 'id' } },
  { key: 'g', id: 'go-on', list: 'work', states: ['failed', 'starting'], capability: 'work.resume', label: 'go on', fill: { work: 'id' } },
  { key: 'a', id: 'answer', list: 'work', states: ['needs-you'], capability: 'work.answer', label: 'answer', fill: { work: 'id' } },
  { key: 't', id: 'step-again', list: 'work', states: ['needs-you', 'running', 'failed'], capability: 'work.retry', label: 'run a step again', fill: { work: 'id' } },
  { key: 'b', id: 'spending-limit', list: 'work', states: [...LIVE], capability: 'work.budget', label: 'spending limit', fill: { work: 'id' } },
  { key: 'v', id: 'check', list: 'work', states: [...LIVE, 'failed'], capability: 'work.status', label: 'check', fill: { work: 'id' } },
  { key: 'v', id: 'check-past', list: 'history', states: ['done', 'stopped', 'failed'], capability: 'work.status', label: 'check', fill: { work: 'id' } },
  // A plan that waits for you.
  { key: 'enter', id: 'approve', list: 'work', states: ['plan-waiting'], capability: 'work.approve', label: 'approve and start', fill: { work: 'id' } },
  { key: 'e', id: 'change-step', list: 'work', states: ['plan-waiting'], capability: 'work.step-edit', label: 'change a step', fill: { work: 'id' } },
  { key: 'd', id: 'take-step-out', list: 'work', states: ['plan-waiting'], capability: 'work.step-drop', label: 'take a step out', fill: { work: 'id' } },
  { key: 'm', id: 'move-step', list: 'work', states: ['plan-waiting'], capability: 'work.step-move', label: 'move a step', fill: { work: 'id' } },
  { key: 'w', id: 'write-again', list: 'work', states: ['plan-waiting'], capability: 'work.plan-redo', label: 'write it again', fill: { work: 'id' } },
  { key: 'X', id: 'throw-away', list: 'work', states: ['plan-waiting'], capability: 'work.plan-discard', label: 'throw the plan away', fill: { work: 'id' } },
  // The checklist.
  { key: 'p', id: 'add-to-checklist', capability: 'work.checklist-add', label: 'put on the checklist' },
  { key: 'enter', id: 'change-item', list: 'checklist', capability: 'work.checklist-edit', label: 'change', fill: { item: 'id' } },
  { key: 'm', id: 'mark-item', list: 'checklist', capability: 'work.checklist-mark', label: 'mark', fill: { item: 'id' } },
  { key: 'o', id: 'move-on', list: 'checklist', capability: 'work.checklist-next', label: 'move on', fill: { item: 'id' } },
  { key: 'x', id: 'take-off', list: 'checklist', capability: 'work.checklist-remove', label: 'take off', fill: { item: 'id' } },
  { key: 'C', id: 'clear-finished', list: 'checklist', capability: 'work.checklist-clear-done', label: 'clear finished' },
  { key: 'M', id: 'as-markdown', list: 'checklist', capability: 'work.checklist-markdown', label: 'as Markdown' },
  { key: 'E', id: 'save-markdown', list: 'checklist', capability: 'work.checklist-export', label: 'save as a file' },
  // Tasks here: this program's own; the daemon's take only cancel and run again.
  { key: 'k', id: 'add-task', list: 'tasks-here', capability: 'work.task-add', label: 'add a task' },
  { key: 'P', id: 'background-commands', list: 'tasks-here', capability: 'work.processes', label: 'background commands' },
  { key: 'enter', id: 'task-detail', list: 'tasks-here', capability: 'work.task', label: 'details', fill: { task: 'id' } },
  { key: 'v', id: 'task-output', list: 'tasks-here', capability: 'work.task-output', label: 'what it produced', fill: { task: 'id' } },
  { key: 's', id: 'start-task', list: 'tasks-here', states: ['queued'], capability: 'work.task-start', label: 'start', fill: { task: 'id' } },
  { key: 'e', id: 'change-task', list: 'tasks-here', capability: 'work.task-change', label: 'change', fill: { task: 'id' } },
  { key: 'o', id: 'task-done', list: 'tasks-here', states: OPEN_TASK, capability: 'work.task-done', label: 'done', fill: { task: 'id' } },
  { key: 'F', id: 'task-failed', list: 'tasks-here', states: OPEN_TASK, capability: 'work.task-failed', label: 'mark failed', fill: { task: 'id' } },
  { key: 'z', id: 'pause-task', list: 'tasks-here', states: ['running', 'queued'], capability: 'work.task-pause', label: 'pause', fill: { task: 'id' } },
  { key: 'z', id: 'resume-task', list: 'tasks-here', states: ['blocked'], capability: 'work.task-resume', label: 'resume', fill: { task: 'id' } },
  { key: 'x', id: 'cancel-task', list: 'tasks-here', states: OPEN_TASK, capability: 'work.task-cancel', label: 'cancel', fill: { task: 'id' } },
  { key: 't', id: 'retry-task', list: 'tasks-here', states: ['failed', 'cancelled'], capability: 'work.task-retry', label: 'run again', fill: { task: 'id' } },
  { key: 'enter', id: 'daemon-task-detail', list: 'daemon-tasks', capability: 'work.task', label: 'details', fill: { task: 'id' } },
  { key: 'v', id: 'daemon-task-output', list: 'daemon-tasks', capability: 'work.task-output', label: 'what it produced', fill: { task: 'id' } },
  { key: 'x', id: 'cancel-daemon-task', list: 'daemon-tasks', states: OPEN_TASK, capability: 'work.task-cancel', label: 'cancel', fill: { task: 'id' } },
  { key: 't', id: 'retry-daemon-task', list: 'daemon-tasks', states: ['failed', 'cancelled'], capability: 'work.task-retry', label: 'run again', fill: { task: 'id' } },
];

export const WORK_PLACE = definePlace<Item>({
  id: 'work',
  group: 'work',
  title: 'Work and agents',
  lists: [workList, historyList, checklistList, tasksHereList, daemonTasksList, ...(WORK_AGENT_LISTS as readonly PlaceList<Item>[])],
  actions: [...WORK_ACTIONS, ...(WORK_AGENT_ACTIONS as readonly PlaceAction<Item>[])],
  count: (lists) => {
    const waiting = (lists.work ?? []).filter((item) => item.state === 'needs-you' || item.state === 'plan-waiting').length;
    const failed = (lists.work ?? []).filter((item) => item.state === 'failed').length;
    if (waiting > 0) return { count: waiting, words: `${waiting} need${waiting === 1 ? 's' : ''} you`, tone: 'waiting' };
    return failed > 0 ? { count: failed, words: `${failed} failed`, tone: 'wrong' } : undefined;
  },
});
