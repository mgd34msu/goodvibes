/**
 * microsoft-gateway-service.ts, the daemon's calendar verbs over a Microsoft
 * Outlook account (Microsoft Graph).
 *
 * The connection has one owner: the token record `/calendar connect outlook`
 * writes under `calendar.microsoft.tokens`, read and refreshed through the same
 * `CalendarTokenStore` the Agent's `/calendar` uses, with the client id the
 * person set in `calendar.microsoft.clientId`. Nothing here connects an account
 * or keeps a second copy of a token; it serves the account that is on record.
 *
 * Every id this service hands out starts with {@link OUTLOOK_ID_PREFIX}, events
 * and calendars alike, so the daemon's calendar can serve Outlook beside a
 * CalDAV server or a Google account and route each call by the id it carries.
 *
 * Failures are `GatewayVerbError`s with the same codes the Google service uses:
 * a refused or expired grant is 424 CALENDAR_AUTH_FAILED, a missing scope 403,
 * an unknown id 404, a limit 429, no answer 502.
 */
import { GatewayVerbError } from '../control-plane/routes/gateway-verb-error.js';
import type {
  CalendarGatewayCalendarSummary,
  CalendarGatewayCreateInput,
  CalendarGatewayCreated,
  CalendarGatewayDeleted,
  CalendarGatewayEventDetail,
  CalendarGatewayEventSummary,
  CalendarGatewayIcsExport,
  CalendarGatewayListInput,
  CalendarGatewayService,
  CalendarGatewayUpdateInput,
  CalendarGatewayUpdated,
} from '../control-plane/routes/calendar.js';
import { CalendarApiError } from './calendar-api-shared.js';
import { normalizeOffsetDateTime } from './merged-calendar-model.js';
import {
  createGraphEvent,
  deleteGraphEvent,
  getGraphEvent,
  listGraphCalendars,
  listGraphEvents,
  updateGraphEvent,
  type GraphEventRead,
} from './microsoft-graph-api.js';
import { NewEventTimeError } from './new-event-times.js';
import { readCalendarClientOverrides, type CalendarConfigReader } from './oauth-client-config.js';
import { providerProfile, resolveClientConfig } from './oauth-providers.js';
import { CalendarTokenStore, TokenRefreshError } from './oauth-token-store.js';
import type { EventDateTime } from './types.js';
import type { HttpFetch, MergedCalendarEvent, ResolvedClientConfig, SecretStoreSlice } from './oauth-types.js';
import { recordCalendarEventIngest, type CalendarUntrustedIngestRecorder } from './untrusted-events.js';

/** The start of every event and calendar id this service hands out. */
export const OUTLOOK_ID_PREFIX = 'outlook:';

/** True when an event or calendar id names something in the Outlook account. */
export function isOutlookId(id: string | undefined): boolean {
  return id !== undefined && id.startsWith(OUTLOOK_ID_PREFIX);
}

/** Read with no window: from a day ago (a meeting that just started still shows) to this far ahead. */
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOOKAHEAD_MS = 90 * 24 * 60 * 60 * 1000;
/** Events in one page when no limit is given. */
const DEFAULT_LIMIT = 250;

const RECONNECT = 'Connect it again with /calendar connect outlook in the Agent.';

export interface MicrosoftCalendarGatewayServiceOptions {
  /** The daemon's secret store: where the token record is read, and a refreshed one written back. */
  readonly secrets: SecretStoreSlice;
  /** Settings: `calendar.microsoft.clientId` and its secret reference. */
  readonly config: CalendarConfigReader;
  readonly fetchImpl: HttpFetch;
  /** The owner's zone (IANA), for an all-day event's midnight. */
  readonly ownerZone: () => string;
  /** Records the text of an event somebody else organized, when a caller reads it. */
  readonly recordUntrustedIngest?: CalendarUntrustedIngestRecorder | undefined;
  readonly now?: (() => number) | undefined;
}

function strip(id: string): string {
  return id.startsWith(OUTLOOK_ID_PREFIX) ? id.slice(OUTLOOK_ID_PREFIX.length) : id;
}

