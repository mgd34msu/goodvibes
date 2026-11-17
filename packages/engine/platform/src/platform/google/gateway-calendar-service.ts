/**
 * The Google-backed implementation of the daemon's `calendar.*` verbs.
 *
 * This is the piece that was missing. `calendar.events.list`,
 * `calendar.events.get`, `calendar.events.create`, `calendar.ics.export` and
 * `calendar.ics.import` were cataloged with `invokable: false` because no
 * daemon-reachable implementation existed, the connector lived inside one
 * product. This adapts the hoisted connector onto the service slice the verb
 * handlers are written against, so the daemon serves them for real, with no
 * product process attached. It also serves `calendar.events.update`,
 * `calendar.events.delete` and `calendar.calendars.list`, so a Google calendar
 * can be corrected and chosen from the same places a CalDAV one can.
 *
 * Credentials come from the daemon's own tier by the platform-wide derivation
 * (`daemonSecretKeyFor`), which is exactly why `setup-plan.ts` derives its
 * secret names the same way: a hand-written name would sit outside daemon
 * ownership and fail to follow a node handover, and the symptom would be
 * calendar going quiet on the node that took over with nothing in the logs to
 * explain it.
 *
 * Every failure the connector reports carries a `problem` and a `fix`, and both
 * survive into the `GatewayVerbError` a caller sees. A missing scope answers
 * "the credential lacks the required permission, re-authorize with the needed
 * scope", not a bare 500.
 */

import { GatewayVerbError } from '../control-plane/routes/gateway-verb-error.js';
import type {
  CalendarGatewayCalendarSummary,
  CalendarGatewayCreateInput,
  CalendarGatewayCreated,
  CalendarGatewayDeleted,
  CalendarGatewayEventDetail,
  CalendarGatewayEventSummary,
  CalendarGatewayIcsAttendeesLeftOff,
  CalendarGatewayIcsExport,
  CalendarGatewayIcsImport,
  CalendarGatewayListInput,
  CalendarGatewayService,
  CalendarGatewayUpdateInput,
  CalendarGatewayUpdated,
} from '../control-plane/routes/calendar.js';
import { parseIcs } from '../calendar/ics-parser.js';
import {
  recordCalendarEventIngest,
  type CalendarUntrustedIngestRecorder,
} from '../calendar/untrusted-events.js';
import type { CalendarEvent, EventDateTime } from '../calendar/types.js';
import type { GoogleApiFailure, GoogleApiResult, CalendarEventRecord } from './api-client.js';
import type { GoogleConnection, GoogleConnectionSources } from './connection.js';
import { GoogleConnectionOwner } from './connection-owner.js';
import type { GoogleFetchPort } from './oauth-loopback.js';
import type { GoogleApiFetchPort } from './api-client.js';
import { grantsCalendarWrite } from './credential-adoption.js';

/** Everything the service needs, all of it injected. */
export interface GoogleCalendarGatewayServiceOptions {
  readonly sources: GoogleConnectionSources;
  readonly fetch: GoogleFetchPort & GoogleApiFetchPort;
  /**
   * The process's Google connection, when the composition holds one to share
   * (and to run the start-up check on). Absent, the service holds its own.
   */
  readonly connectionOwner?: GoogleConnectionOwner | undefined;
  /** Wall clock, injected so `createdAt` is deterministic under test. */
  readonly now?: () => number;
  /**
   * Records that a turn read untrusted event content.
   *
   * An event whose organizer is somebody other than the owner was written by
   * that somebody, and reading it is the same exposure as reading their mail.
   * Recorded from the READ paths, `listEvents`, `getEvent`, `exportIcs` and
   * `importIcs`, each of which runs because a caller asked. An event Google
   * says the owner organized (`organizer.self`) records nothing: the owner wrote it.
   * See calendar/untrusted-events.ts.
   */
  readonly recordUntrustedIngest?: CalendarUntrustedIngestRecorder | undefined;
}

const NOT_CONNECTED = [
  'No Google account is connected on this machine, so there is no calendar to read or write.',
  'Connect one, then retry.',
].join(' ');

