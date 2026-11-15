/**
 * microsoft-graph-api.ts, the Microsoft Graph client over an access token and the
 * injected HttpFetch. Lists calendars (me/calendars), lists events over a window
 * (me/calendars/{id}/calendarView, which returns expanded instances), and creates
 * events (me/calendars/{id}/events). A Prefer: outlook.timezone="UTC" header makes
 * Graph return UTC wall times so normalization is honest. Paging follows
 * @odata.nextLink; failures are named degraded states via CalendarApiError.
 */

import { authedRequest, CalendarApiError } from './calendar-api-shared.js';
import { normalizeGraphEvent } from './merged-calendar-model.js';
import type { EventDateTime } from './types.js';
import type { CalendarRequestOptions, HttpFetch, MergedCalendarEvent, NewCalendarEvent, ProviderCalendar } from './oauth-types.js';

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
    const body = (await authedRequest(fetchImpl, 'microsoft', { url: next, method: 'GET', token }, options)) as {
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
  const first = new URL(`${BASE}/me/calendars/${encodeURIComponent(query.calendarId)}/calendarView`);
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

/** Create an event; returns it normalized into the merged model. */
export async function createGraphEvent(
  fetchImpl: HttpFetch,
  token: string,
  calendarId: string,
  calendarLabel: string,
  event: NewCalendarEvent,
  options: CalendarRequestOptions = {},
): Promise<MergedCalendarEvent> {
  const isAllDay = event.start.kind === 'date';
  const payload: Record<string, unknown> = {
    subject: event.summary,
    isAllDay,
    start: graphEventDate(event.start),
    end: graphEventDate(event.end ?? event.start),
    ...(event.location ? { location: { displayName: event.location } } : {}),
    ...(event.description ? { body: { contentType: 'text', content: event.description } } : {}),
  };
  const url = `${BASE}/me/calendars/${encodeURIComponent(calendarId)}/events`;
  const created = await authedRequest(fetchImpl, 'microsoft', {
    url,
    method: 'POST',
    token,
    body: payload,
    extraHeaders: UTC_PREFER,
  }, options);
  const normalized = normalizeGraphEvent(created, calendarId, calendarLabel);
  if (!normalized) throw new Error('Microsoft Graph accepted the event but returned an unreadable body.');
  return normalized;
}

/** Map an EventDateTime to a Graph {dateTime,timeZone} object. */
function graphEventDate(dt: EventDateTime): { dateTime: string; timeZone: string } {
  if (dt.kind === 'date') return { dateTime: `${dt.value}T00:00:00`, timeZone: 'UTC' };
  if (dt.zone === 'tzid' && dt.tzid) return { dateTime: stripZ(dt.value), timeZone: dt.tzid };
  return { dateTime: stripZ(dt.value), timeZone: 'UTC' };
}

function stripZ(value: string): string {
  return value.endsWith('Z') ? value.slice(0, -1) : value;
}
