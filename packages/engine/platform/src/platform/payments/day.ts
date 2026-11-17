/**
 * day.ts, what "today" means for a budget that resets daily.
 *
 * The daemon had no timezone concept before this. Schedules carried per-schedule
 * IANA names (automation/schedules.ts, automation/cron.ts) and `device.location.*`
 * is a paired phone's GPS permission, but nothing described where the daemon
 * itself thinks it is. A daily budget cannot be built without that, so
 * `daemon.timezone` is added as a GENERAL daemon setting rather than a payments
 * one, the next feature that needs a calendar day should not add a second.
 *
 * ── The midnight split is accepted, not smoothed ──────────────────────────
 *
 * Design rule, ruled explicitly: $100 at 23:59 and $100 at 00:00 both go through.
 * A daily budget has a boundary and a boundary can be sat on. Anything that
 * "fixed" this, a rolling 24-hour window, a cooldown either side of midnight,
 * would be a different feature than the one the owner asked for, and the
 * rolling version is worse in the ordinary case because they could not
 * predict when their budget refreshed. There is a test that asserts the
 * split behaves this way, so a later round cannot quietly close it.
 *
 * ── Why totals are recomputed rather than counted ─────────────────────────
 *
 * Every spend record keeps its UTC instant, the zone in force when it was made
 * and the calendar day it was made on there. Today's totals are derived from
 * those records, never by incrementing a stored counter, and a spend counts
 * until its own day is over where it was made, as well as on the day it falls
 * on in the current zone. A timezone change can therefore keep a spend counted
 * longer but can never hand back a spent budget before its day ends. An agent
 * cannot change `daemon.timezone` at all while it would move today's budget
 * window: that write goes to the owner (config-key-facts.ts).
 */

import { isValidTimezone } from '../utils/timezone.js';
export { isValidTimezone };

/** A calendar day in some zone: 'YYYY-MM-DD'. */
export type DayKey = string & { readonly __dayKey: unique symbol };

/**
 * The zone the daemon reckons calendar days in.
 *
 * Empty or invalid resolves to UTC. Invalid resolving to UTC rather than
 * throwing is deliberate: a bad zone in config must not make the budget
 * unevaluable, because "cannot evaluate the budget" would either block every
 * purchase or, worse, be caught somewhere upstream and treated as no limit.
 */
export function resolveTimezone(configured: string | undefined): string {
  const value = (configured ?? '').trim();
  if (value.length === 0) return 'UTC';
  return isValidTimezone(value) ? value : 'UTC';
}

const PART_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = PART_FORMATTERS.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    PART_FORMATTERS.set(timezone, formatter);
  }
  return formatter;
}

/**
 * The calendar day containing `atMs`, in `timezone`.
 *
 * Built from `formatToParts` rather than string-slicing a locale format, because
 * locale formats reorder fields and a budget that silently reads the month as
 * the day is the kind of bug that only shows up on the 13th.
 */
export function dayKey(atMs: number, timezone: string): DayKey {
  const zone = resolveTimezone(timezone);
  const parts = formatterFor(zone).formatToParts(new Date(atMs));
  let year = '';
  let month = '';
  let day = '';
  for (const part of parts) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
  }
  return `${year}-${month}-${day}` as DayKey;
}

/** True when two instants fall on the same calendar day in `timezone`. */
export function sameDay(leftMs: number, rightMs: number, timezone: string): boolean {
  return dayKey(leftMs, timezone) === dayKey(rightMs, timezone);
}

const HOUR_MS = 60 * 60 * 1000;
/** Wider than any day in any zone, offsets and daylight-saving shifts included. */
const DAY_SEARCH_MS = 27 * HOUR_MS;

/** The first instant at or after `fromMs` that is not on `day` in `zone`, to the millisecond. */
function dayEndsAt(fromMs: number, toMs: number, day: DayKey, zone: string): number {
  let inside = fromMs;
  let outside = toMs;
  while (outside - inside > 1) {
    const middle = Math.floor((inside + outside) / 2);
    if (dayKey(middle, zone) === day) inside = middle; else outside = middle;
  }
  return outside;
}

/** The first instant at or before `fromMs` that is on `day` in `zone`, to the millisecond. */
function dayStartsAt(fromMs: number, toMs: number, day: DayKey, zone: string): number {
  let inside = fromMs;
  let outside = toMs;
  while (inside - outside > 1) {
    const middle = Math.ceil((inside + outside) / 2);
    if (dayKey(middle, zone) === day) inside = middle; else outside = middle;
  }
  return inside;
}

/**
 * Today's daily-budget window in `timezone`: the calendar date and the UTC
 * instants it starts and ends at. About sixty date readings, each a cached
 * formatter call; read only when a timezone change is weighed.
 */
export function todayWindow(nowMs: number, timezone: string | undefined): { readonly day: DayKey; readonly startMs: number; readonly endMs: number } {
  const zone = resolveTimezone(timezone);
  const day = dayKey(nowMs, zone);
  return {
    day,
    startMs: dayStartsAt(nowMs, nowMs - DAY_SEARCH_MS, day, zone),
    endMs: dayEndsAt(nowMs, nowMs + DAY_SEARCH_MS, day, zone),
  };
}

/**
 * Whether moving the daemon from `previous` to `next` would change today's
 * daily-budget window: a different date, or a different midnight at either end.
 * Two names for the same clock (or an unchanged zone) change nothing.
 */
export function timezoneChangeMovesToday(previous: unknown, next: unknown, nowMs: number): boolean {
  const before = resolveTimezone(typeof previous === 'string' ? previous : undefined);
  const after = resolveTimezone(typeof next === 'string' ? next : undefined);
  if (before === after) return false;
  const a = todayWindow(nowMs, before);
  const b = todayWindow(nowMs, after);
  return a.day !== b.day || a.startMs !== b.startMs || a.endMs !== b.endMs;
}
