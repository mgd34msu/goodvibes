/**
 * Automation: schedules and their runs, triggers and the commands they may
 * run, CI watches, and check-ins. Everything here is kept and run by the
 * daemon, so every capability is one of its own methods
 * (`automation.schedules.*`, `automation.runs.*`, `watchers.triggers.*`,
 * `ci.*`, `checkin.*`): no handler and no slash command. The Automation place
 * in both terminal programs and the web UI's Automation view run them through
 * `capabilities.run`, as a model, an outside agent and a script do.
 *
 * The lists the inputs choose from (`schedules`, `triggers`, `ci.watches`, ...)
 * stay registered in terminal-shell (automation-lists.ts), reading the same
 * methods.
 */
import { REASONING_EFFORT_SEVERITY } from '../../config/reasoning-effort-setting.js';
import { formatScheduleTime, formatScheduleTiming } from '../../automation/schedule-values.js';
import type { AutomationScheduleDefinition } from '../../automation/schedules.js';
import type { MethodCapabilityDefinition } from './method-capability.js';
import { AUTOMATION_RUN_STATE_WORDS, CHECKIN_OUTCOME_WORDS, CI_VERDICT_WORDS, TRIGGER_STATE_WORDS, ciTargetText, watchingWords } from './automation-words.js';

export * from './automation-words.js';
import type { FixedChoice, InputDescription, ListName } from '../types.js';

interface MovedMethodCapability {
  readonly definition: MethodCapabilityDefinition;
  readonly command: { readonly name: string; readonly title: string };
}

// ---------------------------------------------------------------------------
// Reading a method's answer (data from the daemon: read defensively)
// ---------------------------------------------------------------------------

type Answer = Readonly<Record<string, unknown>>;

const record = (value: unknown): Answer => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Answer : {};
const list = (value: unknown): readonly Answer[] => Array.isArray(value) ? value.map(record) : [];
const text = (value: unknown): string => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '') : '';
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The daemon's own zone: the times a capability says are in it, named. */
function zone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function timingOf(schedule: unknown): string {
  if (!schedule || typeof schedule !== 'object') return 'at a time not said';
  try { return formatScheduleTiming(schedule as AutomationScheduleDefinition, zone()); } catch { return 'at a time not said'; }
}


/** A CI report job by job, in one line: the verdict, then each job and its conclusion. */
function ciReportLine(report: Answer): string {
  const jobs = list(report['jobs']).map((job) => {
    const status = text(job['status']);
    const ended = status === 'completed' ? text(job['conclusion']) || 'no conclusion' : status.replace('_', ' ');
    return `${text(job['name'])} ${ended}${job['continueOnError'] === true ? ' (allowed to fail)' : ''}`;
  });
  const verdict = CI_VERDICT_WORDS[text(report['overall'])] ?? text(report['overall']);
  const violations = Array.isArray(report['violations']) ? report['violations'].map(text).filter(Boolean) : [];
  return [`CI ${verdict} for ${ciTargetText(report)}${jobs.length > 0 ? `: ${jobs.join(', ')}` : ': no jobs yet'}.`, ...violations.map((violation) => `${violation}.`)].join('\n');
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

const SCHEDULE_INPUT: InputDescription = {
  id: 'schedule', label: 'Schedule', help: 'Your schedules', kind: 'choice', choices: { list: 'schedules' as ListName }, required: true, typed: { position: 1 },
};

const RUN_INPUT: InputDescription = {
  id: 'run', label: 'Run', help: 'A run of one of your schedules', kind: 'text', freeTextReason: 'a run id', required: true, typed: { position: 1 },
};

const HOW: readonly FixedChoice[] = [
  { value: 'describe', label: 'Describe it', help: '"every weekday at 9am"; read for you, and shown before it is kept' },
  { value: 'at', label: 'Once, at a date and time', help: 'Such as 2026-12-01T09:00 (this machine\'s time zone when none is given)' },
  { value: 'every', label: 'Every so often', help: 'Every 15m, 2h, 1d ...' },
  { value: 'cron', label: 'On a calendar pattern', help: 'A cron expression, for people who know cron' },
];

function timingInputs(step: number, required: boolean): readonly InputDescription[] {
  const need = (defaultMeans: string): InputDescription['required'] => required ? true : { default: '', defaultMeans };
  return [
    {
      id: 'how', label: 'When', help: 'How you say when it runs', kind: 'choice', choices: HOW, step,
      required: { default: 'describe', defaultMeans: required ? 'described in your words' : 'keep its timing' },
      typed: { impliedBy: { input: 'when', ifGiven: 'describe', ifNot: 'describe', orIfGiven: [{ input: 'at', value: 'at' }, { input: 'every', value: 'every' }, { input: 'cron', value: 'cron' }] } },
    },
    { id: 'when', label: 'Describe it', help: 'In your words, such as every weekday at 9am, nightly at 2am or hourly', kind: 'text', freeTextReason: 'your own words for when', required: need('keep its timing'), typed: { flag: '--when' }, step, showWhen: { input: 'how', is: 'describe' } },
    { id: 'at', label: 'At', help: 'A date and time such as 2026-12-01T09:00', kind: 'date-time', required: need('keep its timing'), typed: { flag: '--at' }, step, showWhen: { input: 'how', is: 'at' } },
    { id: 'every', label: 'Every', help: 'An interval such as 15m, 2h or 1d', kind: 'text', freeTextReason: 'an interval such as 15m', required: need('keep its timing'), typed: { flag: '--every' }, step, showWhen: { input: 'how', is: 'every' } },
    { id: 'cron', label: 'Pattern', help: 'Five cron fields, such as 0 9 * * 1-5', kind: 'text', freeTextReason: 'a cron expression', required: need('keep its timing'), typed: { flag: '--cron' }, step, showWhen: { input: 'how', is: 'cron' } },
    { id: 'tz', label: 'Time zone', help: 'For a pattern or a description; blank for this machine\'s time zone', kind: 'text', freeTextReason: 'a time zone such as Europe/Vienna', required: { default: '', defaultMeans: 'this machine\'s time zone' }, typed: { flag: '--tz' }, step: step + 1 },
    { id: 'stagger', label: 'Spread the start', help: 'Start up to this long after the pattern\'s time, such as 5m, so many runs do not start at once', kind: 'text', freeTextReason: 'a duration such as 5m', required: { default: '', defaultMeans: 'start on time' }, typed: { flag: '--stagger' }, step: step + 1 },
  ];
}

const TARGETS: readonly FixedChoice[] = [
  { value: 'isolated', label: 'A fresh conversation each time', help: 'Nothing earlier is carried into a run.' },
  { value: 'main', label: 'Your main conversation', help: 'Each run continues the main session.' },
  { value: 'background', label: 'In the background', help: 'A background session of its own.' },
  { value: 'pinned', label: 'The pinned conversation', help: 'Runs in the session you pinned.' },
];

function option(id: string, label: string, help: string, flag: `--${string}`, defaultMeans: string, reason: string): InputDescription {
  return { id, label, help, kind: 'text', freeTextReason: reason, required: { default: '', defaultMeans }, typed: { flag }, step: 4 };
}

const NO_YES: readonly FixedChoice[] = [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }];

