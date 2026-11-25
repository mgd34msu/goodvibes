/**
 * A schedule's timing in words, and its times in a named zone: the words every
 * surface shows (both terminal programs' Automation place, the daemon's
 * schedule preview, the web UI). Moved here from schedule-values.ts and
 * schedules.ts, which re-export them, so a browser may load them: nothing here
 * reaches a Node module.
 */
import type { AutomationScheduleDefinition } from './schedules.js';

/** An interval in its shortest unit: `15m`, `1h`, `2d`, `1500ms`. */
export function formatEveryInterval(intervalMs: number): string {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('intervalMs must be a positive finite number');
  }
  const units: ReadonlyArray<readonly [number, string]> = [
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
    [1_000, 's'],
  ];
  for (const [size, unit] of units) {
    if (intervalMs >= size && intervalMs % size === 0) {
      return `${intervalMs / size}${unit}`;
    }
  }
  return `${intervalMs}ms`;
}

/** A time in one named zone: `2026-12-01 09:00 Europe/Vienna`. */
export function formatScheduleTime(ms: number | undefined, zone: string): string {
  if (ms === undefined || !Number.isFinite(ms)) return 'not planned';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')} ${zone}`;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

function ordinalDay(day: number): string {
  const tens = day % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : day % 10 === 1 ? 'st' : day % 10 === 2 ? 'nd' : day % 10 === 3 ? 'rd' : 'th';
  return `${day}${suffix}`;
}

/** A cron day-of-week field in words ("every weekday", "on Monday and Thursday"), or undefined when it is not a plain list or range. */
function cronDaysInWords(field: string): string | undefined {
  if (field === '*') return 'every day';
  if (field === '1-5') return 'every weekday';
  if (field === '0,6' || field === '6,0' || field === '6-7' || field === '6,7') return 'every weekend day';
  const days = new Set<number>();
  for (const part of field.split(',')) {
    const range = /^(\d)(?:-(\d))?$/.exec(part);
    if (!range) return undefined;
    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    if (from > 7 || to > 7 || to < from) return undefined;
    for (let day = from; day <= to; day++) days.add(day % 7);
  }
  const names = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((day) => DAY_NAMES[day]!);
  return names.length === 1 ? `every ${names[0]}` : `every ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * A five-field cron expression in words, for the shapes a person writes
 * ("every weekday at 09:00", "every hour at :15", "on the 1st of each month at
 * 08:30"); undefined for any other shape, which is then shown as written.
 */
export function describeCronInWords(expression: string): string | undefined {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  const isNumber = (value: string, max: number): boolean => /^\d{1,2}$/.test(value) && Number(value) <= max;
  const step = /^\*\/(\d{1,2})$/.exec(minute);
  if (step && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') return `every ${Number(step[1])} minutes`;
  if (!isNumber(minute, 59)) return undefined;
  const at = isNumber(hour, 23) ? `at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}` : undefined;
  if (hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') return `every hour at :${minute.padStart(2, '0')}`;
  if (!at) return undefined;
  if (dayOfMonth === '*' && month === '*') {
    const days = cronDaysInWords(dayOfWeek);
    return days ? `${days} ${at}` : undefined;
  }
  if (isNumber(dayOfMonth, 31) && Number(dayOfMonth) >= 1 && dayOfWeek === '*') {
    if (month === '*') return `on the ${ordinalDay(Number(dayOfMonth))} of each month ${at}`;
    if (isNumber(month, 12) && Number(month) >= 1) return `every year on ${MONTH_NAMES[Number(month) - 1]} ${Number(dayOfMonth)} ${at}`;
  }
  return undefined;
}

/** A schedule's timing in words ("every 15m", "every weekday at 09:00 (0 9 * * 1-5) [Europe/Vienna]", "once at ..."). */
export function formatScheduleTiming(schedule: AutomationScheduleDefinition, zone: string): string {
  switch (schedule.kind) {
    case 'cron': {
      // The schedule in words, with the cron it is kept as beside it.
      const words = describeCronInWords(schedule.expression);
      return [words ? `${words} (${schedule.expression})` : schedule.expression, schedule.timezone ? `[${schedule.timezone}]` : '', schedule.staggerMs !== undefined ? `[stagger ${schedule.staggerMs}ms]` : ''].filter(Boolean).join(' ');
    }
    case 'every':
      return `every ${formatEveryInterval(schedule.intervalMs)}`;
    case 'at':
      return `once at ${formatScheduleTime(schedule.at, zone)}`;
  }
}