/**
 * The id of a recurring event's series names every occurrence, so a change or
 * removal through it would reach them all. One occurrence, as `events.list`
 * hands it out, has its own id and is changed or removed alone.
 */
function refuseSeries(eventId: string, action: string): GatewayVerbError {
  return new GatewayVerbError(
    `Event ${eventId} is a recurring series, so ${action} it here would change every occurrence. Change one occurrence by the id calendar.events.list gives it, or change the series in Google Calendar.`,
    'CALENDAR_SERIES_NOT_SUPPORTED',
    409,
  );
}

/** A write Google refused (412) because the event changed after it was read. */
function changedMeanwhile(eventId: string): GatewayVerbError {
  return new GatewayVerbError(
    `Event ${eventId} changed on the calendar after it was read, so nothing was written. Read it again and repeat the change.`,
    'CALENDAR_EVENT_CHANGED',
    409,
  );
}

/** Both dates (an all-day event) or both date-times, and the end not before the start. */
function validateEventTimes(start: string, end: string): void {
  if (start.includes('T') !== end.includes('T')) {
    throw new GatewayVerbError(
      "Fields 'start' and 'end' must both be dates (an all-day event) or both date-times. Send both to turn an all-day event into a timed one or back.",
      'INVALID_ARGUMENT',
      400,
    );
  }
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new GatewayVerbError("Fields 'start' and 'end' must be ISO 8601 dates or date-times.", 'INVALID_ARGUMENT', 400);
  }
  if (endMs < startMs) throw new GatewayVerbError("Field 'end' must not be before 'start'.", 'INVALID_ARGUMENT', 400);
}

/**
 * Turn a connector failure into an honest HTTP status.
 *
 * The connector already distinguishes "the credential is not permitted to do
 * this" from "the account is being rate limited" from "that id does not
 * exist"; collapsing all three into 500 would throw that away.
 */
function statusFor(failure: GoogleApiFailure): number {
  // A dead grant carries no HTTP status of its own (the refusal came from the
  // token refresh, not the calendar call), so the status is stated here: 401,
  // the same status the CalDAV service reports CALENDAR_AUTH_FAILED under.
  if (failure.reason === 'grant-invalid') return 401;
  // A usage limit Google reports as a 403 is still a limit: wait and retry.
  if (failure.reason === 'rate-limited') return 429;
  if (failure.status === 401) return 401;
  if (failure.status === 403) return 403;
  if (failure.status === 404) return 404;
  if (failure.status === 429) return 429;
  // No answer from Google at all (unreachable, or no token could be had) is
  // a gateway failure a caller may retry, not a bad request.
  if (failure.status === null) return failure.transport === undefined ? 400 : 502;
  return failure.status >= 500 ? 502 : 400;
}

function codeFor(failure: GoogleApiFailure): string {
  // An expired or revoked refresh token is an authentication failure a person
  // must act on, and the webui renders CALENDAR_AUTH_FAILED as a re-authorize
  // prompt. Mapped by the structured verdict, never by sniffing problem text.
  if (failure.reason === 'grant-invalid') return 'CALENDAR_AUTH_FAILED';
  if (failure.reason === 'rate-limited') return 'RATE_LIMITED';
  if (failure.status === 403) return 'PERMISSION_DENIED';
  if (failure.status === 404) return 'NOT_FOUND';
  if (failure.status === 429) return 'RATE_LIMITED';
  if (failure.status === 401) return 'UNAUTHENTICATED';
  return 'CALENDAR_REQUEST_FAILED';
}

function unwrap<T>(result: GoogleApiResult<T>): T {
  if (result.ok) return result.value;
  throw new GatewayVerbError(`${result.problem} ${result.fix}`, codeFor(result), statusFor(result));
}

function toSummary(record: CalendarEventRecord): CalendarGatewayEventSummary {
  return {
    id: record.id,
    title: record.summary,
    start: record.start,
    end: record.end,
    allDay: record.allDay,
    ...(record.location.length > 0 ? { location: record.location } : {}),
    ...(record.description.length > 0 ? { description: record.description } : {}),
    ...(record.attendees === undefined || record.attendees.length === 0 ? {} : { attendees: record.attendees }),
  };
}

