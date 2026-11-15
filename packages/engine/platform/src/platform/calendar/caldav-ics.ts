/**
 * caldav-ics.ts, the one RFC 5545 (iCalendar) reader.
 *
 * Pure: no network, no filesystem, no clock, no secret. The CalDAV gateway reads
 * REPORT/GET payloads and `calendar.ics.import` files with it, and the feed and
 * file reader (`ics-parser.ts`) uses its line unfolding, content-line split and
 * date parsing, so a named zone is converted the same way everywhere.
 *
 * The VEVENT fields read here are the ones a calendar answer shows: SUMMARY,
 * DTSTART, DTEND or DURATION, DESCRIPTION, LOCATION, UID, ATTENDEE, ORGANIZER,
 * STATUS, RRULE, RECURRENCE-ID, plus all-day (VALUE=DATE) detection. Nothing is
 * re-serialised from this model: an import writes the file's own components
 * (`splitICalDocument`), and an export returns the server's own data.
 *
 * ATTENDEE/ORGANIZER are kept twice: the display name a response may show and
 * the raw value, which stays inside the process (see `ICalAttendee`).
 */

/** One ATTENDEE, split into what may be shown and what must be re-emitted. */
export interface ICalAttendee {
  /** Display name only (CN parameter, or the local-part of the address). */
  readonly displayName: string;
  /**
   * The property value exactly as it arrived (e.g. `mailto:a@b.example`).
   * Never surfaced in a gateway response, where display names are all a caller
   * gets.
   */
  readonly rawValue: string;
}

export interface ParsedICalEvent {
  readonly uid: string;
  readonly summary: string;
  readonly description?: string;
  readonly location?: string;
  /** ISO-8601 start. */
  readonly start: string;
  /** ISO-8601 end. */
  readonly end: string;
  readonly allDay: boolean;
  readonly status?: string;
  /** Raw RRULE value (e.g. "FREQ=WEEKLY;COUNT=10") when present. */
  readonly recurrence?: string;
  /** ISO-8601 RECURRENCE-ID when this VEVENT is one occurrence of a series (an override, or a server-expanded instance). */
  readonly recurrenceId?: string;
  readonly attendees: readonly ICalAttendee[];
  /** Organizer display name only (CN or local-part). */
  readonly organizer?: string;
  /** Raw organizer value, kept inside the process (it names who wrote the event). */
  readonly organizerRaw?: string;
}

// ---------------------------------------------------------------------------
// Line unfolding (RFC 5545 §3.1)
// ---------------------------------------------------------------------------

/** One logical content line and the 1-based physical line it starts on. */
export interface UnfoldedLine {
  readonly text: string;
  readonly line: number;
}

/**
 * Unfold folded content lines: a line beginning with a space or tab is a
 * continuation of the previous one, not a line of its own (RFC 5545 §3.1).
 * Blank lines are dropped; no iCalendar property is expressible as one.
 */
export function unfoldContentLines(content: string): UnfoldedLine[] {
  const physical = content.split(/\r\n|\r|\n/);
  const lines: { text: string; line: number }[] = [];
  for (let i = 0; i < physical.length; i += 1) {
    const rawLine = physical[i] ?? '';
    const last = lines[lines.length - 1];
    if ((rawLine.startsWith(' ') || rawLine.startsWith('\t')) && last !== undefined) {
      last.text += rawLine.slice(1);
    } else {
      lines.push({ text: rawLine, line: i + 1 });
    }
  }
  return lines.filter((entry) => entry.text.length > 0);
}

/** {@link unfoldContentLines} without the line numbers. */
export function unfoldLines(content: string): string[] {
  return unfoldContentLines(content).map((entry) => entry.text);
}

// ---------------------------------------------------------------------------
// Text escaping (RFC 5545 §3.3.11)
// ---------------------------------------------------------------------------

export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\n|\r/g, '\\n');
}

