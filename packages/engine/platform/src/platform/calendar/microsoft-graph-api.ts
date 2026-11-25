/**
 * microsoft-graph-api.ts, the Microsoft Graph client over an access token and the
 * injected HttpFetch. Lists calendars (me/calendars), lists events over a window
 * (me/calendars/{id}/calendarView, which returns expanded instances), creates
 * events (me/calendars/{id}/events), and reads, changes and removes one event by
 * id (me/events/{id}), for the daemon's calendar (microsoft-gateway-service.ts). A Prefer: outlook.timezone="UTC" header makes
 * Graph return UTC wall times so normalization is honest. Paging follows
 * @odata.nextLink; failures are named degraded states via CalendarApiError.
 */

import { authedRequest, authedWrite, CalendarApiError } from './calendar-api-shared.js';
import { normalizeGraphEvent } from './merged-calendar-model.js';
import { resolveNewEventTimes } from './new-event-times.js';
import type { CalendarCreateResult, CalendarRequestOptions, HttpFetch, MergedCalendarEvent, NewCalendarEvent, ProviderCalendar } from './oauth-types.js';

const BASE = 'https://graph.microsoft.com/v1.0';
const UTC_PREFER = { Prefer: 'outlook.timezone="UTC"' } as const;
const GRAPH_ORIGIN = 'https://graph.microsoft.com';
/** A calendar with more pages than this is not being paged, it is looping. */
const MAX_PAGES = 100;

/**
 * The next page URL from a response, or undefined at the end. The bearer token
 * goes to whatever URL this returns, so it must stay on Graph, and the page
 * count is bounded so a self-referencing link cannot loop forever.
 */
function nextGraphPage(link: unknown, pagesFetched: number): string | undefined {
  if (typeof link !== 'string' || link.length === 0) return undefined;
  let origin: string | undefined;
  try {
    origin = new URL(link).origin;
  } catch {
    origin = undefined;
  }
  if (origin !== GRAPH_ORIGIN) {
    throw new CalendarApiError({
      kind: 'provider-error',
      status: 200,
      detail: 'Microsoft Graph returned a next-page link that is not on graph.microsoft.com; it was not followed.',
    });
  }
  if (pagesFetched >= MAX_PAGES) {
    throw new CalendarApiError({
      kind: 'provider-error',
      status: 200,
      detail: `Microsoft Graph kept returning next-page links after ${String(MAX_PAGES)} pages; stopped.`,
    });
  }
  return link;
}

/** List the user's calendars; write access comes from canEdit. */
export async function listGraphCalendars(fetchImpl: HttpFetch, token: string, options: CalendarRequestOptions = {}): Promise<ProviderCalendar[]> {
  const out: ProviderCalendar[] = [];
  let next: string | undefined = `${BASE}/me/calendars?$select=id,name,canEdit,isDefaultCalendar&$top=100`;
  let pages = 0;
  while (next) {
    pages += 1;
    const body = (await authedRequest(fetchImpl, 'microsoft', { url: next, method: 'GET', token, operation: 'list-calendars' }, options)) as {
      value?: unknown[];
      '@odata.nextLink'?: unknown;
    };
    for (const raw of body.value ?? []) {
      const item = (raw ?? {}) as { id?: unknown; name?: unknown; canEdit?: unknown; isDefaultCalendar?: unknown };
      if (typeof item.id !== 'string') continue;
      out.push({
        id: item.id,
        name: typeof item.name === 'string' ? item.name : item.id,
        provider: 'microsoft',
        ...(item.isDefaultCalendar === true ? { primary: true } : {}),
        canWrite: item.canEdit === true,
      });
    }
    next = nextGraphPage(body['@odata.nextLink'], pages);
  }
  return out;
}

export interface GraphEventsQuery {
  /** The calendar to read; empty reads the account's default calendar (me/calendar). */
  readonly calendarId: string;
  readonly calendarLabel: string;
  /** ISO lower bound, e.g. '2026-07-01T00:00:00Z'. */
  readonly start: string;
  /** ISO upper bound. */
  readonly end: string;
  readonly pageSize?: number;
}

