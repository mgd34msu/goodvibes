/**
 * Five-field cron expressions (minute hour day-of-month month day-of-week):
 * parsing, zone validation and the next matching minute. The automation
 * manager owns scheduling; this module is only its calendar arithmetic.
 */

/** `any` for `*`; otherwise every value the field allows, expanded once at parse time. */
type CronField =
  | { readonly type: 'any' }
  | { readonly type: 'list'; readonly values: ReadonlySet<number> };

export interface CronExpression {
  readonly source: string;
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** February 29th can be eight years away when a century year skips its leap day. */
const SCAN_LIMIT_MS = 8 * 366 * DAY_MS;
/** Longest month for each month number; February counts its leap day. */
const MONTH_LENGTHS = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;
const WEEKDAYS: Readonly<Record<string, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function intInRange(raw: string | undefined, min: number, max: number, token: string): number {
  const value = /^\d+$/.test(raw ?? '') ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid cron value "${token}": use whole numbers from ${min} to ${max}.`);
  }
  return value;
}

function parseRange(part: string, min: number, max: number): { readonly from: number; readonly to: number } {
  const [fromRaw, toRaw, extra] = part.split('-');
  if (extra !== undefined) throw new Error(`Invalid cron range "${part}".`);
  const from = intInRange(fromRaw, min, max, part);
  const to = toRaw === undefined ? from : intInRange(toRaw, min, max, part);
  if (from > to) throw new Error(`Invalid cron range "${part}": ${from} is after ${to}.`);
  return { from, to };
}

function parseCronField(token: string, min: number, max: number): CronField {
  if (token === '*') return { type: 'any' };
  const values = new Set<number>();
  for (const part of token.split(',')) {
    const [base, stepRaw, extra] = part.split('/');
    if (extra !== undefined) throw new Error(`Invalid cron step "${part}".`);
    let step = 1;
    if (stepRaw !== undefined) {
      step = /^\d+$/.test(stepRaw) ? Number(stepRaw) : 0;
      if (step < 1) throw new Error(`Invalid cron step "${part}": the step must be a whole number of at least 1.`);
    }
    // `*/n` and `a/n` run to the end of the field; `a-b/n` stops at b.
    const range = base === '*'
      ? { from: min, to: max }
      : stepRaw !== undefined && !base?.includes('-')
        ? { from: intInRange(base, min, max, part), to: max }
        : parseRange(base ?? '', min, max);
    for (let value = range.from; value <= range.to; value += step) values.add(value);
  }
  return { type: 'list', values };
}

function fieldMatches(field: CronField, value: number): boolean {
  return field.type === 'any' || field.values.has(value);
}

/** Day-of-week accepts 7 for Sunday (POSIX); store it as 0 so matching compares one number. */
function normalizeDayOfWeek(field: CronField): CronField {
  if (field.type === 'any' || !field.values.has(7)) return field;
  const values = new Set(field.values);
  values.delete(7);
  values.add(0);
  return { type: 'list', values };
}

/**
 * An expression whose day-of-month exists in none of its months (`0 0 31 2 *`)
 * would scan the whole limit and still find nothing, so it is refused here.
 */
function assertDayOfMonthReachable(expression: CronExpression): void {
  if (expression.dayOfMonth.type === 'any' || expression.dayOfWeek.type !== 'any') return;
  let firstDay = 31;
  for (let day = 1; day <= 31; day++) {
    if (fieldMatches(expression.dayOfMonth, day)) { firstDay = day; break; }
  }
  const months: string[] = [];
  for (let month = 1; month <= 12; month++) {
    if (!fieldMatches(expression.month, month)) continue;
    if (firstDay <= MONTH_LENGTHS[month]!) return;
    months.push(MONTH_NAMES[month]!);
  }
  throw new Error(`Cron expression "${expression.source}" never fires: day ${firstDay} does not occur in ${months.join(', ')}.`);
}

/** Parse a five-field cron expression, refusing one that names a day no month in it has. */
export function parseCron(source: string): CronExpression {
  const parts = source.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Cron expression "${source}" must have 5 fields: minute hour day-of-month month day-of-week.`);
  }
  const expression: CronExpression = {
    source,
    minute: parseCronField(parts[0]!, 0, 59),
    hour: parseCronField(parts[1]!, 0, 23),
    dayOfMonth: parseCronField(parts[2]!, 1, 31),
    month: parseCronField(parts[3]!, 1, 12),
    dayOfWeek: normalizeDayOfWeek(parseCronField(parts[4]!, 0, 7)),
  };
  assertDayOfMonthReachable(expression);
  return expression;
}