const MORE: readonly InputDescription[] = [
  option('name', 'Name', 'What it is called in your list', '--name', 'the first words of what it does', 'a name you choose'),
  { id: 'target', label: 'Where it runs', help: 'Which conversation each run uses', kind: 'choice', choices: TARGETS, required: { default: 'isolated', defaultMeans: 'a fresh conversation each time' }, typed: { flag: '--target' }, step: 4 },
  option('model', 'Model', 'The model a run uses', '--model', 'the same as your chats', 'a model id such as gpt-5'),
  option('provider', 'Provider', 'The provider of that model', '--provider', 'the model\'s usual provider', 'a provider id'),
  option('deliver', 'Answer goes to', 'A channel such as telegram or slack:C123', '--deliver', 'your owner inbox', 'a channel as configuration writes it'),
  {
    id: 'outside', label: 'May act on content from outside sources', help: 'Mail, web pages and messages it reads may steer what it does', kind: 'choice',
    choices: [{ value: 'no', label: 'No', help: 'Outside content is read as data, never as instructions.' }, { value: 'yes', label: 'Yes', help: 'Outside content may steer the run.', risk: 'loosens-a-protection' }],
    required: { default: 'no', defaultMeans: 'no' }, typed: { flag: '--allow-unsafe-external-content', switchOn: 'yes' }, step: 4,
  },
  option('source', 'Outside source', 'The kind of outside content it reads, such as email or web', '--external-source', 'none named', 'a source kind'),
  { id: 'reasoning', label: 'How hard it thinks', help: 'The reasoning effort a run uses', kind: 'choice', choices: REASONING_EFFORT_SEVERITY.map((level): FixedChoice => ({ value: level, label: level })), required: { default: '', defaultMeans: 'the model\'s usual' }, typed: { flag: '--reasoning' }, step: 4 },
  option('thinking', 'Thinking', 'The model\'s thinking mode', '--thinking', 'the model\'s usual', 'a thinking mode the model takes'),
  { id: 'wake', label: 'When it wakes', help: 'Start at its time, or at the next heartbeat', kind: 'choice', choices: [{ value: 'now', label: 'At its time' }, { value: 'next-heartbeat', label: 'At the next heartbeat' }], required: { default: '', defaultMeans: 'at its time' }, typed: { flag: '--wake' }, step: 4 },
  option('fallback', 'Fallback models', 'Models to try when the first fails, separated by commas', '--fallback', 'none', 'model ids'),
  { id: 'tool', label: 'Tools it may use', help: 'Only these tools, one per line', kind: 'text', freeTextReason: 'a tool name', required: { default: '', defaultMeans: 'every tool a run usually has' }, typed: { flag: '--tool', repeats: true }, step: 4 },
  option('template', 'Template', 'A prompt template it starts from', '--template', 'none', 'a template name'),
  { id: 'light', label: 'Light context', help: 'Start each run with less context, for speed', kind: 'choice', choices: NO_YES, required: { default: 'no', defaultMeans: 'no' }, typed: { flag: '--light-context', switchOn: 'yes' }, step: 4 },
  { id: 'paused', label: 'Start paused', help: 'Kept, but runs only once you resume it', kind: 'choice', choices: NO_YES, required: { default: 'no', defaultMeans: 'no' }, typed: { flag: '--paused', switchOn: 'yes' }, step: 4 },
];

function scheduleLine(job: Answer): string {
  const paused = job['enabled'] === false;
  const next = paused ? 'paused' : `next ${formatScheduleTime(count(job['nextRunAt']), zone())}`;
  return `"${text(job['name']) || text(job['id'])}": ${timingOf(job['schedule'])}; ${next}.`;
}