export function unescapeText(value: string): string {
  let result = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '\\' && i + 1 < value.length) {
      const next = value[i + 1];
      if (next === 'n' || next === 'N') {
        result += '\n';
      } else if (next === '\\' || next === ';' || next === ',') {
        result += next;
      } else {
        // Unrecognised escape sequence (not one of \\ \; \, \n \N): RFC 5545
        // defines no such sequence, so the backslash is a literal character.
        // Preserve BOTH the backslash and the following char so values that
        // happen to contain a literal backslash round-trip losslessly.
        result += ch;
        result += next;
      }
      i += 1;
    } else {
      result += ch;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Date/time parsing (RFC 5545 §3.3.5)
// ---------------------------------------------------------------------------

/**
 * Parse an iCalendar date or date-time value into an ISO-8601 string.
 * Supports YYYYMMDD (DATE), YYYYMMDDTHHMMSSZ (UTC), YYYYMMDDTHHMMSS
 * (floating/local) and YYYYMMDDTHHMMSS with a TZID parameter, which is
 * converted to the real UTC instant through the runtime's tz database. A TZID
 * the runtime does not know (a Windows zone name, a private VTIMEZONE id) throws
 * rather than guessing: a computed UTC for a zone nobody resolved is a wrong
 * instant that a later PUT would write back to the server.
 */
export function parseICalDate(
  value: string,
  tzid?: string | undefined,
): { readonly iso: string; readonly allDay: boolean } {
  const trimmed = value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    assertRealDateTime(value, Number(y), Number(m), Number(d), 0, 0, 0);
    const iso = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), 0, 0, 0)).toISOString();
    return { iso, allDay: true };
  }
  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(trimmed);
  if (dateTime) {
    const [, y, m, d, hh, mm, ss, zulu] = dateTime;
    // A trailing 'Z' marks an absolute UTC instant. Without it the value is a
    // floating/local time (RFC 5545 §3.3.5): it has no offset and denotes the
    // wall-clock time in the observer's own zone. Interpreting it via Date.UTC
    // would relabel that wall-clock as UTC and shift the resulting ISO instant
    // by the local offset on round-trip; we instead build it through the local
    // Date constructor so the ISO reflects the same wall-clock in local time.
    assertRealDateTime(value, Number(y), Number(m), Number(d), Number(hh), Number(mm), Number(ss));
    if (!zulu && tzid !== undefined && tzid.length > 0) {
      const wall = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
      return { iso: new Date(zonedWallClockToUtcMs(wall, tzid)).toISOString(), allDay: false };
    }
    const date = zulu
      ? new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)))
      : new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
    return { iso: date.toISOString(), allDay: false };
  }
  throw new Error(`Unrecognised iCalendar date value: ${value}`);
}

/** Refuse an impossible calendar value (month 13, 31 June) instead of letting Date roll it over. */
function assertRealDateTime(
  value: string,
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  ss: number,
): void {
  const probe = new Date(Date.UTC(y, m - 1, d, hh, mm, ss));
  if (
    probe.getUTCFullYear() !== y
    || probe.getUTCMonth() !== m - 1
    || probe.getUTCDate() !== d
    || hh > 23
    || mm > 59
    || ss > 59
  ) {
    throw new Error(`Unrecognised iCalendar date value: ${value}`);
  }
}

/** One formatter per zone: building an Intl.DateTimeFormat costs far more than using one. */
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = zoneFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    zoneFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The offset of `timeZone` from UTC, in ms, at the UTC instant `utcMs`. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(utcMs));
  const part = (type: string): number =>
    Number(parts.find((candidate) => candidate.type === type)?.value ?? '0');
  const asUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * The UTC instant at which `timeZone`'s wall clock reads `wallMs` (the wall
 * clock expressed as if it were UTC). Two passes settle the offset across a
 * DST boundary. Throws for a zone this runtime does not know.
 */
export function zonedWallClockToUtcMs(wallMs: number, timeZone: string): number {
  try {
    const first = wallMs - zoneOffsetMs(wallMs, timeZone);
    return wallMs - zoneOffsetMs(first, timeZone);
  } catch {
    throw new Error(`Unsupported iCalendar TZID '${timeZone}': it is not a time zone this runtime knows.`);
  }
}

/** The wall clock of `timeZone` at the UTC instant `utcMs`, expressed as if it were UTC. */
export function utcToZonedWallClockMs(utcMs: number, timeZone: string): number {
  try {
    return utcMs + zoneOffsetMs(utcMs, timeZone);
  } catch {
    throw new Error(`Unsupported iCalendar TZID '${timeZone}': it is not a time zone this runtime knows.`);
  }
}

/** True when the runtime knows `timeZone`. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    zoneFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Property line parsing
// ---------------------------------------------------------------------------

export interface ContentLine {
  readonly name: string;
  readonly params: Readonly<Record<string, string>>;
  readonly value: string;
}

/** Split a `NAME;PARAM=foo;OTHER="a;b"` prefix on unquoted semicolons. */
function splitParams(input: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === ';' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.length > 0) result.push(current);
  return result;
}

