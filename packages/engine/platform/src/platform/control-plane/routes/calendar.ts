/**
 * routes/calendar.ts, the daemon actually serving `calendar.events.*` and
 * `calendar.ics.*`.
 *
 * These five methods shipped cataloged with `invokable: false` for one
 * reason: the connector that could satisfy them lived inside a single product,
 * so the daemon had nothing to call. A caller who trusted the advertisement
 * and hit `GET /api/calendar/events` got a 404, and scheduled work, triggers
 * and channel-driven work could not read or write a calendar at all with no
 * product process attached.
 *
 * The connector is now platform capability (`platform/google`), so this module
 * is the thin part: it maps the descriptors' declared input and output shapes
 * onto a narrow service slice and nothing else. It performs no I/O, holds no
 * credential, and knows nothing about Google, a CalDAV-backed or Microsoft
 * Graph-backed implementation of `CalendarGatewayService` would serve the same
 * verbs unchanged.
 *
 * Two things are deliberate:
 *
 *  - **`confirm: true` is enforced here, not only advertised.** `events.create`,
 *    `events.update`, `events.delete` and `ics.import` write to a real calendar.
 *    The descriptors mark them `dangerous`/`admin` and require `confirm` in their
 *    input schema; this module refuses without it as well, so the guarantee does
 *    not depend on schema validation being reached by every transport.
 *  - **A failure carries its own fix.** The connector answers with
 *    `{ problem, fix }` rather than an exception, and both survive into the
 *    error a caller sees, because "Google refused the request because the
 *    credential lacks the required permission" plus "re-authorize with the
 *    needed scope" is actionable where a bare 500 is not.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { refuseNonUserRequest } from './explicit-user-request.js';
import { readInvocationParams, requireStringValue } from './invocation-params.js';
import { attachHandler } from './attach-handler.js';

/** One event, in the shape `calendar.events.list` advertises. */
export interface CalendarGatewayEventSummary {
  readonly id: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  /** True for a date-only event; `start`/`end` are then calendar dates, not instants. */
  readonly allDay?: boolean;
  readonly location?: string;
  readonly description?: string;
  readonly attendees?: readonly string[];
}

/** One event, in the shape `calendar.events.get` advertises. */
export interface CalendarGatewayEventDetail extends CalendarGatewayEventSummary {
  readonly uid?: string;
  readonly recurrence?: string;
}

export interface CalendarGatewayListInput {
  readonly calendarId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly limit?: number | undefined;
}

/** One bounded read of the calendar: the events returned, and whether the window holds more than the limit allowed. */
export interface CalendarGatewayEventPage {
  readonly events: readonly CalendarGatewayEventSummary[];
  readonly more: boolean;
}

export interface CalendarGatewayCreateInput {
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly description?: string | undefined;
  readonly location?: string | undefined;
  readonly attendees?: readonly string[] | undefined;
  readonly calendarId?: string | undefined;
}

/** The fields `calendar.events.update` changes; a field left out keeps its current value. */
export interface CalendarGatewayUpdateInput {
  readonly title?: string | undefined;
  readonly start?: string | undefined;
  readonly end?: string | undefined;
  readonly description?: string | undefined;
  readonly location?: string | undefined;
  readonly attendees?: readonly string[] | undefined;
}

export interface CalendarGatewayUpdated {
  readonly eventId: string;
  readonly updatedAt: string;
}

export interface CalendarGatewayDeleted {
  readonly eventId: string;
  readonly deleted: boolean;
}

export interface CalendarGatewayCreated {
  readonly eventId: string;
  readonly uid: string;
  readonly createdAt: string;
}

export interface CalendarGatewayIcsExport {
  readonly icsContent: string;
  /** The number of events in `icsContent`. */
  readonly eventCount: number;
  /** True when the export stopped at a `limit` and the calendar holds further events in the window. */
  readonly more?: boolean;
}

/** One calendar collection a backend can reach, for a setup flow to offer. */
export interface CalendarGatewayCalendarSummary {
  readonly calendarId: string;
  readonly displayName: string;
}