const SCHEDULE_COMMAND = { name: 'schedule', title: 'Schedules' };

export const SCHEDULE_LIST: MethodCapabilityDefinition = {
  capability: { id: 'schedule.list', group: 'automation', home: 'daemon', repeat: 'safe' },
  actionId: 'see-schedules', label: 'See your schedules', word: 'list', inputs: [],
  sentence: 'Shows each schedule: its name, when it runs, its next and last run, and what it does.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  method: { id: 'automation.schedules.list', fields: {} },
  said(answer) {
    const jobs = list(answer['jobs']);
    if (jobs.length === 0) return 'No schedules yet: nothing runs by itself.';
    return [`${plural(jobs.length, 'schedule')} (times in ${zone()}):`, ...jobs.map((job) => `${scheduleLine(job)} Id ${text(job['id'])}.`)].join('\n');
  },
};

export const SCHEDULE_ADD: MethodCapabilityDefinition = {
  capability: { id: 'schedule.add', group: 'automation', home: 'daemon', repeat: 'unsafe' },
  actionId: 'add', label: 'Schedule something to run', word: 'add',
  inputs: [
    { id: 'prompt', label: 'What it does', help: 'Say it the way you would ask in the chat', kind: 'long-text', freeTextReason: 'your own words for what it does', required: true, typed: { tail: true }, step: 1 },
    ...timingInputs(2, true),
    ...MORE,
  ],
  sentence: '"{prompt}" will run at the times you gave, whether or not a program is open, until you change it.',
  done: 'Scheduled.',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'remove',
  example: { prompt: 'summarise open pull requests', when: 'every weekday at 9am' },
  // The daemon reads the blanks (a described time included) into what it keeps; the web UI's sheet shows the reading first.
  method: {
    id: 'automation.schedules.create',
    preview: 'automation.schedules.preview',
    fields: {
      action: '="add"', prompt: 'prompt', when: 'when', at: 'at', every: 'every', cron: 'cron', tz: 'tz', stagger: 'stagger', name: 'name',
      target: 'target', model: 'model', provider: 'provider', deliver: 'deliver', outside: 'outside', source: 'source', reasoning: 'reasoning',
      thinking: 'thinking', wake: 'wake', fallback: 'fallback', tool: 'tool', template: 'template', light: 'light', paused: 'paused',
    },
  },
  said(answer, values) {
    return [scheduleLine(answer), `The answer goes to ${values['deliver'] || 'your owner inbox'}.`, `Id ${text(answer['id'])}.`].join('\n');
  },
};

export const SCHEDULE_RUN: MethodCapabilityDefinition = {
  capability: { id: 'schedule.run', group: 'automation', home: 'daemon', repeat: 'unsafe' },
  actionId: 'run-now', label: 'Run a schedule now', word: 'run', inputs: [SCHEDULE_INPUT],
  sentence: '{schedule} will run once now; its usual times stay as they are.',
  done: 'Started {schedule}.',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none',
  example: { schedule: 'weekly-report' },
  method: { id: 'automation.schedules.run', fields: { scheduleId: 'schedule' } },
  // What ran, and how it stands now; the run's id on its own line, for stopping it.
  said(answer) {
    const status = text(answer['status']);
    return [`Its run is ${AUTOMATION_RUN_STATE_WORDS[status] ?? (status || 'started')}.`, ...(text(answer['runId']) ? [`Run id ${text(answer['runId'])}.`] : [])].join('\n');
  },
};

export const SCHEDULE_PAUSE: MethodCapabilityDefinition = {
  capability: { id: 'schedule.pause', group: 'automation', home: 'daemon', repeat: 'safe' },
  actionId: 'pause', label: 'Pause a schedule', word: 'pause',
  inputs: [{ ...SCHEDULE_INPUT, help: 'Schedules that run now', choices: { list: 'schedules.running' as ListName } }],
  sentence: '{schedule} will not run {lasts}; it is kept, and Resume a schedule starts it again.',
  done: 'Paused {schedule}.',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'resume',
  example: { schedule: 'weekly-report' },
  method: { id: 'automation.schedules.pause', fields: { scheduleId: 'schedule' } },
};

export const SCHEDULE_RESUME: MethodCapabilityDefinition = {
  capability: { id: 'schedule.resume', group: 'automation', home: 'daemon', repeat: 'safe' },
  actionId: 'resume', label: 'Resume a schedule', word: 'resume',
  inputs: [{ ...SCHEDULE_INPUT, help: 'Paused schedules', choices: { list: 'schedules.paused' as ListName } }],
  sentence: '{schedule} is turned back on and runs again at its next time, {lasts}.',
  done: 'Resumed {schedule}.',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'pause',
  example: { schedule: 'weekly-report' },
  method: { id: 'automation.schedules.resume', fields: { scheduleId: 'schedule' } },
};

export const SCHEDULE_STOP_RUN: MethodCapabilityDefinition = {
  capability: { id: 'schedule.stop-run', group: 'automation', home: 'daemon', repeat: 'safe' },
  actionId: 'stop-run', label: 'Stop a run that is going', word: 'stop-run', inputs: [RUN_INPUT],
  sentence: 'Run {run} is stopped; its schedule keeps its usual times.',
  done: 'Stopped {run}.',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'cannot-be-undone',
  example: { run: 'run-1a2b' },
  method: { id: 'automation.runs.cancel', fields: { runId: 'run' } },
  said(answer) {
    const status = text(record(answer['run'])['status']);
    return status && status !== 'cancelled' ? `It had already ${status === 'completed' ? 'finished' : AUTOMATION_RUN_STATE_WORDS[status] ?? status}.` : '';
  },
};