export function parseContentLine(line: string): ContentLine {
  // Split name(+params) from value at the first unquoted colon.
  let colonIndex = -1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) {
      colonIndex = i;
      break;
    }
  }
  if (colonIndex === -1) {
    return { name: line.toUpperCase(), params: {}, value: '' };
  }
  const namePart = line.slice(0, colonIndex);
  const value = line.slice(colonIndex + 1);
  const segments = splitParams(namePart);
  const name = (segments.shift() ?? '').toUpperCase();
  const params: Record<string, string> = {};
  for (const segment of segments) {
    const eq = segment.indexOf('=');
    if (eq === -1) continue;
    const key = segment.slice(0, eq).toUpperCase();
    let paramValue = segment.slice(eq + 1);
    if (paramValue.startsWith('"') && paramValue.endsWith('"')) {
      paramValue = paramValue.slice(1, -1);
    }
    params[key] = paramValue;
  }
  return { name, params, value };
}

/** The display name for an ATTENDEE/ORGANIZER value: its CN, or the local-part. */
export function attendeeDisplayName(params: Readonly<Record<string, string>>, value: string): string {
  const cn = params['CN'];
  if (cn && cn.trim().length > 0) return cn.trim();
  const withoutScheme = value.trim().replace(/^mailto:/i, '');
  const atIndex = withoutScheme.indexOf('@');
  if (atIndex > 0) return withoutScheme.slice(0, atIndex);
  return withoutScheme;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Accumulator for one VEVENT being parsed. Carries the VALUE type observed on
 * DTSTART/DTEND so `finaliseEvent` can enforce that they agree (RFC 5545
 * §3.8.2.2).
 */
interface ParsingEvent {
  uid?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  status?: string;
  recurrence?: string;
  organizer?: string;
  organizerRaw?: string;
  recurrenceId?: string;
  durationMs?: number;
  startIsDate?: boolean;
  endIsDate?: boolean;
  readonly attendees: ICalAttendee[];
}

function applyProperty(target: ParsingEvent, line: ContentLine): void {
  switch (line.name) {
    case 'UID':
      target.uid = line.value.trim();
      break;
    case 'SUMMARY':
      target.summary = unescapeText(line.value);
      break;
    case 'DESCRIPTION':
      target.description = unescapeText(line.value);
      break;
    case 'LOCATION':
      target.location = unescapeText(line.value);
      break;
    case 'STATUS':
      target.status = line.value.trim().toLowerCase();
      break;
    case 'RRULE':
      target.recurrence = line.value.trim();
      break;
    case 'DTSTART': {
      const { iso, allDay } = parseICalDate(line.value, line.params['TZID']);
      // A value is DATE-typed when explicitly tagged VALUE=DATE or when the
      // serialised form carries no time component (parseICalDate -> allDay).
      const isDate = line.params['VALUE'] === 'DATE' || allDay;
      target.start = iso;
      target.startIsDate = isDate;
      target.allDay = isDate;
      break;
    }
    case 'DTEND': {
      const { iso, allDay } = parseICalDate(line.value, line.params['TZID']);
      const isDate = line.params['VALUE'] === 'DATE' || allDay;
      target.end = iso;
      target.endIsDate = isDate;
      break;
    }
    case 'ATTENDEE':
      target.attendees.push({
        displayName: attendeeDisplayName(line.params, line.value),
        rawValue: line.value.trim(),
      });
      break;
    case 'ORGANIZER':
      target.organizer = attendeeDisplayName(line.params, line.value);
      target.organizerRaw = line.value.trim();
      break;
    case 'RECURRENCE-ID':
      target.recurrenceId = parseICalDate(line.value, line.params['TZID']).iso;
      break;
    case 'DURATION':
      target.durationMs = parseICalDuration(line.value);
      break;
    default:
      break;
  }
}

/**
 * An RFC 5545 §3.3.6 DURATION (`P1D`, `PT1H30M`, `P2W`, `-PT15M`) in ms.
 * Days are counted as 24 hours, which is what an end computed for display
 * needs.
 */
export function parseICalDuration(value: string): number {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!match || value.trim().endsWith('T') || value.trim().replace(/^[+-]/, '') === 'P') {
    throw new Error(`Unrecognised iCalendar DURATION value: ${value}`);
  }
  const [, sign, weeks, days, hours, minutes, seconds] = match;
  const ms = (((Number(weeks ?? 0) * 7 + Number(days ?? 0)) * 24 + Number(hours ?? 0)) * 60 + Number(minutes ?? 0)) * 60_000
    + Number(seconds ?? 0) * 1000;
  return sign === '-' ? -ms : ms;
}

