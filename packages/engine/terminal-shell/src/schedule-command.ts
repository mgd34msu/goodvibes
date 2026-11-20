/**
 * `/schedule`, described once (command-actions/), one grammar for both
 * terminal apps: the guided path, typed line, help, completion, confirmation
 * and the model's catalogue entry come from this description. Where a
 * schedule is kept differs by app: the terminal app keeps it with the daemon
 * (or runs it itself while the daemon is off), the Agent on its connected
 * host. That is the host each app installs when it registers the command.
 */
import {
  buildAutonomySchedulePrompt,
  formatScheduleTime as formatScheduleTimeIn,
  formatScheduleTiming as formatScheduleTimingIn,
  readScheduleTiming,
  scheduleCreateTimingFields,
  scheduleFieldsFromValues,
  ScheduleValuesError,
  type AutomationScheduleDefinition,
  type ScheduleFields,
} from '@goodvibes/engine/platform/platform/automation';
import { REASONING_EFFORT_SEVERITY } from '@goodvibes/engine/platform/platform/providers';
import { commandRefusal } from './command-confirmation.js';
import type { TerminalCommandRegistry } from './command-registry.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, readList, type ListRow } from './command-actions/lists.js';
import type { ActionValues, CommandActionContext, CommandDescription, FixedChoice, InputDescription } from './command-actions/types.js';

/** A schedule as `/schedule` shows it, the same for every place one is kept. */
export interface ScheduleView {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly runCount: number;
  readonly nextRunAt?: number | undefined;
  readonly lastRunAt?: number | undefined;
  /** How it is timed, in words ("every 15m", "0 9 * * 1-5 [Europe/Vienna]"). */
  readonly timing: string;
  readonly prompt: string;
  /** The last run's outcome when it needs attention ("missed", "failed"). */
  readonly outcome?: string | undefined;
}

/** A routine's fields apart from its timing, name and prompt, in the shape both places take (one owner: the automation module). */
export type { ScheduleFields };

/** A reading of a described time ("every weekday at 9am") that one line may run at a time. */
export interface ScheduleReadingSlot {
  readonly ok: true;
  readonly signal: AbortSignal;
  current(): boolean;
  assertCurrent(): void;
  finish(): void;
}
export interface ScheduleCommandContext extends CommandActionContext {
  readonly renderRequest?: (() => void) | undefined;
  /** The terminal app's guard against a second reading of the same line while one runs. */
  readonly commandReadings?: {
    begin(key: string, fingerprint: string): ScheduleReadingSlot | { readonly ok: false; readonly reason: string };
    cancel(key: string): void;
  } | undefined;
}

/** Where one app keeps its schedules. Each method throws a refusal sentence when it cannot do it. */
export interface ScheduleHost<Ctx extends ScheduleCommandContext> {
  list(ctx: Ctx): Promise<{ readonly where: string; readonly schedules: readonly ScheduleView[]; readonly notices?: readonly string[] | undefined }>;
  create(ctx: Ctx, schedule: AutomationScheduleDefinition, name: string, prompt: string, fields: ScheduleFields): Promise<{ readonly schedule: ScheduleView; readonly runsNote: string }>;
  change(ctx: Ctx, id: string, patch: { readonly schedule?: AutomationScheduleDefinition | undefined; readonly name?: string | undefined; readonly prompt?: string | undefined }): Promise<string>;
  remove(ctx: Ctx, id: string): Promise<void>;
  setPaused(ctx: Ctx, id: string, paused: boolean): Promise<void>;
  runNow(ctx: Ctx, id: string): Promise<string>;
  /** Stop a run that is going; the answer says how it ended. */
  stopRun(ctx: Ctx, runId: string): Promise<string>;
  /** Run a failed run again; the answer names the new run. */
  retryRun(ctx: Ctx, runId: string): Promise<string>;
}

let installedHost: ScheduleHost<ScheduleCommandContext> | undefined;
function hostOf(): ScheduleHost<ScheduleCommandContext> {
  if (!installedHost) throw commandRefusal('Schedules are not available in this session.');
  return installedHost;
}

