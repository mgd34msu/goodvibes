/**
 * The blanks of "Schedule something to run" and "Change a schedule" (the
 * `/schedule` actions' values, by input id) read into what a schedule is kept
 * with: its timing, and the routine's other fields. One reading for every
 * surface: both terminal apps' `/schedule`, and the daemon's
 * `automation.schedules.preview`, which the web UI's sheet calls so that a
 * described time ("every weekday at 9am") is read, and shown, before it is kept.
 */
import { deliveryChannelProblem, parseChannelDeliveryTarget } from '../channels/delivery/types.js';
import { REASONING_EFFORT_SEVERITY, reasoningEffortRank } from '../config/reasoning-effort-setting.js';
import type { CreateAutomationJobInput } from './manager-runtime-helpers.js';
import { buildAutonomySchedulePrompt } from './autonomy-prompt.js';
import { readNaturalLanguageSchedule } from './schedule-reading.js';
import { zonedWallClockToUtcMs } from '../utils/timezone.js';
import {
  formatEveryInterval,
  getNextAutomationOccurrence,
  normalizeAtSchedule,
  normalizeCronSchedule,
  normalizeEverySchedule,
  parseEveryInterval,
  type AutomationScheduleDefinition,
} from './schedules.js';
import type { AutomationExecutionPolicy, AutomationExternalContentSource, AutomationSessionTarget, AutomationWakeMode } from './session-targets.js';
import { formatScheduleTime, formatScheduleTiming } from './schedule-words.js';

// The words of a schedule live where a browser may load them (schedule-words.ts); every importer of these keeps working.
export { describeCronInWords, formatScheduleTime, formatScheduleTiming } from './schedule-words.js';

/** A schedule action's values by input id (a repeating option's values joined with a newline). */
export type ScheduleValues = Readonly<Record<string, string | undefined>>;

/** A routine's fields apart from its timing, name and prompt, in the shape every place that keeps one takes. */
export type ScheduleFields = Omit<CreateAutomationJobInput, 'schedule' | 'name' | 'prompt'>;

/** A value the person gave that cannot be kept; the message is the sentence to show, ending in what was not done. */
export class ScheduleValuesError extends Error {
  override readonly name = 'ScheduleValuesError';
}

/** "Spread the start": a duration such as 5m, or a number of milliseconds; undefined when blank. */
export function scheduleStaggerMs(values: ScheduleValues): number | undefined {
  const text = values.stagger?.trim();
  if (!text) return undefined;
  try {
    const ms = /^\d+$/.test(text) ? Number(text) : parseEveryInterval(text);
    if (Number.isSafeInteger(ms) && ms >= 0) return ms;
  } catch { /* refused below */ }
  throw new ScheduleValuesError(`"${text}" is not a duration to spread the start by (such as 5m). Nothing was kept.`);
}

const WALL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;
const ZONED_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

/**
 * The instant a typed date and time names: one with `Z` or an offset is that
 * exact instant; one without (`2026-12-01T09:00`, or a date alone for its
 * midnight) is that wall clock in `zone`. NaN when it is neither, or names a
 * day or hour that does not exist.
 */
function readScheduleDateTime(text: string, zone: string): number {
  const trimmed = text.trim();
  if (ZONED_DATE_TIME.test(trimmed)) return Date.parse(trimmed);
  const m = WALL_DATE_TIME.exec(trimmed);
  if (!m) return Number.NaN;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4] ?? '0', m[5] ?? '0', m[6] ?? '0'].map(Number) as [number, number, number, number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const probe = new Date(wall);
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return Number.NaN;
  return zonedWallClockToUtcMs(wall, zone);
}

/**
 * The timing given as a date (`at`), an interval (`every`) or a pattern
 * (`cron`); undefined when none of the three was given (a described time, or
 * no new time at all).
 */
export function explicitScheduleTiming(values: ScheduleValues, options: { readonly zone: string; readonly now: number }): AutomationScheduleDefinition | undefined {
  const timezone = values.tz?.trim() || options.zone;
  const staggerMs = scheduleStaggerMs(values);
  try {
    if (values.cron) return normalizeCronSchedule(values.cron, timezone, staggerMs);
    if (values.every) return normalizeEverySchedule(values.every);
    if (values.at) {
      const at = readScheduleDateTime(values.at, timezone);
      if (Number.isNaN(at)) throw new Error(`"${values.at}" is not a date and time. Use one such as 2026-12-01T09:00 (read in ${timezone} when it has no zone).`);
      if (at <= options.now) throw new Error(`${formatScheduleTime(at, timezone)} has already passed.`);
      return normalizeAtSchedule(at);
    }
  } catch (error) {
    throw new ScheduleValuesError(`Not kept: ${error instanceof Error ? error.message : String(error)}`);
  }
  return undefined;
}

