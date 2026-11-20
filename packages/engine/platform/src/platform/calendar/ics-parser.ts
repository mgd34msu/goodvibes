/**
 * ics-parser.ts, a pure, dependency-free iCalendar (RFC 5545) reader.
 *
 * Vendored on purpose. The platform's `packages/platform` ships ZERO third-party runtime
 * dependencies (workspace packages only, see packages/platform/package.json), and it
 * guards that with bundle-budget / browser-compat / no-any gates. Pulling a general
 * ICS library in for the read-focused subset we actually need would break that
 * convention for little gain; this focused reader matches repo style and is easy to
 * hold honest. See the decision record for the vendored-vs-dependency ruling and the
 * exact supported subset.
 *
 * Scope of what this reads (documented, not faked):
 *  - VCALENDAR framing, X-WR-CALNAME for a calendar display name.
 *  - VEVENT: UID, SUMMARY, LOCATION, DESCRIPTION, ORGANIZER, DTSTART, DTEND, RRULE.
 *  - DTSTART/DTEND as VALUE=DATE ('YYYYMMDD') or date-time ('YYYYMMDDTHHMMSS'),
 *    read through the CalDAV reader's `parseICalDate`, so an impossible date is
 *    refused and a TZID is checked against the runtime's zone data: trailing 'Z'
 *    => utc; a known TZID => tzid (wall time kept for recurrence stepping,
 *    converted wherever events are ordered, see event-time.ts); an unknown TZID
 *    => floating, with a diagnostic; otherwise floating.
 *  - RRULE, EXDATE, RDATE and RECURRENCE-ID, handed to the recurrence expander:
 *    exclusions and overrides are applied, not a reason to skip the series.
 *  - Line unfolding, content-line splitting and TEXT unescaping are the CalDAV
 *    reader's (caldav-ics.ts), one implementation of each.
 *
 * Everything unrecognised is ignored quietly EXCEPT what a caller must be told
 * about: a VEVENT with no usable DTSTART is `skipped` with a reason, and a
 * recurrence we do not fully expand is flagged on the event (in rrule.ts), never
 * dropped.
 *
 * PURE: no fs, no network, no process globals. Input is text; output is data.
 */

import type {
  CalendarEvent,
  EventDateTime,
  ParseDiagnostic,
  ParsedCalendar,
} from './types.js';
import { describeRecurrence } from './rrule.js';
import { contentDigest } from '../utils/target-ref.js';
import {
  isKnownTimeZone,
  parseContentLine as parseWireContentLine,
  parseICalDate,
  unescapeText,
  unfoldContentLines,
} from './caldav-ics.js';

interface ContentLine {
  readonly name: string;
  readonly params: ReadonlyMap<string, string>;
  readonly value: string;
  /** 1-based line number of the first physical line of this (possibly folded) line. */
  readonly line: number;
}

/**
 * Parse one content line into name/params/value (RFC 5545 §3.1). The split
 * honours DQUOTE-quoted parameter values, so `ORGANIZER;CN="Team: Eng":mailto:x`
 * keeps its address, and it is the same codec the CalDAV backend reads with.
 */
function parseContentLine(raw: string, line: number): ContentLine | undefined {
  if (!raw.includes(':')) return undefined;
  const parsed = parseWireContentLine(raw);
  if (parsed.name === '') return undefined;
  return {
    name: parsed.name,
    params: new Map(Object.entries(parsed.params).map(([key, value]): [string, string] => [key, value.trim()])),
    value: parsed.value,
    line,
  };
}

/**
 * Parse one DATE or DATE-TIME value into an EventDateTime, or a reason it
 * cannot be read. `parseICalDate` refuses impossible dates and unknown zones;
 * an unknown zone is read as floating, which the caller is told about.
 */