/** List events over a window via calendarView, paging @odata.nextLink to exhaustion. */
export async function listGraphEvents(
  fetchImpl: HttpFetch,
  token: string,
  query: GraphEventsQuery,
  options: CalendarRequestOptions = {},
): Promise<MergedCalendarEvent[]> {
  const out: MergedCalendarEvent[] = [];
  const calendarPath = query.calendarId ? `me/calendars/${encodeURIComponent(query.calendarId)}` : 'me/calendar';
  const first = new URL(`${BASE}/${calendarPath}/calendarView`);
  first.searchParams.set('startDateTime', query.start);
  first.searchParams.set('endDateTime', query.end);
  first.searchParams.set('$select', 'id,iCalUId,subject,bodyPreview,location,start,end,isAllDay,organizer,isOrganizer,isCancelled');
  first.searchParams.set('$orderby', 'start/dateTime');
  first.searchParams.set('$top', String(query.pageSize ?? 100));
  let next: string | undefined = first.toString();
  let pages = 0;
  while (next) {
    pages += 1;
    const body = (await authedRequest(fetchImpl, 'microsoft', {
      url: next,
      method: 'GET',
      token,
      operation: 'list-events',
      extraHeaders: UTC_PREFER,
    }, options)) as { value?: unknown[]; '@odata.nextLink'?: unknown };
    for (const raw of body.value ?? []) {
      const event = normalizeGraphEvent(raw, query.calendarId, query.calendarLabel);
      if (event) out.push(event);
    }
    next = nextGraphPage(body['@odata.nextLink'], pages);
  }
  return out;
}

/**
 * Create an event. Times go through `resolveNewEventTimes`: a floating time is
 * sent in `ownerZone`, and an all-day event is midnight to a later midnight in
 * that zone, which is what Graph requires of `isAllDay`.
 */
export async function createGraphEvent(
  fetchImpl: HttpFetch,
  token: string,
  calendarId: string,
  calendarLabel: string,
  event: NewCalendarEvent,
  ownerZone: string,
  options: CalendarRequestOptions = {},
  /** Addresses to invite; Outlook sends them the invitation. */
  guests: readonly string[] = [],
): Promise<CalendarCreateResult> {
  const times = resolveNewEventTimes(event, ownerZone);
  const allDayZone = ownerZone.trim().length > 0 ? ownerZone.trim() : 'UTC';
  const payload: Record<string, unknown> = {
    subject: event.summary,
    isAllDay: times.allDay,
    start: times.allDay ? { dateTime: `${times.startDate}T00:00:00`, timeZone: allDayZone } : times.start,
    end: times.allDay ? { dateTime: `${times.endDate}T00:00:00`, timeZone: allDayZone } : times.end,
    ...(event.location ? { location: { displayName: event.location } } : {}),
    ...(event.description ? { body: { contentType: 'text', content: event.description } } : {}),
    ...(guests.length > 0 ? { attendees: graphAttendees(guests) } : {}),
  };
  // An empty calendar id is the account's default calendar.
  const url = calendarId ? `${BASE}/me/calendars/${encodeURIComponent(calendarId)}/events` : `${BASE}/me/calendar/events`;
  const created = await authedWrite(fetchImpl, 'microsoft', {
    url,
    method: 'POST',
    token,
    operation: 'create-event',
    body: payload,
    extraHeaders: UTC_PREFER,
  }, options);
  const normalized = created.body === undefined ? null : normalizeGraphEvent(created.body, calendarId, calendarLabel);
  if (normalized) return { kind: 'created', event: normalized };
  const id = (created.body as { id?: unknown } | undefined)?.id;
  const providerEventId = typeof id === 'string' && id.length > 0 ? id : created.location;
  return {
    kind: 'created-but-unreadable',
    ...(providerEventId ? { providerEventId } : {}),
    detail: 'Microsoft Graph accepted the event but its answer could not be read. The event exists; check the calendar instead of creating it again.',
  };
}

/** Graph's attendee list for a set of addresses: each one a required guest. */
function graphAttendees(addresses: readonly string[]): unknown[] {
  return addresses.map((address) => ({ emailAddress: { address }, type: 'required' }));
}

/** One event as Graph holds it, read by id: the normalized event and what a change needs. */
export interface GraphEventRead {
  /** Null when Graph returns it cancelled (the event is no longer on the calendar). */
  readonly event: MergedCalendarEvent | null;
  /** Graph's version of the event (`changeKey`), compared before a change. */
  readonly changeKey?: string;
  /** The HTTP ETag Graph gave the event, sent back as If-Match on a change. */
  readonly etag?: string;
  /** `singleInstance`, `occurrence`, `exception` or `seriesMaster`. */
  readonly type?: string;
  /** The guests' addresses. */
  readonly attendees: readonly string[];
}

