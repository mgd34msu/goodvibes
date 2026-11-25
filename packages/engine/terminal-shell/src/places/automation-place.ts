/**
 * automation-place.ts, the Automation place: your schedules and their runs.
 *
 * Both lists are read from the daemon (`automation.schedules.list`, which
 * holds the jobs and their recent runs) and follow its `automation` events,
 * so a schedule paused, resumed, changed or run from the web UI or a script
 * shows here with no key pressed. Every action is a schedule capability;
 * only the one that applies to the selected item in its state is on the
 * hint row (pause for a running schedule, resume for a paused one).
 */
import type { AutomationScheduleDefinition } from '@goodvibes/engine/platform/platform/automation';
import { formatScheduleTime, formatScheduleTiming } from '../schedule-command.js';
import { definePlace, type PlaceItem } from './place-types.js';

interface ScheduleItem extends PlaceItem {
  readonly state: 'active' | 'paused';
  readonly name: string;
  readonly timing: string;
  readonly nextRunAt?: number | undefined;
  readonly lastRunAt?: number | undefined;
  readonly runCount: number;
  readonly prompt: string;
  /** The last run's outcome when it needs attention. */
  readonly trouble?: string | undefined;
  readonly pausedReason?: string | undefined;
}

interface RunItem extends PlaceItem {
  readonly state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'missed';
  readonly schedule: string;
  readonly at?: number | undefined;
  readonly endedAt?: number | undefined;
  readonly error?: string | undefined;
}

type Item = ScheduleItem | RunItem;

interface ListedJob {
  readonly id?: unknown; readonly name?: unknown; readonly enabled?: unknown; readonly schedule?: unknown;
  readonly nextRunAt?: unknown; readonly lastRunAt?: unknown; readonly runCount?: unknown; readonly pausedReason?: unknown;
  readonly lastOutcome?: unknown; readonly execution?: { readonly prompt?: unknown } | undefined; readonly description?: unknown;
}
interface ListedRun {
  readonly id?: unknown; readonly jobId?: unknown; readonly status?: unknown; readonly startedAt?: unknown;
  readonly queuedAt?: unknown; readonly endedAt?: unknown; readonly error?: unknown;
}

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const time = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function listed(output: unknown): { readonly jobs: readonly ListedJob[]; readonly runs: readonly ListedRun[] } {
  const body = (output && typeof output === 'object' ? output : {}) as { readonly jobs?: unknown; readonly runs?: unknown };
  return {
    jobs: Array.isArray(body.jobs) ? body.jobs as ListedJob[] : [],
    runs: Array.isArray(body.runs) ? body.runs as ListedRun[] : [],
  };
}

function timing(schedule: unknown): string {
  if (!schedule || typeof schedule !== 'object') return 'not said';
  try { return formatScheduleTiming(schedule as AutomationScheduleDefinition); } catch { return 'not said'; }
}

function schedules(output: unknown): readonly ScheduleItem[] {
  const { jobs, runs } = listed(output);
  const latest = new Map<string, ListedRun>();
  for (const run of runs) {
    const job = text(run.jobId);
    const at = time(run.startedAt) ?? time(run.queuedAt) ?? 0;
    const held = latest.get(job);
    if (!held || (time(held.startedAt) ?? time(held.queuedAt) ?? 0) < at) latest.set(job, run);
  }
  return jobs.filter((job) => text(job.id)).map((job): ScheduleItem => {
    const id = text(job.id);
    const last = latest.get(id);
    const lastStatus = text(last?.status);
    const trouble = lastStatus === 'failed' || lastStatus === 'missed' ? `last run ${lastStatus}` : job.lastOutcome === 'failed' ? 'last run failed' : undefined;
    return {
      id,
      state: job.enabled === false ? 'paused' : 'active',
      name: text(job.name) || id,
      timing: timing(job.schedule),
      nextRunAt: time(job.nextRunAt),
      lastRunAt: time(job.lastRunAt),
      runCount: typeof job.runCount === 'number' ? job.runCount : 0,
      prompt: text(job.execution?.prompt) || text(job.description),
      ...(trouble ? { trouble } : {}),
      ...(text(job.pausedReason) ? { pausedReason: text(job.pausedReason) } : {}),
    };
  });
}