function finaliseEvent(partial: ParsingEvent): ParsedICalEvent {
  // RFC 5545 §3.8.2.2: when DTEND is present it MUST share the VALUE type of
  // DTSTART. A DATE-valued DTSTART paired with a DATE-TIME DTEND (or vice
  // versa) is malformed; accepting it silently would corrupt all-day handling.
  if (
    partial.startIsDate !== undefined
    && partial.endIsDate !== undefined
    && partial.startIsDate !== partial.endIsDate
  ) {
    throw new Error(
      'VEVENT DTSTART and DTEND have mismatched VALUE types (one DATE, one DATE-TIME).',
    );
  }
  // A VEVENT with no DTSTART has no place on a calendar. Dating it 1970 would
  // write a wrong event; it is reported instead.
  if (partial.start === undefined) {
    throw new Error('VEVENT has no DTSTART, so it cannot be placed on a calendar.');
  }
  const start = partial.start;
  const end = partial.end
    ?? (partial.durationMs !== undefined ? new Date(Date.parse(start) + partial.durationMs).toISOString() : undefined)
    // RFC 5545 §3.6.1: no DTEND and no DURATION is one day for a DATE start and
    // the same instant for a DATE-TIME start.
    ?? (partial.startIsDate ? new Date(Date.parse(start) + 86_400_000).toISOString() : start);
  return {
    uid: partial.uid ?? '',
    summary: partial.summary ?? '',
    ...(partial.description === undefined ? {} : { description: partial.description }),
    ...(partial.location === undefined ? {} : { location: partial.location }),
    start,
    end,
    allDay: partial.allDay ?? false,
    ...(partial.status === undefined ? {} : { status: partial.status }),
    ...(partial.recurrence === undefined ? {} : { recurrence: partial.recurrence }),
    ...(partial.recurrenceId === undefined ? {} : { recurrenceId: partial.recurrenceId }),
    attendees: partial.attendees,
    ...(partial.organizer === undefined ? {} : { organizer: partial.organizer }),
    ...(partial.organizerRaw === undefined ? {} : { organizerRaw: partial.organizerRaw }),
  };
}

/** One VEVENT that could not be read, with the UID it declared (if it got that far). */
export interface ICalEventParseError {
  readonly uid?: string;
  readonly message: string;
}

/**
 * Parse a full .ics document and return every VEVENT it holds, plus the ones it
 * could not read. A VEVENT with a date value this module cannot read, or with a
 * DTSTART/DTEND VALUE-type mismatch, is reported in `errors` instead of
 * failing its neighbours: one hostile or damaged invitation must not make the
 * rest of a collection unreadable.
 *
 * Properties of child components (a VALARM's DESCRIPTION, ACTION, TRIGGER) are
 * not the event's: they are skipped while a nested BEGIN/END pair is open.
 */
