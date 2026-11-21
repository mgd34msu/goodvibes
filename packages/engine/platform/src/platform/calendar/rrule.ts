/**
 * rrule.ts, a pure RRULE reader for an honest, deliberately-bounded subset.
 *
 * The honesty rule (see the decision record): an event's recurrence is either
 * FULLY and correctly expanded, or NOT expanded at all with an explicit reason.
 * We never emit occurrences from a rule we do not completely honor, a half-honored
 * BYMONTHDAY would put events on wrong dates, which is worse than not expanding.
 *
 * Fully supported (expanded to real occurrences):
 *  - FREQ = DAILY | WEEKLY | MONTHLY | YEARLY
 *  - INTERVAL (default 1)
 *  - COUNT  (occurrence cap)
 *  - UNTIL  (inclusive end bound; a DATE, or an instant compared with each
 *             occurrence's true instant, so a TZID series ends when it really ends)
 *  - EXDATE, RDATE and RECURRENCE-ID overrides (carried on the event as
 *             `exdates` / `rdates` by the reader): excluded starts are dropped,
 *             RDATE starts are added
 *  - BYDAY , ONLY for FREQ=WEEKLY with INTERVAL=1 and weekday-only tokens
 *             (MO,TU,WE,TH,FR,SA,SU with no leading ordinal). Under those
 *             conditions WKST does not change the matched set, so it is ignored
 *             safely. Any BYDAY outside that condition is treated as unsupported.
 *
 * Everything else present in the RRULE (BYMONTHDAY, BYMONTH, BYSETPOS, BYHOUR,
 * BYWEEKNO, BYYEARDAY, ordinal BYDAY, BYDAY on non-weekly, INTERVAL>1 with BYDAY,
 * or an unknown FREQ), an RDATE period, or an override with RANGE=THISANDFUTURE
 * marks the series `unsupported` and names the offending part; `expandEvents`
 * then lists it in `unexpandedSeries` instead of letting it vanish.
 *
 * PURE: no fs, no network, no process globals.
 */

import type {
  CalendarEvent,
  DateWindow,
  EventDateTime,
  EventOccurrence,
  RecurrenceInfo,
  WindowExpansion,
} from './types.js';
import { utcToZonedWallClockMs } from '../utils/timezone.js';
import { eventDateTimeEpochMs } from './event-time.js';

const WEEKDAY_TOKENS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
type WeekdayToken = (typeof WEEKDAY_TOKENS)[number];

const KNOWN_FREQ = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);

/** Parts we fully honor; anything else present makes the rule unsupported. */
const SUPPORTED_PARTS = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'WKST', 'BYDAY']);

interface RRuleParts {
  readonly map: ReadonlyMap<string, string>;
}

function parseRRule(rule: string): RRuleParts {
  const map = new Map<string, string>();
  for (const seg of rule.split(';')) {
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    const k = seg.slice(0, eq).trim().toUpperCase();
    const v = seg.slice(eq + 1).trim();
    if (k !== '') map.set(k, v);
  }
  return { map };
}

/**
 * Classify a raw RRULE into an honest RecurrenceInfo. Called by the parser at read
 * time so the event carries its expansion verdict before any window is known.
 * `unsupportedParts` names series features the reader found and this build does
 * not apply (an RDATE period, a THISANDFUTURE override). An empty `rule` is a
 * series made only of RDATE values, which expands to its seed plus those dates.
 */
export function describeRecurrence(rule: string, unsupportedParts: readonly string[] = []): RecurrenceInfo {
  const unsupported = unsupportedParts[0];
  if (unsupported !== undefined) {
    return { rule, expansion: 'unsupported', unsupportedReason: `${unsupported} is not applied by this build, so the series is not expanded` };
  }
  if (rule.trim() === '') return { rule, expansion: 'full' };

  const { map } = parseRRule(rule);
  const freq = (map.get('FREQ') ?? '').toUpperCase();

  if (!KNOWN_FREQ.has(freq)) {
    return { rule, expansion: 'unsupported', unsupportedReason: `RRULE FREQ '${freq || '(missing)'}' is not expanded by this build` };
  }

  for (const part of map.keys()) {
    if (!SUPPORTED_PARTS.has(part)) {
      return { rule, expansion: 'unsupported', unsupportedReason: `RRULE part ${part} is not expanded by this build` };
    }
  }

  if (map.has('BYDAY')) {
    const byDayVerdict = classifyByDay(freq, map);
    if (byDayVerdict) return { rule, expansion: 'unsupported', unsupportedReason: byDayVerdict };
  }

  return { rule, expansion: 'full' };
}