export const SCHEDULE_RETRY_RUN: MethodCapabilityDefinition = {
  capability: { id: 'schedule.retry-run', group: 'automation', home: 'daemon', repeat: 'unsafe' },
  actionId: 'retry-run', label: 'Run a failed run again', word: 'retry-run', inputs: [{ ...RUN_INPUT, help: 'A run that failed' }],
  sentence: 'Run {run} runs again as a new run; its schedule keeps its usual times.',
  done: 'Started {run} again as a new run.',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none',
  example: { run: 'run-1a2b' },
  method: { id: 'automation.runs.retry', fields: { runId: 'run' } },
  said(answer) {
    const run = record(answer['run']);
    const status = text(run['status']);
    return [`The new run is ${AUTOMATION_RUN_STATE_WORDS[status] ?? (status || 'started')}.`, ...(text(run['id']) ? [`Run id ${text(run['id'])}.`] : [])].join('\n');
  },
};

export const SCHEDULE_CHANGE: MethodCapabilityDefinition = {
  capability: { id: 'schedule.change', group: 'automation', home: 'daemon', repeat: 'safe' },
  actionId: 'change', label: 'Change a schedule', word: 'change',
  inputs: [
    { ...SCHEDULE_INPUT, step: 1 },
    ...timingInputs(2, false),
    { id: 'name', label: 'Name', help: 'A new name; blank keeps it', kind: 'text', freeTextReason: 'a name you choose', required: { default: '', defaultMeans: 'keep its name' }, typed: { flag: '--name' }, step: 4 },
    { id: 'prompt', label: 'What it does', help: 'New words for what it does; blank keeps them', kind: 'long-text', freeTextReason: 'your own words for what it does', required: { default: '', defaultMeans: 'keep what it does' }, typed: { tail: true }, step: 4 },
    { id: 'task', label: 'Or a task', help: 'Instead of plain words: the task, with the result that shows it is done below', kind: 'text', freeTextReason: 'your own words for the task', required: { default: '', defaultMeans: 'no task' }, typed: { flag: '--task' }, step: 4 },
    { id: 'success', label: 'Done when', help: 'The result that shows the task is done', kind: 'text', freeTextReason: 'your own words for the result', required: { default: '', defaultMeans: 'no task' }, typed: { flag: '--success-criteria' }, step: 4 },
  ],
  sentence: '{schedule} will run with what you changed, until you change it again.',
  done: 'Changed {schedule}.',
  touches: 'this-machine', lasts: 'kept', risk: 'none',
  example: { schedule: 'weekly-report', cron: '0 8 * * 1' },
  method: {
    id: 'automation.jobs.update',
    preview: 'automation.schedules.preview',
    fields: { action: '="change"', schedule: 'schedule', when: 'when', at: 'at', every: 'every', cron: 'cron', tz: 'tz', stagger: 'stagger', name: 'name', prompt: 'prompt', task: 'task', success: 'success' },
  },
  said(answer) {
    return `It runs ${timingOf(answer['schedule'])}.`;
  },
};

export const SCHEDULE_REMOVE: MethodCapabilityDefinition = {
  capability: { id: 'schedule.remove', group: 'automation', home: 'daemon', repeat: 'safe' },
  actionId: 'remove', label: 'Remove a schedule', word: 'remove', inputs: [SCHEDULE_INPUT],
  sentence: '{schedule} will stop running and be deleted for good.',
  done: 'Removed {schedule}.',
  touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone',
  example: { schedule: 'weekly-report' },
  method: { id: 'automation.schedules.delete', fields: { scheduleId: 'schedule' } },
};

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

const TRIGGER_INPUT: InputDescription = {
  id: 'trigger', label: 'Trigger', help: 'Your triggers', kind: 'choice', choices: { list: 'triggers' as ListName }, required: true, typed: { position: 1 },
};

const WATCH_KINDS: readonly FixedChoice[] = [
  { value: 'finishes', label: 'A command finishing', help: 'Start a command and act when it ends, however it ends.' },
  { value: 'prints', label: 'A line a command prints', help: 'Keep a command running and act on each line that matches.' },
  { value: 'page', label: 'A web address changing', help: 'Fetch it every so often and act when it is different.' },
  { value: 'file', label: 'A file changing', help: 'Look at it every so often and act when it is different.' },
  { value: 'written', label: 'Something else, written out', help: 'A definition with any probe, rule or action the trigger family takes.' },
];

const THEN: readonly FixedChoice[] = [
  { value: 'ask', label: 'Ask the agent to look at it', help: 'A model turn reads what happened; its answer comes to you.' },
  { value: 'run', label: 'Run a command you approved', help: 'One of the commands you let triggers run.' },
];

function triggerLine(trigger: Answer): string {
  const state = text(trigger['state']);
  const fired = count(trigger['firedCount']);
  return [
    `"${text(trigger['label']) || text(trigger['id'])}" is ${TRIGGER_STATE_WORDS[state] ?? state}`,
    trigger['watching'] !== undefined ? `; it watches ${watchingWords(text(trigger['watching']))}` : '',
    fired === undefined ? '' : fired === 0 ? '; it has not acted yet' : `; it acted ${fired === 1 ? 'once' : `${fired} times`}`,
    trigger['lastError'] !== undefined ? `; last problem: ${text(trigger['lastError'])}` : '',
    '.',
  ].join('');
}