function parseDateValue(
  value: string,
  params: ReadonlyMap<string, string>,
): { readonly value: EventDateTime; readonly note?: string } | { readonly error: string } {
  const trimmed = value.trim();
  const tzid = params.get('TZID');
  const knownZone = tzid !== undefined && tzid.length > 0 && isKnownTimeZone(tzid);
  try {
    parseICalDate(trimmed, knownZone ? tzid : undefined);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
  if (date) return { value: { value: `${date[1]}-${date[2]}-${date[3]}`, kind: 'date', zone: 'floating' } };
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(trimmed);
  if (!dt) return { error: `Unrecognised iCalendar date value: ${value}` };
  const local = `${dt[1]}-${dt[2]}-${dt[3]}T${dt[4]}:${dt[5]}:${dt[6]}`;
  if (dt[7] === 'Z') return { value: { value: `${local}Z`, kind: 'date-time', zone: 'utc' } };
  if (knownZone && tzid) return { value: { value: local, kind: 'date-time', zone: 'tzid', tzid } };
  if (tzid) {
    return {
      value: { value: local, kind: 'date-time', zone: 'floating' },
      note: `TZID '${tzid}' is not a time zone this runtime knows; the time is read as floating.`,
    };
  }
  return { value: { value: local, kind: 'date-time', zone: 'floating' } };
}

/** Every value of a multi-valued date property (EXDATE, RDATE), and the ones that could not be read. */
function parseDateList(value: string, params: ReadonlyMap<string, string>): { readonly values: EventDateTime[]; readonly errors: string[] } {
  const values: EventDateTime[] = [];
  const errors: string[] = [];
  for (const part of value.split(',')) {
    if (part.trim().length === 0) continue;
    const parsed = parseDateValue(part, params);
    if ('error' in parsed) errors.push(parsed.error);
    else values.push(parsed.value);
  }
  return { values, errors };
}

/**
 * The UID of a VEVENT that omitted one: a digest of the feed it came from, its
 * start, its title and its place among identical events of the same feed, so
 * the same event gets the same id on every read of the feed, whatever else was
 * parsed before it.
 */
function syntheticUid(source: string | undefined, start: EventDateTime, summary: string, seen: Map<string, number>): string {
  const facts = { source: source ?? null, start: start.value, kind: start.kind, zone: start.zone, tzid: start.tzid ?? null, summary };
  const key = contentDigest(facts);
  const ordinal = seen.get(key) ?? 0;
  seen.set(key, ordinal + 1);
  return `synthetic:${contentDigest({ ...facts, ordinal })}`;
}

interface VEventDraft {
  uid?: string;
  summary?: string;
  location?: string;
  description?: string;
  organizer?: string;
  attendees?: string[];
  start?: EventDateTime;
  end?: EventDateTime;
  rrule?: string;
  exdates: EventDateTime[];
  rdates: EventDateTime[];
  recurrenceId?: EventDateTime;
  /** Series features this build does not apply (an RDATE period, a THISANDFUTURE override). */
  unsupportedParts: string[];
  /** True when the VEVENT carried EXDATE or RDATE. */
  hasDateExceptions: boolean;
  startLine: number;
}

/**
 * Parse .ics text into typed events plus honest skip/diagnostic lists.
 *
 * @param text raw .ics content (file body or fetched feed body).
 * @param options.source the feed address (or file) the text came from; it is
 *   part of the id a VEVENT without a UID is given.
 */
export function parseIcs(text: string, options: { readonly source?: string | undefined } = {}): ParsedCalendar {
  // Identical UID-less events seen so far in this feed, for their ordinal.
  const syntheticSeen = new Map<string, number>();
  const synthetic = (start: EventDateTime, summary: string): string => syntheticUid(options.source, start, summary, syntheticSeen);
  const lines = unfoldContentLines(text).map(({ text: raw, line }) => ({ raw, line }));
  const events: CalendarEvent[] = [];
  const overrides: CalendarEvent[] = [];
  const thisAndFutureUids = new Set<string>();
  const skipped: ParseDiagnostic[] = [];
  const diagnostics: ParseDiagnostic[] = [];
  let calendarName: string | undefined;

  let inEvent = false;
  let draft: VEventDraft | undefined;
  // Depth of child components (VALARM) open inside the VEVENT: their properties
  // are not the event's.
  let childDepth = 0;

  for (const { raw, line } of lines) {
    if (raw.trim() === '') continue;
    const cl = parseContentLine(raw, line);
    if (!cl) continue;

    if (cl.name === 'BEGIN' && cl.value.trim().toUpperCase() === 'VEVENT') {
      inEvent = true;
      draft = { startLine: line, exdates: [], rdates: [], unsupportedParts: [], hasDateExceptions: false };
      childDepth = 0;
      continue;
    }
    if (inEvent && cl.name === 'BEGIN') {
      childDepth += 1;
      continue;
    }
    if (inEvent && cl.name === 'END' && childDepth > 0) {
      childDepth -= 1;
      continue;
    }
    if (cl.name === 'END' && cl.value.trim().toUpperCase() === 'VEVENT') {
      if (draft) finalizeEvent(draft, events, skipped, diagnostics, overrides, thisAndFutureUids, synthetic);
      inEvent = false;
      draft = undefined;
      continue;
    }

    if (!inEvent) {
      if (cl.name === 'X-WR-CALNAME') calendarName = unescapeText(cl.value).trim();
      continue;
    }
    if (!draft || childDepth > 0) continue;

    switch (cl.name) {
      case 'UID':
        draft.uid = cl.value.trim();
        break;
      case 'SUMMARY':
        draft.summary = unescapeText(cl.value);
        break;
      case 'LOCATION':
        draft.location = unescapeText(cl.value);
        break;
      case 'DESCRIPTION':
        draft.description = unescapeText(cl.value);
        break;
      case 'ORGANIZER': {
        // The value is a CAL-ADDRESS ('mailto:alice@example.com'); the address
        // is what identifies the inviter, so the scheme is dropped and the
        // CN parameter (a display name the same party wrote) is not preferred
        // over it. Recorded as CLAIMED, nothing here verifies it.
        const address = cl.value.trim().replace(/^mailto:/i, '').trim();
        if (address.length > 0) draft.organizer = address;
        break;
      }
      case 'ATTENDEE': {
        const address = cl.value.trim().replace(/^mailto:/i, '').trim();
        if (address.length > 0) (draft.attendees ??= []).push(address);
        break;
      }
      case 'DTSTART': {
        const parsed = parseDateValue(cl.value, cl.params);
        if ('error' in parsed) {
          diagnostics.push({ line: cl.line, component: 'DTSTART', message: `${parsed.error}; event kept without a usable start.` });
          break;
        }
        draft.start = parsed.value;
        if (parsed.note) diagnostics.push({ line: cl.line, component: 'DTSTART', message: parsed.note });
        break;
      }
      case 'DTEND': {
        const parsed = parseDateValue(cl.value, cl.params);
        if ('error' in parsed) {
          diagnostics.push({ line: cl.line, component: 'DTEND', message: `${parsed.error}; event kept without an end.` });
          break;
        }
        draft.end = parsed.value;
        break;
      }
      case 'RRULE':
        draft.rrule = cl.value.trim();
        break;
      case 'EXDATE':
      case 'RDATE': {
        draft.hasDateExceptions = true;
        if (cl.name === 'RDATE' && cl.params.get('VALUE') === 'PERIOD') {
          if (!draft.unsupportedParts.includes('RDATE;VALUE=PERIOD')) draft.unsupportedParts.push('RDATE;VALUE=PERIOD');
          break;
        }
        const { values, errors } = parseDateList(cl.value, cl.params);
        (cl.name === 'EXDATE' ? draft.exdates : draft.rdates).push(...values);
        for (const error of errors) diagnostics.push({ line: cl.line, component: cl.name, message: `${error}; that date is not applied.` });
        break;
      }
      case 'RECURRENCE-ID': {
        const parsed = parseDateValue(cl.value, cl.params);
        if ('error' in parsed) {
          diagnostics.push({ line: cl.line, component: 'RECURRENCE-ID', message: `${parsed.error}; the override is kept as an event of its own.` });
          break;
        }
        draft.recurrenceId = parsed.value;
        if (cl.params.get('RANGE')?.toUpperCase() === 'THISANDFUTURE') draft.unsupportedParts.push('RECURRENCE-ID;RANGE=THISANDFUTURE');
        break;
      }
      default:
        break;
    }
  }

  if (inEvent && draft) {
    diagnostics.push({ line: draft.startLine, component: 'VEVENT', message: 'VEVENT was not closed with END:VEVENT before end of feed, finalised anyway.' });
    finalizeEvent(draft, events, skipped, diagnostics, overrides, thisAndFutureUids, synthetic);
  }

  // A RECURRENCE-ID override replaces one occurrence of the series sharing its
  // UID. The override is an event of its own, so the series drops that start;
  // a THISANDFUTURE override moves every later one too, which is not applied.
  const overridesByUid = new Map<string, CalendarEvent[]>();
  for (const override of overrides) {
    const list = overridesByUid.get(override.uid) ?? [];
    list.push(override);
    overridesByUid.set(override.uid, list);
  }
  const finalEvents = events.map((event) => {
    const own = overridesByUid.get(event.uid);
    if (!event.recurrence || event.isOverride === true || own === undefined) return event;
    const replaced = own.flatMap((override) => (override.recurrenceId ? [override.recurrenceId] : []));
    const thisAndFuture = thisAndFutureUids.has(event.uid);
    let recurrence = event.recurrence;
    if (thisAndFuture && recurrence.expansion === 'full') {
      recurrence = describeRecurrence(recurrence.rule, ['RECURRENCE-ID;RANGE=THISANDFUTURE']);
      diagnostics.push({ line: 0, component: 'RECURRENCE-ID', message: `Event '${event.summary}': ${recurrence.unsupportedReason ?? ''}` });
    }
    return {
      ...event,
      recurrence,
      exdates: [...(event.exdates ?? []), ...replaced],
      hasSeriesExceptions: true as const,
    };
  });

  return {
    ...(calendarName !== undefined ? { calendarName } : {}),
    events: finalEvents,
    skipped,
    diagnostics,
  };
}

function finalizeEvent(
  draft: VEventDraft,
  events: CalendarEvent[],
  skipped: ParseDiagnostic[],
  diagnostics: ParseDiagnostic[],
  overrides: CalendarEvent[],
  thisAndFutureUids: Set<string>,
  synthetic: (start: EventDateTime, summary: string) => string,
): void {
  if (!draft.start) {
    skipped.push({ line: draft.startLine, component: 'VEVENT', message: `Skipped VEVENT '${draft.summary ?? draft.uid ?? 'untitled'}', no usable DTSTART.` });
    return;
  }
  const summary = draft.summary ?? '(no title)';
  const uid = draft.uid && draft.uid !== '' ? draft.uid : synthetic(draft.start, summary);
  const isOverride = draft.recurrenceId !== undefined;

  // An override is one event; a THISANDFUTURE one marks the series it moves.
  if (isOverride && draft.unsupportedParts.includes('RECURRENCE-ID;RANGE=THISANDFUTURE')) thisAndFutureUids.add(uid);
  const seriesUnsupported = draft.unsupportedParts.filter((part) => part !== 'RECURRENCE-ID;RANGE=THISANDFUTURE');
  let recurrence;
  if (!isOverride && (draft.rrule !== undefined || draft.rdates.length > 0 || seriesUnsupported.length > 0)) {
    recurrence = describeRecurrence(draft.rrule ?? '', seriesUnsupported);
    if (recurrence.expansion === 'unsupported' && recurrence.unsupportedReason) {
      diagnostics.push({ line: draft.startLine, component: 'RRULE', message: `Event '${summary}': ${recurrence.unsupportedReason}` });
    }
  }

  const event: CalendarEvent = {
    uid,
    summary,
    ...(draft.location !== undefined ? { location: draft.location } : {}),
    ...(draft.description !== undefined ? { description: draft.description } : {}),
    ...(draft.organizer !== undefined ? { organizer: draft.organizer } : {}),
    start: draft.start,
    ...(draft.end !== undefined ? { end: draft.end } : {}),
    ...(recurrence !== undefined ? { recurrence } : {}),
    ...(draft.attendees !== undefined ? { attendees: draft.attendees } : {}),
    ...(isOverride ? { isOverride: true as const, recurrenceId: draft.recurrenceId } : {}),
    ...(draft.exdates.length > 0 ? { exdates: draft.exdates } : {}),
    ...(draft.rdates.length > 0 ? { rdates: draft.rdates } : {}),
    ...(recurrence !== undefined && draft.hasDateExceptions ? { hasSeriesExceptions: true as const } : {}),
  };
  events.push(event);
  if (isOverride) overrides.push(event);
}
