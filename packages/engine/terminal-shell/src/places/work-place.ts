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
import { definePlace, type PlaceAction, type PlaceDetailLine, type PlaceFollow, type PlaceItem, type PlaceList, type PlaceProgramName } from './place-types.js';

/**
 * Where a piece of work stands. `step-failed` is the daemon's "a step failed" where the steps after it need its result;
 * `step-failed-go-on` the same where the work can go on without it (the place's own word, so "go on without it" shows
 * only there).
 */
type WorkState = 'not-started' | 'plan-waiting' | 'starting' | 'interrupted' | 'running' | 'needs-you' | 'step-failed' | 'step-failed-go-on' | 'done' | 'failed' | 'stopped';

interface WorkStep { readonly id: string; readonly title: string; readonly status: string; readonly dependsOn: readonly string[] }
/** The step the work stopped at when it failed. */
interface FailedStep { readonly id: string; readonly title: string; readonly reason: string; readonly canGoOn: boolean }
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
  readonly failedSteps: readonly FailedStep[];
  readonly statusLine?: string | undefined;
  /** What last held a step's change back, in words with what to do. */
  readonly held?: string | undefined;
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

/** Work you asked for, or a message you typed, that has no answer from the daemon yet (session source `unanswered`). */
interface UnansweredItem extends PlaceItem {
  readonly kind: 'sent-work' | 'typed-message';
  readonly title: string;
  readonly said: string;
}

type Item = WorkItem | ChecklistItem | TaskItem | UnansweredItem | WorkAgentItem;

/** Text from another process, shown on one line: control characters out. */
const plain = (value: unknown): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').trim() : '';
const record = (value: unknown): Readonly<Record<string, unknown>> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : [];

const STATES = new Set<WorkState>(['not-started', 'plan-waiting', 'starting', 'interrupted', 'running', 'needs-you', 'step-failed', 'done', 'failed', 'stopped']);

const STATE_WORDS: Readonly<Record<WorkState, string>> = {
  'not-started': 'not started', 'plan-waiting': 'its plan waits for you', starting: 'starting', interrupted: 'cut off when the daemon stopped; go on runs the parts that were running again',
  running: 'running', 'needs-you': 'needs you', 'step-failed': 'a step failed', 'step-failed-go-on': 'a step failed',
  done: 'done', failed: 'failed', stopped: 'stopped',
};
/** The word a row has room for; the detail says it in full. */
const ROW_WORDS: Partial<Readonly<Record<WorkState, string>>> = { 'plan-waiting': 'plan waits', interrupted: 'cut off', 'step-failed': 'step failed', 'step-failed-go-on': 'step failed' };

const STEP_WORDS: Readonly<Record<string, string>> = {
  pending: 'waiting', blocked: 'waiting on another step', running: 'running', checking: 'being checked', held: 'held', nudged: 'running',
  fixing: 'being fixed', 'awaiting-owner': 'needs you', 'held-merge': 'done, waiting to merge', passed: 'done', failed: 'failed', cancelled: 'stopped',
};

const RESULT_WORDS: Readonly<Record<string, string>> = { met: 'met', unmet: 'not met', unshown: 'not shown yet', unread: 'not checked yet' };

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
    const failedSteps = list(run['failedSteps']).map(record).filter((step) => plain(step['id'])).map((step): FailedStep => ({
      id: plain(step['id']), title: plain(step['title']) || plain(step['id']), reason: plain(step['reason']), canGoOn: step['canGoOn'] === true,
    }));
    const said = STATES.has(work['state'] as WorkState) ? work['state'] as WorkState : 'not-started';
    // A failed step the work can go on without has its own word here, so "go on without it" shows only there.
    const state: WorkState = said === 'step-failed' && failedSteps.length > 0 && failedSteps.every((step) => step.canGoOn) ? 'step-failed-go-on' : said;
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
      failedSteps,
      // The run words its own status line in the words of a piece of work (contract/runner.ts `workStatusWords`).
      ...(plain(run['statusLine']) ? { statusLine: plain(run['statusLine']) } : {}),
      ...(plain(run['held']) ? { held: plain(run['held']) } : {}),
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

/**
 * A request, the ledger or a run changed (NATIVE_REQUEST_CHANGED), a run moved on (contracts), or a plan changed (the
 * `work` list). Named by type, never as every `workspace` frame: that domain carries every list change notice of every place.
 */