/** The failure of a Graph or token call as the verb answers it. */
function verbError(error: unknown): unknown {
  if (error instanceof GatewayVerbError) return error;
  if (error instanceof TokenRefreshError) {
    return new GatewayVerbError(`Microsoft Outlook: ${error.message} ${RECONNECT}`, 'CALENDAR_AUTH_FAILED', 424);
  }
  if (error instanceof NewEventTimeError) return new GatewayVerbError(error.message, 'INVALID_ARGUMENT', 400);
  if (!(error instanceof CalendarApiError)) return error;
  const state = error.degraded;
  switch (state.kind) {
    case 'reconnect-needed':
      return new GatewayVerbError(state.detail, 'CALENDAR_AUTH_FAILED', 424);
    case 'insufficient-scope':
      return new GatewayVerbError(state.detail, 'PERMISSION_DENIED', 403);
    case 'rate-limited':
      return new GatewayVerbError(state.detail, 'RATE_LIMITED', 429);
    case 'network-error':
      return new GatewayVerbError(state.detail, 'CALENDAR_REQUEST_FAILED', 502);
    case 'provider-error':
      if (state.status === 404) return new GatewayVerbError(state.detail, 'NOT_FOUND', 404);
      if (state.status === 412) return new GatewayVerbError('The event changed in Outlook after it was read, so nothing was written. Read it again and repeat the change.', 'CALENDAR_EVENT_CHANGED', 409);
      return new GatewayVerbError(state.detail, 'CALENDAR_REQUEST_FAILED', state.status >= 500 ? 502 : 400);
  }
}

/** An ISO value a caller sent as the shape a new Graph event is made from. */
function eventTime(value: string): EventDateTime {
  if (!value.includes('T')) return { value, kind: 'date', zone: 'floating' };
  return normalizeOffsetDateTime(value);
}

function toSummary(event: MergedCalendarEvent, attendees?: readonly string[]): CalendarGatewayEventSummary {
  const id = event.sourceEventId ?? event.uid;
  return {
    id: `${OUTLOOK_ID_PREFIX}${id}`,
    // Every occurrence of a series carries the series' iCalendar UID: a list counts it once.
    seriesId: `${OUTLOOK_ID_PREFIX}${event.uid}`,
    title: event.summary,
    start: event.start.value,
    end: event.end?.value ?? event.start.value,
    allDay: event.start.kind === 'date',
    ...(event.location ? { location: event.location } : {}),
    ...(event.description ? { description: event.description } : {}),
    ...(attendees && attendees.length > 0 ? { attendees } : {}),
  };
}

/** One event per line of an iCalendar file (RFC 5545 TEXT escaping). */
function escapeIcsText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function icsStamp(value: string): string {
  if (!value.includes('T')) return `;VALUE=DATE:${value.replace(/-/g, '')}`;
  const parsed = Date.parse(value);
  return `:${Number.isFinite(parsed) ? new Date(parsed).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z') : value}`;
}

