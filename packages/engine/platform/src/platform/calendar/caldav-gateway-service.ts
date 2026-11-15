/**
 * caldav-gateway-service.ts, the CalDAV-backed implementation of the daemon's
 * `calendar.*` verbs.
 *
 * A sibling of `google/gateway-calendar-service.ts`, not a replacement for it:
 * both satisfy the same `CalendarGatewayService` slice that
 * `control-plane/routes/calendar.ts` is written against, so the five verbs are
 * served identically whether the operator's calendar is a Google account or any
 * CalDAV server (Fastmail, iCloud, Nextcloud, Radicale, a corporate DAV host).
 * The route layer knows about neither.
 *
 * This is a port, verb for verb, of the CalDAV surface that lived inside one
 * product, the same discovery, the same collection mapping, the same
 * .ics import/export, and the same operator-facing wording, including the
 * config keys the errors name. Two implementations of one advertised capability
 * is how a contract drifts, so there is now one.
 *
 * Three properties are kept exactly as they were:
 *
 *  - **`calendarId` is logical.** It maps inward to a collection URL and never
 *    comes back out; ids handed to a caller are host-relative hrefs, so no
 *    response carries the scheme+host a credential is scoped to.
 *  - **Attendees are display names.** A gateway response carries the CN (or the
 *    address local-part) and never the address itself. The raw value survives
 *    only inside a PUT, where the server needs it to address an invitation.
 *  - **Import stores the file's own events.** Components are grouped by UID
 *    (a series with its overrides is one calendar object), wrapped with the
 *    file's VTIMEZONEs, and PUT once each as written, never re-serialised, so
 *    EXDATE, DURATION, alarms and zones survive. An existing event is not
 *    overwritten unless the caller asks (`replace`). A UID that cannot be
 *    stored is named in `errors`; the rest land.
 *  - **Export returns the server's own data**, and **list returns occurrences**:
 *    a recurring event is answered with its occurrences in the window (the
 *    server expands, the local expander is the fallback).
 *
 * Everything is injected: the HTTP port, the config port, the secret port, the
 * clock and the uid source. Nothing here reads a socket, a file, or `Date.now`.
 */

import { GatewayVerbError } from '../control-plane/routes/gateway-verb-error.js';
import type {
  CalendarGatewayCalendarSummary,
  CalendarGatewayCreateInput,
  CalendarGatewayCreated,
  CalendarGatewayEventDetail,
  CalendarGatewayEventSummary,
  CalendarGatewayIcsExport,
  CalendarGatewayIcsImport,
  CalendarGatewayListInput,
  CalendarGatewayService,
} from '../control-plane/routes/calendar.js';
import { CalDavClient, type CalDavHttpPort } from '../google/caldav-client.js';
import { isCalendarResourceType, parseMultistatus } from '../google/caldav-parse.js';
import { parseICSDetailed, splitICalDocument, type ICalComponentBlock, type ParsedICalEvent } from './caldav-ics.js';
import { buildCalendarObject, generateICS, ICalValueError, type GenerateICalInput } from './caldav-ics-generate.js';
import { parseIcs } from './ics-parser.js';
import { expandEvents } from './rrule.js';
import { eventDateTimeEpochMs } from './event-time.js';
import { logger } from '../utils/logger.js';
import {
  collectionPathOrRoot,
  collectionUrlFor,
  isHrefLike,
  joinUrl,
  resolveCalDavGatewayConfig,
  resolveResourceUrl,
  stripTrailingSlash,
  toRelativeHref,
  type CalDavConfigPort,
  type CalDavGatewayConfig,
  type CalDavSecretPort,
} from './caldav-gateway-config.js';
import {
  recordCalendarEventIngest,
  type CalendarUntrustedIngestRecorder,
} from './untrusted-events.js';
import {
  calendarQueryBody,
  calendarQueryByUidBody,
  createCalDavRequest,
  propfindCalendarsBody,
  readHeader,
  type CalDavRequest,
} from './caldav-gateway-wire.js';