const TRIGGERS_COMMAND = { name: 'triggers', title: 'Triggers' };

export const TRIGGERS_LIST: MethodCapabilityDefinition = {
  capability: { id: 'triggers.list', group: 'automation', home: 'daemon', repeat: 'safe' },
  actionId: 'see-triggers', label: 'See your triggers', word: 'list', inputs: [],
  sentence: 'Shows each trigger: what it watches, its state and how often it acted.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  method: { id: 'watchers.triggers.list', fields: {} },
  said(answer) {
    const triggers = list(answer['triggers']);
    const elsewhere = answer['ownership'] === 'other-process' ? ' Another process on this machine supervises them.' : '';
    if (triggers.length === 0) return `No triggers: nothing is watched.${elsewhere}`;
    return [`${plural(triggers.length, 'trigger')}.${elsewhere}`, ...triggers.map((trigger) => `${triggerLine(trigger)} Id ${text(trigger['id'])}.`)].join('\n');
  },
};

export const TRIGGERS_WATCH: MethodCapabilityDefinition = {
  capability: { id: 'triggers.watch', group: 'automation', home: 'daemon', repeat: 'unsafe' },
  actionId: 'watch', label: 'Watch for something and tell me when it happens', word: 'watch',
  inputs: [
    { id: 'name', label: 'Name', help: 'What it is called in your list', kind: 'text', freeTextReason: 'a name you choose', required: true, typed: { position: 1 }, step: 1 },
    {
      id: 'kind', label: 'Watch', help: 'What it watches', kind: 'choice', choices: WATCH_KINDS, step: 1,
      required: { default: 'finishes', defaultMeans: 'a command finishing' },
      typed: { impliedBy: { input: 'match', ifGiven: 'prints', ifNot: 'finishes', orIfGiven: [{ input: 'url', value: 'page' }, { input: 'path', value: 'file' }, { input: 'definition', value: 'written' }] } },
    },
    { id: 'definition', label: 'Definition', help: 'JSON: { "spec": {...}, "action": {...} }, as the trigger family reads it', kind: 'long-text', freeTextReason: 'a probe, rule or action the choices above do not cover', required: true, typed: { flag: '--definition' }, step: 1, showWhen: { input: 'kind', is: 'written' } },
    { id: 'command', label: 'Command', help: 'The program and its own arguments, one per line, such as a build or a test run', kind: 'list', freeTextReason: 'the program and its arguments', required: true, typed: { tail: true }, step: 1, showWhen: { input: 'kind', is: 'finishes' } },
    { id: 'match', label: 'Lines that match', help: 'A pattern, such as ERROR|FAILED', kind: 'text', freeTextReason: 'a pattern a line matches', required: true, typed: { flag: '--match' }, step: 1, showWhen: { input: 'kind', is: 'prints' } },
    { id: 'url', label: 'Address', help: 'The https:// page to fetch', kind: 'text', freeTextReason: 'the page\'s address', required: true, typed: { flag: '--url' }, step: 1, showWhen: { input: 'kind', is: 'page' } },
    { id: 'path', label: 'File', help: 'The file to look at', kind: 'path', freeTextReason: 'a file on the daemon\'s machine', required: true, typed: { flag: '--file' }, step: 1, showWhen: { input: 'kind', is: 'file' } },
    { id: 'every', label: 'How often', help: 'How often a page or file is looked at, such as 5m or 1h', kind: 'text', freeTextReason: 'an interval such as 5m', required: { default: '5m', defaultMeans: 'every 5 minutes' }, typed: { flag: '--every' }, step: 1 },
    { id: 'then', label: 'Then', help: 'What happens when it fires', kind: 'choice', choices: THEN, required: { default: 'ask', defaultMeans: 'ask the agent to look at it' }, typed: { impliedBy: { input: 'grant', ifGiven: 'run', ifNot: 'ask' } }, step: 2 },
    { id: 'say', label: 'Tell the agent', help: 'Your own instructions for the turn; blank for what happened only', kind: 'long-text', freeTextReason: 'your own words', required: { default: '', defaultMeans: 'what happened, nothing more' }, typed: { flag: '--say' }, step: 2, showWhen: { input: 'then', is: 'ask' } },
    { id: 'deliver', label: 'Answer goes to', help: 'A channel such as telegram or slack:C123', kind: 'text', freeTextReason: 'a channel as configuration writes it', required: { default: '', defaultMeans: 'your owner inbox' }, typed: { flag: '--deliver' }, step: 2, showWhen: { input: 'then', is: 'ask' } },
    { id: 'grant', label: 'Command to run', help: 'Commands you let triggers run', kind: 'choice', choices: { list: 'triggers.commands' as ListName }, required: true, typed: { flag: '--run' }, step: 2, showWhen: { input: 'then', is: 'run' } },
  ],
  sentence: '{name} will watch what you gave (a command when it finishes, a line it prints, a page or a file when it changes) and act each time it fires, telling you or running a command, until you change it.',
  done: 'Watching: {name}.',
  touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'stop',
  example: { name: 'Build finished', command: 'npm\nrun\nbuild' },
  // The daemon reads the blanks into the trigger's definition (and the approved command's digest) before it is made.
  method: {
    id: 'watchers.triggers.create',
    preview: 'watchers.triggers.preview',
    fields: { name: 'name', kind: 'kind', command: 'command', match: 'match', url: 'url', path: 'path', every: 'every', then: 'then', say: 'say', deliver: 'deliver', grant: 'grant', definition: 'definition' },
  },
  said(answer) {
    const trigger = record(answer['trigger']);
    return `${triggerLine(trigger)}${text(trigger['id']) ? `\nId ${text(trigger['id'])}.` : ''}`;
  },
};