/** Guests an imported event named that were not added to it. */
export interface CalendarGatewayIcsAttendeesLeftOff {
  readonly eventId: string;
  readonly title: string;
  readonly attendees: readonly string[];
  /** How to invite them. */
  readonly next: string;
}

export interface CalendarGatewayIcsImport {
  readonly imported: number;
  readonly eventIds: readonly string[];
  readonly errors: readonly string[];
  /** Present when an imported event named attendees; an import never adds guests itself. */
  readonly attendeesLeftOff?: readonly CalendarGatewayIcsAttendeesLeftOff[];
}

/**
 * What a calendar backend must be able to do to serve these verbs.
 *
 * Every method reports failure by throwing `GatewayVerbError` with an honest
 * status, a missing scope is a 403, an unknown event id a 404, an
 * unconfigured account a 400 naming what to configure. Nothing here returns a
 * plausible empty result in place of an error.
 */
export interface CalendarGatewayService {
  listEvents(input: CalendarGatewayListInput): Promise<CalendarGatewayEventPage>;
  getEvent(eventId: string, calendarId?: string | undefined): Promise<CalendarGatewayEventDetail>;
  createEvent(input: CalendarGatewayCreateInput): Promise<CalendarGatewayCreated>;
  /**
   * Change an event the calendar holds; an unknown id is a 404. Optional: a
   * backend without it answers the verb with a 501 that says so.
   */
  updateEvent?(eventId: string, changes: CalendarGatewayUpdateInput, calendarId?: string | undefined): Promise<CalendarGatewayUpdated>;
  /** Remove an event; `deleted: false` when the calendar no longer held it. Optional, as `updateEvent`. */
  deleteEvent?(eventId: string, calendarId?: string | undefined): Promise<CalendarGatewayDeleted>;
  exportIcs(input: CalendarGatewayListInput): Promise<CalendarGatewayIcsExport>;
  /**
   * The calendars the configured account can reach, so setup can offer them
   * instead of asking for a collection path. Optional: a backend that cannot
   * discover calendars leaves it out and the verb says so.
   */
  listCalendars?(): Promise<readonly CalendarGatewayCalendarSummary[]>;
  /** Stores each event of the file; an event already on the calendar is kept unless `replace` is true. */
  importIcs(
    icsContent: string,
    calendarId?: string | undefined,
    options?: { readonly replace?: boolean | undefined },
  ): Promise<CalendarGatewayIcsImport>;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return undefined;
  return Math.trunc(parsed);
}

function readOptionalStringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  return entries.length > 0 ? entries : undefined;
}

/**
 * A write verb without `confirm: true` is refused before the backend is
 * touched. See the module header for why this is not left to schema
 * validation alone.
 */
function requireConfirmation(params: Record<string, unknown>, action: string): void {
  if (params.confirm !== true) {
    throw new GatewayVerbError(
      `${action} writes to a real calendar. Re-issue with confirm: true once the change has been reviewed.`,
      'CONFIRMATION_REQUIRED',
      400,
    );
  }
}

function listInputFrom(params: Record<string, unknown>): CalendarGatewayListInput {
  return {
    calendarId: readOptionalString(params.calendarId),
    from: readOptionalString(params.from),
    to: readOptionalString(params.to),
    limit: readOptionalNumber(params.limit),
  };
}

export function createCalendarEventsListHandler(service: CalendarGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const { events, more } = await service.listEvents(listInputFrom(readInvocationParams(invocation)));
    return { events, more };
  };
}

export function createCalendarEventsGetHandler(service: CalendarGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const eventId = requireStringValue(params.eventId, 'eventId');
    return service.getEvent(eventId, readOptionalString(params.calendarId));
  };
}