/** Everything the service needs, all of it injected. */
export interface CalDavCalendarGatewayServiceOptions {
  /** Reads `surfaces.calendar.*`. */
  readonly config: CalDavConfigPort;
  /** Resolves the CalDAV password from the secret store. */
  readonly secrets: CalDavSecretPort;
  /** The HTTP transport. The fetch-backed adapter is `createFetchCalDavHttpPort`. */
  readonly http: CalDavHttpPort;
  /** Wall clock, injected so DTSTAMP and `createdAt` are deterministic under test. */
  readonly now?: (() => number) | undefined;
  /** UID source for created events, injected for the same reason. */
  readonly randomUuid?: (() => string) | undefined;
  /**
   * Records that a turn read untrusted event content.
   *
   * Events on a CalDAV collection are written by whoever sent the invitation,
   * so every read path here records: `listEvents`, `getEvent`, `exportIcs` and
   * `importIcs`. Each of those runs because a caller asked for it, which is the
   * condition for recording at all, nothing in this service runs on a timer.
   * See untrusted-events.ts.
   */
  readonly recordUntrustedIngest?: CalendarUntrustedIngestRecorder | undefined;
}

/** One calendar collection the account can reach. */
export type CalDavCalendarSummary = CalendarGatewayCalendarSummary;

/**
 * The gateway slice with discovery always present: `calendar.calendars.list`
 * is what a setup flow calls to fill in `surfaces.calendar.defaultCalendarId`
 * with something real instead of asking an operator to hand-copy a collection
 * path out of a web UI.
 */
export interface CalDavCalendarGatewayService extends CalendarGatewayService {
  listCalendars(): Promise<readonly CalDavCalendarSummary[]>;
}

/** One event as it came off the wire, with where it lives. */
interface CalDavEvent extends ParsedICalEvent {
  /** Opaque, host-relative href (never absolute, never authenticated). */
  readonly href: string;
  /** The logical calendar id this event was read from. */
  readonly calendarId: string;
}

// ---------------------------------------------------------------------------
// Input validation (the wording an operator sees, unchanged)
// ---------------------------------------------------------------------------

function validateIsoDate(value: string, field: string): string {
  if (Number.isNaN(new Date(value).getTime())) {
    throw new GatewayVerbError(
      `Field '${field}' must be a valid ISO-8601 date.`,
      'INVALID_ARGUMENT',
      400,
    );
  }
  return value;
}

/**
 * The page size. Absent means 20; anything else is clamped to 1..200 rather
 * than refused, because a caller asking for 10000 events wants "as many as you
 * will give me", and a caller asking for 0 has a bug that an empty page would
 * hide.
 */
/** How far back an unwindowed `listEvents` reaches, so a meeting that just started still shows. */
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** How far ahead a list reaches when no end is given: occurrences need a bounded window. */
const DEFAULT_LOOKAHEAD_MS = 30 * 24 * 60 * 60 * 1000;

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return 20;
  return Math.max(1, Math.min(200, Math.floor(limit)));
}

// ---------------------------------------------------------------------------
// Response mapping (credential-free, address-free, schema-exact)
// ---------------------------------------------------------------------------

function displayAttendees(event: CalDavEvent): string[] {
  return event.attendees.map((attendee) => attendee.displayName).filter((name) => name.length > 0);
}

function toSummary(event: CalDavEvent): CalendarGatewayEventSummary {
  const attendees = displayAttendees(event);
  return {
    id: event.href || event.uid,
    title: event.summary,
    start: event.start,
    end: event.end,
    ...(event.location === undefined ? {} : { location: event.location }),
    ...(event.description === undefined ? {} : { description: event.description }),
    ...(attendees.length > 0 ? { attendees } : {}),
  };
}

function toDetail(event: CalDavEvent): CalendarGatewayEventDetail {
  return {
    ...toSummary(event),
    uid: event.uid,
    ...(event.recurrence === undefined ? {} : { recurrence: event.recurrence }),
  };
}

/** One stored calendar object as the server returned it. */
interface CalDavResource {
  readonly href: string;
  readonly calendarData: string;
}

/** Every calendar object carried by a multistatus body. */
function resourcesFromMultistatus(xml: string): CalDavResource[] {
  const resources: CalDavResource[] = [];
  for (const entry of parseMultistatus(xml)) {
    const calendarData = entry.props['calendar-data'];
    if (!calendarData) continue;
    resources.push({ href: toRelativeHref(entry.href), calendarData });
  }
  return resources;
}