/** Return an unsupported-reason string if this BYDAY is outside the honored subset, else undefined. */
function classifyByDay(freq: string, map: ReadonlyMap<string, string>): string | undefined {
  if (freq !== 'WEEKLY') {
    return `RRULE BYDAY on FREQ=${freq} is not expanded by this build (only weekly BYDAY is supported)`;
  }
  const interval = parseInterval(map);
  if (interval !== 1) {
    return 'RRULE BYDAY with INTERVAL>1 is not expanded by this build (week-boundary/WKST handling required)';
  }
  const tokens = (map.get('BYDAY') ?? '').split(',').map((t) => t.trim().toUpperCase());
  for (const tok of tokens) {
    if (!WEEKDAY_TOKENS.includes(tok as WeekdayToken)) {
      return `RRULE BYDAY token '${tok}' with an ordinal is not expanded by this build`;
    }
  }
  return undefined;
}

function parseInterval(map: ReadonlyMap<string, string>): number {
  const raw = map.get('INTERVAL');
  if (!raw) return 1;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Extract 'YYYY-MM-DD' from an EventDateTime value. */
function datePart(value: string): string {
  return value.slice(0, 10);
}

/**
 * The UNTIL bound. A DATE bounds by date (inclusive). A date-time is an
 * instant: with 'Z' it is UTC (RFC 5545 requires that when DTSTART has a
 * TZID); without, it is wall time in the seed's own zone.
 */
type UntilBound = { readonly kind: 'date'; readonly ymd: string } | { readonly kind: 'instant'; readonly ms: number };

function parseUntil(raw: string, seed: EventDateTime): UntilBound | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(raw.trim());
  if (!m) return undefined;
  const ymd = `${m[1]}-${m[2]}-${m[3]}`;
  if (m[4] === undefined || seed.kind === 'date') return { kind: 'date', ymd };
  const wall = `${ymd}T${m[4]}:${m[5]}:${m[6]}`;
  if (m[7] === 'Z') return { kind: 'instant', ms: Date.parse(`${wall}Z`) };
  return { kind: 'instant', ms: eventDateTimeEpochMs({ ...seed, value: wall }) };
}

/** A start's identity for EXDATE matching: the date for an all-day value, else the instant. */
function startKey(dt: EventDateTime): string {
  return dt.kind === 'date' ? `D${datePart(dt.value)}` : `T${String(eventDateTimeEpochMs(dt))}`;
}

/** The occurrence a series start string stands for, in the seed's kind and zone. */
function occurrenceDateTime(event: CalendarEvent, start: string): EventDateTime {
  return { ...event.start, value: start };
}

/**
 * An RDATE value as a start string mirroring the seed's kind and zone. A
 * value in another zone is moved to the seed's wall clock so it sorts and
 * de-duplicates with the RRULE's own starts.
 */
function rdateStart(event: CalendarEvent, rdate: EventDateTime): string | undefined {
  const seed = event.start;
  if (seed.kind === 'date' || rdate.kind === 'date') return seed.kind === 'date' ? datePart(rdate.value) : `${datePart(rdate.value)}${seed.value.slice(10)}`;
  if (rdate.zone === seed.zone && rdate.tzid === seed.tzid) return rdate.value;
  const instant = eventDateTimeEpochMs(rdate);
  if (!Number.isFinite(instant)) return undefined;
  let wall = instant;
  if (seed.zone === 'tzid' && seed.tzid) {
    try {
      wall = utcToZonedWallClockMs(instant, seed.tzid);
    } catch {
      wall = instant;
    }
  }
  const iso = new Date(wall).toISOString().slice(0, 19);
  return seed.zone === 'utc' ? `${iso}Z` : iso;
}