export function createCalendarEventsCreateHandler(service: CalendarGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    requireConfirmation(params, 'calendar.events.create');
    refuseNonUserRequest(invocation, 'calendar.events.create');
    return service.createEvent({
      title: requireStringValue(params.title, 'title'),
      start: requireStringValue(params.start, 'start'),
      end: requireStringValue(params.end, 'end'),
      description: readOptionalString(params.description),
      location: readOptionalString(params.location),
      attendees: readOptionalStringList(params.attendees),
      calendarId: readOptionalString(params.calendarId),
    });
  };
}

function unsupportedWrite(action: string): GatewayVerbError {
  return new GatewayVerbError(
    `The configured calendar backend cannot ${action} events yet. Change the event in the calendar's own application.`,
    'CALENDAR_NOT_SUPPORTED',
    501,
  );
}

export function createCalendarEventsUpdateHandler(service: CalendarGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const eventId = requireStringValue(params.eventId, 'eventId');
    requireConfirmation(params, 'calendar.events.update');
    refuseNonUserRequest(invocation, 'calendar.events.update');
    const changes: CalendarGatewayUpdateInput = {
      title: readOptionalString(params.title),
      start: readOptionalString(params.start),
      end: readOptionalString(params.end),
      description: typeof params.description === 'string' ? params.description : undefined,
      location: typeof params.location === 'string' ? params.location : undefined,
      attendees: Array.isArray(params.attendees) ? readOptionalStringList(params.attendees) ?? [] : undefined,
    };
    if (Object.values(changes).every((value) => value === undefined)) {
      throw new GatewayVerbError(
        'calendar.events.update names no field to change. Send at least one of title, start, end, description, location or attendees.',
        'INVALID_ARGUMENT',
        400,
      );
    }
    if (service.updateEvent === undefined) throw unsupportedWrite('update');
    return service.updateEvent(eventId, changes, readOptionalString(params.calendarId));
  };
}

export function createCalendarEventsDeleteHandler(service: CalendarGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const eventId = requireStringValue(params.eventId, 'eventId');
    requireConfirmation(params, 'calendar.events.delete');
    refuseNonUserRequest(invocation, 'calendar.events.delete');
    if (service.deleteEvent === undefined) throw unsupportedWrite('delete');
    return service.deleteEvent(eventId, readOptionalString(params.calendarId));
  };
}

export function createCalendarCalendarsListHandler(service: CalendarGatewayService): GatewayMethodHandler {
  return async () => {
    if (service.listCalendars === undefined) {
      throw new GatewayVerbError(
        'The configured calendar backend cannot list its calendars. Set surfaces.calendar.defaultCalendarId to the calendar to use.',
        'CALENDAR_NOT_SUPPORTED',
        501,
      );
    }
    return { calendars: await service.listCalendars() };
  };
}

export function createCalendarIcsExportHandler(service: CalendarGatewayService): GatewayMethodHandler {
  return async (invocation) => service.exportIcs(listInputFrom(readInvocationParams(invocation)));
}

export function createCalendarIcsImportHandler(service: CalendarGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    requireConfirmation(params, 'calendar.ics.import');
    refuseNonUserRequest(invocation, 'calendar.ics.import');
    return service.importIcs(
      requireStringValue(params.icsContent, 'icsContent'),
      readOptionalString(params.calendarId),
      { replace: params.replace === true },
    );
  };
}

/** Attach the calendar handlers to their registered descriptors (missing = no-op). */
export function registerCalendarGatewayMethods(
  catalog: GatewayMethodCatalog,
  service: CalendarGatewayService,
): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => { attachHandler(catalog, id, handler); };
  attach('calendar.events.list', createCalendarEventsListHandler(service));
  attach('calendar.events.get', createCalendarEventsGetHandler(service));
  attach('calendar.events.create', createCalendarEventsCreateHandler(service));
  attach('calendar.events.update', createCalendarEventsUpdateHandler(service));
  attach('calendar.events.delete', createCalendarEventsDeleteHandler(service));
  attach('calendar.calendars.list', createCalendarCalendarsListHandler(service));
  attach('calendar.ics.export', createCalendarIcsExportHandler(service));
  attach('calendar.ics.import', createCalendarIcsImportHandler(service));
}
