/**
 * ics-calendar.ts, iCalendar (RFC 5545) writing for the local calendar's export.
 *
 * Reading .ics text is the platform's (`parseIcs` and `expandEvent` in
 * `@goodvibes-jev/engine/platform/platform/calendar`), the same reader the feed
 * subscriptions use, so a file imported and a feed subscribed give the same events.
 *
 * Times are written in the form they were stored:
 *   - all-day: `DTSTART;VALUE=DATE:YYYYMMDD`;
 *   - UTC (stored with a trailing Z): `DTSTART:YYYYMMDDTHHMMSSZ`;
 *   - a named zone: `DTSTART;TZID=Zone:YYYYMMDDTHHMMSS` (no VTIMEZONE block; the
 *     calendar readers in common use accept an IANA name without one);
 *   - floating (no zone): `DTSTART:YYYYMMDDTHHMMSS`, no Z, so another calendar
 *     reads it as the same wall-clock time instead of shifting it by the offset.
 */

import type { EventDateTime } from '@goodvibes-jev/engine/platform/platform/calendar';

/** One event to write. Start and end use the stored forms named in the module header. */
export interface IcsEvent {
  readonly uid: string;
  readonly summary: string;
  readonly description?: string | undefined;
  readonly location?: string | undefined;
  readonly dtstart: string;
  readonly dtend?: string | undefined;
  readonly allDay: boolean;
  readonly tzid?: string | undefined;
  /** The RRULE value, e.g. `FREQ=WEEKLY;BYDAY=TH`. */
  readonly rrule?: string | undefined;
  readonly exdates?: readonly EventDateTime[] | undefined;
  readonly rdates?: readonly EventDateTime[] | undefined;
  /** When the record last changed, ISO-8601; written as DTSTAMP. */
  readonly dtstamp?: string | undefined;
}

/** Escape text for iCalendar output. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Fold a single content line at 75 octets (UTF-8 bytes), continuing with
 * CRLF + SPACE per RFC 5545 §3.1, never inside a multi-byte character.
 */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(line);
  if (bytes.length <= 75) return line;

  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let offset = 0;
  let firstChunk = true;
  while (offset < bytes.length) {
    const limit = firstChunk ? 75 : 74;
    let end = Math.min(offset + limit, bytes.length);
    while (end > offset + 1 && (bytes[end]! & 0xc0) === 0x80) end--;
    chunks.push(decoder.decode(bytes.slice(offset, end)));
    offset = end;
    firstChunk = false;
  }
  return chunks.join('\r\n ');
}

/** `2026-11-20T09:00:00` (optionally with Z) as `20261120T090000` (with Z kept). */
function compactDateTime(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(value.trim());
  if (!match) return value.replace(/[-:]/g, '');
  const [, y, mo, d, h, mi, s] = match;
  return `${y}${mo}${d}T${h}${mi}${s ?? '00'}${value.trim().endsWith('Z') ? 'Z' : ''}`;
}

function compactDate(value: string): string {
  return value.trim().slice(0, 10).replace(/-/g, '');
}

/** A UTC stamp for DTSTAMP from any ISO-8601 instant; the current time when unreadable. */
function stamp(iso: string | undefined): string {
  const date = iso ? new Date(iso) : new Date();
  const value = Number.isNaN(date.getTime()) ? new Date() : date;
  return `${value.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}

function icsLine(name: string, value: string, params?: string): string {
  return foldLine(`${params ? `${name};${params}` : name}:${value}`);
}

/** A DTSTART/DTEND line for a stored value. */
function timeLine(name: 'DTSTART' | 'DTEND', value: string, event: IcsEvent): string {
  if (event.allDay || !value.includes('T')) return icsLine(name, compactDate(value), 'VALUE=DATE');
  if (value.trim().endsWith('Z')) return icsLine(name, compactDateTime(value));
  if (event.tzid) return icsLine(name, compactDateTime(value), `TZID=${event.tzid}`);
  return icsLine(name, compactDateTime(value));
}

/** An EXDATE/RDATE line for one platform date value. */
function dateListLine(name: 'EXDATE' | 'RDATE', value: EventDateTime): string {
  if (value.kind === 'date') return icsLine(name, compactDate(value.value), 'VALUE=DATE');
  if (value.zone === 'tzid' && value.tzid) return icsLine(name, compactDateTime(value.value), `TZID=${value.tzid}`);
  return icsLine(name, compactDateTime(value.value));
}

/** Render events into one VCALENDAR with CRLF line endings, escaped text and folded lines. */
export function renderIcs(events: readonly IcsEvent[]): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'PRODID:-//GoodVibes Agent//Calendar//EN',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  for (const event of events) {
    lines.push('BEGIN:VEVENT');
    lines.push(icsLine('UID', escapeText(event.uid)));
    lines.push(icsLine('DTSTAMP', stamp(event.dtstamp)));
    lines.push(icsLine('SUMMARY', escapeText(event.summary)));
    lines.push(timeLine('DTSTART', event.dtstart, event));
    if (event.dtend) lines.push(timeLine('DTEND', event.dtend, event));
    if (event.description) lines.push(icsLine('DESCRIPTION', escapeText(event.description)));
    if (event.location) lines.push(icsLine('LOCATION', escapeText(event.location)));
    if (event.rrule) lines.push(icsLine('RRULE', event.rrule));
    for (const value of event.exdates ?? []) lines.push(dateListLine('EXDATE', value));
    for (const value of event.rdates ?? []) lines.push(dateListLine('RDATE', value));
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map((line) => `${line}\r\n`).join('');
}