export const TRIGGERS_HISTORY: MethodCapabilityDefinition = {
  capability: { id: 'triggers.history', group: 'automation', home: 'daemon', repeat: 'safe' },
  actionId: 'history', label: 'See what a trigger did', word: 'history',
  inputs: [TRIGGER_INPUT, { id: 'count', label: 'How many', help: 'The newest runs to show, 1 to 200', kind: 'number', required: { default: '20', defaultMeans: 'the newest 20' }, typed: { flag: '--count' } }],
  sentence: 'Shows the newest runs of {trigger}: when, the outcome, and how a watched command ended.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none',
  example: { trigger: 'build-finished' },
  method: { id: 'watchers.triggers.history', fields: { id: 'trigger', limit: 'count:number' } },
  // Newest first, each run as when and how it came out.
  said(answer) {
    const runs = list(answer['runs']).slice().reverse();
    if (runs.length === 0) return 'It has not run yet.';
    const at = (run: Answer): string => {
      const when = Date.parse(text(run['at']));
      return Number.isFinite(when) ? formatScheduleTime(when, zone()) : text(run['at']);
    };
    return [`Newest first: ${runs.slice(0, 5).map((run) => `${at(run)} ${text(run['outcome'])}${run['detail'] !== undefined ? ` (${text(run['detail'])})` : ''}`).join('; ')}.`,
      ...runs.slice(5).map((run) => `${at(run)} ${text(run['outcome'])}${run['detail'] !== undefined ? ` (${text(run['detail'])})` : ''}.`)].join('\n');
  },
};

export const TRIGGERS_STOP: MethodCapabilityDefinition = {
  capability: { id: 'triggers.stop', group: 'automation', home: 'daemon', repeat: 'safe' },
  actionId: 'stop', label: 'Stop a trigger', word: 'stop', inputs: [TRIGGER_INPUT],
  sentence: '{trigger} will stop watching, and a command it started is stopped.',
  done: 'Stopped {trigger}.',
  touches: 'another-machine', lasts: 'kept', risk: 'cannot-be-undone',
  example: { trigger: 'build-finished' },
  method: { id: 'watchers.triggers.cancel', fields: { id: 'trigger' } },
  said(answer) {
    const state = text(record(answer['trigger'])['state']);
    return state === 'fired' ? 'It had already acted and finished.' : state && state !== 'cancelled' ? `It is ${TRIGGER_STATE_WORDS[state] ?? state}.` : '';
  },
};

export const TRIGGERS_RESTART: MethodCapabilityDefinition = {
  capability: { id: 'triggers.restart', group: 'automation', home: 'daemon', repeat: 'safe' },
  actionId: 'restart', label: 'Start a trigger that gave up', word: 'restart',
  inputs: [{ ...TRIGGER_INPUT, help: 'Triggers that stopped after failing again and again' }],
  sentence: '{trigger}, which stopped after repeated failures, will watch again {lasts}; fix what made it fail first.',
  done: 'Started {trigger} again.',
  touches: 'another-machine', lasts: 'kept', risk: 'none',
  example: { trigger: 'build-finished' },
  method: { id: 'watchers.triggers.reset', fields: { id: 'trigger' } },
  said(answer) {
    const state = text(record(answer['trigger'])['state']);
    return state ? `It is ${TRIGGER_STATE_WORDS[state] ?? state}.` : '';
  },
};

function grantCommand(grant: Answer): string {
  return [text(grant['command']), ...(Array.isArray(grant['args']) ? grant['args'].map(text) : [])].join(' ');
}

export const TRIGGERS_COMMANDS: MethodCapabilityDefinition = {
  capability: { id: 'triggers.commands', group: 'automation', home: 'daemon', repeat: 'safe' },
  actionId: 'see-commands', label: 'See commands triggers may run', word: 'commands', inputs: [],
  sentence: 'Shows each command you let triggers run, with the digest a trigger names.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  method: { id: 'watchers.triggers.grant.list', fields: {} },
  said(answer) {
    const grants = list(answer['grants']);
    if (grants.length === 0) return 'Triggers may run no command.';
    return [`Triggers may run ${plural(grants.length, 'command')}:`, ...grants.map((grant) => `"${text(grant['id'])}" runs ${grantCommand(grant)} (digest ${text(grant['digest'])}).`)].join('\n');
  },
};