const WORK_EVENTS: PlaceFollow = { domains: ['workspace', 'contracts'], events: ['NATIVE_REQUEST_CHANGED', 'contracts'], lists: ['work'] };
const TASK_EVENTS: PlaceFollow = { domains: ['tasks'], events: ['tasks'] };

const CHECKLIST_WORDS: Readonly<Record<string, string>> = {
  pending: 'not started', in_progress: 'in progress', blocked: 'blocked', done: 'done', failed: 'failed', cancelled: 'cancelled',
};
const TASK_WORDS: Readonly<Record<string, string>> = {
  queued: 'waiting to start', running: 'running', blocked: 'paused', completed: 'done', failed: 'failed', cancelled: 'cancelled',
};

/** A plan's steps, each with what it waits on: the plan as a graph, in lines. */
function planLines(label: string, steps: readonly WorkStep[], work?: WorkItem): PlaceDetailLine[] {
  const number = new Map(steps.map((step, index) => [step.id, index + 1]));
  const failed = new Set(work?.failedSteps.map((step) => step.id) ?? []);
  const live = work !== undefined && !PAST.has(work.state) && work.state !== 'failed';
  return steps.map((step, index) => {
    const after = step.dependsOn.map((id) => number.get(id)).filter((value): value is number => value !== undefined);
    // The step the work stopped at failed (its record waits on you, but nothing is asked); one stopped in live work was left out.
    // In work cut off by the daemon stopping, a step that was running is not running now: it runs again on go on.
    const cutOff = work?.state === 'interrupted' && ['running', 'checking', 'nudged', 'fixing'].includes(step.status);
    const words = failed.has(step.id) ? 'failed, the work stopped here' : cutOff ? 'cut off, runs again when you go on'
      : live && step.status === 'cancelled' ? 'left out' : STEP_WORDS[step.status] ?? step.status;
    const state = step.status ? `: ${words}` : '';
    return { label: index === 0 ? label : '', text: `${index + 1}. ${step.title}${state}${after.length > 0 ? ` (after ${after.join(', ')})` : ''}` };
  });
}

function workDetail(item: Item): readonly PlaceDetailLine[] {
  const work = item as WorkItem;
  const lines: PlaceDetailLine[] = [
    { label: 'Where it stands', text: work.imported ? 'carried in from old planning records' : STATE_WORDS[work.state] },
    ...(work.statusLine ? [{ label: 'Now', text: work.statusLine }] : []),
    ...(work.held ? [{ label: 'Held back', text: work.held, tone: 'warning' as const }] : []),
    // The step it stopped at: what failed, and whether the work can go on without it. Nothing is asked of anyone.
    ...work.failedSteps.flatMap((step) => [
      { label: 'Stopped at', text: `${step.title}, which failed`, tone: 'warning' as const },
      ...(step.reason ? [{ label: 'What failed', text: step.reason, tone: 'warning' as const }] : []),
      { label: '', text: step.canGoOn ? 'Run it again, go on without it, or stop the work.' : 'Run it again or stop the work: the steps after it need its result.', tone: 'muted' as const },
    ]),
    ...work.questions.map((question) => ({ label: 'It asks', text: question, tone: 'warning' as const })),
    ...(work.blocker ? [{ label: 'Held up by', text: work.blocker, tone: 'warning' as const }] : []),
    ...work.attention.map((reason) => ({ label: 'Needs a look', text: reason, tone: 'warning' as const })),
    ...(work.budget ? [{ label: 'May spend', text: work.budget }] : []),
    { text: '' },
    { label: 'What you asked for', text: work.goal || work.title },
    ...work.criteria.map((criterion, index) => ({ label: index === 0 ? 'Done when' : '', text: criterion })),
    { text: '' },
  ];
  if (work.steps.length > 0) lines.push(...planLines('Plan', work.steps, work));
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
  // Whether its results were checked says something only once it ran (or was carried in); before that there is nothing to check.
  const ran = work.imported || work.state === 'done' || work.state === 'failed' || work.state === 'stopped';
  if (work.verification && ran) lines.push({ label: 'Checked', text: work.verification, tone: 'muted' });
  return lines;
}