/** The VEVENT lines of a set of events, for an export. */
export function outlookIcsEvents(events: readonly MergedCalendarEvent[], stampMs: number): string[] {
  const stamp = new Date(stampMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const lines: string[] = [];
  for (const event of events) {
    lines.push('BEGIN:VEVENT', `UID:${event.uid}`, `DTSTAMP:${stamp}`, `DTSTART${icsStamp(event.start.value)}`);
    if (event.end) lines.push(`DTEND${icsStamp(event.end.value)}`);
    lines.push(`SUMMARY:${escapeIcsText(event.summary)}`);
    if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
    if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
    lines.push('END:VEVENT');
  }
  return lines;
}

export function createMicrosoftCalendarGatewayService(options: MicrosoftCalendarGatewayServiceOptions): CalendarGatewayService {
  const now = options.now ?? ((): number => Date.now());
  // One store for the daemon: concurrent calls share one token refresh.
  const store = new CalendarTokenStore({ secrets: options.secrets, clock: now });

  /** The client the account signed in with, and a usable access token. */
  async function connect(): Promise<{ readonly config: ResolvedClientConfig; readonly token: string; readonly label: string }> {
    const account = await store.loadAccount('microsoft');
    if (!account) {
      throw new GatewayVerbError('No Microsoft Outlook account is connected. Connect one with /calendar connect outlook in the Agent.', 'CALENDAR_NOT_CONFIGURED', 400);
    }
    const profile = providerProfile('microsoft');
    const config = resolveClientConfig(profile, await readCalendarClientOverrides(profile, {
      config: options.config,
      secretGet: (key) => options.secrets.get(key),
    }));
    if (!config.isConfigured) {
      throw new GatewayVerbError(
        `Microsoft Outlook: ${account.label} is connected, but the client id of the app it signed in with is not set (calendar.microsoft.clientId), so it cannot be used.`,
        'CALENDAR_NOT_CONFIGURED',
        400,
      );
    }
    const token = await store.getFreshAccessToken('microsoft', config, options.fetchImpl);
    return { config, token, label: account.label };
  }

  function recordRead(label: string, events: readonly MergedCalendarEvent[]): void {
    recordCalendarEventIngest({
      record: options.recordUntrustedIngest,
      provenance: { kind: 'provider', provider: 'microsoft', calendarLabel: label },
      events,
      at: new Date(now()).toISOString(),
    });
  }

  async function guarded<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw verbError(error);
    }
  }

  /** Every event of the window, on the calendar named or the account's default calendar. */
  async function readWindow(input: CalendarGatewayListInput): Promise<MergedCalendarEvent[]> {
    const { token, label } = await connect();
    const from = input.from ?? new Date(now() - DEFAULT_LOOKBACK_MS).toISOString();
    const to = input.to ?? new Date(Date.parse(from) + DEFAULT_LOOKAHEAD_MS).toISOString();
    const events = await listGraphEvents(options.fetchImpl, token, {
      calendarId: input.calendarId === undefined ? '' : strip(input.calendarId),
      calendarLabel: label,
      start: from,
      end: to,
    });
    recordRead(label, events);
    return events;
  }

  /** The event as Graph holds it now; refuses a recurring series (a change through it would reach every occurrence). */
  async function readForChange(eventId: string, token: string, label: string, action: string): Promise<GraphEventRead> {
    const current = await getGraphEvent(options.fetchImpl, token, strip(eventId), label);
    if (current.type === 'seriesMaster') {
      throw new GatewayVerbError(
        `Event ${eventId} is a recurring series, so ${action} it here would change every occurrence. Change one occurrence by the id calendar.events.list gives it, or change the series in Outlook.`,
        'CALENDAR_SERIES_NOT_SUPPORTED',
        409,
      );
    }
    return current;
  }

  return {
    listEvents: (input) => guarded(async () => {
      const limit = input.limit ?? DEFAULT_LIMIT;
      const events = await readWindow(input);
      return { events: events.slice(0, limit).map((event) => toSummary(event)), more: events.length > limit };
    }),

    getEvent: (eventId) => guarded(async (): Promise<CalendarGatewayEventDetail> => {
      const { token, label } = await connect();
      const read = await getGraphEvent(options.fetchImpl, token, strip(eventId), label);
      if (!read.event) {
        return { id: eventId, title: '', start: '', end: '', cancelled: true, ...(read.changeKey ? { revision: read.changeKey } : {}) };
      }
      recordRead(label, [read.event]);
      return {
        ...toSummary(read.event, read.attendees),
        id: eventId,
        uid: read.event.uid,
        ...(read.changeKey ? { revision: read.changeKey } : {}),
      };
    }),

    createEvent: (input: CalendarGatewayCreateInput) => guarded(async (): Promise<CalendarGatewayCreated> => {
      const { token, label } = await connect();
      const startMs = Date.parse(input.start);
      const endMs = Date.parse(input.end);
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs < startMs) {
        throw new GatewayVerbError("Field 'end' must not be before 'start'.", 'INVALID_ARGUMENT', 400);
      }
      const result = await createGraphEvent(
        options.fetchImpl,
        token,
        input.calendarId === undefined ? '' : strip(input.calendarId),
        label,
        {
          summary: input.title,
          start: eventTime(input.start),
          end: eventTime(input.end),
          ...(input.location === undefined ? {} : { location: input.location }),
          ...(input.description === undefined ? {} : { description: input.description }),
        },
        options.ownerZone(),
        {},
        input.attendees ?? [],
      );
      const createdAt = new Date(now()).toISOString();
      if (result.kind === 'created') {
        const id = result.event.sourceEventId ?? result.event.uid;
        return { eventId: `${OUTLOOK_ID_PREFIX}${id}`, uid: input.uid ?? result.event.uid, createdAt };
      }
      const id = result.providerEventId ?? '';
      return { eventId: id ? `${OUTLOOK_ID_PREFIX}${id}` : '', uid: input.uid ?? id, createdAt };
    }),

    updateEvent: (eventId: string, changes: CalendarGatewayUpdateInput) => guarded(async (): Promise<CalendarGatewayUpdated> => {
      const { token, label } = await connect();
      const current = await readForChange(eventId, token, label, 'changing');
      if (changes.expectedRevision !== undefined && current.changeKey !== undefined && current.changeKey !== changes.expectedRevision) {
        throw new GatewayVerbError(`Event ${eventId} changed in Outlook after it was read, so nothing was written. Read it again and repeat the change.`, 'CALENDAR_EVENT_CHANGED', 409);
      }
      const timesChanged = changes.start !== undefined || changes.end !== undefined;
      const start = changes.start ?? current.event?.start.value ?? '';
      const end = changes.end ?? current.event?.end?.value ?? start;
      if (timesChanged) {
        if (start.includes('T') !== end.includes('T')) {
          throw new GatewayVerbError("Fields 'start' and 'end' must both be dates (an all-day event) or both date-times.", 'INVALID_ARGUMENT', 400);
        }
        if (Date.parse(end) < Date.parse(start)) throw new GatewayVerbError("Field 'end' must not be before 'start'.", 'INVALID_ARGUMENT', 400);
      }
      await updateGraphEvent(options.fetchImpl, token, strip(eventId), {
        ...(changes.title === undefined ? {} : { subject: changes.title }),
        ...(timesChanged ? { start, end } : {}),
        ...(changes.location === undefined ? {} : { location: changes.location }),
        ...(changes.description === undefined ? {} : { description: changes.description }),
        ...(changes.attendees === undefined ? {} : { attendees: changes.attendees }),
      }, options.ownerZone(), current.etag);
      return { eventId, updatedAt: new Date(now()).toISOString() };
    }),

    deleteEvent: (eventId: string) => guarded(async (): Promise<CalendarGatewayDeleted> => {
      const { token, label } = await connect();
      let current: GraphEventRead;
      try {
        current = await readForChange(eventId, token, label, 'removing');
      } catch (error) {
        if (error instanceof CalendarApiError && error.degraded.kind === 'provider-error' && (error.degraded.status === 404 || error.degraded.status === 410)) {
          return { eventId, deleted: false };
        }
        throw error;
      }
      if (!current.event) return { eventId, deleted: false };
      await deleteGraphEvent(options.fetchImpl, token, strip(eventId), current.etag);
      return { eventId, deleted: true };
    }),

    listCalendars: () => guarded(async (): Promise<readonly CalendarGatewayCalendarSummary[]> => {
      const { token } = await connect();
      const calendars = await listGraphCalendars(options.fetchImpl, token);
      return calendars.map((calendar) => ({ calendarId: `${OUTLOOK_ID_PREFIX}${calendar.id}`, displayName: `${calendar.name} (Outlook)` }));
    }),

    exportIcs: (input) => guarded(async (): Promise<CalendarGatewayIcsExport> => {
      const events = await readWindow(input);
      const shown = input.limit === undefined ? events : events.slice(0, input.limit);
      const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//GoodVibes//Calendar Export//EN', 'CALSCALE:GREGORIAN', ...outlookIcsEvents(shown, now()), 'END:VCALENDAR'];
      return { icsContent: `${lines.join('\r\n')}\r\n`, eventCount: shown.length, ...(shown.length < events.length ? { more: true } : {}) };
    }),

    importIcs: () => Promise.reject(new GatewayVerbError(
      'Importing an .ics file into a Microsoft Outlook calendar is not done here: import it in Outlook, or choose another calendar to import into.',
      'CALENDAR_NOT_SUPPORTED',
      501,
    )),
  };
}
