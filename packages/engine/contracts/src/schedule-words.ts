/**
 * How a schedule, a trigger and their last run are said, in a full and a
 * short form: "Every day at 8:00" / "daily 8:00", "last ran today,
 * delivered" / "last: delivered", "Checks every 30 min" / "every 30 min".
 * The work board (work-board.ts) and every surface that lists schedules
 * read these. Pure and browser-safe; times are read in the local time zone.
 */

/** When something runs: a fixed interval, a cron expression, or once. */
export type ScheduleCadence =
  | { readonly kind: 'every'; readonly intervalMs: number }
  | { readonly kind: 'cron'; readonly expression: string; readonly timezone?: string | undefined }
  | { readonly kind: 'at'; readonly at: number };

/** How a scheduled job's last run ended, as the job record keeps it. */
export type ScheduleRunOutcome = 'delivered' | 'not-delivered' | 'inbox' | 'failed';

export type WordForm = 'full' | 'short';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "30 min", "2 hours", "1 day", "45 s". */
export function intervalWords(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  if (m % (60 * 24) === 0) return plural(m / (60 * 24), 'day');
  if (m % 60 === 0) return plural(m / 60, 'hour');
  return `${m} min`;
}

/** "8:00", "17:30". */
function clock(hour: number, minute: number): string {
  return `${hour}:${String(minute).padStart(2, '0')}`;
}

function isNumber(field: string): boolean {
  return /^\d+$/.test(field);
}

/** A cron expression in words, for the forms people write; the expression itself otherwise. */
function cronWords(expression: string, form: WordForm): string {
  const fields = expression.trim().split(/\s+/);
  const fallback = form === 'full' ? `On the schedule ${expression.trim()}` : `cron ${expression.trim()}`;
  if (fields.length !== 5) return fallback;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  const step = /^\*\/(\d+)$/;
  if (dayOfMonth !== '*' || month !== '*') return fallback;
  if (step.test(minute) && hour === '*' && dayOfWeek === '*') {
    const n = Number(step.exec(minute)![1]);
    return form === 'full' ? `Every ${n} min` : `every ${n} min`;
  }
  if (isNumber(minute) && hour === '*' && dayOfWeek === '*') {
    const at = `:${minute.padStart(2, '0')}`;
    return form === 'full' ? `Every hour at ${at}` : `hourly ${at}`;
  }
  if (!isNumber(minute) || !isNumber(hour)) return fallback;
  const time = clock(Number(hour), Number(minute));
  if (dayOfWeek === '*') return form === 'full' ? `Every day at ${time}` : `daily ${time}`;
  if (dayOfWeek === '1-5') return form === 'full' ? `Every weekday at ${time}` : `weekdays ${time}`;
  if (isNumber(dayOfWeek) && Number(dayOfWeek) <= 7) {
    const day = DAY_NAMES[Number(dayOfWeek) % 7]!;
    return form === 'full' ? `Every ${day} at ${time}` : `${day}s ${time}`;
  }
  return fallback;
}

/** When a date falls, relative to now: "today", "yesterday", "on Tuesday", "on 12 Nov". */
export function dayWords(at: number, now: number): string {
  const day = new Date(at);
  const today = new Date(now);
  const startOf = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(day)) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days === -1) return 'tomorrow';
  if (days > 1 && days < 7) return `on ${DAY_NAMES[day.getDay()]}`;
  return `on ${day.getDate()} ${day.toLocaleString('en-GB', { month: 'short' })}`;
}

/** The time of day a moment falls at, "8:00". */
function timeOfDay(at: number): string {
  const d = new Date(at);
  return clock(d.getHours(), d.getMinutes());
}

/** When it runs: "Every day at 8:00" / "daily 8:00", "Every 30 min" / "every 30 min", "Once, today at 9:15" / "once 9:15". */
export function describeSchedule(cadence: ScheduleCadence, form: WordForm, now: number = Date.now()): string {
  switch (cadence.kind) {
    case 'every': return form === 'full' ? `Every ${intervalWords(cadence.intervalMs)}` : `every ${intervalWords(cadence.intervalMs)}`;
    case 'cron': return cronWords(cadence.expression, form);
    case 'at': {
      const day = dayWords(cadence.at, now);
      const when = `${day === 'today' || day === 'tomorrow' || day === 'yesterday' ? day : day.replace(/^on /, '')} at ${timeOfDay(cadence.at)}`;
      return form === 'full' ? `Once, ${when}` : `once ${timeOfDay(cadence.at)}`;
    }
  }
}

const OUTCOME_WORDS: Readonly<Record<ScheduleRunOutcome, string>> = {
  delivered: 'delivered',
  'not-delivered': 'not delivered',
  inbox: 'sent to your inbox',
  failed: 'failed',
};

/** How the last run went: "last ran today, delivered" / "last: delivered"; "not run yet". */
export function describeLastRun(lastRunAt: number | undefined, outcome: ScheduleRunOutcome | undefined, form: WordForm, now: number): string {
  if (lastRunAt === undefined) return 'not run yet';
  const words = outcome === undefined ? undefined : OUTCOME_WORDS[outcome];
  if (form === 'short') return `last: ${words ?? dayWords(lastRunAt, now)}`;
  return `last ran ${dayWords(lastRunAt, now)}${words ? `, ${words}` : ''}`;
}

/** What a trigger saw: "no change since Tuesday" / "no change"; "changed 3 times, last today" / "3 changes". */
export function describeChanges(firedCount: number, lastFiredAt: number | undefined, since: number, form: WordForm, now: number): string {
  if (firedCount === 0) {
    const day = dayWords(since, now);
    return form === 'full' ? `no change since ${day === 'today' ? 'today' : day.replace(/^on /, '')}` : 'no change';
  }
  if (form === 'short') return plural(firedCount, 'change');
  return `changed ${firedCount === 1 ? 'once' : `${firedCount} times`}${lastFiredAt !== undefined ? `, last ${dayWords(lastFiredAt, now)}` : ''}`;
}

/** How a trigger checks: "Checks every 30 min" / "every 30 min"; "Watches a command's output" / "watching". */
export function describeTriggerCadence(cadence: ScheduleCadence | undefined, form: WordForm, now: number = Date.now()): string {
  if (cadence === undefined) return form === 'full' ? 'Watches for its event' : 'watching';
  const when = describeSchedule(cadence, 'short', now);
  return form === 'full' ? `Checks ${when}` : when;
}

/** "30s", "5m", "2h", "1d" (a workflow schedule's interval) in milliseconds, or undefined. */
export function parseIntervalWords(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(text.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 'ms' | 's' | 'm' | 'h' | 'd'];
  return amount > 0 ? amount * unit : undefined;
}
