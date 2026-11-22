/**
 * Calendar date handling. The daemon emits an all-day event as midnight UTC
 * (the iCalendar DATE has no zone) and a timed event as an instant, so the two
 * must be bucketed differently: an all-day event belongs to its UTC calendar
 * date wherever the viewer is, a timed event to the viewer's local date.
 */
import { toIsoDate } from '../../components/ui/DateField';

const DAY_MS = 86_400_000;

/** What an event says about its own day-only shape, when the daemon sends it. */
export interface AllDayFlag {
  readonly allDay?: boolean | undefined;
}

/** The daemon's `allDay` when the event carries one, otherwise undefined. */
export function allDayFlagOf(event: unknown): boolean | undefined {
  const flag = typeof event === 'object' && event !== null ? (event as AllDayFlag).allDay : undefined;
  return typeof flag === 'boolean' ? flag : undefined;
}

/**
 * Whether an event is all-day. The event's own `allDay` decides when it is
 * sent (the calendar knows a DATE from a DATE-TIME). Without it, the shape the
 * engine writes for one is recognised: a start at exactly 00:00:00.000Z and an
 * end equal to the start or a whole number of days later, which a timed event
 * filling whole days from midnight UTC also matches.
 */
export function isAllDayEvent(start: string, end?: string, allDay?: boolean): boolean {
  if (allDay !== undefined) return allDay;
  const from = Date.parse(start);
  const to = end === undefined ? Number.NaN : Date.parse(end);
  if (Number.isNaN(from) || Number.isNaN(to)) return false;
  return from % DAY_MS === 0 && to >= from && (to - from) % DAY_MS === 0;
}

/** The date (YYYY-MM-DD) an event starts on in the viewer's calendar. */
export function eventDayKey(start: string, end?: string, allDay?: boolean): string {
  const parsed = new Date(start);
  if (Number.isNaN(parsed.getTime())) return start.slice(0, 10);
  return isAllDayEvent(start, end, allDay) ? parsed.toISOString().slice(0, 10) : toIsoDate(parsed);
}

/**
 * The time shown beside an event, in the viewer's time zone: "All day" (with
 * how many days when it spans more than one), "9:00 – 10:30 AM", "9:00 PM –
 * Tue 1:00 AM" when it ends on a later day, the start alone when there is no
 * readable end, or '' when the start is unreadable.
 */
export function eventTimeLabel(start: string, end?: string, allDay?: boolean): string {
  if (isAllDayEvent(start, end, allDay)) {
    const from = Date.parse(start);
    const to = end === undefined ? Number.NaN : Date.parse(end);
    const days = Number.isNaN(to) ? 1 : Math.max(1, Math.round((to - from) / DAY_MS));
    return days > 1 ? `All day · ${String(days)} days` : 'All day';
  }
  const from = new Date(start);
  if (Number.isNaN(from.getTime())) return '';
  const time: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  const to = end === undefined ? null : new Date(end);
  if (!to || Number.isNaN(to.getTime()) || to.getTime() <= from.getTime()) return from.toLocaleTimeString(undefined, time);
  if (toIsoDate(from) === toIsoDate(to)) return new Intl.DateTimeFormat(undefined, time).formatRange(from, to);
  return `${from.toLocaleTimeString(undefined, time)} – ${to.toLocaleString(undefined, { weekday: 'short', ...time })}`;
}

/** The viewer's time zone, the one every time on the page is shown in: "Europe/Berlin (GMT+2)". */
export function viewerTimeZoneLabel(now: Date = new Date()): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = new Intl.DateTimeFormat('en-US', { timeZoneName: 'shortOffset' })
    .formatToParts(now).find((part) => part.type === 'timeZoneName')?.value;
  return offset && offset !== zone ? `${zone} (${offset})` : zone;
}

/** The named date ranges the agenda offers; `custom` shows the two date fields. */
export type RangePreset = 'today' | 'this-week' | 'next-two-weeks' | 'this-month' | 'custom';

export const RANGE_PRESETS: readonly { value: RangePreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'this-week', label: 'This week' },
  { value: 'next-two-weeks', label: 'Next two weeks' },
  { value: 'this-month', label: 'This month' },
  { value: 'custom', label: 'Choose dates' },
];

/** The first and last local date (YYYY-MM-DD) of a named range; weeks run Monday to Sunday. */
export function rangeOfPreset(preset: Exclude<RangePreset, 'custom'>, now: Date = new Date()): { from: string; to: string } {
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  switch (preset) {
    case 'today': return { from: toIsoDate(now), to: toIsoDate(now) };
    case 'this-week': {
      const sinceMonday = (now.getDay() + 6) % 7;
      return { from: toIsoDate(new Date(y, m, d - sinceMonday)), to: toIsoDate(new Date(y, m, d - sinceMonday + 6)) };
    }
    case 'next-two-weeks': return { from: toIsoDate(now), to: toIsoDate(new Date(y, m, d + 13)) };
    case 'this-month': return { from: toIsoDate(new Date(y, m, 1)), to: toIsoDate(new Date(y, m + 1, 0)) };
  }
}

/** The named range two dates are, or `custom`. */
export function presetOfRange(from: string, to: string, now: Date = new Date()): RangePreset {
  for (const { value } of RANGE_PRESETS) {
    if (value === 'custom') continue;
    const range = rangeOfPreset(value, now);
    if (range.from === from && range.to === to) return value;
  }
  return 'custom';
}

function parseLocalDate(dateOnly: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

/** The instant a local calendar date starts, as ISO, or '' for no date. */
export function localDayStartIso(dateOnly: string): string {
  return parseLocalDate(dateOnly)?.toISOString() ?? '';
}

/** The last millisecond of a local calendar date, as ISO, or '' for no date. */
export function localDayEndIso(dateOnly: string): string {
  const date = parseLocalDate(dateOnly);
  if (!date) return '';
  date.setHours(23, 59, 59, 999);
  return date.toISOString();
}