/** The VEVENTs of one resource, tagged with where they came from; unreadable ones are logged. */
function eventsOfResource(resource: CalDavResource, calendarId: string): CalDavEvent[] {
  const parsed = parseICSDetailed(resource.calendarData);
  // One unreadable VEVENT must not make the rest of the collection
  // unreadable; it is named in the log and left out of the answer.
  for (const failure of parsed.errors) {
    logger.warn('CalDAV event skipped: it could not be read', {
      calendarId,
      href: resource.href,
      ...(failure.uid === undefined ? {} : { uid: failure.uid }),
      reason: failure.message,
    });
  }
  return parsed.events.map((event) => ({ ...event, href: resource.href, calendarId }));
}

/** Every VEVENT carried by a multistatus body, tagged with where it came from. */
function eventsFromMultistatus(xml: string, calendarId: string): CalDavEvent[] {
  return resourcesFromMultistatus(xml).flatMap((resource) => eventsOfResource(resource, calendarId));
}

/**
 * The occurrences of one resource inside [from, to), for a server that did not
 * expand it (its answer still carries an RRULE). The feed reader's expander
 * applies the series' EXDATE, RDATE and overrides; display fields come from
 * the CalDAV reader so a response still carries display names only. A series
 * the expander cannot expand is answered by its stored first occurrence and
 * logged, so it does not vanish.
 */
function expandResourceLocally(resource: CalDavResource, events: readonly CalDavEvent[], fromMs: number, toMs: number): CalDavEvent[] {
  const window = {
    from: new Date(fromMs - 86_400_000).toISOString().slice(0, 10),
    to: new Date(toMs + 86_400_000).toISOString().slice(0, 10),
  };
  const { occurrences, unexpandedSeries } = expandEvents(parseIcs(resource.calendarData).events, window);
  const master = events.find((event) => event.recurrenceId === undefined) ?? events[0];
  const out: CalDavEvent[] = [];
  for (const occurrence of occurrences) {
    const source = occurrence.event.recurrenceId !== undefined
      ? events.find((event) => event.recurrenceId === new Date(eventDateTimeEpochMs(occurrence.event.recurrenceId!)).toISOString()) ?? master
      : master;
    if (source === undefined) continue;
    const startMs = eventDateTimeEpochMs({ ...occurrence.event.start, value: occurrence.start });
    if (!Number.isFinite(startMs)) continue;
    const lengthMs = Math.max(0, Date.parse(source.end) - Date.parse(source.start));
    if (startMs >= toMs || startMs + lengthMs < fromMs) continue;
    out.push({ ...source, start: new Date(startMs).toISOString(), end: new Date(startMs + lengthMs).toISOString() });
  }
  for (const series of unexpandedSeries) {
    logger.warn('CalDAV recurring event not expanded: its recurrence is outside what this build expands', {
      href: resource.href,
      uid: series.uid,
      reason: series.recurrence?.unsupportedReason ?? 'unsupported recurrence',
    });
    const stored = events.find((event) => event.uid === series.uid && event.recurrenceId === undefined);
    if (stored !== undefined && Date.parse(stored.start) < toMs && Date.parse(stored.end) >= fromMs) out.push(stored);
  }
  return out;
}

/** The components of a VCALENDAR text worth storing or returning: events and the zones they name. */
function eventAndZoneComponents(parts: readonly ICalComponentBlock[]): {
  readonly events: readonly ICalComponentBlock[];
  readonly zones: readonly ICalComponentBlock[];
} {
  return {
    events: parts.filter((component) => component.name === 'VEVENT'),
    zones: parts.filter((component) => component.name === 'VTIMEZONE'),
  };
}