export interface ScheduleTimingOptions {
  /** The zone a time without one is read in: the terminal's machine, or the browser's. */
  readonly zone: string;
  readonly now?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Synchronous: throws when the reading is no longer wanted. */
  readonly beforeAttempt?: (() => void) | undefined;
  readonly onRetry?: (() => void) | undefined;
  /** Called once, just before a described time is read (the decision model, or the fixed grammar without one). */
  readonly onReading?: (() => void) | undefined;
}

/**
 * The timing the values give, or undefined when none was given. A described
 * time (`when`) is read once; one that cannot be read exactly is refused with
 * the reason, never approximated.
 */
export async function readScheduleTiming(values: ScheduleValues, options: ScheduleTimingOptions): Promise<AutomationScheduleDefinition | undefined> {
  const now = options.now ?? Date.now();
  const explicit = explicitScheduleTiming(values, { zone: options.zone, now });
  if (explicit || !values.when?.trim()) return explicit;
  const timezone = values.tz?.trim() || options.zone;
  options.onReading?.();
  const parsed = await readNaturalLanguageSchedule({ phrase: values.when, now, timezone, staggerMs: scheduleStaggerMs(values) }, {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.beforeAttempt ? { beforeAttempt: options.beforeAttempt } : {}),
    ...(options.onRetry ? { onRetry: options.onRetry } : {}),
  });
  if (parsed.kind === 'unknown') {
    const why = parsed.message ?? `the timing is ${parsed.reason}`;
    throw new ScheduleValuesError(`Not kept: ${why}; give it as a date and time, an interval or a calendar pattern instead.`);
  }
  if (parsed.schedule.kind === 'at' && parsed.schedule.at <= Date.now()) throw new ScheduleValuesError('Not kept: that time has already passed.');
  return parsed.schedule;
}

/** The create fields for a timing (`cron`, `every` or `at`), the one mapping every caller of `automation.schedules.create` uses. */
export function scheduleCreateTimingFields(schedule: AutomationScheduleDefinition): { readonly kind: 'cron' | 'every' | 'at'; readonly cron?: string; readonly every?: string; readonly at?: string; readonly timezone?: string; readonly staggerMs?: number } {
  switch (schedule.kind) {
    case 'cron':
      return { kind: 'cron', cron: schedule.expression, ...(schedule.timezone ? { timezone: schedule.timezone } : {}), ...(schedule.staggerMs !== undefined ? { staggerMs: schedule.staggerMs } : {}) };
    case 'every':
      return { kind: 'every', every: formatEveryInterval(schedule.intervalMs) };
    case 'at':
      return { kind: 'at', at: new Date(schedule.at).toISOString() };
  }
}

/** When a timing runs next, or undefined for none. */
export function nextScheduleRun(schedule: AutomationScheduleDefinition, now: number = Date.now()): number | undefined {
  return getNextAutomationOccurrence(schedule, now);
}