export const TRIGGERS_ALLOW_COMMAND: MethodCapabilityDefinition = {
  capability: { id: 'triggers.allow-command', group: 'automation', home: 'daemon', repeat: 'safe' },
  actionId: 'allow-command', label: 'Let triggers run a command', word: 'allow-command',
  inputs: [
    { id: 'name', label: 'Name', help: 'What a trigger calls it', kind: 'text', freeTextReason: 'a name you choose', required: true, typed: { position: 1 } },
    { id: 'command', label: 'Command', help: 'The program and its own arguments, one per line, run exactly so', kind: 'list', freeTextReason: 'the program and its arguments', required: true, typed: { tail: true } },
  ],
  sentence: 'A trigger may run {command} as {name} when it fires, with nobody asked, until you change it.',
  done: 'Triggers may run {name}.',
  // It loosens a protection: a model's call of it is put to the owner in every mode, opening on No (never refused outright).
  touches: 'another-machine', lasts: 'kept', risk: 'loosens-a-protection',
  example: { name: 'deploy', command: 'make\ndeploy' },
  method: { id: 'watchers.triggers.grant.register', fields: { id: 'name', command: 'command:first', args: 'command:rest', description: 'name' } },
  said(answer) {
    const grant = record(answer['grant']);
    return `A trigger names it with "Then: Run a command you approved"${text(grant['digest']) ? ` (digest ${text(grant['digest'])})` : ''}.`;
  },
};

// ---------------------------------------------------------------------------
// CI watches
// ---------------------------------------------------------------------------

const CI_TARGET_INPUT: InputDescription = {
  id: 'target', label: 'Repository', help: 'owner/repo, owner/repo#123 for a pull request, or owner/repo@branch', kind: 'text', freeTextReason: 'a repository on GitHub',
  required: true, typed: { position: 1 },
};

const CI_WATCH_INPUT: InputDescription = {
  id: 'watch', label: 'Watch', help: 'Your standing CI watches', kind: 'choice', choices: { list: 'ci.watches' as ListName }, required: true, typed: { position: 1 },
};

function ciWatchLine(watch: Answer): string {
  const verdict = text(watch['lastOverall']);
  return `${ciTargetText(watch)}: failures go to ${text(watch['deliveryChannel'])}${watch['triggerFixSession'] === true ? ', and a fix session starts' : ''}; ${verdict ? `last checked ${CI_VERDICT_WORDS[verdict] ?? verdict}` : 'not checked yet'}.`;
}

const CI_COMMAND = { name: 'ci', title: 'CI checks' };

export const CI_WATCHES: MethodCapabilityDefinition = {
  capability: { id: 'ci.watches', group: 'automation', home: 'daemon', repeat: 'safe' },
  actionId: 'watches', label: 'See your CI watches', word: 'watches', inputs: [],
  sentence: 'Lists every standing CI watch, where it reports, and its last verdict.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  method: { id: 'ci.watches.list', fields: {} },
  said(answer) {
    const watches = list(answer['watches']);
    if (watches.length === 0) return 'No standing CI watches.';
    return [`${watches.length} CI ${watches.length === 1 ? 'watch' : 'watches'}:`, ...watches.map((watch) => `${ciWatchLine(watch)} Id ${text(watch['id'])}.`)].join('\n');
  },
};

export const CI_STATUS: MethodCapabilityDefinition = {
  capability: { id: 'ci.status', group: 'automation', home: 'daemon', repeat: 'safe' },
  actionId: 'status', label: 'Check a repository\'s CI now', word: 'status', inputs: [CI_TARGET_INPUT],
  sentence: 'Shows each CI job of {target} and its conclusion, and the verdict they give together.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none',
  example: { target: 'acme/web#42' },
  // The daemon reads owner/repo#123 and owner/repo@branch itself.
  method: { id: 'ci.status', fields: { repo: 'target' } },
  said(answer) {
    return ciReportLine(record(answer['report']));
  },
};

export const CI_WATCH: MethodCapabilityDefinition = {
  capability: { id: 'ci.watch', group: 'automation', home: 'daemon', repeat: 'unsafe' },
  actionId: 'watch', label: 'Watch a repository\'s CI', word: 'watch',
  inputs: [
    CI_TARGET_INPUT,
    { id: 'channel', label: 'Tell me on', help: 'Where a failure is reported: a channel kind (slack) or kind:address', kind: 'text', freeTextReason: 'a channel kind, or kind:address', required: true, typed: { position: 2 } },
    {
      id: 'fix', label: 'On a failure', help: 'Only tell you, or also start a session that tries to fix it', kind: 'choice',
      choices: [{ value: 'no', label: 'Only tell me' }, { value: 'yes', label: 'Also start a fix session', help: 'A session starts on its own and spends model time.', risk: 'spends-money',
        // Setting up the watch spends nothing: a failure later starts the session that does.
        riskDone: 'Nothing was spent yet: when CI fails, a fix session starts on its own and spends model time.' }],
      required: { default: 'no', defaultMeans: 'only tell me' }, typed: { flag: '--fix-session', switchOn: 'yes' },
    },
  ],
  sentence: 'The daemon checks {target}\'s CI until it passes or ends, and tells you on {channel} when CI fails, until you change it.',
  done: 'Watching {target}; failures go to {channel}.',
  touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'unwatch',
  example: { target: 'acme/web#42', channel: 'slack' },
  method: { id: 'ci.watches.create', fields: { repo: 'target', deliveryChannel: 'channel', triggerFixSession: 'fix:yes' } },
  said(answer) {
    const watch = record(answer['watch']);
    return text(watch['id']) ? `Watch id ${text(watch['id'])}.` : '';
  },
};