/** A VEVENT block with a UID line added after its BEGIN line, for an event that came without one. */
function withUid(block: ICalComponentBlock, uid: string): ICalComponentBlock {
  const [begin, ...rest] = block.lines;
  return { ...block, uid, lines: [begin ?? 'BEGIN:VEVENT', `UID:${uid}`, ...rest] };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createCalDavCalendarGatewayService(
  options: CalDavCalendarGatewayServiceOptions,
): CalDavCalendarGatewayService {
  const now = options.now ?? ((): number => Date.now());
  const randomUuid = options.randomUuid ?? ((): string => crypto.randomUUID());

  /**
   * Resolved per call rather than cached: the password can be stored, rotated
   * or withdrawn while the daemon is running, and a cached client would keep
   * answering from a credential the owner has already changed.
   */
  async function connect(): Promise<{
    readonly config: CalDavGatewayConfig;
    readonly request: CalDavRequest;
  }> {
    const config = await resolveCalDavGatewayConfig(options.config, options.secrets);
    return { config, request: createCalDavRequest(options.http, config) };
  }

  function stampNow(): string {
    return new Date(now()).toISOString();
  }

  /**
   * Record that a caller just read these events.
   *
   * The origin prefers the RAW organizer value, because the inviter's address
   * is what identifies who wrote the text, that value stays inside the ledger
   * and never reaches a gateway response, which continues to carry display
   * names only.
   *
   * Every CalDAV event is recorded, including one whose ORGANIZER matches the
   * configured account. The ORGANIZER line is text inside the event body, and
   * nothing here can tell whether the server verified who wrote it: a shared or
   * delegated collection, a server without scheduling, or one that accepts
   * inbound invitations without checking the sender will all hand over an event
   * naming the owner as organizer. Exempting on that claim would let such an
   * event's text steer outward actions unchecked, so no CalDAV event is treated
   * as the owner's own.
   */
  function recordEventsRead(
    calendarId: string,
    events: readonly CalDavEvent[],
  ): void {
    recordCalendarEventIngest({
      record: options.recordUntrustedIngest,
      provenance: { kind: 'caldav', calendarId },
      events: events.map((event) => {
        const organizer = event.organizerRaw ?? event.organizer;
        return {
          summary: event.summary,
          location: event.location,
          description: event.description,
          attendees: displayAttendees(event),
          organizer,
        };
      }),
      at: stampNow(),
    });
  }

  /**
   * The resource name an event is PUT under. A UID from an imported file is
   * somebody else's text and is a path segment here: one carrying `/`, `\`,
   * `?`, `#`, whitespace or control characters, or made only of dots, would
   * name a resource outside the collection (or cut the URL short), so such a
   * UID gets a generated name instead. The UID itself stays inside the event
   * body.
   */
  function resourceNameFor(uid: string): string {
    return /^[A-Za-z0-9._@+=~-]+$/.test(uid) && !/^\.+$/.test(uid) ? uid : `${randomUuid()}@goodvibes`;
  }

  function newUid(): string {
    return `${randomUuid()}@goodvibes`;
  }

  /**
   * One calendar-query REPORT over a collection. `expand` asks the server for
   * occurrences instead of stored series (listing does; export does not).
   */
  async function readResources(
    input: CalendarGatewayListInput,
    expand: boolean,
  ): Promise<{ readonly calendarId: string; readonly resources: CalDavResource[] }> {
    if (input.from !== undefined) validateIsoDate(input.from, 'from');
    if (input.to !== undefined) validateIsoDate(input.to, 'to');
    const { config, request } = await connect();
    const calendarId = input.calendarId && input.calendarId.length > 0
      ? input.calendarId
      : config.defaultCalendarId;
    const response = await request(
      collectionUrlFor(config, calendarId),
      'REPORT',
      calendarQueryBody(input.from, input.to, { expand }),
      { Depth: '1' },
    );
    return { calendarId, resources: resourcesFromMultistatus(response.body) };
  }

  /**
   * Write one .ics resource into a collection and report the host-relative
   * href it now lives at. `If-None-Match: *` on a create refuses to overwrite
   * an existing resource that happens to share the name. `resourceName` is one
   * path segment: callers pass `resourceNameFor(uid)`, never a raw UID.
   */
  async function putEvent(
    config: CalDavGatewayConfig,
    request: CalDavRequest,
    calendarId: string,
    resourceName: string,
    ics: string,
    guardAgainstOverwrite: boolean,
  ): Promise<string> {
    const collectionUrl = collectionUrlFor(config, calendarId);
    const resourcePath = `${resourceName}.ics`;
    const response = await request(
      joinUrl(collectionUrl, resourcePath),
      'PUT',
      ics,
      guardAgainstOverwrite ? { 'If-None-Match': '*' } : undefined,
    );
    // Prefer the server-assigned location; otherwise the relative resource path.
    const location = readHeader(response.headers, 'Location');
    return location !== undefined && location.length > 0
      ? toRelativeHref(location)
      : toRelativeHref(joinUrl(collectionPathOrRoot(collectionUrl, config.baseUrl), resourcePath));
  }

  return {
    async listCalendars(): Promise<readonly CalDavCalendarSummary[]> {
      const { config, request } = await connect();
      const response = await request(
        stripTrailingSlash(config.baseUrl),
        'PROPFIND',
        propfindCalendarsBody(),
        { Depth: '1' },
      );
      const calendars = collectionsFrom(response.body, config.defaultCalendarId);
      if (calendars.length > 0) return calendars;

      // The configured URL is not itself a calendar home (a server root, or a
      // principal URL). Chain the standard discovery, current-user-principal,
      // then calendar-home-set, then the collections under it, through the
      // hoisted client, which speaks exactly those three PROPFINDs.
      const discovered = await new CalDavClient({
        http: options.http,
        auth: { kind: 'basic', username: config.username, password: config.password },
      }).discover(config.baseUrl);
      if (discovered.ok && discovered.calendars.length > 0) {
        return discovered.calendars.map((calendar) => ({
          calendarId: logicalIdFor(toRelativeHref(calendar.href), config.defaultCalendarId),
          displayName: calendar.displayName.length > 0
            ? calendar.displayName
            : logicalIdFor(toRelativeHref(calendar.href), config.defaultCalendarId),
        }));
      }
      // Nothing advertised a calendar collection. The configured default is
      // still a usable answer, it is the collection every other verb writes
      // to, and is a better reply than an empty list that reads as "you have
      // no calendars".
      return [{ calendarId: config.defaultCalendarId, displayName: config.defaultCalendarId }];
    },

    async listEvents(input: CalendarGatewayListInput): Promise<readonly CalendarGatewayEventSummary[]> {
      // A list is a window of occurrences, so it always has both ends. With no
      // window the answer is what is coming up: from a day ago (a meeting that
      // just started still shows) to thirty days ahead.
      if (input.from !== undefined) validateIsoDate(input.from, 'from');
      if (input.to !== undefined) validateIsoDate(input.to, 'to');
      const from = input.from ?? (input.to !== undefined
        ? new Date(Math.min(now() - DEFAULT_LOOKBACK_MS, Date.parse(input.to) - DEFAULT_LOOKAHEAD_MS)).toISOString()
        : new Date(now() - DEFAULT_LOOKBACK_MS).toISOString());
      const to = input.to ?? new Date(Date.parse(from) + DEFAULT_LOOKAHEAD_MS).toISOString();
      const fromMs = Date.parse(from);
      const toMs = Date.parse(to);
      const { calendarId, resources } = await readResources({ ...input, from, to }, true);
      const events: CalDavEvent[] = [];
      for (const resource of resources) {
        const resourceEvents = eventsOfResource(resource, calendarId);
        // A server that ignored the expand request still answers with the
        // stored series; it is expanded here instead.
        if (resourceEvents.some((event) => event.recurrence !== undefined)) {
          events.push(...expandResourceLocally(resource, resourceEvents, fromMs, toMs));
        } else {
          events.push(...resourceEvents);
        }
      }
      const sorted = events.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
      const page = sorted.slice(0, resolveLimit(input.limit));
      // Only the page is recorded: it is what the caller actually receives, and
      // recording the rest would claim exposure to text nobody was handed.
      if (page.length > 0) recordEventsRead(calendarId, page);
      return page.map(toSummary);
    },

    async getEvent(
      eventId: string,
      calendarId?: string | undefined,
    ): Promise<CalendarGatewayEventDetail> {
      const { config, request } = await connect();
      const id = calendarId && calendarId.length > 0 ? calendarId : config.defaultCalendarId;
      const collectionUrl = collectionUrlFor(config, id);

      // Strategy 1, an href-like identifier (a path, or a *.ics resource
      // name): resolve it to a single resource URL and GET that. A true
      // single-event fetch, not a collection scan.
      if (isHrefLike(eventId)) {
        let body: string;
        try {
          body = (await request(
            resolveResourceUrl(collectionUrl, config.baseUrl, eventId),
            'GET',
            undefined,
            { Depth: '0' },
          )).body;
        } catch (error) {
          // A 404 is "no such event"; anything else is a real failure.
          if (error instanceof GatewayVerbError && error.code === 'CALENDAR_NOT_FOUND') {
            throw notFound(eventId);
          }
          throw error;
        }
        const parsed = parseICSDetailed(body);
        const first = parsed.events[0];
        const unreadable = parsed.errors[0];
        if (first === undefined && unreadable !== undefined) {
          throw new GatewayVerbError(
            `Event ${eventId} could not be read: ${unreadable.message}`,
            'CALENDAR_EVENT_UNREADABLE',
            422,
          );
        }
        if (first === undefined) throw notFound(eventId);
        const event = { ...first, href: toRelativeHref(eventId), calendarId: id };
        recordEventsRead(id, [event]);
        return toDetail(event);
      }

      // Strategy 2, a bare UID: ask the server for only the matching resource
      // via a UID prop-filter. Some servers ignore an unsupported prop-filter
      // and return the whole collection, so the exact UID is confirmed here as
      // well; a near-miss must never come back as the answer.
      const response = await request(collectionUrl, 'REPORT', calendarQueryByUidBody(eventId), { Depth: '1' });
      const found = eventsFromMultistatus(response.body, id).find((event) => event.uid === eventId);
      if (found === undefined) throw notFound(eventId);
      recordEventsRead(id, [found]);
      return toDetail(found);
    },

    async createEvent(input: CalendarGatewayCreateInput): Promise<CalendarGatewayCreated> {
      const start = validateIsoDate(input.start, 'start');
      const end = validateIsoDate(input.end, 'end');
      if (new Date(end).getTime() < new Date(start).getTime()) {
        throw new GatewayVerbError(
          "Field 'end' must not be before 'start'.",
          'INVALID_ARGUMENT',
          400,
        );
      }
      const { config, request } = await connect();
      const calendarId = input.calendarId && input.calendarId.length > 0
        ? input.calendarId
        : config.defaultCalendarId;
      const uid = newUid();
      const createdAt = stampNow();
      const ics = generateICSOrRefuse({
        uid,
        summary: input.title,
        start,
        end,
        dtStamp: createdAt,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.location === undefined ? {} : { location: input.location }),
        ...(input.attendees === undefined ? {} : { attendees: input.attendees }),
        status: 'confirmed',
      });
      const href = await putEvent(config, request, calendarId, uid, ics, true);
      return { eventId: href, uid, createdAt };
    },

    async exportIcs(input: CalendarGatewayListInput): Promise<CalendarGatewayIcsExport> {
      // The server's own calendar objects, as stored: series with their
      // overrides, zones, alarms and every property, not a re-serialised subset.
      const { calendarId, resources } = await readResources(input, false);
      const events: ICalComponentBlock[] = [];
      const zones = new Map<string, ICalComponentBlock>();
      const read: CalDavEvent[] = [];
      for (const resource of resources) {
        const parts = eventAndZoneComponents(splitICalDocument(resource.calendarData).components);
        events.push(...parts.events);
        for (const zone of parts.zones) {
          const key = zone.tzid ?? zone.lines.join('\n');
          if (!zones.has(key)) zones.set(key, zone);
        }
        read.push(...eventsOfResource(resource, calendarId));
      }
      if (read.length > 0) recordEventsRead(calendarId, read);
      return { icsContent: buildCalendarObject([...zones.values(), ...events]), eventCount: events.length };
    },

    async importIcs(
      icsContent: string,
      calendarId?: string | undefined,
      importOptions: { readonly replace?: boolean | undefined } = {},
    ): Promise<CalendarGatewayIcsImport> {
      const document = splitICalDocument(icsContent);
      const { events: eventBlocks, zones } = eventAndZoneComponents(document.components);
      if (eventBlocks.length === 0) {
        throw new GatewayVerbError(
          'No VEVENT components found in .ics content.',
          'CALENDAR_EMPTY_ICS',
          400,
        );
      }
      // The .ics body is somebody else's text and the caller asked for it to be
      // read, so this is an ingest, recorded before a single PUT is attempted.
      const { events: parsed } = parseICSDetailed(icsContent);
      recordCalendarEventIngest({
        record: options.recordUntrustedIngest,
        provenance: { kind: 'ics-import' },
        events: parsed.map((event) => ({
          summary: event.summary,
          location: event.location,
          description: event.description,
          attendees: event.attendees.map((attendee) => attendee.displayName),
          organizer: event.organizerRaw ?? event.organizer,
        })),
        at: stampNow(),
      });

      // One calendar object per UID: a series and its overrides share a UID and
      // must be stored together, or the last one written replaces the rest.
      const groups = new Map<string, ICalComponentBlock[]>();
      for (const block of eventBlocks) {
        const uid = block.uid !== undefined && block.uid.length > 0 ? block.uid : newUid();
        const list = groups.get(uid) ?? [];
        list.push(block.uid === uid ? block : withUid(block, uid));
        groups.set(uid, list);
      }

      const { config, request } = await connect();
      const id = calendarId && calendarId.length > 0 ? calendarId : config.defaultCalendarId;
      const eventIds: string[] = [];
      const errors: string[] = [];
      for (const [uid, blocks] of groups) {
        const object = buildCalendarObject([...zones, ...blocks], document.properties);
        // Checked before the PUT: an event with no start, or with a date that
        // cannot exist, is reported, not written. A zone this runtime does not
        // know is not a reason to refuse: the text is stored as written, with
        // the file's own VTIMEZONE, and the server reads it.
        const check = parseICSDetailed(object);
        const zoneOnly = check.errors.filter((failure) => failure.message.startsWith('Unsupported iCalendar TZID'));
        const unreadable = check.errors.find((failure) => !zoneOnly.includes(failure));
        if (unreadable !== undefined) {
          errors.push(`${uid}: not imported, ${unreadable.message}`);
          continue;
        }
        if (check.events.length + zoneOnly.length < blocks.length) {
          errors.push(`${uid}: not imported, an event in it is not closed with END:VEVENT.`);
          continue;
        }
        try {
          const href = await putEvent(config, request, id, resourceNameFor(uid), object, importOptions.replace !== true);
          eventIds.push(href);
        } catch (error) {
          errors.push(`${uid}: ${describeImportFailure(error)}`);
        }
      }
      return { imported: eventIds.length, eventIds, errors };
    },
  };
}

