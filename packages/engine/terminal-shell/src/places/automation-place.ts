/**
 * automation-place.ts, the Automation place: what runs by itself. Your
 * schedules and their runs, your triggers and the commands they may run,
 * your CI watches, and what the check-ins did.
 *
 * Every list is read from the daemon, which keeps and runs all of it, and
 * follows its change events (the `automation` domain for schedules and runs;
 * the `triggers`, `ci-watches` and `check-ins` lists), so a schedule paused,
 * a trigger stopped or a watch made from the web UI, a script or a model
 * shows here with no key pressed. Every action is an Automation capability
 * (platform capabilities/builtin/automation.ts), run through
 * `capabilities.run`; only those that apply to the selected item in its state
 * are on the hint row, with the one that makes a new thing of a tab's kind.
 */
// The schedule words' own module (no store, no scheduler): the web UI draws this declaration too (places/browser.ts).
import {
  formatScheduleTime as formatScheduleTimeIn,
  formatScheduleTiming as formatScheduleTimingIn,
} from '@goodvibes/engine/platform/platform/automation/schedule-words';
import type { AutomationScheduleDefinition } from '@goodvibes/engine/platform/platform/automation';
import {
  AUTOMATION_RUN_STATE_WORDS, CHECKIN_OUTCOME_WORDS, CI_VERDICT_WORDS, TRIGGER_GAVE_UP_STATES, TRIGGER_LIVE_STATES, TRIGGER_STATE_WORDS, ciTargetText, watchingWords,
} from '@goodvibes/engine/platform/platform/capabilities/automation-words';
// The lists the capabilities' inputs choose from (a form that asks for a schedule, a trigger or a watch) are
// automation-lists.ts, registered by each program with its daemon binding; this declaration holds no terminal code.
import { definePlace, type PlaceAction, type PlaceItem, type PlaceList } from './place-types.js';
import { AUTOMATION_ROUTINE_ACTIONS, AUTOMATION_ROUTINES_LIST } from './memory-stores-entries.js';

const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** A time in this machine's zone, named. */
export function formatScheduleTime(ms: number | undefined): string {
  return formatScheduleTimeIn(ms, LOCAL_ZONE);
}

/** A schedule's timing in words, its times in this machine's zone. */
export function formatScheduleTiming(schedule: AutomationScheduleDefinition): string {
  return formatScheduleTimingIn(schedule, LOCAL_ZONE);
}

interface ScheduleItem extends PlaceItem {
  readonly kind: 'schedule';
  readonly state: 'active' | 'paused';
  readonly name: string;
  readonly timing: string;
  readonly nextRunAt?: number | undefined;
  readonly lastRunAt?: number | undefined;
  readonly runCount: number;
  readonly prompt: string;
  /** The project folder it runs in (its execution's); empty for a schedule kept before schedules kept one. */
  readonly project: string;
  /** The last run's outcome when it needs attention. */
  readonly trouble?: string | undefined;
  readonly pausedReason?: string | undefined;
}

interface RunItem extends PlaceItem {
  readonly kind: 'run';
  readonly state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'missed';
  readonly schedule: string;
  readonly at?: number | undefined;
  readonly endedAt?: number | undefined;
  readonly error?: string | undefined;
}

interface TriggerItem extends PlaceItem {
  readonly kind: 'trigger';
  /** The supervisor's own state: idle, running, backoff, circuit-open, firing, fired, cancelled, failed. */
  readonly state: string;
  readonly label: string;
  readonly watching: string;
  readonly firedCount: number;
  readonly lastFiredAt?: number | undefined;
  readonly nextCheckAt?: number | undefined;
  readonly lastError?: string | undefined;
}

interface GrantItem extends PlaceItem {
  readonly kind: 'grant';
  readonly state: 'allowed';
  readonly command: string;
  readonly digest: string;
  readonly confirmedBy: string;
  readonly confirmedAt?: number | undefined;
}

interface WatchItem extends PlaceItem {
  readonly kind: 'watch';
  /** Its last verdict (passed, failed, pending, unknown), or `unchecked`. */
  readonly state: string;
  readonly target: string;
  readonly channel: string;
  readonly fixSession: boolean;
  readonly expiresAt?: number | undefined;
  readonly repair?: string | undefined;
}

