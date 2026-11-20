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
  CalendarGatewayDeleted,
  CalendarGatewayEventDetail,
  CalendarGatewayEventPage,
  CalendarGatewayEventSummary,
  CalendarGatewayIcsExport,
  CalendarGatewayIcsImport,
  CalendarGatewayListInput,
  CalendarGatewayService,
  CalendarGatewayUpdated,
  CalendarGatewayUpdateInput,
} from '../control-plane/routes/calendar.js';
import { CalDavClient, withinCredentialPin, type CalDavHttpPort } from '../google/caldav-client.js';
import { isCalendarResourceType, parseMultistatus } from '../google/caldav-parse.js';
import { parseICSDetailed, splitICalDocument, type ICalComponentBlock, type ParsedICalEvent } from './caldav-ics.js';
import { buildCalendarObject, eventToVEvent, foldLine, generateICS, ICalValueError, type GenerateICalInput } from './caldav-ics-generate.js';
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
  /**
   * For one occurrence of a recurring series: the instant (ISO) it recurs at,
   * its RECURRENCE-ID. Absent for a single event and for a stored series.
   */
  readonly occurrence?: string;
}

/**
 * The id a caller is handed for an event: its resource href, and for one
 * occurrence of a series the href plus `#` and the occurrence's
 * RECURRENCE-ID instant, so every occurrence has its own id and reading it
 * answers that occurrence, not the series' first.
 */
function eventIdOf(event: CalDavEvent): string {
  const occurrence = event.occurrence ?? event.recurrenceId;
  const base = event.href || event.uid;
  return occurrence === undefined || event.href.length === 0 ? base : `${base}#${occurrence}`;
}