/** Generate the .ics for a create, turning a value that would corrupt the event into a 400. */
function generateICSOrRefuse(input: GenerateICalInput): string {
  try {
    return generateICS(input);
  } catch (error) {
    if (error instanceof ICalValueError) {
      throw new GatewayVerbError(error.message, 'INVALID_ARGUMENT', 400);
    }
    throw error;
  }
}

function notFound(eventId: string): GatewayVerbError {
  return new GatewayVerbError(`Event not found: ${eventId}`, 'CALENDAR_NOT_FOUND', 404);
}

/**
 * What a per-event import failure says. `GatewayVerbError` messages are already
 * written for an operator and carry no host or credential; anything else is
 * reduced to its message text for the same reason.
 */
function describeImportFailure(error: unknown): string {
  if (error instanceof GatewayVerbError && error.status === 412) {
    return 'already on the calendar, so it was not overwritten. Import again with replace: true to overwrite it.';
  }
  if (error instanceof GatewayVerbError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * A collection href to a stable logical id: the last path segment, decoded.
 * That is the id an operator sees, and the one `surfaces.calendar.calendars`
 * maps back to a path.
 */
function logicalIdFor(relativeHref: string, fallback: string): string {
  const segments = relativeHref.split('/').filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1];
  return last === undefined ? fallback : decodeURIComponent(last);
}

/** Calendar collections in a PROPFIND multistatus body, de-duplicated by logical id. */
function collectionsFrom(xml: string, fallbackId: string): CalDavCalendarSummary[] {
  const calendars: CalDavCalendarSummary[] = [];
  const seen = new Set<string>();
  for (const entry of parseMultistatus(xml)) {
    if (!isCalendarResourceType(entry.props['resourcetype'])) continue;
    const logical = logicalIdFor(toRelativeHref(entry.href), fallbackId);
    if (seen.has(logical)) continue;
    seen.add(logical);
    const displayName = entry.props['displayname'];
    calendars.push({
      calendarId: logical,
      displayName: displayName !== undefined && displayName.length > 0 ? displayName : logical,
    });
  }
  return calendars;
}