interface CheckinItem extends PlaceItem {
  readonly kind: 'checkin';
  /** The receipt's outcome: delivered, partial, quiet, skipped-*, cancelled, error. */
  readonly state: string;
  readonly ranAt?: number | undefined;
  readonly manual: boolean;
  readonly summary: string;
  readonly reason?: string | undefined;
  readonly delivered?: string | undefined;
  readonly channel?: string | undefined;
  readonly error?: string | undefined;
}

type Item = ScheduleItem | RunItem | TriggerItem | GrantItem | WatchItem | CheckinItem;

type Row = Readonly<Record<string, unknown>>;
const isRow = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const rowsAt = (output: unknown, field: string): readonly Row[] => {
  const body = isRow(output) ? output[field] : undefined;
  return Array.isArray(body) ? body.filter(isRow) : [];
};
/** Text from another process, with control characters taken out before it is shown. */
const text = (value: unknown): string => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '') : '';
const time = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const isoTime = (value: unknown): number | undefined => {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : time(value);
};

// ---------------------------------------------------------------------------
// Schedules and runs (one `automation.schedules.list` for both)
// ---------------------------------------------------------------------------

function timing(schedule: unknown): string {
  if (!schedule || typeof schedule !== 'object') return 'not said';
  try { return formatScheduleTiming(schedule as AutomationScheduleDefinition); } catch { return 'not said'; }
}

function schedules(output: unknown): readonly ScheduleItem[] {
  const jobs = rowsAt(output, 'jobs');
  const runs = rowsAt(output, 'runs');
  const latest = new Map<string, Row>();
  for (const run of runs) {
    const job = text(run['jobId']);
    const at = time(run['startedAt']) ?? time(run['queuedAt']) ?? 0;
    const held = latest.get(job);
    if (!held || (time(held['startedAt']) ?? time(held['queuedAt']) ?? 0) < at) latest.set(job, run);
  }
  return jobs.filter((job) => text(job['id'])).map((job): ScheduleItem => {
    const id = text(job['id']);
    const lastStatus = text(latest.get(id)?.['status']);
    const trouble = lastStatus === 'failed' || lastStatus === 'missed' ? `last run ${lastStatus}` : job['lastOutcome'] === 'failed' ? 'last run failed' : undefined;
    const execution = isRow(job['execution']) ? job['execution'] : {};
    return {
      kind: 'schedule',
      id,
      state: job['enabled'] === false ? 'paused' : 'active',
      name: text(job['name']) || id,
      timing: timing(job['schedule']),
      nextRunAt: time(job['nextRunAt']),
      lastRunAt: time(job['lastRunAt']),
      runCount: time(job['runCount']) ?? 0,
      prompt: text(execution['prompt']) || text(job['description']),
      project: text(execution['workingDirectory']),
      ...(trouble ? { trouble } : {}),
      ...(text(job['pausedReason']) ? { pausedReason: text(job['pausedReason']) } : {}),
    };
  });
}

const RUN_STATES = new Set<string>(['queued', 'running', 'completed', 'failed', 'cancelled', 'missed']);