/** An event id split into its resource href and, for one occurrence, its RECURRENCE-ID instant. */
function splitEventId(eventId: string): { readonly href: string; readonly occurrence?: string } {
  const mark = eventId.indexOf('#');
  if (mark < 0 || !isHrefLike(eventId.slice(0, mark))) return { href: eventId };
  const instant = Date.parse(eventId.slice(mark + 1));
  if (!Number.isFinite(instant)) {
    throw new GatewayVerbError(`Event id '${eventId}' names no occurrence this calendar can read. Use an event id calendar.events.list returned.`, 'INVALID_ARGUMENT', 400);
  }
  return { href: eventId.slice(0, mark), occurrence: new Date(instant).toISOString() };
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
    id: eventIdOf(event),
    title: event.summary,
    start: event.start,
    end: event.end,
    allDay: event.allDay,
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

/** Whether two ETags name the same version: a weak marker and surrounding space do not count. */
function sameEtag(a: string, b: string): boolean {
  const bare = (value: string): string => value.trim().replace(/^W\//, '');
  return bare(a) === bare(b);
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
    const recurrenceId = occurrence.event.recurrenceId !== undefined
      ? new Date(eventDateTimeEpochMs(occurrence.event.recurrenceId)).toISOString()
      : undefined;
    const source = recurrenceId !== undefined
      ? events.find((event) => event.recurrenceId === recurrenceId) ?? master
      : master;
    if (source === undefined) continue;
    const startMs = eventDateTimeEpochMs({ ...occurrence.event.start, value: occurrence.start });
    if (!Number.isFinite(startMs)) continue;
    const lengthMs = Math.max(0, Date.parse(source.end) - Date.parse(source.start));
    if (startMs >= toMs || startMs + lengthMs < fromMs) continue;
    // The occurrence is named by the instant it recurs at: an override's
    // RECURRENCE-ID, otherwise the start the rule gave it.
    const recursAt = recurrenceId ?? new Date(startMs).toISOString();
    out.push({ ...source, start: new Date(startMs).toISOString(), end: new Date(startMs + lengthMs).toISOString(), occurrence: recursAt });
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

/**
 * The one occurrence of a resource's series that recurs at `recursAt` (an ISO
 * instant): the override written for it, else the rule's occurrence at that
 * instant. Undefined when the series has no occurrence there.
 */
function occurrenceOf(resource: CalDavResource, events: readonly CalDavEvent[], recursAt: string): CalDavEvent | undefined {
  const override = events.find((event) => event.recurrenceId === recursAt);
  if (override !== undefined) return { ...override, occurrence: recursAt };
  if (!events.some((event) => event.recurrence !== undefined)) return undefined;
  const instant = Date.parse(recursAt);
  return expandResourceLocally(resource, events, instant, instant + 1)
    .find((event) => event.occurrence === recursAt);
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

/** The properties an update writes afresh; every other line of the stored event is kept as it was. */
const UPDATED_PROPERTIES = new Set([
  'UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'DURATION', 'SUMMARY', 'DESCRIPTION', 'LOCATION',
  'STATUS', 'RRULE', 'ORGANIZER', 'ATTENDEE', 'SEQUENCE', 'LAST-MODIFIED',
]);

/**
 * The stored VEVENT with the changed properties written afresh and everything
 * else (alarms, categories, a server's own properties) kept line for line, so
 * a change made here loses nothing another calendar application put there.
 */
function updatedEventBlock(stored: ICalComponentBlock, fresh: readonly string[]): ICalComponentBlock {
  const kept: string[] = [];
  let sequence = 0;
  let depth = 0;
  let keepingProperty = true;
  for (const line of stored.lines.slice(1, -1)) {
    const continuation = line.startsWith(' ') || line.startsWith('\t');
    if (continuation) {
      if (keepingProperty) kept.push(line);
      continue;
    }
    const upper = line.toUpperCase();
    if (upper.startsWith('BEGIN:')) depth += 1;
    const name = upper.slice(0, upper.search(/[;:]|$/));
    if (depth === 0 && name === 'SEQUENCE') {
      const value = Number(line.slice(line.indexOf(':') + 1));
      if (Number.isFinite(value)) sequence = value;
    }
    keepingProperty = depth > 0 || !UPDATED_PROPERTIES.has(name);
    if (keepingProperty) kept.push(line);
    if (upper.startsWith('END:')) depth -= 1;
  }
  const body = fresh.slice(1, -1).map(foldLine);
  return {
    ...stored,
    lines: ['BEGIN:VEVENT', ...body, `SEQUENCE:${String(sequence + 1)}`, ...kept, 'END:VEVENT'],
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

  /**
   * Where each calendar the server advertised lives, by logical id, per
   * configured address and account: the collection URL the server named,
   * which can sit below the configured path or on a sibling host of the same
   * domain (iCloud names `p42-caldav.icloud.com` for an account configured as
   * `caldav.icloud.com`). A read goes there instead of to a path guessed from
   * the id. Only URLs the credentials may go to are kept.
   */
  const discoveredCollections = new Map<string, { readonly at: number; readonly urls: ReadonlyMap<string, string> }>();
  const REDISCOVER_AFTER_MS = 60_000;
  const discoveryKey = (config: CalDavGatewayConfig): string => `${config.baseUrl}\n${config.username}`;

  /** The calendars the server advertises, remembering where each one lives. */
  async function findCalendars(config: CalDavGatewayConfig, request: CalDavRequest): Promise<readonly CalDavCalendarSummary[]> {
    const urls = new Map<string, string>();
    const remember = (calendarId: string, href: string): void => {
      let url: string;
      try { url = new URL(href, config.baseUrl).href; } catch { return; }
      if (!urls.has(calendarId) && withinCredentialPin(config.baseUrl, url)) urls.set(calendarId, stripTrailingSlash(url));
    };
    const response = await request(
      stripTrailingSlash(config.baseUrl),
      'PROPFIND',
      propfindCalendarsBody(),
      { Depth: '1' },
    );
    let calendars: readonly CalDavCalendarSummary[] = collectionsFrom(response.body, config.defaultCalendarId, remember);
    if (calendars.length === 0) {
      // The configured URL is not itself a calendar home (a server root, or a
      // principal URL). Chain the standard discovery, current-user-principal,
      // then calendar-home-set, then the collections under it, through the
      // hoisted client, which speaks exactly those three PROPFINDs.
      const discovered = await new CalDavClient({
        http: options.http,
        auth: { kind: 'basic', username: config.username, password: config.password },
      }).discover(config.baseUrl);
      if (discovered.ok) {
        calendars = discovered.calendars.map((calendar) => {
          const calendarId = logicalIdFor(toRelativeHref(calendar.href), config.defaultCalendarId);
          remember(calendarId, calendar.href);
          return { calendarId, displayName: calendar.displayName.length > 0 ? calendar.displayName : calendarId };
        });
      }
    }
    discoveredCollections.set(discoveryKey(config), { at: now(), urls });
    return calendars;
  }

  /**
   * The collection URL for a logical calendar id: the default calendar and an
   * id the owner mapped resolve from configuration; any other id resolves to
   * where the server said that calendar lives, asking the server once when
   * nothing is known yet; an id the server never named keeps the configured
   * guess (a child collection of the base URL).
   */
  async function collectionUrlOf(config: CalDavGatewayConfig, request: CalDavRequest, calendarId: string): Promise<string> {
    if (calendarId === config.defaultCalendarId || config.collectionMap[calendarId]) return collectionUrlFor(config, calendarId);
    let known = discoveredCollections.get(discoveryKey(config));
    if (known === undefined || (!known.urls.has(calendarId) && now() - known.at > REDISCOVER_AFTER_MS)) {
      try {
        await findCalendars(config, request);
      } catch (error) {
        logger.debug('CalDAV calendar discovery failed; using the configured calendar path', { error: error instanceof Error ? error.message : String(error) });
      }
      known = discoveredCollections.get(discoveryKey(config));
    }
    return known?.urls.get(calendarId) ?? collectionUrlFor(config, calendarId);
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
      await collectionUrlOf(config, request, calendarId),
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
    const collectionUrl = await collectionUrlOf(config, request, calendarId);
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

  /**
   * The one stored calendar object an event id names, with the ETag it was
   * read at so a write can refuse to overwrite a change made meanwhile. An
   * href-like id is fetched directly; a UID is found by a UID query first.
   */
  async function readStoredEvent(
    eventId: string,
    calendarId: string | undefined,
  ): Promise<{
    readonly config: CalDavGatewayConfig;
    readonly request: CalDavRequest;
    readonly url: string;
    readonly href: string;
    readonly calendarId: string;
    readonly body: string;
    readonly etag?: string;
  }> {
    const { config, request } = await connect();
    const id = calendarId && calendarId.length > 0 ? calendarId : config.defaultCalendarId;
    const collectionUrl = await collectionUrlOf(config, request, id);
    // An occurrence id names its series' resource; a change to it is then
    // refused below as a change to the whole series.
    let href = splitEventId(eventId).href;
    if (!isHrefLike(eventId)) {
      const response = await request(collectionUrl, 'REPORT', calendarQueryByUidBody(eventId), { Depth: '1' });
      const resource = resourcesFromMultistatus(response.body)
        .find((candidate) => eventsOfResource(candidate, id).some((event) => event.uid === eventId));
      if (resource === undefined) throw notFound(eventId);
      href = resource.href;
    }
    const url = resolveResourceUrl(collectionUrl, config.baseUrl, href);
    let response: Awaited<ReturnType<CalDavRequest>>;
    try {
      response = await request(url, 'GET', undefined, { Depth: '0' });
    } catch (error) {
      if (error instanceof GatewayVerbError && error.code === 'CALENDAR_NOT_FOUND') throw notFound(eventId);
      throw error;
    }
    const etag = readHeader(response.headers, 'ETag');
    return {
      config,
      request,
      url,
      href: toRelativeHref(href),
      calendarId: id,
      body: response.body,
      ...(etag === undefined || etag.length === 0 ? {} : { etag }),
    };
  }

  /** A recurring event is changed in the calendar's own application: one id here names the whole series. */
  function refuseSeries(eventId: string, action: string): GatewayVerbError {
    return new GatewayVerbError(
      `Event ${eventId} is a recurring event, so ${action} it here would change every occurrence. Change the series in the calendar's own application.`,
      'CALENDAR_SERIES_NOT_SUPPORTED',
      409,
    );
  }

  /** A write the server refused because the event changed after it was read. */
  function changedMeanwhile(eventId: string): GatewayVerbError {
    return new GatewayVerbError(
      `Event ${eventId} changed on the calendar after it was read, so nothing was written. Read it again and repeat the change.`,
      'CALENDAR_EVENT_CHANGED',
      409,
    );
  }

  return {
    async updateEvent(
      eventId: string,
      changes: CalendarGatewayUpdateInput,
      calendarId?: string | undefined,
    ): Promise<CalendarGatewayUpdated> {
      if (changes.start !== undefined) validateIsoDate(changes.start, 'start');
      if (changes.end !== undefined) validateIsoDate(changes.end, 'end');
      const stored = await readStoredEvent(eventId, calendarId);
      // The version the person edited, when they sent it: a newer one on the server is refused before anything is written.
      if (changes.expectedRevision !== undefined && stored.etag !== undefined && !sameEtag(stored.etag, changes.expectedRevision)) {
        throw changedMeanwhile(eventId);
      }
      const document = splitICalDocument(stored.body);
      const { events: blocks } = eventAndZoneComponents(document.components);
      const parsed = parseICSDetailed(stored.body).events;
      const current = parsed[0];
      if (current === undefined || blocks.length === 0) throw notFound(eventId);
      if (blocks.length > 1 || current.recurrence !== undefined || current.recurrenceId !== undefined) {
        throw refuseSeries(eventId, 'changing');
      }
      const start = changes.start ?? current.start;
      const end = changes.end ?? current.end;
      if (Date.parse(end) < Date.parse(start)) {
        throw new GatewayVerbError("Field 'end' must not be before 'start'.", 'INVALID_ARGUMENT', 400);
      }
      const updatedAt = stampNow();
      const description = changes.description ?? current.description;
      const location = changes.location ?? current.location;
      let fresh: string[];
      try {
        fresh = eventToVEvent({
          uid: current.uid,
          summary: changes.title ?? current.summary,
          start,
          end,
          dtStamp: updatedAt,
          // A day-only event stays day-only unless its times were changed.
          allDay: current.allDay && changes.start === undefined && changes.end === undefined,
          ...(description === undefined ? {} : { description }),
          ...(location === undefined ? {} : { location }),
          ...(current.status === undefined ? {} : { status: current.status }),
          ...(current.organizerRaw === undefined ? {} : { organizer: current.organizerRaw }),
          attendees: changes.attendees ?? current.attendees.map((attendee) => attendee.rawValue),
        });
      } catch (error) {
        if (error instanceof ICalValueError) throw new GatewayVerbError(error.message, 'INVALID_ARGUMENT', 400);
        throw error;
      }
      const components = document.components.map((component) => (
        component === blocks[0] ? updatedEventBlock(component, fresh) : component
      ));
      try {
        await stored.request(
          stored.url,
          'PUT',
          buildCalendarObject(components, document.properties),
          stored.etag === undefined ? undefined : { 'If-Match': stored.etag },
        );
      } catch (error) {
        if (error instanceof GatewayVerbError && error.status === 412) throw changedMeanwhile(eventId);
        throw error;
      }
      return { eventId: stored.href, updatedAt };
    },

    async deleteEvent(eventId: string, calendarId?: string | undefined): Promise<CalendarGatewayDeleted> {
      let stored: Awaited<ReturnType<typeof readStoredEvent>>;
      try {
        stored = await readStoredEvent(eventId, calendarId);
      } catch (error) {
        if (error instanceof GatewayVerbError && error.code === 'CALENDAR_NOT_FOUND') return { eventId, deleted: false };
        throw error;
      }
      const { events: blocks } = eventAndZoneComponents(splitICalDocument(stored.body).components);
      const parsed = parseICSDetailed(stored.body).events;
      if (blocks.length > 1 || parsed.some((event) => event.recurrence !== undefined || event.recurrenceId !== undefined)) {
        throw refuseSeries(eventId, 'removing');
      }
      try {
        await stored.request(stored.url, 'DELETE', undefined, stored.etag === undefined ? undefined : { 'If-Match': stored.etag });
      } catch (error) {
        if (error instanceof GatewayVerbError && error.code === 'CALENDAR_NOT_FOUND') return { eventId: stored.href, deleted: false };
        if (error instanceof GatewayVerbError && error.status === 412) throw changedMeanwhile(eventId);
        throw error;
      }
      return { eventId: stored.href, deleted: true };
    },

    async listCalendars(): Promise<readonly CalDavCalendarSummary[]> {
      const { config, request } = await connect();
      const calendars = await findCalendars(config, request);
      if (calendars.length > 0) return calendars;
      // Nothing advertised a calendar collection. The configured default is
      // still a usable answer, it is the collection every other verb writes
      // to, and is a better reply than an empty list that reads as "you have
      // no calendars".
      return [{ calendarId: config.defaultCalendarId, displayName: config.defaultCalendarId }];
    },

    async listEvents(input: CalendarGatewayListInput): Promise<CalendarGatewayEventPage> {
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
      const limit = resolveLimit(input.limit);
      const page = sorted.slice(0, limit);
      // Only the page is recorded: it is what the caller actually receives, and
      // recording the rest would claim exposure to text nobody was handed.
      if (page.length > 0) recordEventsRead(calendarId, page);
      return { events: page.map(toSummary), more: sorted.length > limit };
    },

    async getEvent(
      eventId: string,
      calendarId?: string | undefined,
    ): Promise<CalendarGatewayEventDetail> {
      const { config, request } = await connect();
      const id = calendarId && calendarId.length > 0 ? calendarId : config.defaultCalendarId;
      const collectionUrl = await collectionUrlOf(config, request, id);

      // Strategy 1, an href-like identifier (a path, or a *.ics resource
      // name): resolve it to a single resource URL and GET that. A true
      // single-event fetch, not a collection scan.
      if (isHrefLike(eventId)) {
        const named = splitEventId(eventId);
        let body: string;
        let revision: string | undefined;
        try {
          const response = await request(
            resolveResourceUrl(collectionUrl, config.baseUrl, named.href),
            'GET',
            undefined,
            { Depth: '0' },
          );
          body = response.body;
          revision = readHeader(response.headers, 'ETag') || undefined;
        } catch (error) {
          // A 404 is "no such event"; anything else is a real failure.
          if (error instanceof GatewayVerbError && error.code === 'CALENDAR_NOT_FOUND') {
            throw notFound(eventId);
          }
          throw error;
        }
        const parsed = parseICSDetailed(body);
        const unreadable = parsed.errors[0];
        if (parsed.events.length === 0 && unreadable !== undefined) {
          throw new GatewayVerbError(
            `Event ${eventId} could not be read: ${unreadable.message}`,
            'CALENDAR_EVENT_UNREADABLE',
            422,
          );
        }
        const href = toRelativeHref(named.href);
        const events = parsed.events.map((event) => ({ ...event, href, calendarId: id }));
        const event = named.occurrence === undefined
          // The resource as a whole: a series is answered by its master, not by whichever override comes first.
          ? events.find((candidate) => candidate.recurrenceId === undefined) ?? events[0]
          : occurrenceOf({ href, calendarData: body }, events, named.occurrence);
        if (event === undefined) throw notFound(eventId);
        recordEventsRead(id, [event]);
        return { ...toDetail(event), ...(revision === undefined ? {} : { revision }) };
      }

      // Strategy 2, a bare UID: ask the server for only the matching resource
      // via a UID prop-filter. Some servers ignore an unsupported prop-filter
      // and return the whole collection, so the exact UID is confirmed here as
      // well; a near-miss must never come back as the answer.
      const response = await request(collectionUrl, 'REPORT', calendarQueryByUidBody(eventId), { Depth: '1' });
      const found = eventsFromMultistatus(response.body, id).find((event) => event.uid === eventId);
      if (found === undefined) throw notFound(eventId);
      recordEventsRead(id, [found]);
      // The resource's ETag from the same answer (the query asks for getetag).
      const etag = parseMultistatus(response.body).find((entry) => toRelativeHref(entry.href) === found.href)?.props['getetag'];
      return { ...toDetail(found), ...(etag ? { revision: etag } : {}) };
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
      // The caller's UID when it gave one (the same for every attempt at this
      // event, so a create repeated after an unknown outcome is refused by the
      // server's If-None-Match instead of making a second event).
      const uid = input.uid ?? newUid();
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
      let href: string;
      try {
        href = await putEvent(config, request, calendarId, uid, ics, true);
      } catch (error) {
        // The PUT went out and no answer came back: the event may be on the
        // calendar. Creating it again would make a second one under a new
        // UID, so the answer is "unknown" and names the UID to look for.
        if (error instanceof GatewayVerbError && error.code === 'CALENDAR_NETWORK_ERROR') throw outcomeUnknown(uid, error);
        throw error;
      }
      return { eventId: href, uid, createdAt };
    },

    async exportIcs(input: CalendarGatewayListInput): Promise<CalendarGatewayIcsExport> {
      // The server's own calendar objects, as stored: series with their
      // overrides, zones, alarms and every property, not a re-serialised subset.
      const { calendarId, resources: all } = await readResources(input, false);
      // With a limit the export stops at that many stored objects and says when the window holds more.
      const limit = input.limit === undefined ? undefined : resolveLimit(input.limit);
      const resources = limit === undefined ? all : all.slice(0, limit);
      const more = limit !== undefined && all.length > limit;
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
      return { icsContent: buildCalendarObject([...zones.values(), ...events]), eventCount: events.length, ...(more ? { more: true } : {}) };
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

/** A create whose PUT got no answer: whether the event exists is unknown, and its UID says where to look. */
function outcomeUnknown(uid: string, cause: GatewayVerbError): GatewayVerbError {
  const why = cause.message.replace(/^CalDAV request failed: /, '').replace(/;? ?try again later\.?$/, '').replace(/\.$/, '');
  return new GatewayVerbError(
    `No answer came back for the new event (${why}), so whether event ${uid} was created is unknown. Read it with calendar.events.get eventId ${uid} before creating it again; creating it again now could add it twice.`,
    'CALENDAR_OUTCOME_UNKNOWN',
    502,
  );
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

/** Calendar collections in a PROPFIND multistatus body, de-duplicated by logical id; `found` hears each one's href. */
function collectionsFrom(xml: string, fallbackId: string, found?: (calendarId: string, href: string) => void): CalDavCalendarSummary[] {
  const calendars: CalDavCalendarSummary[] = [];
  const seen = new Set<string>();
  for (const entry of parseMultistatus(xml)) {
    if (!isCalendarResourceType(entry.props['resourcetype'])) continue;
    const logical = logicalIdFor(toRelativeHref(entry.href), fallbackId);
    if (seen.has(logical)) continue;
    seen.add(logical);
    found?.(logical, entry.href);
    const displayName = entry.props['displayname'];
    calendars.push({
      calendarId: logical,
      displayName: displayName !== undefined && displayName.length > 0 ? displayName : logical,
    });
  }
  return calendars;
}