export const CI_RUN: MethodCapabilityDefinition = {
  capability: { id: 'ci.run', group: 'automation', home: 'daemon', repeat: 'unsafe' },
  actionId: 'run', label: 'Check a watch now', word: 'run', inputs: [CI_WATCH_INPUT],
  sentence: '{watch} is checked now; a failure is reported and, if it says so, a fix session starts.', done: '',
  touches: 'another-machine', lasts: 'not-a-change', risk: 'none',
  example: { watch: 'w-31c' },
  method: { id: 'ci.watches.run', fields: { watchId: 'watch' } },
  said(answer) {
    return [
      ciReportLine(record(answer['report'])),
      answer['notified'] === true ? 'You were told.' : '',
      answer['fixSessionTriggered'] === true ? 'A fix session started.' : '',
      text(answer['fixSessionError']) ? `No fix session started: ${text(answer['fixSessionError'])}.` : '',
      answer['retired'] === true ? `The watch ended${text(answer['endedReason']) ? `: ${text(answer['endedReason'])}` : ''}.` : '',
      text(answer['fixSessionId']) ? `Fix session ${text(answer['fixSessionId'])}.` : '',
    ].filter(Boolean).join('\n');
  },
};

export const CI_UNWATCH: MethodCapabilityDefinition = {
  capability: { id: 'ci.unwatch', group: 'automation', home: 'daemon', repeat: 'safe' },
  actionId: 'unwatch', label: 'Stop watching a repository', word: 'unwatch', inputs: [CI_WATCH_INPUT],
  sentence: '{watch} is deleted; its repository is no longer checked.', done: '',
  touches: 'another-machine', lasts: 'kept', risk: 'cannot-be-undone',
  example: { watch: 'w-31c' },
  method: { id: 'ci.watches.delete', fields: { watchId: 'watch' } },
  said(answer, values) {
    return answer['deleted'] === true ? `Stopped watching ${values['watch'] ?? 'it'}.` : `No CI watch had the id ${values['watch'] ?? ''}; nothing was deleted.`;
  },
  // Nothing deleted: there is nothing that cannot be undone to speak of.
  did: (answer) => answer['deleted'] === true ? undefined : '',
};

// ---------------------------------------------------------------------------
// Check-ins
// ---------------------------------------------------------------------------

const CHECKIN_COMMAND = { name: 'checkin', title: 'Check-ins' };

export const CHECKIN_STATUS: MethodCapabilityDefinition = {
  capability: { id: 'checkin.status', group: 'automation', home: 'daemon', repeat: 'safe' },
  actionId: 'status', label: 'See what check-ins did', word: 'status', inputs: [],
  sentence: 'Shows the latest check-ins and what each did: stayed quiet, told you something, or was skipped and why.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  method: { id: 'checkin.receipts.list', fields: { limit: '=10' } },
  said(answer) {
    const receipts = list(answer['receipts']);
    if (receipts.length === 0) return 'No check-ins yet.';
    return receipts.map((receipt) => {
      const outcome = text(receipt['outcome']);
      const at = count(receipt['ranAt']);
      return `${formatScheduleTime(at, zone())}: ${CHECKIN_OUTCOME_WORDS[outcome] ?? outcome}. ${text(receipt['briefingSummary'])}`.trim();
    }).join('\n');
  },
};

export const CHECKIN_RUN: MethodCapabilityDefinition = {
  capability: { id: 'checkin.run', group: 'automation', home: 'daemon', repeat: 'unsafe' },
  actionId: 'run', label: 'Check in now', word: 'run', inputs: [],
  sentence: 'One check-in runs now: it reads how things stand and, when something needs you, sends a message to the check-in channel.', done: '',
  touches: 'another-machine', lasts: 'not-a-change', risk: 'sends-out', example: {},
  method: { id: 'checkin.run', fields: {} },
  said(answer) {
    const outcome = text(answer['outcome']);
    const did: Readonly<Record<string, string>> = { delivered: 'told you', quiet: 'stayed quiet: nothing needed you', skipped: 'was skipped', error: 'failed' };
    const summary = text(answer['summary']);
    return [`The check-in ${did[outcome] ?? outcome}${summary ? ` (${summary})` : ''}.`, text(answer['error']) ? `${text(answer['error'])}.` : ''].filter(Boolean).join('\n');
  },
  // Only a check-in that told you sent a message; one that stayed quiet, was skipped or failed sent nothing.
  did: (answer) => text(answer['outcome']) === 'delivered' ? 'This sent a message to the check-in channel.' : 'Nothing was sent.',
};

/** Every Automation capability, with the command name and title find shows beside it. */
export const AUTOMATION_METHOD_CAPABILITIES: readonly MovedMethodCapability[] = [
  ...[SCHEDULE_LIST, SCHEDULE_ADD, SCHEDULE_RUN, SCHEDULE_PAUSE, SCHEDULE_RESUME, SCHEDULE_STOP_RUN, SCHEDULE_RETRY_RUN, SCHEDULE_CHANGE, SCHEDULE_REMOVE]
    .map((definition) => ({ definition, command: SCHEDULE_COMMAND })),
  ...[TRIGGERS_LIST, TRIGGERS_WATCH, TRIGGERS_HISTORY, TRIGGERS_STOP, TRIGGERS_RESTART, TRIGGERS_COMMANDS, TRIGGERS_ALLOW_COMMAND]
    .map((definition) => ({ definition, command: TRIGGERS_COMMAND })),
  ...[CI_WATCHES, CI_STATUS, CI_WATCH, CI_RUN, CI_UNWATCH].map((definition) => ({ definition, command: CI_COMMAND })),
  ...[CHECKIN_STATUS, CHECKIN_RUN].map((definition) => ({ definition, command: CHECKIN_COMMAND })),
];