/** Read one event by its Graph id (me/events/{id}). An unknown id is a CalendarApiError with status 404. */
export async function getGraphEvent(
  fetchImpl: HttpFetch,
  token: string,
  eventId: string,
  calendarLabel: string,
  options: CalendarRequestOptions = {},
): Promise<GraphEventRead> {
  const url = new URL(`${BASE}/me/events/${encodeURIComponent(eventId)}`);
  url.searchParams.set('$select', 'id,iCalUId,subject,bodyPreview,location,start,end,isAllDay,organizer,isOrganizer,isCancelled,attendees,changeKey,type,calendar');
  const raw = (await authedRequest(fetchImpl, 'microsoft', {
    url: url.toString(),
    method: 'GET',
    token,
    operation: 'list-events',
    extraHeaders: UTC_PREFER,
  }, options)) as { changeKey?: unknown; '@odata.etag'?: unknown; type?: unknown; attendees?: unknown };
  const attendees = Array.isArray(raw.attendees)
    ? raw.attendees.flatMap((entry) => {
      const address = (entry as { emailAddress?: { address?: unknown } } | null)?.emailAddress?.address;
      return typeof address === 'string' && address.length > 0 ? [address] : [];
    })
    : [];
  return {
    event: normalizeGraphEvent(raw, '', calendarLabel),
    ...(typeof raw.changeKey === 'string' ? { changeKey: raw.changeKey } : {}),
    ...(typeof raw['@odata.etag'] === 'string' ? { etag: raw['@odata.etag'] } : {}),
    ...(typeof raw.type === 'string' ? { type: raw.type } : {}),
    attendees,
  };
}

/** The fields of an event change, in Graph's shape (UTC times, or an all-day pair of dates). */
export interface GraphEventChange {
  readonly subject?: string;
  readonly start?: string;
  readonly end?: string;
  readonly location?: string;
  readonly description?: string;
  readonly attendees?: readonly string[];
}

/** A Graph date-time or date (all day) from an ISO value. */
function graphTime(value: string, allDayZone: string): { readonly dateTime: string; readonly timeZone: string } {
  if (!value.includes('T')) return { dateTime: `${value}T00:00:00`, timeZone: allDayZone };
  return { dateTime: new Date(Date.parse(value)).toISOString().replace(/Z$/, ''), timeZone: 'UTC' };
}

/** Change an event (PATCH me/events/{id}); `ifMatch` makes Graph refuse it (412) when the event changed since it was read. */
export async function updateGraphEvent(
  fetchImpl: HttpFetch,
  token: string,
  eventId: string,
  change: GraphEventChange,
  ownerZone: string,
  ifMatch: string | undefined,
  options: CalendarRequestOptions = {},
): Promise<void> {
  const allDayZone = ownerZone.trim().length > 0 ? ownerZone.trim() : 'UTC';
  const allDay = change.start !== undefined && !change.start.includes('T');
  const payload: Record<string, unknown> = {
    ...(change.subject === undefined ? {} : { subject: change.subject }),
    ...(change.start === undefined ? {} : { start: graphTime(change.start, allDayZone), isAllDay: allDay }),
    ...(change.end === undefined ? {} : { end: graphTime(change.end, allDayZone) }),
    ...(change.location === undefined ? {} : { location: { displayName: change.location } }),
    ...(change.description === undefined ? {} : { body: { contentType: 'text', content: change.description } }),
    ...(change.attendees === undefined ? {} : { attendees: graphAttendees(change.attendees) }),
  };
  await authedWrite(fetchImpl, 'microsoft', {
    url: `${BASE}/me/events/${encodeURIComponent(eventId)}`,
    method: 'PATCH',
    token,
    operation: 'create-event',
    body: payload,
    extraHeaders: { ...UTC_PREFER, ...(ifMatch === undefined ? {} : { 'If-Match': ifMatch }) },
  }, options);
}

/** Remove an event (DELETE me/events/{id}); `ifMatch` as in {@link updateGraphEvent}. */
export async function deleteGraphEvent(
  fetchImpl: HttpFetch,
  token: string,
  eventId: string,
  ifMatch: string | undefined,
  options: CalendarRequestOptions = {},
): Promise<void> {
  await authedWrite(fetchImpl, 'microsoft', {
    url: `${BASE}/me/events/${encodeURIComponent(eventId)}`,
    method: 'DELETE',
    token,
    operation: 'create-event',
    ...(ifMatch === undefined ? {} : { extraHeaders: { 'If-Match': ifMatch } }),
  }, options);
}
