/**
 * merged-calendar-model.ts, normalization of provider (Google Calendar API v3,
 * Microsoft Graph) events into the ONE merged event model shared with A9's .ics
 * path: A9's CalendarEvent shape plus a source label and the provider ids.
 *
 * Time anchoring:
 *  - An all-day value keeps its 'YYYY-MM-DD' date and is `zone: 'floating'`.
 *  - A timed value carrying an explicit numeric offset or a trailing Z is normalized
 *    to a real UTC instant (`zone: 'utc'`).
 *  - A timed value that only names a zone (no offset) is kept as wall time with the
 *    TZID recorded (`zone: 'tzid'`); ordering converts it (event-time.ts).
 *
 * Recurrence is delegated to the provider: the API clients request expanded single
 * instances (Google singleEvents=true, Graph calendarView), so each normalized event
 * is one concrete occurrence, no rule is fabricated here.
 */

import type { EventDateTime } from './types.js';
import type { CalendarProviderId, MergedCalendarEvent } from './oauth-types.js';
import { eventDateTimeEpochMs } from './event-time.js';

export { eventDateTimeEpochMs };

// ---------------------------------------------------------------------------
// Google Calendar API v3
// ---------------------------------------------------------------------------

interface GoogleDate {
  date?: unknown;
  dateTime?: unknown;
  timeZone?: unknown;
}
interface GoogleOrganizer {
  email?: unknown;
  /**
   * Google Calendar API v3, Events resource: "Whether the organizer corresponds
   * to the calendar on which this copy of the event appears. Read-only. The
   * default is False."
   */
  self?: unknown;
}
interface GoogleEvent {
  id?: unknown;
  iCalUID?: unknown;
  summary?: unknown;
  location?: unknown;
  description?: unknown;
  start?: GoogleDate;
  end?: GoogleDate;
  status?: unknown;
  organizer?: GoogleOrganizer;
}

function googleDateTime(value: GoogleDate | undefined): EventDateTime | null {
  if (!value) return null;
  if (typeof value.date === 'string') {
    return { value: value.date, kind: 'date', zone: 'floating' };
  }
  if (typeof value.dateTime === 'string') {
    return normalizeOffsetDateTime(value.dateTime, typeof value.timeZone === 'string' ? value.timeZone : undefined);
  }
  return null;
}

/**
 * Normalize one Google event (already a concrete instance from singleEvents=true)
 * into the merged model. Returns null for an event with no usable start.
 */
export function normalizeGoogleEvent(
  raw: unknown,
  calendarId: string,
  calendarLabel: string,
): MergedCalendarEvent | null {
  const ev = (raw ?? {}) as GoogleEvent;
  const start = googleDateTime(ev.start);
  if (!start) return null;
  const id = typeof ev.id === 'string' ? ev.id : undefined;
  const uid = typeof ev.iCalUID === 'string' && ev.iCalUID.length > 0 ? ev.iCalUID : id ?? syntheticUid('google', calendarId);
  const end = googleDateTime(ev.end);
  const organizer = typeof ev.organizer?.email === 'string' ? ev.organizer.email.trim() : '';
  return {
    uid,
    summary: typeof ev.summary === 'string' ? ev.summary : '(no title)',
    ...(typeof ev.location === 'string' ? { location: ev.location } : {}),
    ...(typeof ev.description === 'string' ? { description: ev.description } : {}),
    ...(organizer.length > 0 ? { organizer } : {}),
    // Only `true` counts. The field is read-only and defaults to false, so a
    // missing organizer block leaves this absent and the event reads as
    // somebody else's, which is the direction that fails towards recording.
    ...(ev.organizer?.self === true ? { organizerIsOwner: true } : {}),
    start,
    ...(end ? { end } : {}),
    source: 'google-api',
    ...(id ? { sourceEventId: id } : {}),
    calendarId,
    calendarLabel,
  };
}

// ---------------------------------------------------------------------------
// Microsoft Graph
// ---------------------------------------------------------------------------

interface GraphDate {
  dateTime?: unknown;
  timeZone?: unknown;
}
interface GraphEvent {
  id?: unknown;
  iCalUId?: unknown;
  subject?: unknown;
  bodyPreview?: unknown;
  location?: { displayName?: unknown } | undefined;
  start?: GraphDate;
  end?: GraphDate;
  isAllDay?: unknown;
  /** Microsoft Graph `recipient`: `{ emailAddress: { name, address } }`. */
  organizer?: { emailAddress?: { address?: unknown; name?: unknown } | undefined } | undefined;
  /**
   * Microsoft Graph, event resource: "Set to true if the calendar owner
   * (specified by the owner property of the calendar) is the organizer of the
   * event (specified by the organizer property of the event)."
   */
  isOrganizer?: unknown;
  /** True for a meeting the organizer cancelled; the entry stays on the calendar. */
  isCancelled?: unknown;
}