function runsOf(output: unknown): readonly RunItem[] {
  const names = new Map(rowsAt(output, 'jobs').map((job) => [text(job['id']), text(job['name'])]));
  return rowsAt(output, 'runs')
    .filter((run) => text(run['id']) && RUN_STATES.has(text(run['status'])))
    .map((run): RunItem => ({
      kind: 'run',
      id: text(run['id']),
      state: text(run['status']) as RunItem['state'],
      schedule: names.get(text(run['jobId'])) || text(run['jobId']),
      at: time(run['startedAt']) ?? time(run['queuedAt']),
      endedAt: time(run['endedAt']),
      ...(text(run['error']) ? { error: text(run['error']) } : {}),
    }))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

/** Why a schedule is paused, in a person's words (the daemon's reason codes). */
const PAUSED_WORDS: Readonly<Record<string, string>> = {
  'operator-disabled': 'it was paused on request (here, the web UI or a script)',
  disabled: 'it was paused',
  'failure-threshold-reached': 'it failed too many times in a row',
};

// ---------------------------------------------------------------------------
// Triggers and the commands they may run
// ---------------------------------------------------------------------------

function triggers(output: unknown): readonly TriggerItem[] {
  return rowsAt(output, 'triggers').filter((trigger) => text(trigger['id'])).map((trigger): TriggerItem => ({
    kind: 'trigger',
    id: text(trigger['id']),
    state: text(trigger['state']) || 'idle',
    label: text(trigger['label']) || text(trigger['id']),
    watching: watchingWords(text(trigger['watching'])),
    firedCount: time(trigger['firedCount']) ?? 0,
    lastFiredAt: isoTime(trigger['lastFiredAt']),
    nextCheckAt: isoTime(trigger['nextCheckAt']),
    ...(text(trigger['lastError']) ? { lastError: text(trigger['lastError']) } : {}),
  }));
}

function grants(output: unknown): readonly GrantItem[] {
  return rowsAt(output, 'grants').filter((grant) => text(grant['id'])).map((grant): GrantItem => ({
    kind: 'grant',
    id: text(grant['id']),
    state: 'allowed',
    command: [text(grant['command']), ...(Array.isArray(grant['args']) ? grant['args'].map(text) : [])].join(' '),
    digest: text(grant['digest']),
    confirmedBy: text(grant['confirmedBy']),
    confirmedAt: isoTime(grant['confirmedAt']),
  }));
}

const TRIGGER_LIVE = TRIGGER_LIVE_STATES;
const TRIGGER_GAVE_UP = TRIGGER_GAVE_UP_STATES;

// ---------------------------------------------------------------------------
// CI watches and check-ins
// ---------------------------------------------------------------------------

function watches(output: unknown): readonly WatchItem[] {
  return rowsAt(output, 'watches').filter((watch) => text(watch['id'])).map((watch): WatchItem => {
    const repair = isRow(watch['repair']) ? watch['repair'] : undefined;
    return {
      kind: 'watch',
      id: text(watch['id']),
      state: text(watch['lastOverall']) || 'unchecked',
      target: ciTargetText(watch),
      channel: text(watch['deliveryChannel']),
      fixSession: watch['triggerFixSession'] === true,
      expiresAt: time(watch['expiresAt']),
      ...(repair ? { repair: `${text(repair['outcome'])} after ${time(repair['attempts']) ?? 1} attempt${time(repair['attempts']) === 1 ? '' : 's'}${text(repair['reason']) ? `: ${text(repair['reason'])}` : ''}` } : {}),
    };
  });
}

function checkins(output: unknown): readonly CheckinItem[] {
  return rowsAt(output, 'receipts').filter((receipt) => text(receipt['id'])).map((receipt): CheckinItem => ({
    kind: 'checkin',
    id: text(receipt['id']),
    state: text(receipt['outcome']) || 'error',
    ranAt: time(receipt['ranAt']),
    manual: receipt['trigger'] === 'manual',
    summary: text(receipt['briefingSummary']),
    ...(text(receipt['decisionReason']) ? { reason: text(receipt['decisionReason']) } : {}),
    ...(text(receipt['deliveredMessage']) ? { delivered: text(receipt['deliveredMessage']) } : {}),
    ...(text(receipt['deliveryChannel']) ? { channel: text(receipt['deliveryChannel']) } : {}),
    ...(text(receipt['error']) ? { error: text(receipt['error']) } : {}),
  }));
}

/**
 * What each list follows: its own source's notice only (a trigger change does not read the CI watches again).
 * Schedules and runs: the automation domain's frames; triggers and the commands they may run: LIST_CHANGED `triggers`
 * (triggers/manager.ts); CI watches: `ci-watches`; check-ins: `check-ins`. A capability that acts on a list is heard by
 * it besides (LIST_CHANGED `capabilities`, place-modal.ts followPlace).
 */
const AUTOMATION_EVENTS = { domains: ['automation'], events: ['automation'] } as const;
const TRIGGER_EVENTS = { domains: [], events: [], lists: ['triggers'] } as const;
const CI_EVENTS = { domains: [], events: [], lists: ['ci-watches'] } as const;
const CHECKIN_EVENTS = { domains: [], events: [], lists: ['check-ins'] } as const;

export const AUTOMATION_PLACE = definePlace<Item>({
  id: 'automation',
  group: 'automation',
  title: 'Automation',
  lists: [
    {
      id: 'schedules',
      label: 'Schedules',
      noun: 'your schedules',
      source: { kind: 'daemon', method: 'automation.schedules.list', input: {}, items: schedules },
      follows: AUTOMATION_EVENTS,
      empty: 'No schedules yet: nothing runs by itself.',
      row: (item) => {
        const schedule = item as ScheduleItem;
        // One schedule list for the person: each row names its project; a state that needs a word (paused, failed)
        // comes first; its times are in the detail.
        const where = schedule.project ? `in ${schedule.project.split(/[\\/]/).filter(Boolean).pop() ?? schedule.project}` : 'in no project';
        return {
          title: schedule.name,
          right: schedule.state === 'paused' ? `paused, ${where}` : schedule.trouble ? `${schedule.trouble}, ${where}` : where,
          mark: schedule.state === 'paused' ? 'paused' : schedule.trouble ? 'attention' : 'ok',
        };
      },
      detail: (item) => {
        const schedule = item as ScheduleItem;
        return [
          { label: 'Project', text: schedule.project || 'none kept (made before schedules kept their project)' },
          { label: 'When', text: schedule.timing },
          { label: 'Next run', text: schedule.state === 'paused' ? 'none (paused)' : formatScheduleTime(schedule.nextRunAt) },
          { label: 'Last run', text: schedule.lastRunAt ? formatScheduleTime(schedule.lastRunAt) : 'never' },
          { label: 'Runs so far', text: String(schedule.runCount) },
          ...(schedule.trouble ? [{ label: 'Needs a look', text: schedule.trouble, tone: 'warning' as const }] : []),
          ...(schedule.state === 'paused' && schedule.pausedReason ? [{ label: 'Paused because', text: PAUSED_WORDS[schedule.pausedReason] ?? schedule.pausedReason, tone: 'muted' as const }] : []),
          { text: '' },
          { label: 'What it does', text: schedule.prompt || 'not said' },
        ];
      },
    },
    {
      id: 'runs',
      label: 'Runs',
      noun: 'the runs of your schedules',
      source: { kind: 'daemon', method: 'automation.schedules.list', input: {}, items: runsOf },
      follows: AUTOMATION_EVENTS,
      empty: 'No runs yet.',
      row: (item) => {
        const run = item as RunItem;
        return {
          title: run.schedule,
          right: AUTOMATION_RUN_STATE_WORDS[run.state] ?? run.state,
          mark: run.state === 'failed' || run.state === 'missed' ? 'attention' : run.state === 'running' || run.state === 'queued' ? 'running' : 'ok',
        };
      },
      detail: (item) => {
        const run = item as RunItem;
        return [
          { label: 'Schedule', text: run.schedule },
          { label: 'State', text: AUTOMATION_RUN_STATE_WORDS[run.state] ?? run.state },
          ...(run.at ? [{ label: 'Started', text: formatScheduleTime(run.at) }] : []),
          ...(run.endedAt ? [{ label: 'Ended', text: formatScheduleTime(run.endedAt) }] : []),
          ...(run.error ? [{ label: 'What went wrong', text: run.error, tone: 'warning' as const }] : []),
        ];
      },
    },
    {
      id: 'triggers',
      label: 'Triggers',
      noun: 'your triggers',
      source: { kind: 'daemon', method: 'watchers.triggers.list', input: {}, items: triggers },
      follows: TRIGGER_EVENTS,
      empty: 'No triggers yet: nothing is watched.',
      row: (item) => {
        const trigger = item as TriggerItem;
        const words = TRIGGER_STATE_WORDS[trigger.state] ?? trigger.state;
        return {
          title: trigger.label,
          ...(trigger.state === 'idle' ? {} : { right: words.split(':')[0] }),
          mark: trigger.state === 'idle' ? 'ok' : trigger.state === 'running' || trigger.state === 'firing' ? 'running'
            : trigger.state === 'cancelled' || trigger.state === 'fired' ? 'paused' : 'attention',
        };
      },
      detail: (item) => {
        const trigger = item as TriggerItem;
        return [
          { label: 'Watches', text: trigger.watching || 'not said' },
          { label: 'State', text: TRIGGER_STATE_WORDS[trigger.state] ?? trigger.state, ...(TRIGGER_GAVE_UP.includes(trigger.state) ? { tone: 'warning' as const } : {}) },
          { label: 'Acted', text: trigger.firedCount === 0 ? 'not yet' : trigger.firedCount === 1 ? 'once' : `${trigger.firedCount} times` },
          ...(trigger.lastFiredAt ? [{ label: 'Last acted', text: formatScheduleTime(trigger.lastFiredAt) }] : []),
          ...(trigger.nextCheckAt && TRIGGER_LIVE.includes(trigger.state) ? [{ label: 'Looks again', text: formatScheduleTime(trigger.nextCheckAt) }] : []),
          ...(trigger.lastError ? [{ label: 'Last problem', text: trigger.lastError, tone: 'warning' as const }] : []),
        ];
      },
    },
    {
      id: 'commands',
      label: 'Commands',
      noun: 'the commands triggers may run',
      source: { kind: 'daemon', method: 'watchers.triggers.grant.list', input: {}, items: grants },
      follows: TRIGGER_EVENTS,
      empty: 'Triggers may run no command yet.',
      row: (item) => ({ title: item.id, right: (item as GrantItem).command, mark: 'ok' }),
      detail: (item) => {
        const grant = item as GrantItem;
        return [
          { label: 'Runs', text: grant.command },
          { label: 'Approved by', text: grant.confirmedBy || 'not said' },
          ...(grant.confirmedAt ? [{ label: 'Approved', text: formatScheduleTime(grant.confirmedAt) }] : []),
          { label: 'Digest', text: grant.digest, tone: 'muted' as const },
          { text: '' },
          { text: 'A trigger runs it, exactly so and with nobody asked, when it names it with "Then: Run a command you approved".', tone: 'muted' as const },
        ];
      },
    },
    {
      id: 'ci',
      label: 'CI watches',
      noun: 'your CI watches',
      source: { kind: 'daemon', method: 'ci.watches.list', input: {}, items: watches },
      follows: CI_EVENTS,
      empty: 'No CI watches yet.',
      row: (item) => {
        const watch = item as WatchItem;
        return {
          title: watch.target,
          right: watch.state === 'unchecked' ? 'not checked yet' : CI_VERDICT_WORDS[watch.state] ?? watch.state,
          mark: watch.state === 'failed' ? 'attention' : watch.state === 'passed' ? 'ok' : 'running',
        };
      },
      detail: (item) => {
        const watch = item as WatchItem;
        return [
          { label: 'Last checked', text: watch.state === 'unchecked' ? 'not yet' : CI_VERDICT_WORDS[watch.state] ?? watch.state, ...(watch.state === 'failed' ? { tone: 'warning' as const } : {}) },
          { label: 'Failures go to', text: watch.channel || 'not said' },
          { label: 'On a failure', text: watch.fixSession ? 'tell you, and start a fix session' : 'tell you' },
          ...(watch.expiresAt ? [{ label: 'Ends by itself', text: formatScheduleTime(watch.expiresAt) }] : []),
          ...(watch.repair ? [{ label: 'Repair', text: watch.repair }] : []),
        ];
      },
    },
    {
      id: 'checkins',
      label: 'Check-ins',
      noun: 'what the check-ins did',
      source: { kind: 'daemon', method: 'checkin.receipts.list', input: { limit: 20 }, items: checkins },
      follows: CHECKIN_EVENTS,
      empty: 'No check-ins yet. Whether they run, how often and where they go are in Settings.',
      row: (item) => {
        const checkin = item as CheckinItem;
        const words = CHECKIN_OUTCOME_WORDS[checkin.state] ?? checkin.state;
        return {
          title: checkin.ranAt ? formatScheduleTime(checkin.ranAt) : 'not said when',
          right: words.split(':')[0],
          mark: checkin.state === 'error' ? 'attention' : checkin.state.startsWith('skipped') || checkin.state === 'cancelled' ? 'paused' : 'ok',
        };
      },
      detail: (item) => {
        const checkin = item as CheckinItem;
        return [
          { label: 'What it did', text: CHECKIN_OUTCOME_WORDS[checkin.state] ?? checkin.state, ...(checkin.state === 'error' ? { tone: 'warning' as const } : {}) },
          { label: 'Started', text: checkin.manual ? 'on request' : 'on its schedule' },
          ...(checkin.channel ? [{ label: 'Sent to', text: checkin.channel }] : []),
          ...(checkin.reason ? [{ label: 'Why', text: checkin.reason }] : []),
          ...(checkin.error ? [{ label: 'What went wrong', text: checkin.error, tone: 'warning' as const }] : []),
          { text: '' },
          { label: 'What it read', text: checkin.summary || 'not said' },
          ...(checkin.delivered ? [{ label: 'What it said', text: checkin.delivered }] : []),
        ];
      },
    },
    // Routines that run by themselves once switched on and put on a schedule (memory-stores-entries.ts, memory-b's).
    AUTOMATION_ROUTINES_LIST as unknown as PlaceList<Item>,
  ],
  actions: [
    // Switching a routine on or off, putting it on a schedule, its receipts (memory-stores-entries.ts, memory-b's).
    ...(AUTOMATION_ROUTINE_ACTIONS as unknown as readonly PlaceAction<Item>[]),
    // Schedules and their runs.
    { key: 'n', list: 'schedules', whole: true, capability: 'schedule.add', label: 'new schedule' },
    { key: 'g', list: 'schedules', capability: 'schedule.run', label: 'run now', fill: { schedule: 'id' } },
    { key: 'p', list: 'schedules', states: ['active'], capability: 'schedule.pause', label: 'pause', fill: { schedule: 'id' } },
    { key: 'p', list: 'schedules', states: ['paused'], capability: 'schedule.resume', label: 'resume', fill: { schedule: 'id' } },
    { key: 'c', list: 'schedules', capability: 'schedule.change', label: 'change', fill: { schedule: 'id' } },
    { key: 'x', list: 'schedules', capability: 'schedule.remove', label: 'remove', fill: { schedule: 'id' } },
    { key: 's', list: 'runs', states: ['queued', 'running'], capability: 'schedule.stop-run', label: 'stop', fill: { run: 'id' } },
    { key: 't', list: 'runs', states: ['failed'], capability: 'schedule.retry-run', label: 'run again', fill: { run: 'id' } },
    // Triggers.
    { key: 'n', list: 'triggers', whole: true, capability: 'triggers.watch', label: 'watch for something' },
    { key: 'h', list: 'triggers', capability: 'triggers.history', label: 'what it did', fill: { trigger: 'id' } },
    // Its own name in the key context: the Runs tab's `stop` is another action.
    { key: 'x', id: 'stop-trigger', list: 'triggers', states: TRIGGER_LIVE, capability: 'triggers.stop', label: 'stop', fill: { trigger: 'id' } },
    { key: 's', list: 'triggers', states: TRIGGER_GAVE_UP, capability: 'triggers.restart', label: 'start again', fill: { trigger: 'id' } },
    // The commands triggers may run.
    { key: 'n', list: 'commands', whole: true, capability: 'triggers.allow-command', label: 'let triggers run a command' },
    // CI watches.
    { key: 'n', list: 'ci', whole: true, capability: 'ci.watch', label: 'watch a repository' },
    { key: 'k', list: 'ci', whole: true, capability: 'ci.status', label: 'check a repository' },
    { key: 'g', list: 'ci', capability: 'ci.run', label: 'check now', fill: { watch: 'id' } },
    { key: 'x', list: 'ci', capability: 'ci.unwatch', label: 'stop watching', fill: { watch: 'id' } },
    // Check-ins.
    { key: 'g', list: 'checkins', whole: true, capability: 'checkin.run', label: 'check in now' },
    // The settings of scheduled routines, watchers and triggers (the setup topic's form), from every tab.
    { key: 'o', capability: 'setup.automation', label: 'automation settings' },
  ],
  count: (lists) => {
    const failedSchedules = (lists.schedules ?? []).filter((item) => (item as ScheduleItem).trouble !== undefined).length;
    const gaveUp = (lists.triggers ?? []).filter((item) => TRIGGER_GAVE_UP.includes(item.state)).length;
    const failing = (lists.ci ?? []).filter((item) => item.state === 'failed').length;
    const parts = [
      ...(failedSchedules > 0 ? [`${failedSchedules} failed`] : []),
      ...(gaveUp > 0 ? [`${gaveUp} gave up`] : []),
      ...(failing > 0 ? [`${failing} CI failing`] : []),
    ];
    const total = failedSchedules + gaveUp + failing;
    return total > 0 ? { count: total, words: parts.join(', '), tone: 'wrong' } : undefined;
  },
});