/** The routine's other fields (where it runs, model, where the answer goes ...); throws a sentence for a value it cannot keep. */
export function scheduleFieldsFromValues(values: ScheduleValues): ScheduleFields {
  const deliver = values.deliver?.trim();
  const problem = deliver ? deliveryChannelProblem(deliver) : undefined;
  if (problem) throw new ScheduleValuesError(`Answer goes to: ${problem}. Write a channel such as telegram or slack:C123, or leave it blank for the owner inbox. Nothing was kept.`);
  if (values.reasoning && reasoningEffortRank(values.reasoning) === -1) throw new ScheduleValuesError(`"${values.reasoning}" is not a reasoning effort (${REASONING_EFFORT_SEVERITY.join(', ')}).`);
  const fallback = values.fallback?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? [];
  const tools = values.tool?.split('\n').map((entry) => entry.trim()).filter(Boolean) ?? [];
  const target: AutomationSessionTarget = { kind: (values.target || 'isolated') as AutomationSessionTarget['kind'], createIfMissing: true };
  return {
    ...(values.model ? { model: values.model } : {}),
    ...(values.provider ? { provider: values.provider } : {}),
    ...(values.template ? { template: values.template } : {}),
    ...(values.reasoning ? { reasoningEffort: values.reasoning as AutomationExecutionPolicy['reasoningEffort'] } : {}),
    ...(values.thinking ? { thinking: values.thinking } : {}),
    ...(values.wake ? { wakeMode: values.wake as AutomationWakeMode } : {}),
    ...(values.source ? { externalContentSource: values.source as AutomationExternalContentSource } : {}),
    target,
    ...(fallback.length > 0 ? { fallbackModels: fallback } : {}),
    ...(tools.length > 0 ? { toolAllowlist: tools } : {}),
    ...(values.outside === 'yes' ? { allowUnsafeExternalContent: true } : {}),
    ...(values.light === 'yes' ? { lightContext: true } : {}),
    ...(deliver ? { delivery: { mode: 'surface' as const, targets: [parseChannelDeliveryTarget(deliver)] } } : {}),
    enabled: values.paused !== 'yes',
  };
}

/** The schedule's name: the one given, else the first words of what it does. */
export function scheduleNameFromValues(values: ScheduleValues): string {
  return values.name?.trim() || (values.prompt ?? '').trim().slice(0, 40);
}

/** What a schedule action will keep: the reading in words, and the input of the method that keeps it. */
export interface SchedulePreview {
  readonly summary: string;
  readonly input: Readonly<Record<string, unknown>>;
}

function timingSentence(schedule: AutomationScheduleDefinition, zone: string): string {
  const next = nextScheduleRun(schedule);
  return `Read as: ${formatScheduleTiming(schedule, zone)}.${next !== undefined ? ` Next run: ${formatScheduleTime(next, zone)}.` : ''}`;
}

/**
 * Read the values of "Schedule something to run" (`add`) or "Change a
 * schedule" (`change`) into the input of `automation.schedules.create` or
 * `automation.jobs.update`, with the reading in words. Nothing is kept here;
 * a described time costs one reading (the decision model's, or the fixed
 * grammar's without one). Throws a `ScheduleValuesError` sentence.
 */
export async function previewScheduleAction(action: 'add' | 'change', values: ScheduleValues, options: ScheduleTimingOptions): Promise<SchedulePreview> {
  const zone = options.zone;
  if (action === 'add') {
    const prompt = values.prompt?.trim();
    if (!prompt) throw new ScheduleValuesError('Say what it does. Nothing was kept.');
    const fields = scheduleFieldsFromValues(values);
    const schedule = await readScheduleTiming(values, options);
    if (!schedule) throw new ScheduleValuesError('Say when it runs: describe it, give a date, an interval or a pattern. Nothing was kept.');
    return {
      summary: timingSentence(schedule, zone),
      input: { ...fields, ...scheduleCreateTimingFields(schedule), name: scheduleNameFromValues(values), prompt },
    };
  }
  const jobId = values.schedule?.trim();
  if (!jobId) throw new ScheduleValuesError('Choose the schedule to change. Nothing was changed.');
  if (Boolean(values.task) !== Boolean(values.success)) throw new ScheduleValuesError('A task needs the result that shows it is done (and that result its task); give both. Nothing was changed.');
  if (values.task && values.prompt) throw new ScheduleValuesError('Give new words for what it does, or a task with its result, not both. Nothing was changed.');
  const prompt = values.task && values.success
    ? buildAutonomySchedulePrompt({ task: values.task, successCriteria: values.success, explicitUserRequest: `Change a schedule ${jobId}` })
    : values.prompt?.trim() || undefined;
  const schedule = await readScheduleTiming(values, options);
  const name = values.name?.trim() || undefined;
  if (!schedule && !name && !prompt) throw new ScheduleValuesError('Nothing to change: give a new time, name or what it does.');
  return {
    summary: [
      schedule ? timingSentence(schedule, zone) : 'Its timing stays as it is.',
      name ? `New name: ${name}.` : '',
      prompt ? (values.task ? `New task: ${values.task}.` : 'New words for what it does.') : '',
    ].filter(Boolean).join(' '),
    input: { jobId, ...(schedule ? { schedule } : {}), ...(name ? { name } : {}), ...(prompt ? { prompt } : {}) },
  };
}
