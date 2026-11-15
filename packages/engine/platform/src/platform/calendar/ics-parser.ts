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
 *    with honest zone anchoring: trailing 'Z' => utc; TZID=... => tzid (wall time
 *    kept, NOT offset-converted, because this build has no tz database); otherwise
 *    floating. RRULE is captured raw and handed to the recurrence expander.
 *  - RFC 5545 line unfolding (a leading space/tab continues the previous line) and
 *    TEXT unescaping (\\n \\, \\; \\, \\\\).
 *
 * Everything unrecognised is ignored quietly EXCEPT the two things a caller must be
 * told about: a VEVENT with no usable DTSTART is `skipped` with a reason, and an
 * RRULE we do not fully expand is flagged on the event (in rrule.ts), never dropped.
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
import { parseContentLine as parseWireContentLine, unescapeText } from './caldav-ics.js';

interface ContentLine {
  readonly name: string;
  readonly params: ReadonlyMap<string, string>;
  readonly value: string;
  /** 1-based line number of the first physical line of this (possibly folded) line. */
  readonly line: number;
}

/**
 * Unfold physical lines into logical content lines (RFC 5545 §3.1). A line beginning
 * with a single space or tab is a continuation of the previous line.
 */
function unfold(text: string): { raw: string; line: number }[] {
  const physical = text.split(/\r\n|\r|\n/);
  const out: { raw: string; line: number }[] = [];
  for (let i = 0; i < physical.length; i++) {
    const cur = physical[i] ?? '';
    if ((cur.startsWith(' ') || cur.startsWith('\t')) && out.length > 0) {
      out[out.length - 1]!.raw += cur.slice(1);
    } else {
      out.push({ raw: cur, line: i + 1 });
    }
  }
  return out;
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

const DATE_ONLY = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/;

/** Parse a DTSTART/DTEND value + params into an honest EventDateTime, or undefined. */
function parseDateValue(
  value: string,
  params: ReadonlyMap<string, string>,
): EventDateTime | undefined {
  const trimmed = value.trim();
  const isDateParam = params.get('VALUE') === 'DATE';
  const tzid = params.get('TZID');

  const dateMatch = DATE_ONLY.exec(trimmed);
  if (dateMatch && (isDateParam || !trimmed.includes('T'))) {
    const [, y, m, d] = dateMatch;
    return { value: `${y}-${m}-${d}`, kind: 'date', zone: 'floating' };
  }

  const dtMatch = DATE_TIME.exec(trimmed);
  if (dtMatch) {
    const [, y, m, d, hh, mm, ss, z] = dtMatch;
    const local = `${y}-${m}-${d}T${hh}:${mm}:${ss}`;
    if (z === 'Z') {
      return { value: `${local}Z`, kind: 'date-time', zone: 'utc' };
    }
    if (tzid) {
      return { value: local, kind: 'date-time', zone: 'tzid', tzid };
    }
    return { value: local, kind: 'date-time', zone: 'floating' };
  }
  return undefined;
}

let syntheticCounter = 0;

/** Build a stable synthetic UID for a VEVENT that omitted one. */
function syntheticUid(start: EventDateTime | undefined, summary: string): string {
  syntheticCounter += 1;
  const stamp = start?.value ?? 'no-start';
  const slug = summary.replace(/\s+/g, '-').slice(0, 24) || 'event';
  return `synthetic:${slug}:${stamp}:${syntheticCounter}`;
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
  /** Properties that change which occurrences a series has (EXDATE, RDATE, RECURRENCE-ID). */
  seriesParts: string[];
  startLine: number;
}

/**
 * Parse .ics text into typed events plus honest skip/diagnostic lists.
 *
 * @param text raw .ics content (file body or fetched feed body).
 */
export function parseIcs(text: string): ParsedCalendar {
  const lines = unfold(text);
  const events: CalendarEvent[] = [];
  const overrideUids: string[] = [];
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
      draft = { startLine: line, seriesParts: [] };
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
      if (draft) finalizeEvent(draft, events, skipped, diagnostics, overrideUids);
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
        if (parsed) draft.start = parsed;
        else diagnostics.push({ line: cl.line, component: 'DTSTART', message: `Unrecognised DTSTART value '${cl.value.trim()}', event kept without a usable start.` });
        break;
      }
      case 'DTEND': {
        const parsed = parseDateValue(cl.value, cl.params);
        if (parsed) draft.end = parsed;
        else diagnostics.push({ line: cl.line, component: 'DTEND', message: `Unrecognised DTEND value '${cl.value.trim()}', event kept without an end.` });
        break;
      }
      case 'RRULE':
        draft.rrule = cl.value.trim();
        break;
      case 'EXDATE':
      case 'RDATE':
      case 'RECURRENCE-ID':
        if (!draft.seriesParts.includes(cl.name)) draft.seriesParts.push(cl.name);
        break;
      default:
        break;
    }
  }

  if (inEvent && draft) {
    diagnostics.push({ line: draft.startLine, component: 'VEVENT', message: 'VEVENT was not closed with END:VEVENT before end of feed, finalised anyway.' });
    finalizeEvent(draft, events, skipped, diagnostics, overrideUids);
  }

  // A RECURRENCE-ID override moves or replaces one occurrence of the series
  // sharing its UID, so that series cannot be expanded from its RRULE alone.
  const overridden = new Set(overrideUids);
  const finalEvents = events.map((event) => {
    if (!event.recurrence || event.isOverride === true || !overridden.has(event.uid)) return event;
    if (event.recurrence.expansion !== 'full') return { ...event, hasSeriesExceptions: true as const };
    const recurrence = describeRecurrence(event.recurrence.rule, ['RECURRENCE-ID overrides']);
    if (recurrence.unsupportedReason) {
      diagnostics.push({ line: 0, component: 'RRULE', message: `Event '${event.summary}': ${recurrence.unsupportedReason}` });
    }
    return { ...event, recurrence, hasSeriesExceptions: true as const };
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
  overrideUids: string[],
): void {
  if (!draft.start) {
    skipped.push({ line: draft.startLine, component: 'VEVENT', message: `Skipped VEVENT '${draft.summary ?? draft.uid ?? 'untitled'}', no usable DTSTART.` });
    return;
  }
  const summary = draft.summary ?? '(no title)';
  const uid = draft.uid && draft.uid !== '' ? draft.uid : syntheticUid(draft.start, summary);

  let recurrence;
  if (draft.rrule) {
    recurrence = describeRecurrence(draft.rrule, draft.seriesParts.filter((part) => part !== 'RECURRENCE-ID'));
    if (recurrence.expansion === 'unsupported' && recurrence.unsupportedReason) {
      diagnostics.push({ line: draft.startLine, component: 'RRULE', message: `Event '${summary}': ${recurrence.unsupportedReason}` });
    }
  } else {
    // RDATE or EXDATE without an RRULE still makes a series; reading it as a one-off would drop those dates silently.
    const dateParts = draft.seriesParts.filter((part) => part === 'RDATE' || part === 'EXDATE');
    if (dateParts.length > 0) {
      recurrence = describeRecurrence('', dateParts);
      diagnostics.push({ line: draft.startLine, component: dateParts[0]!, message: `Event '${summary}': ${recurrence.unsupportedReason}` });
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
    ...(draft.seriesParts.includes('RECURRENCE-ID') ? { isOverride: true as const } : {}),
    ...(recurrence !== undefined && draft.seriesParts.some((part) => part === 'RDATE' || part === 'EXDATE') ? { hasSeriesExceptions: true as const } : {}),
  };
  events.push(event);
  if (draft.seriesParts.includes('RECURRENCE-ID')) overrideUids.push(uid);
}