function graphDateTime(value: GraphDate | undefined, isAllDay: boolean): EventDateTime | null {
  if (!value || typeof value.dateTime !== 'string') return null;
  const zone = typeof value.timeZone === 'string' ? value.timeZone : 'UTC';
  if (isAllDay) {
    // Graph all-day start is midnight; keep the date part as a floating date.
    return { value: value.dateTime.slice(0, 10), kind: 'date', zone: 'floating' };
  }
  if (zone === 'UTC') {
    // Graph returns UTC wall time without an offset; stamp it as real UTC.
    const iso = value.dateTime.endsWith('Z') ? isoSeconds(value.dateTime) : `${isoSeconds(value.dateTime)}Z`;
    return { value: iso, kind: 'date-time', zone: 'utc' };
  }
  // A named zone with no offset: keep wall time and the TZID; ordering converts it.
  return { value: isoSeconds(value.dateTime), kind: 'date-time', zone: 'tzid', tzid: zone };
}

/** Normalize one Graph event (a concrete instance from calendarView) into the model. */
export function normalizeGraphEvent(
  raw: unknown,
  calendarId: string,
  calendarLabel: string,
): MergedCalendarEvent | null {
  const ev = (raw ?? {}) as GraphEvent;
  if (ev.isCancelled === true) return null;
  const isAllDay = ev.isAllDay === true;
  const start = graphDateTime(ev.start, isAllDay);
  if (!start) return null;
  const id = typeof ev.id === 'string' ? ev.id : undefined;
  const uid = typeof ev.iCalUId === 'string' && ev.iCalUId.length > 0 ? ev.iCalUId : id ?? syntheticUid('microsoft', calendarId);
  const end = graphDateTime(ev.end, isAllDay);
  const location = ev.location && typeof ev.location.displayName === 'string' ? ev.location.displayName : undefined;
  const organizerAddress = typeof ev.organizer?.emailAddress?.address === 'string'
    ? ev.organizer.emailAddress.address.trim()
    : '';
  return {
    uid,
    summary: typeof ev.subject === 'string' ? ev.subject : '(no title)',
    ...(location ? { location } : {}),
    ...(typeof ev.bodyPreview === 'string' && ev.bodyPreview.length > 0 ? { description: ev.bodyPreview } : {}),
    ...(organizerAddress.length > 0 ? { organizer: organizerAddress } : {}),
    // Only `true` counts, for the same reason as the Google path above.
    ...(ev.isOrganizer === true ? { organizerIsOwner: true } : {}),
    start,
    ...(end ? { end } : {}),
    source: 'microsoft-graph',
    ...(id ? { sourceEventId: id } : {}),
    calendarId,
    calendarLabel,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a date-time that may carry a numeric offset or trailing Z into a real
 * UTC instant. A value with only a named zone (no offset) is impossible here (the
 * Google API always includes an offset on dateTime), but we defend: if Date cannot
 * parse it, keep the wall value as tzid when a zone was named, else floating.
 */
export function normalizeOffsetDateTime(value: string, namedZone?: string): EventDateTime {
  const hasOffset = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(value);
  if (hasOffset) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) {
      return { value: new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'), kind: 'date-time', zone: 'utc' };
    }
  }
  if (namedZone) return { value: isoSeconds(value), kind: 'date-time', zone: 'tzid', tzid: namedZone };
  return { value: isoSeconds(value), kind: 'date-time', zone: 'floating' };
}

/** Trim a provider date-time to whole-second ISO (drop sub-second + any offset tail). */
function isoSeconds(value: string): string {
  const trimmed = value.replace(/\.\d+/, '');
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.exec(trimmed);
  return m ? m[1]! : trimmed;
}

function syntheticUid(provider: CalendarProviderId, calendarId: string): string {
  return `goodvibes-${provider}-${calendarId}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Cross-zone chronological ordering
// ---------------------------------------------------------------------------

/**
 * Chronological comparator for {@link EventDateTime} values (ascending), suitable
 * for `Array.prototype.sort`, through {@link eventDateTimeEpochMs} (event-time.ts).
 * Sort through this rather than comparing `.value` strings: a 'utc' value and a
 * 'tzid' value are not on the same axis as text.
 */
export function compareEventDateTime(a: EventDateTime, b: EventDateTime): number {
  return eventDateTimeEpochMs(a) - eventDateTimeEpochMs(b);
}

/** Sort {@link MergedCalendarEvent}s by start time, through {@link compareEventDateTime}. */
export function compareMergedCalendarEventsByStart(a: MergedCalendarEvent, b: MergedCalendarEvent): number {
  return compareEventDateTime(a.start, b.start);
}