function toDetail(record: CalendarEventRecord): CalendarGatewayEventDetail {
  // Google's event id IS the stable identifier a caller round-trips, so `uid`
  // reports the same value rather than inventing a second one that would then
  // disagree with what `events.list` handed back.
  return {
    ...toSummary(record),
    uid: record.id,
    ...(record.recurrence === undefined || record.recurrence.length === 0 ? {} : { recurrence: record.recurrence.join('\n') }),
  };
}

/**
 * Escape a value for an iCalendar TEXT property (RFC 5545 §3.3.11). Backslash
 * first, or the escapes this adds would themselves be escaped.
 */
function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** `2026-07-27T10:00:00Z` / `2026-07-27` -> the iCalendar wire forms. */
function toIcsStamp(value: string): { readonly property: string; readonly value: string } {
  if (!value.includes('T')) {
    return { property: ';VALUE=DATE', value: value.replace(/-/g, '') };
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return { property: '', value };
  return { property: '', value: new Date(parsed).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z') };
}

function renderIcs(events: readonly CalendarEventRecord[], stampMs: number): string {
  const stamp = new Date(stampMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const lines: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//GoodVibes//Calendar Export//EN', 'CALSCALE:GREGORIAN'];
  for (const event of events) {
    const start = toIcsStamp(event.start);
    const end = toIcsStamp(event.end);
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${event.id}`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART${start.property}:${start.value}`);
    if (end.value.length > 0) lines.push(`DTEND${end.property}:${end.value}`);
    lines.push(`SUMMARY:${escapeIcsText(event.summary)}`);
    if (event.location.length > 0) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
    if (event.description.length > 0) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * The zone Google needs beside a parsed .ics date-time, or the reason the
 * event cannot be created faithfully. A wall-clock time with no zone would be
 * guessed at, and a guessed time is a meeting at the wrong hour.
 */
function zoneFor(
  start: EventDateTime,
  end: EventDateTime,
  recurring: boolean,
): { readonly timeZone?: string; readonly refusal?: string } {
  if (start.kind === 'date' || end.kind === 'date') return {};
  if (start.zone === 'floating' || end.zone === 'floating') {
    return { refusal: 'its times have no time zone, so the hour cannot be placed' };
  }
  if (start.zone === 'tzid') {
    if (end.zone !== 'tzid' || end.tzid !== start.tzid) return { refusal: 'its start and end are in different time zones' };
    return start.tzid === undefined ? { refusal: 'its time zone is not named' } : { timeZone: start.tzid };
  }
  if (end.zone !== 'utc') return { refusal: 'its start and end are in different time zones' };
  // Google needs a zone on every recurring event, even for UTC times.
  return recurring ? { timeZone: 'UTC' } : {};
}

export function createGoogleCalendarGatewayService(
  options: GoogleCalendarGatewayServiceOptions,
): CalendarGatewayService {
  const now = options.now ?? ((): number => Date.now());
  const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

  /**
   * One held connection: calls share the access token and one refresh, and a
   * dead grant is latched instead of re-asked. The owner re-reads the stored
   * credential on each call and builds a new connection when it was replaced,
   * so a credential connected or revoked while the daemon runs is followed.
   */
  const owner = options.connectionOwner ?? new GoogleConnectionOwner({ sources: options.sources, fetch: options.fetch, now });
  async function connect(): Promise<GoogleConnection> {
    const connection = await owner.connection();
    if (connection === null) {
      throw new GatewayVerbError(NOT_CONNECTED, 'CALENDAR_NOT_CONFIGURED', 400);
    }
    return connection;
  }

  /**
   * Record that a caller just read these events.
   *
   * `organizerIsSelf` is Google's own read-only statement that the owner
   * organized the event; that and only that keeps an event out of the ledger.
   */
  function recordEventsRead(calendarId: string | undefined, events: readonly CalendarEventRecord[]): void {
    recordCalendarEventIngest({
      record: options.recordUntrustedIngest,
      provenance: {
        kind: 'provider',
        provider: 'google',
        ...(calendarId === undefined ? {} : { calendarLabel: calendarId }),
      },
      events: events.map((event) => ({
        summary: event.summary,
        location: event.location,
        description: event.description,
        organizer: event.organizer,
        organizerIsOwner: event.organizerIsSelf,
      })),
      at: new Date(now()).toISOString(),
    });
  }

  /**
   * One read of the calendar. `all` follows every page (export); otherwise one
   * page of `limit` is read and `more` says whether Google holds further events
   * in the window.
   */
  async function readEvents(
    input: CalendarGatewayListInput,
    all: boolean,
  ): Promise<{ readonly events: readonly CalendarEventRecord[]; readonly more: boolean }> {
    const { client } = await connect();
    const page = unwrap(
      await client.listEvents({
        ...(input.calendarId === undefined ? {} : { calendarId: input.calendarId }),
        ...(input.from === undefined ? {} : { timeMin: input.from }),
        ...(input.to === undefined ? {} : { timeMax: input.to }),
        ...(all || input.limit === undefined ? {} : { maxResults: input.limit }),
        ...(all ? { all: true } : {}),
      }),
    );
    recordEventsRead(input.calendarId, page.items);
    return { events: page.items, more: page.more };
  }

  /**
   * Refuses a write when the grant carries no calendar write scope. What the
   * grant permits is the scope list Google returned on the last token refresh
   * (credentials from the secret store record none until then), so a token is
   * obtained first. A refresh that fails decides nothing here: the write call
   * that follows reports that failure itself.
   */
  async function requireCalendarWrite(connection: GoogleConnection): Promise<void> {
    const token = await connection.tokens.accessToken();
    if (!token.ok) return;
    if (!grantsCalendarWrite(connection.tokens.scopes())) {
      throw new GatewayVerbError(
        'The connected Google account was not granted a scope that permits writing to the calendar. Re-authorize with the calendar.events scope.',
        'PERMISSION_DENIED',
        403,
      );
    }
  }

  return {
    async listEvents(input) {
      // With no window the answer is what is coming up, from a day ago so a
      // meeting that just started still shows. Export reads every page instead.
      const windowed = input.from === undefined && input.to === undefined
        ? { ...input, from: new Date(now() - DEFAULT_LOOKBACK_MS).toISOString() }
        : input;
      const { events, more } = await readEvents(windowed, false);
      return { events: events.map(toSummary), more };
    },

    async getEvent(eventId, calendarId) {
      const { client } = await connect();
      const record = unwrap(await client.getEvent(eventId, calendarId ?? 'primary'));
      recordEventsRead(calendarId, [record]);
      return toDetail(record);
    },

    async createEvent(input: CalendarGatewayCreateInput): Promise<CalendarGatewayCreated> {
      const connection = await connect();
      await requireCalendarWrite(connection);
      const { client } = connection;
      const startMs = Date.parse(input.start);
      const endMs = Date.parse(input.end);
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs < startMs) {
        throw new GatewayVerbError("Field 'end' must not be before 'start'.", 'INVALID_ARGUMENT', 400);
      }
      const created = unwrap(
        await client.createEvent({
          summary: input.title,
          start: input.start,
          end: input.end,
          // The route already required the owner's confirmation for this
          // call, with the attendee list in front of them.
          ...(input.attendees === undefined || input.attendees.length === 0
            ? {}
            : { attendees: input.attendees, notifyAttendees: true }),
          ...(input.location === undefined ? {} : { location: input.location }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.calendarId === undefined ? {} : { calendarId: input.calendarId }),
        }),
      );
      return { eventId: created.id, uid: created.id, createdAt: new Date(now()).toISOString() };
    },

    /**
     * Changes the fields sent. The event is read first for its etag, so a
     * change made elsewhere in the meantime is refused (409
     * CALENDAR_EVENT_CHANGED) instead of overwritten; guests are told when
     * the event has any, as the calendar's own application would.
     */
    async updateEvent(eventId: string, changes: CalendarGatewayUpdateInput, calendarId?: string | undefined): Promise<CalendarGatewayUpdated> {
      const connection = await connect();
      await requireCalendarWrite(connection);
      const { client } = connection;
      const calendar = calendarId ?? 'primary';
      const current = unwrap(await client.getEvent(eventId, calendar));
      if (current.recurrence !== undefined && current.recurrence.length > 0) throw refuseSeries(eventId, 'changing');
      const timesChanged = changes.start !== undefined || changes.end !== undefined;
      const start = changes.start ?? current.start;
      const end = changes.end ?? current.end;
      if (timesChanged) validateEventTimes(start, end);
      const guests = changes.attendees ?? current.attendees ?? [];
      const patched = await client.patchEvent(eventId, calendar, {
        ...(changes.title === undefined ? {} : { summary: changes.title }),
        ...(timesChanged ? { start, end } : {}),
        ...(changes.location === undefined ? {} : { location: changes.location }),
        ...(changes.description === undefined ? {} : { description: changes.description }),
        ...(changes.attendees === undefined ? {} : { attendees: changes.attendees }),
        ...(guests.length > 0 ? { notifyAttendees: true } : {}),
        ...(current.etag === undefined ? {} : { ifMatch: current.etag }),
      });
      if (!patched.ok && patched.status === 412) throw changedMeanwhile(eventId);
      return { eventId: unwrap(patched).id, updatedAt: new Date(now()).toISOString() };
    },

    /** Removes one event (or one occurrence); refused like `updateEvent` when it changed since it was read. */
    async deleteEvent(eventId: string, calendarId?: string | undefined): Promise<CalendarGatewayDeleted> {
      const connection = await connect();
      await requireCalendarWrite(connection);
      const { client } = connection;
      const calendar = calendarId ?? 'primary';
      const read = await client.getEvent(eventId, calendar);
      if (!read.ok && (read.status === 404 || read.status === 410)) return { eventId, deleted: false };
      const current = unwrap(read);
      if (current.recurrence !== undefined && current.recurrence.length > 0) throw refuseSeries(eventId, 'removing');
      const removed = await client.deleteEvent(eventId, calendar, {
        ...(current.etag === undefined ? {} : { ifMatch: current.etag }),
        ...((current.attendees?.length ?? 0) > 0 ? { notifyAttendees: true } : {}),
      });
      if (!removed.ok && removed.status === 412) throw changedMeanwhile(eventId);
      return { eventId, deleted: unwrap(removed).deleted };
    },

    /** The calendars in the account's calendar list, by the name the owner sees. */
    async listCalendars(): Promise<readonly CalendarGatewayCalendarSummary[]> {
      const { client } = await connect();
      return unwrap(await client.listCalendars()).map((entry) => ({
        calendarId: entry.id,
        displayName: entry.summary.length > 0 ? entry.summary : entry.id,
      }));
    },

    /**
     * Every event in the window, every page of it, so the file and its
     * `eventCount` are the whole calendar for that window. With a `limit` the
     * export stops at one page of that size and `more` says when it is partial.
     */
    async exportIcs(input): Promise<CalendarGatewayIcsExport> {
      const { events, more } = await readEvents(input, input.limit === undefined);
      return { icsContent: renderIcs(events, now()), eventCount: events.length, ...(more ? { more: true } : {}) };
    },

    /**
     * Import is per-event and reports partial success honestly: an .ics with
     * one bad VEVENT imports the rest and names the one it could not, rather
     * than failing the whole file or silently dropping it. An entry imported
     * before is skipped, or overwritten with `replace`.
     *
     * Attendees named in the file are not added. An event inserted with guests
     * appears on every guest's Google calendar organised by the owner, which
     * for a forwarded invitation is a duplicate meeting sent to people the
     * owner was never shown. The result lists who was left off, and inviting
     * them is `calendar.events.create`, which confirms with the list in view.
     */
    async importIcs(icsContent, calendarId, importOptions = {}): Promise<CalendarGatewayIcsImport> {
      const connection = await connect();
      await requireCalendarWrite(connection);
      const { client } = connection;
      const parsed = parseIcs(icsContent);
      // Somebody else's text, read because the caller asked for it to be
      // imported, recorded before anything is written to a real calendar.
      recordCalendarEventIngest({
        record: options.recordUntrustedIngest,
        provenance: { kind: 'ics-import' },
        events: parsed.events,
        at: new Date(now()).toISOString(),
      });
      const eventIds: string[] = [];
      const errors: string[] = [];
      const attendeesLeftOff: CalendarGatewayIcsAttendeesLeftOff[] = [];
      for (const diagnostic of parsed.skipped) {
        errors.push(`Skipped an event in the .ics: ${diagnostic.message}`);
      }
      for (const event of parsed.events as readonly CalendarEvent[]) {
        if (event.end === undefined) {
          errors.push(`"${event.summary || event.uid}" has no end time, so it was not imported.`);
          continue;
        }
        const label = `"${event.summary || event.uid}"`;
        if (event.isOverride === true) {
          errors.push(`${label} was not imported: it replaces a single occurrence of a recurring series (RECURRENCE-ID), which this import cannot apply.`);
          continue;
        }
        if (event.hasSeriesExceptions === true) {
          errors.push(`${label} was not imported: its recurrence would be sent without the parts that change it (${event.recurrence?.unsupportedReason ?? 'EXDATE, RDATE or RECURRENCE-ID'}), so excluded or extra dates would be wrong.`);
          continue;
        }
        const zone = zoneFor(event.start, event.end, event.recurrence !== undefined);
        if (zone.refusal !== undefined) {
          errors.push(`${label} was not imported: ${zone.refusal}.`);
          continue;
        }
        // Importing the same file twice must not double the calendar.
        const existing = await client.listEvents({
          ...(calendarId === undefined ? {} : { calendarId }),
          sourceUid: event.uid,
          maxResults: 1,
        });
        if (!existing.ok) {
          errors.push(`${label} was not imported because it could not be checked against events already imported: ${existing.problem} ${existing.fix}`);
          continue;
        }
        const already = existing.value.items[0];
        if (already !== undefined && importOptions.replace !== true) {
          errors.push(`${label} was skipped: an event imported from this .ics entry is already in the calendar. Import again with replace: true to overwrite it.`);
          continue;
        }
        if (already !== undefined) {
          // The file's version replaces the one imported earlier (the whole series when it recurs:
          // a lookup hands out occurrences); its guests are still not invited.
          const replaced = await client.patchEvent(already.recurringEventId ?? already.id, calendarId ?? 'primary', {
            summary: event.summary,
            start: event.start.value,
            end: event.end.value,
            location: event.location ?? '',
            description: event.description ?? '',
            ...(zone.timeZone === undefined ? {} : { timeZone: zone.timeZone }),
            recurrence: event.recurrence === undefined ? [] : [`RRULE:${event.recurrence.rule}`],
          });
          if (!replaced.ok) {
            errors.push(`${label} was not replaced: ${replaced.problem} ${replaced.fix}`);
            continue;
          }
          eventIds.push(replaced.value.id);
          continue;
        }
        const created = await client.createEvent({
          summary: event.summary,
          start: event.start.value,
          end: event.end.value,
          sourceUid: event.uid,
          ...(zone.timeZone === undefined ? {} : { timeZone: zone.timeZone }),
          ...(event.recurrence === undefined ? {} : { recurrence: [`RRULE:${event.recurrence.rule}`] }),
          ...(event.location === undefined ? {} : { location: event.location }),
          ...(event.description === undefined ? {} : { description: event.description }),
          ...(calendarId === undefined ? {} : { calendarId }),
        });
        if (!created.ok) {
          errors.push(`${label} was not imported: ${created.problem} ${created.fix}`);
          continue;
        }
        eventIds.push(created.value.id);
        const guests = (event.attendees ?? []).map((address) => address.trim()).filter((address) => address.length > 0);
        if (guests.length > 0) {
          attendeesLeftOff.push({
            eventId: created.value.id,
            title: event.summary || event.uid,
            attendees: guests,
            next: 'To invite them, create the event with calendar.events.create and these attendees; it asks for confirmation with the list shown.',
          });
        }
      }
      return {
        imported: eventIds.length,
        eventIds,
        errors,
        ...(attendeesLeftOff.length === 0 ? {} : { attendeesLeftOff }),
      };
    },
  };
}