const RUN_STATES = new Set<RunItem['state']>(['queued', 'running', 'completed', 'failed', 'cancelled', 'missed']);

function runsOf(output: unknown): readonly RunItem[] {
  const { jobs, runs } = listed(output);
  const names = new Map(jobs.map((job) => [text(job.id), text(job.name)]));
  return runs
    .filter((run) => text(run.id) && RUN_STATES.has(text(run.status) as RunItem['state']))
    .map((run): RunItem => ({
      id: text(run.id),
      state: text(run.status) as RunItem['state'],
      schedule: names.get(text(run.jobId)) || text(run.jobId),
      at: time(run.startedAt) ?? time(run.queuedAt),
      endedAt: time(run.endedAt),
      ...(text(run.error) ? { error: text(run.error) } : {}),
    }))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

/** The automation domain's frames: a job created, changed, switched on or off; a run started or ended. */
const AUTOMATION_EVENTS = { domains: ['automation'], events: ['automation'] } as const;

/** Why a schedule is paused, in a person's words (the daemon's reason codes). */
const PAUSED_WORDS: Readonly<Record<string, string>> = {
  'operator-disabled': 'it was paused on request (here, the web UI or a script)',
  disabled: 'it was paused',
  'failure-threshold-reached': 'it failed too many times in a row',
};

const STATE_WORDS: Readonly<Record<RunItem['state'], string>> = {
  queued: 'waiting to start', running: 'running', completed: 'finished', failed: 'failed', cancelled: 'stopped', missed: 'missed its time',
};

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
        // The row names only a state that needs a word (paused, failed); its times are in the detail.
        return {
          title: schedule.name,
          ...(schedule.state === 'paused' ? { right: 'paused' } : schedule.trouble ? { right: schedule.trouble } : {}),
          mark: schedule.state === 'paused' ? 'paused' : schedule.trouble ? 'attention' : 'ok',
        };
      },
      detail: (item) => {
        const schedule = item as ScheduleItem;
        return [
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
          right: STATE_WORDS[run.state],
          mark: run.state === 'failed' || run.state === 'missed' ? 'attention' : run.state === 'running' || run.state === 'queued' ? 'running' : 'ok',
        };
      },
      detail: (item) => {
        const run = item as RunItem;
        return [
          { label: 'Schedule', text: run.schedule },
          { label: 'State', text: STATE_WORDS[run.state] },
          ...(run.at ? [{ label: 'Started', text: formatScheduleTime(run.at) }] : []),
          ...(run.endedAt ? [{ label: 'Ended', text: formatScheduleTime(run.endedAt) }] : []),
          ...(run.error ? [{ label: 'What went wrong', text: run.error, tone: 'warning' as const }] : []),
        ];
      },
    },
  ],
  actions: [
    { key: 'n', capability: 'schedule.add', label: 'new schedule' },
    { key: 'g', list: 'schedules', capability: 'schedule.run', label: 'run now', fill: { schedule: 'id' } },
    { key: 'p', list: 'schedules', states: ['active'], capability: 'schedule.pause', label: 'pause', fill: { schedule: 'id' } },
    { key: 'p', list: 'schedules', states: ['paused'], capability: 'schedule.resume', label: 'resume', fill: { schedule: 'id' } },
    { key: 'c', list: 'schedules', capability: 'schedule.change', label: 'change', fill: { schedule: 'id' } },
    { key: 'x', list: 'schedules', capability: 'schedule.remove', label: 'remove', fill: { schedule: 'id' } },
    { key: 's', list: 'runs', states: ['queued', 'running'], capability: 'schedule.stop-run', label: 'stop', fill: { run: 'id' } },
    { key: 't', list: 'runs', states: ['failed'], capability: 'schedule.retry-run', label: 'run again', fill: { run: 'id' } },
  ],
  count: (lists) => {
    const trouble = (lists.schedules ?? []).filter((item) => (item as ScheduleItem).trouble !== undefined).length;
    return trouble > 0 ? { count: trouble, words: `${trouble} failed`, tone: 'wrong' } : undefined;
  },
});
