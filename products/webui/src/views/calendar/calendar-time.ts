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

/** The time shown beside an event: "All day", or its start time, or '' when unreadable. */
export function eventTimeLabel(start: string, end?: string, allDay?: boolean): string {
  if (isAllDayEvent(start, end, allDay)) return 'All day';
  const parsed = new Date(start);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
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

/** The local date `days` from today, as YYYY-MM-DD. */
export function localDateOffset(days: number, now: Date = new Date()): string {
  return toIsoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
}