// One formatter per zone for the life of the process: building one costs far
// more than reading a date with it, and a scan reads hundreds of dates.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (formatter) return formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
      weekday: 'short',
    });
  } catch {
    throw new Error(`Invalid timezone: "${timezone}". Use an IANA name like "America/New_York" or "Europe/London".`);
  }
  formatters.set(timezone, formatter);
  return formatter;
}

/** Throws a message naming the expected form when `timezone` is not an IANA zone the runtime knows. */
export function validateTimezone(timezone: string): void {
  formatterFor(timezone);
}

function processTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

interface CalendarParts {
  readonly minute: number;
  readonly hour: number;
  readonly dom: number;
  readonly month: number;
  readonly dow: number;
}

function calendarParts(formatter: Intl.DateTimeFormat, ms: number): CalendarParts {
  let minute = 0, hour = 0, dom = 1, month = 1, dow = 0;
  for (const part of formatter.formatToParts(ms)) {
    switch (part.type) {
      case 'minute': minute = Number(part.value); break;
      // hour12:false reads midnight as 24 in some runtimes.
      case 'hour': hour = Number(part.value) % 24; break;
      case 'day': dom = Number(part.value); break;
      case 'month': month = Number(part.value); break;
      case 'weekday': dow = WEEKDAYS[part.value] ?? 0; break;
      default: break;
    }
  }
  return { minute, hour, dom, month, dow };
}

function dayMatches(expression: CronExpression, dom: number, dow: number): boolean {
  const domIsAny = expression.dayOfMonth.type === 'any';
  const dowIsAny = expression.dayOfWeek.type === 'any';
  if (domIsAny && dowIsAny) return true;
  if (domIsAny) return fieldMatches(expression.dayOfWeek, dow);
  if (dowIsAny) return fieldMatches(expression.dayOfMonth, dom);
  // POSIX: when both day fields are restricted, either one matching is enough.
  return fieldMatches(expression.dayOfMonth, dom) || fieldMatches(expression.dayOfWeek, dow);
}

/**
 * The first minute strictly after `fromMs` that matches `expression`, read in
 * `timezone` (the process zone when none is given), as epoch milliseconds.
 *
 * The scan moves in absolute time and re-reads the calendar after every step,
 * so a repeated or skipped DST hour can neither stall it nor be mistaken for a
 * match. Long steps stop about two hours short of a local day or month
 * boundary, which a DST shift cannot carry past.
 */
export function computeNextCronRun(expression: string | CronExpression, fromMs: number, timezone?: string): number {
  const cron = typeof expression === 'string' ? parseCron(expression) : expression;
  const formatter = formatterFor(timezone || processTimeZone());
  let cur = Math.floor(fromMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const limit = cur + SCAN_LIMIT_MS;
  while (cur < limit) {
    const { minute, hour, dom, month, dow } = calendarParts(formatter, cur);
    const toNextHour = (60 - minute) * MINUTE_MS;
    const toLateInDay = Math.max(0, 21 - hour) * HOUR_MS + toNextHour;
    if (!fieldMatches(cron.month, month)) {
      // Every month has at least 28 days, so landing on the 26th stays inside this one.
      cur += Math.max(0, 26 - dom) * DAY_MS + toLateInDay;
      continue;
    }
    if (!dayMatches(cron, dom, dow)) {
      cur += toLateInDay;
      continue;
    }
    if (!fieldMatches(cron.hour, hour)) {
      cur += toNextHour;
      continue;
    }
    if (!fieldMatches(cron.minute, minute)) {
      let next = minute + 1;
      while (next < 60 && !fieldMatches(cron.minute, next)) next++;
      cur += (next - minute) * MINUTE_MS;
      continue;
    }
    return cur;
  }
  throw new Error(`Cron expression "${cron.source}" has no matching time in the next eight years.`);
}