export function parseICSDetailed(content: string): {
  readonly events: ParsedICalEvent[];
  readonly errors: ICalEventParseError[];
} {
  const lines = unfoldLines(content);
  const events: ParsedICalEvent[] = [];
  const errors: ICalEventParseError[] = [];
  let current: ParsingEvent | null = null;
  let failure: string | undefined;
  let depth = 0;

  for (const line of lines) {
    const upper = line.toUpperCase();
    if (current === null) {
      if (upper === 'BEGIN:VEVENT') {
        current = { attendees: [] };
        failure = undefined;
        depth = 0;
      }
      continue;
    }
    if (upper === 'BEGIN:VEVENT' && depth === 0) {
      // A VEVENT left unclosed: the next one starts a fresh event.
      current = { attendees: [] };
      failure = undefined;
      continue;
    }
    if (upper === 'END:VEVENT' && depth === 0) {
      if (failure === undefined) {
        try {
          events.push(finaliseEvent(current));
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
      }
      if (failure !== undefined) {
        errors.push({ ...(current.uid ? { uid: current.uid } : {}), message: failure });
      }
      current = null;
      continue;
    }
    if (upper.startsWith('BEGIN:')) {
      depth += 1;
      continue;
    }
    if (upper.startsWith('END:')) {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth > 0 || failure !== undefined) continue;
    try {
      applyProperty(current, parseContentLine(line));
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
  }

  return { events, errors };
}

/**
 * Parse a full .ics document and return every VEVENT component in it. Multiple
 * VEVENTs (a VCALENDAR carrying recurrence overrides, or a whole collection
 * exported as one file) all come back.
 *
 * Throws, rather than dropping the event, on a date value it cannot read or
 * on a DTSTART/DTEND VALUE-type mismatch: a calendar entry silently landing on
 * the wrong day is worse than a refusal that names the file. Callers that must
 * survive a bad neighbour use `parseICSDetailed`.
 */
export function parseICS(content: string): ParsedICalEvent[] {
  const { events, errors } = parseICSDetailed(content);
  const first = errors[0];
  if (first !== undefined) throw new Error(first.message);
  return events;
}

/** The first UID in a raw .ics document, if it has one. */
export function extractUid(content: string): string | undefined {
  for (const line of unfoldLines(content)) {
    if (line.toUpperCase().startsWith('UID:')) {
      return line.slice(line.indexOf(':') + 1).trim();
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Splitting a document into its components, text untouched
// ---------------------------------------------------------------------------

/** One top-level component of an iCalendar document, as the physical lines it was written with. */
export interface ICalComponentBlock {
  /** Upper-case component name: VEVENT, VTIMEZONE, VTODO, ... */
  readonly name: string;
  /** The component's own UID (not a child's), when it has one. */
  readonly uid?: string;
  /** The component's TZID (a VTIMEZONE's), when it has one. */
  readonly tzid?: string;
  /** Physical lines, folds kept, without line terminators. */
  readonly lines: readonly string[];
}

export interface ICalDocumentParts {
  /** VCALENDAR-level property lines (VERSION, PRODID, METHOD, X-WR-...), folds kept. */
  readonly properties: readonly string[];
  readonly components: readonly ICalComponentBlock[];
}

/**
 * Split an iCalendar document into its calendar properties and its top-level
 * components, keeping every component's text exactly as written. This is what
 * lets an import store a file's own events (series, overrides, alarms,
 * EXDATE, DURATION, zones and all) instead of a re-serialised subset, and what
 * lets an export return the server's own data. Several VCALENDARs in one
 * document, and bare components outside any VCALENDAR, are both accepted.
 */
export function splitICalDocument(content: string): ICalDocumentParts {
  const physical = content.split(/\r\n|\r|\n/);
  // Group physical lines into logical lines, keeping the folds.
  const logical: { readonly text: string; readonly lines: string[] }[] = [];
  for (const rawLine of physical) {
    const last = logical[logical.length - 1];
    if ((rawLine.startsWith(' ') || rawLine.startsWith('\t')) && last !== undefined) {
      last.lines.push(rawLine);
      (last as { text: string }).text += rawLine.slice(1);
    } else if (rawLine.length > 0) {
      logical.push({ text: rawLine, lines: [rawLine] });
    }
  }
  const properties: string[] = [];
  const components: ICalComponentBlock[] = [];
  let inCalendar = false;
  let block: { name: string; uid?: string; tzid?: string; lines: string[]; depth: number } | null = null;
  for (const entry of logical) {
    const upper = entry.text.toUpperCase();
    if (block !== null) {
      block.lines.push(...entry.lines);
      if (upper.startsWith('BEGIN:')) {
        block.depth += 1;
      } else if (upper.startsWith('END:')) {
        block.depth -= 1;
        if (block.depth === 0) {
          components.push({
            name: block.name,
            ...(block.uid === undefined ? {} : { uid: block.uid }),
            ...(block.tzid === undefined ? {} : { tzid: block.tzid }),
            lines: block.lines,
          });
          block = null;
        }
      } else if (block.depth === 1) {
        const line = parseContentLine(entry.text);
        if (line.name === 'UID') block.uid = line.value.trim();
        if (line.name === 'TZID') block.tzid = line.value.trim();
      }
      continue;
    }
    if (upper === 'BEGIN:VCALENDAR') {
      inCalendar = true;
      continue;
    }
    if (upper === 'END:VCALENDAR') {
      inCalendar = false;
      continue;
    }
    if (upper.startsWith('BEGIN:')) {
      block = { name: upper.slice('BEGIN:'.length).trim(), lines: [...entry.lines], depth: 1 };
      continue;
    }
    if (inCalendar) properties.push(...entry.lines);
  }
  // A component left unclosed at the end of the text is kept as written: the
  // reader reports it, and nothing here invents an END line for it.
  if (block !== null) {
    components.push({ name: block.name, ...(block.uid === undefined ? {} : { uid: block.uid }), lines: block.lines });
  }
  return { properties, components };
}