const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** One zone for every time this command prints: this machine's, named. */
export function formatScheduleTime(ms: number | undefined): string {
  return formatScheduleTimeIn(ms, LOCAL_ZONE);
}

/** A schedule's timing in words, its times in this machine's zone. */
export function formatScheduleTiming(schedule: AutomationScheduleDefinition): string {
  return formatScheduleTimingIn(schedule, LOCAL_ZONE);
}

/** The daemon's and host's create fields for a timing (`cron`, `every` or `at`), the one mapping both apps use. */
export const scheduleTimingFields = scheduleCreateTimingFields;

// ---------------------------------------------------------------------------
// Live list, read only when a guided step or a completion asks
// ---------------------------------------------------------------------------

function scheduleRow(view: ScheduleView): ListRow {
  return {
    value: view.id,
    label: view.name,
    detail: `${view.timing}; next ${view.enabled ? formatScheduleTime(view.nextRunAt) : 'none (paused)'}`,
    state: view.outcome ?? (view.enabled ? undefined : 'paused'),
  };
}

const SCHEDULES = defineList<ScheduleCommandContext>({
  name: 'schedules',
  async read(ctx) {
    return (await hostOf().list(ctx)).schedules.map(scheduleRow);
  },
  operator: { method: 'automation.schedules.list', input: {}, rows: { from: 'jobs', value: 'id', label: 'name', detail: 'description' } },
});

const PAUSED = defineList<ScheduleCommandContext>({
  name: 'schedules.paused',
  async read(ctx) {
    return (await hostOf().list(ctx)).schedules.filter((view) => !view.enabled).map(scheduleRow);
  },
  operator: { method: 'automation.schedules.list', input: {}, rows: { from: 'jobs', where: { field: 'enabled', equals: 'false' }, value: 'id', label: 'name', detail: 'description' } },
});

const RUNNING = defineList<ScheduleCommandContext>({
  name: 'schedules.running',
  async read(ctx) {
    return (await hostOf().list(ctx)).schedules.filter((view) => view.enabled).map(scheduleRow);
  },
  operator: { method: 'automation.schedules.list', input: {}, rows: { from: 'jobs', where: { field: 'enabled', equals: 'true' }, value: 'id', label: 'name', detail: 'description' } },
});

const SCHEDULE: InputDescription = {
  id: 'schedule', label: 'Schedule', help: 'Your schedules', kind: 'choice', choices: { list: SCHEDULES }, required: true, typed: { position: 1 },
};

// ---------------------------------------------------------------------------
// The timing blanks, shared by "Schedule something to run" and "Change a schedule"
// ---------------------------------------------------------------------------

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
    { id: 'when', label: 'Describe it', help: 'In your words, such as every weekday at 9am', kind: 'text', freeTextReason: 'your own words for when', required: need('keep its timing'), typed: { flag: '--when' }, step, showWhen: { input: 'how', is: 'describe' } },
    { id: 'at', label: 'At', help: 'A date and time such as 2026-12-01T09:00', kind: 'date-time', required: need('keep its timing'), typed: { flag: '--at' }, step, showWhen: { input: 'how', is: 'at' } },
    { id: 'every', label: 'Every', help: 'An interval such as 15m, 2h or 1d', kind: 'text', freeTextReason: 'an interval such as 15m', required: need('keep its timing'), typed: { flag: '--every' }, step, showWhen: { input: 'how', is: 'every' } },
    { id: 'cron', label: 'Pattern', help: 'Five cron fields, such as 0 9 * * 1-5', kind: 'text', freeTextReason: 'a cron expression', required: need('keep its timing'), typed: { flag: '--cron' }, step, showWhen: { input: 'how', is: 'cron' } },
    { id: 'tz', label: 'Time zone', help: 'For a pattern or a description; blank for this machine\'s time zone', kind: 'text', freeTextReason: 'a time zone such as Europe/Vienna', required: { default: '', defaultMeans: 'this machine\'s time zone' }, typed: { flag: '--tz' }, step: step + 1 },
    { id: 'stagger', label: 'Spread the start', help: 'Start up to this long after the pattern\'s time, such as 5m, so many runs do not start at once', kind: 'text', freeTextReason: 'a duration such as 5m', required: { default: '', defaultMeans: 'start on time' }, typed: { flag: '--stagger' }, step: step + 1 },
  ];
}