function workRow(item: Item) {
  const work = item as WorkItem;
  return {
    title: work.title,
    // The row's word is short (a narrow window keeps the title); the detail says it in full.
    ...(work.state === 'running' ? {} : { right: work.imported ? 'carried in' : ROW_WORDS[work.state] ?? STATE_WORDS[work.state] }),
    mark: work.state === 'needs-you' || work.state === 'plan-waiting' || work.state === 'interrupted' ? 'waiting' as const
      : work.state === 'failed' || work.state === 'step-failed' || work.state === 'step-failed-go-on' ? 'attention' as const
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
  empty: 'No past work yet: finished and stopped work, and work carried in from old planning records, are kept here.',
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

function unanswered(raw: unknown): readonly UnansweredItem[] {
  return list(raw).map(record).filter((item) => plain(item['id']) && (item['kind'] === 'sent-work' || item['kind'] === 'typed-message')).map((item): UnansweredItem => ({
    kind: item['kind'] as UnansweredItem['kind'], id: plain(item['id']), state: item['kind'] as string,
    title: plain(item['title']) || (item['kind'] === 'sent-work' ? 'Work you asked for' : 'A message you typed'), said: plain(item['said']),
  }));
}

const unansweredList: PlaceList<Item> = {
  id: 'unanswered',
  label: 'Unanswered',
  noun: 'what has no answer yet',
  source: { kind: 'session', name: 'unanswered', items: unanswered },
  empty: 'Everything you asked for and typed has its answer.',
  row: (item) => {
    const entry = item as UnansweredItem;
    return { title: entry.title, right: entry.kind === 'sent-work' ? 'work you asked for' : 'a message you typed', mark: 'waiting' };
  },
  detail: (item) => {
    const entry = item as UnansweredItem;
    return [
      { label: 'What it is', text: entry.kind === 'sent-work' ? 'Work you asked for; the daemon has not confirmed it has it.' : 'A message you typed; the daemon has not answered it.' },
      ...(entry.said ? [{ label: 'Last heard', text: entry.said }] : []),
    ];
  },
};

const STEP_FAILED: readonly WorkState[] = ['step-failed', 'step-failed-go-on'];
/** Work that is under way: started and not ended, a failed step included (the work stopped at it, still live). */
const LIVE: readonly WorkState[] = ['starting', 'interrupted', 'running', 'needs-you', ...STEP_FAILED];
/** The step the work stopped at (its first, when several failed). */
const failedStep = (item: Item): string => (item as WorkItem).failedSteps[0]?.id ?? '';
const OPEN_TASK = ['queued', 'running', 'blocked'];
/** The programs where a task can be changed: the Agent's tasks are read only. */
const TASK_CHANGERS: readonly PlaceProgramName[] = ['tui', 'web'];

const WORK_ACTIONS: readonly PlaceAction<Item>[] = [
  // Asking for work: what you want done and when it is done, written in the form or read from a file; or your own words.
  // On the Work tab only: they make a piece of work, the tab's kind of thing.
  { key: 'n', id: 'new-work', list: 'work', whole: true, capability: 'work.new', label: 'new work', form: true, firstOnEmpty: true },
  { key: 'y', id: 'ask', list: 'work', whole: true, capability: 'work.request', label: 'ask in your own words' },
  // What has no answer yet: the work you asked for, and the message you typed.
  { key: 'v', id: 'check-sent', list: 'unanswered', states: ['sent-work'], capability: 'work.submission', label: 'check' },
  { key: 't', id: 'send-again', list: 'unanswered', states: ['sent-work'], capability: 'work.submission-retry', label: 'send again' },
  { key: 'X', id: 'drop-sent', list: 'unanswered', states: ['sent-work'], capability: 'work.submission-discard', label: 'drop' },
  { key: 'v', id: 'check-message', list: 'unanswered', states: ['typed-message'], capability: 'work.intake', label: 'check' },
  { key: 't', id: 'try-message-again', list: 'unanswered', states: ['typed-message'], capability: 'work.intake-retry', label: 'try again' },
  { key: 'g', id: 'go-on-with-message', list: 'unanswered', states: ['typed-message'], capability: 'work.intake-resume', label: 'go on' },
  { key: 'X', id: 'drop-message', list: 'unanswered', states: ['typed-message'], capability: 'work.intake-cancel', label: 'drop' },
  // One piece of work, by where it stands.
  // The work goes on after these presses: their line (and how to undo it) stays only while the work is as the press
  // left it (`outcomeFollowsItem`); once it moves on, the line is history and stopping it no longer undoes the press.
  { key: 's', id: 'start', list: 'work', states: ['not-started'], capability: 'work.start', label: 'start', fill: { work: 'id' }, outcomeFollowsItem: true },
  { key: 'x', id: 'stop', list: 'work', states: [...LIVE], capability: 'work.cancel', label: 'stop', fill: { work: 'id' } },
  // Go on: a start cut off by a restart goes on; a failed step is gone on without only where nothing after it needs its result.
  { key: 'g', id: 'go-on', list: 'work', states: ['interrupted'], capability: 'work.resume', label: 'go on', fill: { work: 'id' }, outcomeFollowsItem: true },
  { key: 'g', id: 'go-on-without-step', list: 'work', states: ['step-failed-go-on'], capability: 'work.go-on-without', label: 'go on without it', fill: { work: 'id', step: failedStep }, outcomeFollowsItem: true },
  { key: 'a', id: 'answer', list: 'work', states: ['needs-you'], capability: 'work.answer', label: 'answer', fill: { work: 'id' }, outcomeFollowsItem: true },
  { key: 't', id: 'step-again', list: 'work', states: [...STEP_FAILED], capability: 'work.retry', label: 'run this step again', fill: { work: 'id', step: failedStep }, outcomeFollowsItem: true },
  { key: 'b', id: 'spending-limit', list: 'work', states: [...LIVE], capability: 'work.budget', label: 'spending limit', fill: { work: 'id' } },
  { key: 'v', id: 'check', list: 'work', states: [...LIVE, 'failed'], capability: 'work.status', label: 'check', fill: { work: 'id' } },
  { key: 'v', id: 'check-past', list: 'history', states: ['done', 'stopped', 'failed'], capability: 'work.status', label: 'check', fill: { work: 'id' } },
  // A plan that waits for you.
  { key: 'enter', id: 'approve', list: 'work', states: ['plan-waiting'], capability: 'work.approve', label: 'approve and start', fill: { work: 'id' }, outcomeFollowsItem: true },
  { key: 'e', id: 'change-step', list: 'work', states: ['plan-waiting'], capability: 'work.step-edit', label: 'change a step', fill: { work: 'id' } },
  { key: 'd', id: 'take-step-out', list: 'work', states: ['plan-waiting'], capability: 'work.step-drop', label: 'take a step out', fill: { work: 'id' } },
  { key: 'm', id: 'move-step', list: 'work', states: ['plan-waiting'], capability: 'work.step-move', label: 'move a step', fill: { work: 'id' } },
  { key: 'w', id: 'write-again', list: 'work', states: ['plan-waiting'], capability: 'work.plan-redo', label: 'write it again', fill: { work: 'id' } },
  { key: 'X', id: 'throw-away', list: 'work', states: ['plan-waiting'], capability: 'work.plan-discard', label: 'throw the plan away', fill: { work: 'id' } },
  // The checklist.
  { key: 'p', id: 'add-to-checklist', list: 'checklist', whole: true, capability: 'work.checklist-add', label: 'put on the checklist' },
  { key: 'enter', id: 'change-item', list: 'checklist', capability: 'work.checklist-edit', label: 'change', fill: { item: 'id' } },
  { key: 'm', id: 'mark-item', list: 'checklist', capability: 'work.checklist-mark', label: 'mark', fill: { item: 'id' } },
  { key: 'o', id: 'move-on', list: 'checklist', capability: 'work.checklist-next', label: 'move on', fill: { item: 'id' } },
  { key: 'x', id: 'take-off', list: 'checklist', capability: 'work.checklist-remove', label: 'take off', fill: { item: 'id' } },
  // These act on the checklist as a whole: on its tab whether or not an item is selected.
  { key: 'C', id: 'clear-finished', list: 'checklist', whole: true, capability: 'work.checklist-clear-done', label: 'clear finished', notOnEmpty: true },
  { key: 'M', id: 'as-markdown', list: 'checklist', whole: true, capability: 'work.checklist-markdown', label: 'as Markdown', notOnEmpty: true },
  { key: 'E', id: 'save-markdown', list: 'checklist', whole: true, capability: 'work.checklist-export', label: 'save as a file', notOnEmpty: true },
  // Tasks here: this program's own; the daemon's take only cancel and run again.
  // The Agent's tasks are read only (products/agent tasks-runtime.ts `mutations.readOnly`): a key that changes a task
  // is the terminal app's alone, never a control that can only refuse.
  { key: 'k', id: 'add-task', list: 'tasks-here', whole: true, capability: 'work.task-add', label: 'add a task', programs: TASK_CHANGERS },
  { key: 'P', id: 'background-commands', list: 'tasks-here', whole: true, capability: 'work.processes', label: 'background commands' },
  { key: 'enter', id: 'task-detail', list: 'tasks-here', capability: 'work.task', label: 'details', fill: { task: 'id' } },
  { key: 'v', id: 'task-output', list: 'tasks-here', capability: 'work.task-output', label: 'what it produced', fill: { task: 'id' } },
  { key: 's', id: 'start-task', list: 'tasks-here', states: ['queued'], capability: 'work.task-start', label: 'start', fill: { task: 'id' }, programs: TASK_CHANGERS },
  { key: 'e', id: 'change-task', list: 'tasks-here', capability: 'work.task-change', label: 'change', fill: { task: 'id' }, programs: TASK_CHANGERS },
  { key: 'o', id: 'task-done', list: 'tasks-here', states: OPEN_TASK, capability: 'work.task-done', label: 'done', fill: { task: 'id' }, programs: TASK_CHANGERS },
  { key: 'F', id: 'task-failed', list: 'tasks-here', states: OPEN_TASK, capability: 'work.task-failed', label: 'mark failed', fill: { task: 'id' }, programs: TASK_CHANGERS },
  { key: 'z', id: 'pause-task', list: 'tasks-here', states: ['running', 'queued'], capability: 'work.task-pause', label: 'pause', fill: { task: 'id' }, programs: TASK_CHANGERS },
  { key: 'z', id: 'resume-task', list: 'tasks-here', states: ['blocked'], capability: 'work.task-resume', label: 'resume', fill: { task: 'id' }, programs: TASK_CHANGERS },
  { key: 'x', id: 'cancel-task', list: 'tasks-here', states: OPEN_TASK, capability: 'work.task-cancel', label: 'cancel', fill: { task: 'id' }, programs: TASK_CHANGERS },
  { key: 't', id: 'retry-task', list: 'tasks-here', states: ['failed', 'cancelled'], capability: 'work.task-retry', label: 'run again', fill: { task: 'id' }, programs: TASK_CHANGERS },
  { key: 'enter', id: 'daemon-task-detail', list: 'daemon-tasks', capability: 'work.task', label: 'details', fill: { task: 'id' } },
  { key: 'v', id: 'daemon-task-output', list: 'daemon-tasks', capability: 'work.task-output', label: 'what it produced', fill: { task: 'id' } },
  { key: 'x', id: 'cancel-daemon-task', list: 'daemon-tasks', states: OPEN_TASK, capability: 'work.task-cancel', label: 'cancel', fill: { task: 'id' } },
  { key: 't', id: 'retry-daemon-task', list: 'daemon-tasks', states: ['failed', 'cancelled'], capability: 'work.task-retry', label: 'run again', fill: { task: 'id' } },
];

export const WORK_PLACE = definePlace<Item>({
  id: 'work',
  group: 'work',
  title: 'Work and agents',
  lists: [workList, historyList, unansweredList, checklistList, tasksHereList, daemonTasksList, ...(WORK_AGENT_LISTS as readonly PlaceList<Item>[])],
  actions: [...WORK_ACTIONS, ...(WORK_AGENT_ACTIONS as readonly PlaceAction<Item>[])],
  count: (lists) => {
    const waiting = (lists.work ?? []).filter((item) => item.state === 'needs-you' || item.state === 'plan-waiting' || item.state === 'interrupted').length;
    // A failed step stops its work until someone acts on it: counted with what is wrong.
    const stepFailed = (lists.work ?? []).filter((item) => item.state === 'step-failed' || item.state === 'step-failed-go-on').length;
    const failed = (lists.work ?? []).filter((item) => item.state === 'failed').length;
    const wrong = [stepFailed > 0 ? `${stepFailed} stopped at a failed step` : '', failed > 0 ? `${failed} failed` : ''].filter(Boolean).join(', ');
    if (waiting > 0) return { count: waiting + stepFailed + failed, words: `${waiting} need${waiting === 1 ? 's' : ''} you${wrong ? `, ${wrong}` : ''}`, tone: 'waiting' };
    return stepFailed + failed > 0 ? { count: stepFailed + failed, words: wrong, tone: 'wrong' } : undefined;
  },
});