/** Hard ceiling so a COUNT-less UNTIL-less rule cannot run away. */
const MAX_OCCURRENCES = 1000;

function toUtcDate(ymd: string): number {
  const [y, m, d] = ymd.split('-').map((s) => Number.parseInt(s, 10));
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

function fromUtcDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear().toString().padStart(4, '0');
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const DAY_MS = 86_400_000;

/** Build an occurrence start string that mirrors the seed's kind/zone. */
function occurrenceStart(event: CalendarEvent, ymd: string): string {
  const s = event.start;
  if (s.kind === 'date') return ymd;
  const time = s.value.slice(10); // 'THH:mm:ss' or 'THH:mm:ssZ'
  return `${ymd}${time}`;
}

/**
 * Expand a (possibly recurring) event into concrete occurrences inside [window.from,
 * window.to] inclusive. A non-recurring event yields at most its single seed. An
 * event whose recurrence is `unsupported` yields ONLY its seed (if in-window),
 * flagged `isSeed`, never a fabricated series; `expandEvents` also lists such a
 * series in `unexpandedSeries`. EXDATE values and the starts of overrides are
 * dropped; RDATE values are added.
 */
export function expandEvent(event: CalendarEvent, window: DateWindow): EventOccurrence[] {
  const seedYmd = datePart(event.start.value);
  const fromMs = toUtcDate(window.from);
  const toMs = toUtcDate(window.to);
  const seedMs = toUtcDate(seedYmd);

  const inWindow = (ms: number): boolean => ms >= fromMs && ms <= toMs;
  const seedOccurrence = (): EventOccurrence[] =>
    inWindow(seedMs) ? [{ event, start: occurrenceStart(event, seedYmd), isSeed: true }] : [];

  if (!event.recurrence || event.recurrence.expansion !== 'full') {
    return seedOccurrence();
  }

  // EXDATE matches an occurrence by instant; an all-day EXDATE on a timed
  // series removes that day's occurrence.
  const excluded = new Set((event.exdates ?? []).map(startKey));
  const excludedDays = new Set((event.exdates ?? []).filter((dt) => dt.kind === 'date').map((dt) => datePart(dt.value)));
  const isExcluded = (start: string): boolean =>
    excludedDays.has(datePart(start)) || excluded.has(startKey(occurrenceDateTime(event, start)));

  const out: EventOccurrence[] = [];
  if (event.recurrence.rule.trim() !== '') expandRule(event, event.recurrence.rule, { seedMs, fromMs, toMs }, out);
  else if (inWindow(seedMs)) out.push({ event, start: occurrenceStart(event, seedYmd), isSeed: true });

  const seen = new Set(out.map((occurrence) => occurrence.start));
  for (const rdate of event.rdates ?? []) {
    const start = rdateStart(event, rdate);
    if (start === undefined || seen.has(start)) continue;
    if (!inWindow(toUtcDate(datePart(start)))) continue;
    seen.add(start);
    out.push({ event, start, isSeed: false });
  }
  return out
    .filter((occurrence) => !isExcluded(occurrence.start))
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

/**
 * Expand every event in a window, and list the recurring series that could not
 * be expanded and may reach into it (seed on or before the window's end), so a
 * caller can report them instead of showing nothing.
 */
export function expandEvents(events: readonly CalendarEvent[], window: DateWindow): WindowExpansion {
  const occurrences: EventOccurrence[] = [];
  const unexpandedSeries: CalendarEvent[] = [];
  for (const event of events) {
    occurrences.push(...expandEvent(event, window));
    if (event.recurrence?.expansion === 'unsupported' && datePart(event.start.value) <= window.to) {
      unexpandedSeries.push(event);
    }
  }
  return { occurrences, unexpandedSeries };
}

/** The RRULE's own starts inside the window, in series order. */
function expandRule(
  event: CalendarEvent,
  rule: string,
  bounds: { readonly seedMs: number; readonly fromMs: number; readonly toMs: number },
  out: EventOccurrence[],
): void {
  const { seedMs, fromMs, toMs } = bounds;
  const { map } = parseRRule(rule);
  const freq = (map.get('FREQ') ?? '').toUpperCase();
  const interval = parseInterval(map);
  const count = map.has('COUNT') ? Number.parseInt(map.get('COUNT') ?? '', 10) : undefined;
  const until = map.has('UNTIL') ? parseUntil(map.get('UNTIL') ?? '', event.start) : undefined;
  // The last date any occurrence can fall on: UNTIL's date, plus a day when it
  // is an instant (a TZID wall clock can be a day either side of UTC).
  const untilMs = until === undefined
    ? undefined
    : until.kind === 'date'
      ? toUtcDate(until.ymd)
      : Number.isFinite(until.ms) ? toUtcDate(new Date(until.ms).toISOString().slice(0, 10)) + DAY_MS : undefined;
  const pastUntil = (ms: number): boolean => {
    if (until === undefined) return false;
    if (until.kind === 'date') return ms > toUtcDate(until.ymd);
    if (!Number.isFinite(until.ms)) return false;
    const start = occurrenceStart(event, fromUtcDate(ms));
    return eventDateTimeEpochMs(occurrenceDateTime(event, start)) > until.ms;
  };
  const byDay = map.has('BYDAY')
    ? new Set((map.get('BYDAY') ?? '').split(',').map((t) => WEEKDAY_TOKENS.indexOf(t.trim().toUpperCase() as WeekdayToken)))
    : undefined;

  let emitted = 0; // series position (counts every occurrence, in or out of window)

  // `series` yields candidate UTC-midnight ms values in ascending series order.
  // Weekly BYDAY walks day-by-day emitting matching weekdays; every other supported
  // FREQ steps period-by-period from the seed. Both share one COUNT/UNTIL/window filter.
  const emit = (ms: number): boolean => {
    // Return false to STOP the whole series (COUNT reached, past UNTIL, past window end).
    if (count !== undefined && emitted >= count) return false;
    if (pastUntil(ms)) return false;
    if (ms > toMs) return false;
    emitted += 1;
    if (ms >= fromMs) {
      const ymd = fromUtcDate(ms);
      out.push({ event, start: occurrenceStart(event, ymd), isSeed: ms === seedMs });
    }
    return true;
  };

  if (freq === 'WEEKLY' && byDay) {
    // Skip whole weeks straight to the window: every 7-day block from the seed
    // holds each weekday exactly once, so the series position of the first
    // candidate is known without walking there.
    const weeksBefore = Math.max(0, Math.floor((fromMs - seedMs) / (7 * DAY_MS)));
    let cursor = seedMs + weeksBefore * 7 * DAY_MS;
    emitted = weeksBefore * byDay.size;
    for (let i = 0; i < MAX_OCCURRENCES * 8; i++) {
      if (byDay.has(new Date(cursor).getUTCDay())) {
        if (!emit(cursor)) break;
      } else if ((untilMs !== undefined && cursor > untilMs) || cursor > toMs) {
        break; // no more matches possible past UNTIL / window end
      }
      cursor += DAY_MS;
    }
    return;
  }

  if (freq === 'MONTHLY' || freq === 'YEARLY') {
    stepMonthlyOrYearly(freq, interval, seedMs, toMs, untilMs, emit);
    return;
  }

  const step = freqStepper(freq, interval);
  // DAILY/WEEKLY: jump to the first period at or after the window start. The
  // series position of that period is its index, which COUNT needs.
  const periodMs = step(0);
  const periodsBefore = Math.max(0, Math.floor((fromMs - seedMs) / periodMs));
  let cursor = seedMs + periodsBefore * periodMs;
  emitted = periodsBefore;
  for (let i = 0; i < MAX_OCCURRENCES; i++) {
    if (!emit(cursor)) break;
    cursor = step(cursor);
  }
}

/** A stepper that advances a UTC-midnight ms cursor by one FREQ*INTERVAL period. DAILY/WEEKLY
 *  only, MONTHLY/YEARLY need the anchor-day-preserving/skip-invalid logic in
 *  stepMonthlyOrYearly below, since naive Date.UTC(y, m+1, day) arithmetic normalizes an
 *  out-of-range day (e.g. day 31 in a 30-day month) into the NEXT month, permanently
 *  shifting the rest of the series (the bug this file used to have). */
function freqStepper(freq: string, interval: number): (ms: number) => number {
  switch (freq) {
    case 'DAILY':
      return (ms) => ms + DAY_MS * interval;
    case 'WEEKLY':
      return (ms) => ms + DAY_MS * 7 * interval;
    default:
      return (ms) => ms + DAY_MS;
  }
}

/**
 * MONTHLY/YEARLY stepping, RFC 5545-correct: every candidate is measured from the
 * ORIGINAL anchor day-of-month (`seedDay`), never from a previously normalized/drifted
 * cursor. A candidate (year, month, seedDay) that is not a real calendar date, Feb 31,
 * Feb 29 in a non-leap year, Apr 31, etc., does not exist and is SKIPPED entirely: it is
 * never passed to `emit`, so it never consumes COUNT and never appears in the output.
 *
 * Citation (RFC 5545 §3.3.10, "Recurrence Rule"): "Recurrence rules may generate
 * recurrence instances with an invalid date (e.g., February 30) or nonexistent local time
 * ... Such recurrence instances MUST be ignored and MUST NOT count towards the recurrence
 * count specified by the COUNT rule part." This function and its COUNT bookkeeping (via
 * the caller's `emit`) implement that rule directly: e.g. FREQ=MONTHLY anchored on the
 * 31st walks Jan 31 -> Mar 31 -> May 31 -> ... (Feb/Apr/Jun skipped, uncounted); FREQ=YEARLY
 * anchored on Feb 29 walks leap year -> leap year only.
 */
function stepMonthlyOrYearly(
  freq: 'MONTHLY' | 'YEARLY',
  interval: number,
  seedMs: number,
  toMs: number,
  untilMs: number | undefined,
  emit: (ms: number) => boolean,
): void {
  const seed = new Date(seedMs);
  const seedYear = seed.getUTCFullYear();
  const seedMonth = seed.getUTCMonth();
  const seedDay = seed.getUTCDate();
  // Generous candidate ceiling (not an occurrence ceiling, MAX_OCCURRENCES already
  // bounds emitted occurrences via `emit`/COUNT): covers the worst case of a monthly
  // anchor that only lands ~7 times a year (a 31st) needing many more candidate
  // months than emitted occurrences, and a yearly Feb-29 anchor needing up to 4x the
  // candidate years.
  const maxCandidates = freq === 'MONTHLY' ? MAX_OCCURRENCES * 12 : MAX_OCCURRENCES * 4;
  for (let k = 0; k < maxCandidates; k++) {
    const year = freq === 'MONTHLY'
      ? Math.floor((seedYear * 12 + seedMonth + k * interval) / 12)
      : seedYear + k * interval;
    const month = freq === 'MONTHLY'
      ? (((seedYear * 12 + seedMonth + k * interval) % 12) + 12) % 12
      : seedMonth;
    // Bail out once even the FIRST of this candidate month is past every hard stop,
    // further k only move further forward, so nothing later can help either. This
    // check runs before the validity check so a run of skipped (invalid) candidates
    // near the end of the window does not burn through maxCandidates.
    const monthStartMs = Date.UTC(year, month, 1);
    if (monthStartMs > toMs && (untilMs === undefined || monthStartMs > untilMs)) return;
    const candidateMs = Date.UTC(year, month, seedDay);
    const candidate = new Date(candidateMs);
    const isRealDate = candidate.getUTCFullYear() === year
      && candidate.getUTCMonth() === month
      && candidate.getUTCDate() === seedDay;
    if (!isRealDate) continue; // invalid calendar date, skipped, does not consume COUNT
    if (!emit(candidateMs)) return;
  }
}