/** The timing the values give, or undefined when none was given; throws a refusal sentence. */
async function timingOf(values: ActionValues, ctx: ScheduleCommandContext, line: string): Promise<AutomationScheduleDefinition | undefined> {
  // A second run of the same line while the first is still being read starts no second reading.
  const described = Boolean(values.when) && !values.cron && !values.every && !values.at;
  const readings = described ? ctx.commandReadings : undefined;
  readings?.cancel('schedule');
  const begun = readings?.begin('schedule', line);
  if (begun && !begun.ok) throw commandRefusal(begun.reason === 'pending' ? 'This schedule is already being read; it is kept when the reading finishes. Nothing new was started.' : 'Schedule reading is not available while the terminal is closing. Nothing was kept.');
  const slot = begun && begun.ok ? begun : undefined;
  try {
    const schedule = await readScheduleTiming(values, {
      zone: LOCAL_ZONE,
      ...(slot ? { signal: slot.signal, beforeAttempt: slot.assertCurrent } : {}),
      onReading: () => ctx.print('Reading when it runs…'),
      onRetry: () => { if (!slot || slot.current()) ctx.print('Still reading when it runs…'); },
    });
    if (slot && !slot.current()) throw commandRefusal('A newer line replaced this one; nothing was kept.');
    if (schedule && described) ctx.print(`Read as: ${formatScheduleTiming(schedule)}`);
    return schedule;
  } catch (error) {
    if (error instanceof ScheduleValuesError) throw commandRefusal(error.message);
    throw error;
  } finally {
    slot?.finish();
  }
}

// ---------------------------------------------------------------------------
// The further settings of a new schedule ("Anything else?")
// ---------------------------------------------------------------------------

const TARGETS: readonly FixedChoice[] = [
  { value: 'isolated', label: 'A fresh conversation each time', help: 'Nothing earlier is carried into a run.' },
  { value: 'main', label: 'Your main conversation', help: 'Each run continues the main session.' },
  { value: 'background', label: 'In the background', help: 'A background session of its own.' },
  { value: 'pinned', label: 'The pinned conversation', help: 'Runs in the session you pinned.' },
];

function option(id: string, label: string, help: string, flag: `--${string}`, defaultMeans: string, reason: string): InputDescription {
  return { id, label, help, kind: 'text', freeTextReason: reason, required: { default: '', defaultMeans }, typed: { flag }, step: 4 };
}

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
  { id: 'tool', label: 'Tools it may use', help: 'Only these tools; one per --tool', kind: 'text', freeTextReason: 'a tool name', required: { default: '', defaultMeans: 'every tool a run usually has' }, typed: { flag: '--tool', repeats: true }, step: 4 },
  option('template', 'Template', 'A prompt template it starts from', '--template', 'none', 'a template name'),
  { id: 'light', label: 'Light context', help: 'Start each run with less context, for speed', kind: 'choice', choices: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }], required: { default: 'no', defaultMeans: 'no' }, typed: { flag: '--light-context', switchOn: 'yes' }, step: 4 },
  { id: 'paused', label: 'Start paused', help: 'Kept, but runs only once you resume it', kind: 'choice', choices: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }], required: { default: 'no', defaultMeans: 'no' }, typed: { flag: '--paused', switchOn: 'yes' }, step: 4 },
];

function fieldsOf(values: ActionValues): ScheduleFields {
  try { return scheduleFieldsFromValues(values); } catch (error) {
    if (error instanceof ScheduleValuesError) throw commandRefusal(error.message);
    throw error;
  }
}

async function pick(ctx: ScheduleCommandContext, id: string): Promise<ScheduleView> {
  const { schedules } = await hostOf().list(ctx);
  const exact = schedules.find((view) => view.id === id);
  if (exact) return exact;
  const matches = schedules.filter((view) => view.id.startsWith(id) || view.name === id);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw commandRefusal(`No schedule ${id}; nothing was changed.`, '/schedule list shows them.');
  throw commandRefusal(`"${id}" names ${matches.length} schedules; nothing was changed: ${matches.map((view) => `${view.id} (${view.name})`).join(', ')}.`, 'Give more of its id.');
}

function shortPrompt(prompt: string): string {
  const trimmed = prompt.trim();
  return trimmed.length > 60 ? `${trimmed.slice(0, 60)}...` : trimmed;
}

// ---------------------------------------------------------------------------
// The description
// ---------------------------------------------------------------------------

export const SCHEDULE_COMMAND: CommandDescription<ScheduleCommandContext> = {
  name: 'schedule',
  // --yes confirms only right after the action word: the same word in the text is text.
  leadingFlagsOnly: true,
  title: 'Schedules',
  summary: 'Run something at set times, with or without the app open',
  group: 'Automation',
  report: 'see-schedules',
  firstScreenRows: ['see-schedules', 'add', 'run-now', 'pause', 'resume', 'change', 'remove', { label: 'A run that is going or failed…', actions: ['stop-run', 'retry-run'] }],
  actions: [
    {
      id: 'see-schedules', label: 'See your schedules', word: 'list', inputs: [],
      async rowValue(ctx) {
        const { schedules } = await hostOf().list(ctx);
        if (schedules.length === 0) return 'none yet';
        const paused = schedules.filter((view) => !view.enabled).length;
        return `${schedules.length} schedule${schedules.length === 1 ? '' : 's'}${paused > 0 ? `, ${paused} paused` : ''}`;
      },
      sentence: 'Shows each schedule: its name, when it runs, its next and last run, and what it does.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { method: 'automation.schedules.list', fields: {} }, example: {},
      async run(_values, ctx) {
        const { where, schedules, notices } = await hostOf().list(ctx);
        if (notices && notices.length > 0) ctx.print(notices.join('\n'));
        if (schedules.length === 0) {
          ctx.print(`No schedules (${where}). Make one: /schedule, "Schedule something to run", or /schedule add --when "every weekday at 9am" summarise open pull requests`);
          return;
        }
        const lines = [`Schedules (${schedules.length}, ${where}; times in ${LOCAL_ZONE}):`, ''];
        for (const view of schedules) {
          lines.push(`  ${view.enabled ? '●' : '○'} ${view.name}${view.enabled ? '' : ' (paused)'}  ${view.timing}  next: ${view.enabled ? formatScheduleTime(view.nextRunAt) : 'none'}  last: ${view.lastRunAt ? formatScheduleTime(view.lastRunAt) : 'never'}  runs: ${view.runCount}`);
          lines.push(`    ${shortPrompt(view.prompt)}  (id ${view.id})`);
          if (view.outcome) lines.push(`    last run ${view.outcome}`);
        }
        ctx.print(lines.join('\n'));
      },
    },
    {
      id: 'add', label: 'Schedule something to run', word: 'add',
      stepTitles: ['What should it do? Say it the way you would ask in the chat.', 'When?', 'When, more exactly', 'Anything else? These are the usual settings.'],
      inputs: [
        { id: 'prompt', label: 'What it does', help: 'Say it the way you would ask in the chat', kind: 'long-text', freeTextReason: 'your own words for what it does', required: true, typed: { tail: true }, step: 1 },
        ...timingInputs(2, true),
        ...MORE,
      ],
      sentence: '"{prompt}" will run at the times you gave, whether or not this app is open, until you change it.',
      done: 'Scheduled.',
      touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'remove',
      // The web UI's sheet has the daemon read the blanks (a described time included) and show the reading before it keeps it.
      operator: {
        method: 'automation.schedules.create',
        preview: 'automation.schedules.preview',
        fields: {
          action: '="add"', prompt: 'prompt', when: 'when', at: 'at', every: 'every', cron: 'cron', tz: 'tz', stagger: 'stagger', name: 'name',
          target: 'target', model: 'model', provider: 'provider', deliver: 'deliver', outside: 'outside', source: 'source', reasoning: 'reasoning',
          thinking: 'thinking', wake: 'wake', fallback: 'fallback', tool: 'tool', template: 'template', light: 'light', paused: 'paused',
        },
      },
      example: { prompt: 'summarise open pull requests', when: 'every weekday at 9am' },
      async run(values, ctx) {
        const fields = fieldsOf(values);
        const schedule = await timingOf(values, ctx, JSON.stringify(values));
        if (!schedule) throw commandRefusal('Say when it runs: describe it (--when), a date (--at), an interval (--every) or a pattern (--cron). Nothing was kept.');
        const prompt = values.prompt!.trim();
        const { schedule: kept, runsNote } = await hostOf().create(ctx, schedule, values.name || prompt.slice(0, 40), prompt, fields);
        ctx.renderRequest?.();
        return [
          `"${kept.name}": ${kept.timing}; next run ${formatScheduleTime(kept.nextRunAt)}${runsNote ? ` (${runsNote})` : ''}.`,
          `The answer goes to ${values.deliver ? values.deliver : 'your owner inbox'}. Id ${kept.id}.`,
        ].join('\n');
      },
    },
    {
      id: 'run-now', label: 'Run a schedule now', word: 'run',
      inputs: [SCHEDULE],
      sentence: '{schedule} will run once now; its usual times stay as they are.',
      done: 'Started {schedule}.',
      touches: 'this-machine', lasts: 'not-a-change', risk: 'none',
      operator: { method: 'automation.schedules.run', fields: { scheduleId: 'schedule' } },
      example: { schedule: 'weekly-report' },
      async run(values, ctx) {
        const view = await pick(ctx, values.schedule!);
        return `${view.name}: ${await hostOf().runNow(ctx, view.id)}`;
      },
    },
    {
      id: 'pause', label: 'Pause a schedule', word: 'pause',
      inputs: [{ ...SCHEDULE, help: 'Schedules that run now', choices: { list: RUNNING } }],
      sentence: '{schedule} will not run {lasts}; it is kept, and Resume a schedule starts it again.',
      done: 'Paused {schedule}.',
      touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'resume',
      operator: { method: 'automation.schedules.pause', fields: { scheduleId: 'schedule' } },
      example: { schedule: 'weekly-report' },
      async run(values, ctx) {
        const view = await pick(ctx, values.schedule!);
        await hostOf().setPaused(ctx, view.id, true);
        ctx.renderRequest?.();
        return undefined;
      },
    },
    {
      id: 'resume', label: 'Resume a schedule', word: 'resume',
      inputs: [{ ...SCHEDULE, help: 'Paused schedules', choices: { list: PAUSED } }],
      sentence: '{schedule} will run again at its next time, {lasts}.',
      done: 'Resumed {schedule}.',
      touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'pause',
      operator: { method: 'automation.schedules.resume', fields: { scheduleId: 'schedule' } },
      example: { schedule: 'weekly-report' },
      async run(values, ctx) {
        const view = await pick(ctx, values.schedule!);
        await hostOf().setPaused(ctx, view.id, false);
        ctx.renderRequest?.();
        return undefined;
      },
    },
    {
      id: 'stop-run', label: 'Stop a run that is going', word: 'stop-run',
      inputs: [{ id: 'run', label: 'Run', help: 'The run id Run a schedule now printed', kind: 'text', freeTextReason: 'a run id', required: true, typed: { position: 1 } }],
      sentence: 'Run {run} is stopped; its schedule keeps its usual times.',
      done: 'Stopped run {run}.',
      touches: 'this-machine', lasts: 'not-a-change', risk: 'cannot-be-undone',
      operator: { method: 'automation.runs.cancel', fields: { runId: 'run' } },
      example: { run: 'run-1a2b' },
      async run(values, ctx) { return hostOf().stopRun(ctx, values.run!); },
    },
    {
      id: 'retry-run', label: 'Run a failed run again', word: 'retry-run',
      inputs: [{ id: 'run', label: 'Run', help: 'The run id of the run that failed', kind: 'text', freeTextReason: 'a run id', required: true, typed: { position: 1 } }],
      sentence: 'Run {run} runs again as a new run; its schedule keeps its usual times.',
      done: '',
      touches: 'this-machine', lasts: 'not-a-change', risk: 'none',
      operator: { method: 'automation.runs.retry', fields: { runId: 'run' } },
      example: { run: 'run-1a2b' },
      async run(values, ctx) { return hostOf().retryRun(ctx, values.run!); },
    },
    {
      id: 'change', label: 'Change a schedule', word: 'change',
      stepTitles: ['Which schedule?', 'When? Leave it to keep its timing.', 'When, more exactly', 'What else changes? Blank keeps it.'],
      inputs: [
        { ...SCHEDULE, step: 1 },
        ...timingInputs(2, false),
        { id: 'name', label: 'Name', help: 'A new name; blank keeps it', kind: 'text', freeTextReason: 'a name you choose', required: { default: '', defaultMeans: 'keep its name' }, typed: { flag: '--name' }, step: 4 },
        { id: 'prompt', label: 'What it does', help: 'New words for what it does; blank keeps them', kind: 'long-text', freeTextReason: 'your own words for what it does', required: { default: '', defaultMeans: 'keep what it does' }, typed: { tail: true }, step: 4 },
        { id: 'task', label: 'Or a task', help: 'Instead of plain words: the task, with the result that shows it is done below', kind: 'text', freeTextReason: 'your own words for the task', required: { default: '', defaultMeans: 'no task' }, typed: { flag: '--task' }, step: 4 },
        { id: 'success', label: 'Done when', help: 'The result that shows the task is done', kind: 'text', freeTextReason: 'your own words for the result', required: { default: '', defaultMeans: 'no task' }, typed: { flag: '--success-criteria' }, step: 4 },
      ],
      sentence: '{schedule} will run with what you changed, until you change it again.',
      done: 'Changed {schedule}.',
      touches: 'this-machine', lasts: 'kept', risk: 'none',
      operator: {
        method: 'automation.jobs.update',
        preview: 'automation.schedules.preview',
        fields: { action: '="change"', schedule: 'schedule', when: 'when', at: 'at', every: 'every', cron: 'cron', tz: 'tz', stagger: 'stagger', name: 'name', prompt: 'prompt', task: 'task', success: 'success' },
      },
      example: { schedule: 'weekly-report', cron: '0 8 * * 1' },
      async run(values, ctx) {
        const view = await pick(ctx, values.schedule!);
        if (Boolean(values.task) !== Boolean(values.success)) throw commandRefusal('A task needs the result that shows it is done (and that result its task); give both. Nothing was changed.');
        if (values.task && values.prompt) throw commandRefusal('Give new words for what it does, or a task with its result, not both. Nothing was changed.');
        const prompt = values.task && values.success
          ? buildAutonomySchedulePrompt({ task: values.task, successCriteria: values.success, explicitUserRequest: `/schedule change ${view.id}` })
          : values.prompt || undefined;
        const schedule = await timingOf(values, ctx, JSON.stringify(values));
        if (!schedule && !values.name && !prompt) throw commandRefusal(`Nothing to change for ${view.name}: give a new time, name or what it does.`);
        const detail = await hostOf().change(ctx, view.id, { schedule, name: values.name || undefined, prompt });
        ctx.renderRequest?.();
        return detail;
      },
    },
    {
      id: 'remove', label: 'Remove a schedule', word: 'remove',
      inputs: [SCHEDULE],
      sentence: '{schedule} will stop running and be removed.',
      done: 'Removed {schedule}.',
      touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone',
      operator: { method: 'automation.schedules.delete', fields: { scheduleId: 'schedule' } },
      example: { schedule: 'weekly-report' },
      async run(values, ctx) {
        const view = await pick(ctx, values.schedule!);
        await hostOf().remove(ctx, view.id);
        ctx.renderRequest?.();
        return `It was "${view.name}" (${view.timing}).`;
      },
    },
  ],
};

const SCHEDULE_SLASH_COMMAND = defineCommand(SCHEDULE_COMMAND);

/** Register `/schedule` (the one description) with this app's host. */
export function registerScheduleCommand<Ctx extends ScheduleCommandContext>(registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>, host: ScheduleHost<Ctx>): void {
  installedHost = host as unknown as ScheduleHost<ScheduleCommandContext>;
  registry.register(SCHEDULE_SLASH_COMMAND);
}

/** The schedules this app keeps, as rows (the Agent workspace and the palette read them). */
export function readSchedules(ctx: ScheduleCommandContext): Promise<readonly ListRow[]> {
  return readList(SCHEDULES, ctx, {});
}
