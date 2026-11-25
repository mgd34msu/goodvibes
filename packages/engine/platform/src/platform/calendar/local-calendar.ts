/**
 * local-calendar.ts, the daemon's own calendar on this computer: the events
 * kept here (`<daemon home>/calendar/events.json`) and the calendar feeds
 * subscribed to (`<daemon home>/calendar/subscriptions.json`, each feed's
 * address in the daemon's secret store). Served beside the connected remote
 * calendars as one calendar (control-plane/routes/calendar-composition.ts).
 *
 * The Agent kept these itself up to 3.5.0 (`~/.goodvibes/agent/calendar/`, the
 * same two files, the same format). They are carried into the daemon's once,
 * at the daemon's first start of this version, copied as they are (an entry
 * this version cannot read included); the Agent's files are left untouched, so
 * a 3.5.0 Agent after a rollback still has every event and feed it had, but
 * not what was added here since. The feeds' addresses were already in the
 * daemon's secret store (credential-scope-registry.ts `GOODVIBES_CALENDAR_SUB_`).
 *
 * Reading a feed's events for a person or a turn records an untrusted ingest
 * (the feed's text is written by whoever controls the feed); fetching a feed
 * never does (arrival is not ingest, docs/decisions/2026-07-27).
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeDocument } from '../utils/atomic-json-store.js';
import { containsIssuerCredential } from '../utils/redaction.js';
import { postToPublicWebhook } from '../utils/url-safety.js';
import { resolveGoodVibesDaemonHome } from '../config/goodvibes-home.js';
import { parseIcs } from './ics-parser.js';
import { expandEvent, expandEvents } from './rrule.js';
import { eventDateTimeEpochMs } from './merged-calendar-model.js';
import { DEFAULT_REFRESH_INTERVAL_MS, SubscriptionStore, maskFeedUrl } from './subscription-store.js';
import { recordCalendarEventIngest, type CalendarUntrustedIngestRecorder } from './untrusted-events.js';
import type { CalendarEvent, EventDateTime, FeedFetcher, RecurrenceInfo, SubscriptionHealth } from './types.js';

// ── Where it is kept ──────────────────────────────────────────────────────────

export interface LocalCalendarPaths {
  readonly events: string;
  readonly feeds: string;
}

/** The daemon's own files. */
export function localCalendarPaths(homeDirectory: string): LocalCalendarPaths {
  const root = join(resolveGoodVibesDaemonHome(homeDirectory), 'calendar');
  return { events: join(root, 'events.json'), feeds: join(root, 'subscriptions.json') };
}

/** The Agent's files up to 3.5.0. */
export function agentCalendarPaths(homeDirectory: string): LocalCalendarPaths {
  const root = join(homeDirectory, '.goodvibes', 'agent', 'calendar');
  return { events: join(root, 'events.json'), feeds: join(root, 'subscriptions.json') };
}

/**
 * Carry the Agent's events and feeds into the daemon's files once: a daemon file that does not exist yet is
 * written with the Agent's file as it is. Returns what was carried. The Agent's files are only read.
 */
export function carryAgentCalendar(homeDirectory: string): { readonly events: boolean; readonly feeds: boolean } {
  const from = agentCalendarPaths(homeDirectory);
  const to = localCalendarPaths(homeDirectory);
  const carry = (source: string, target: string): boolean => {
    if (existsSync(target) || !existsSync(source)) return false;
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, readFileSync(source), { mode: 0o600 });
    return true;
  };
  return { events: carry(from.events, to.events), feeds: carry(from.feeds, to.feeds) };
}

// ── A small store: one JSON file, entries read one by one, an unreadable entry kept as found ──

interface StoreRead<T> {
  readonly exists: boolean;
  readonly entries: T[];
  /** Entries this version cannot read: written back as they were. */
  readonly kept: unknown[];
  /** Why the whole file could not be read. */
  readonly unreadable?: string | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

function readStore<T>(path: string, key: string, parse: (value: unknown) => T | null): StoreRead<T> {
  if (!existsSync(path)) return { exists: false, entries: [], kept: [] };
  let body: unknown;
  try { body = JSON.parse(readFileSync(path, 'utf8')); } catch (error) {
    return { exists: true, entries: [], kept: [], unreadable: error instanceof Error ? error.message : String(error) };
  }
  const raw = isRecord(body) && Array.isArray(body[key]) ? body[key] as unknown[] : [];
  const entries: T[] = [];
  const kept: unknown[] = [];
  for (const entry of raw) {
    const parsed = parse(entry);
    if (parsed === null) kept.push(entry); else entries.push(parsed);
  }
  return { exists: true, entries, kept };
}

function writeStore<T>(path: string, key: string, read: StoreRead<T>, entries: readonly T[]): void {
  // A file that could not be read is kept beside the new one before it is replaced.
  if (read.unreadable && existsSync(path)) writeFileSync(`${path}.unreadable-${Date.now()}`, readFileSync(path), { mode: 0o600 });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeDocument(path, { version: 1, [key]: [...entries, ...read.kept] });
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i, /\bsk-[A-Za-z0-9_-]{16,}\b/, /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, /\b(?:password|passwd|api[_-]?key|token|secret)\s*[:=]\s*\S{6,}/i,
];
function secretLike(fields: readonly string[]): boolean {
  return fields.some((field) => containsIssuerCredential(field) || SECRET_PATTERNS.some((pattern) => pattern.test(field)));
}

// ── Events ───────────────────────────────────────────────────────────────────

export interface LocalRecurrence extends RecurrenceInfo {
  readonly exdates?: readonly EventDateTime[];
  readonly rdates?: readonly EventDateTime[];
}

/** One event kept here (the Agent's 3.5.0 record, field for field). */
export interface LocalEvent {
  readonly id: string;
  readonly title: string;
  /** `YYYY-MM-DD` all day; `YYYY-MM-DDTHH:MM:SS` wall clock (in `tzid`, else local); with `Z` for UTC. */
  readonly start: string;
  readonly end?: string | undefined;
  readonly allDay: boolean;
  readonly location?: string | undefined;
  readonly notes?: string | undefined;
  readonly tzid?: string | undefined;
  readonly recurrence?: LocalRecurrence | undefined;
  readonly sourceProvenance?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const UNTITLED_EVENT_TITLE = 'Untitled event';
const DAY_MS = 86_400_000;

function dateValue(value: unknown): EventDateTime | null {
  if (!isRecord(value)) return null;
  const raw = str(value.value).trim();
  const kind = value.kind === 'date' ? 'date' : value.kind === 'date-time' ? 'date-time' : null;
  const zone = value.zone === 'utc' || value.zone === 'tzid' || value.zone === 'floating' ? value.zone : null;
  if (!raw || !kind || !zone) return null;
  const tzid = str(value.tzid).trim();
  return { value: raw, kind, zone, ...(tzid ? { tzid } : {}) };
}

function parseEvent(value: unknown): LocalEvent | null {
  if (!isRecord(value)) return null;
  const id = str(value.id).trim();
  const title = str(value.title).trim();
  const start = str(value.start).trim();
  if (!id || !title || !start) return null;
  const opt = (key: string): string | undefined => str(value[key]).trim() || undefined;
  let recurrence: LocalRecurrence | undefined;
  if (isRecord(value.recurrence)) {
    const rule = str(value.recurrence.rule).trim();
    const list = (key: string): EventDateTime[] => (Array.isArray((value.recurrence as Record<string, unknown>)[key]) ? ((value.recurrence as Record<string, unknown>)[key] as unknown[]).map(dateValue).filter((entry): entry is EventDateTime => entry !== null) : []);
    const exdates = list('exdates');
    const rdates = list('rdates');
    if (rule || rdates.length > 0) {
      const expansion = value.recurrence.expansion === 'unsupported' ? 'unsupported' : 'full';
      const reason = str(value.recurrence.unsupportedReason).trim();
      recurrence = { rule, expansion, ...(expansion === 'unsupported' && reason ? { unsupportedReason: reason } : {}), ...(exdates.length > 0 ? { exdates } : {}), ...(rdates.length > 0 ? { rdates } : {}) };
    }
  }
  const now = new Date().toISOString();
  return {
    id, title, start, end: opt('end'), allDay: value.allDay === true, location: opt('location'), notes: opt('notes'), tzid: opt('tzid'),
    ...(recurrence ? { recurrence } : {}), sourceProvenance: opt('sourceProvenance'),
    createdAt: str(value.createdAt, now), updatedAt: str(value.updatedAt, now),
  };
}

/** A stored start or end as the platform's date value. */
function toDateTime(value: string, allDay: boolean, tzid: string | undefined): EventDateTime {
  const trimmed = value.trim();
  if (allDay || !trimmed.includes('T')) return { value: trimmed.slice(0, 10), kind: 'date', zone: 'floating' };
  if (trimmed.endsWith('Z')) return { value: trimmed, kind: 'date-time', zone: 'utc' };
  if (tzid) return { value: trimmed, kind: 'date-time', zone: 'tzid', tzid };
  return { value: trimmed, kind: 'date-time', zone: 'floating' };
}

function toCalendarEvent(event: LocalEvent): CalendarEvent {
  const { exdates, rdates, ...info } = event.recurrence ?? { rule: '', expansion: 'full' as const };
  return {
    uid: event.id, summary: event.title, start: toDateTime(event.start, event.allDay, event.tzid),
    ...(event.end ? { end: toDateTime(event.end, event.allDay, event.tzid) } : {}),
    ...(event.recurrence ? { recurrence: info } : {}), ...(exdates ? { exdates } : {}), ...(rdates ? { rdates } : {}),
  };
}

/** An instant's local date, `YYYY-MM-DD`. */
function localDate(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}
function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** One occurrence of an event in a window: its own start (and end, moved with it). */
export interface LocalOccurrence {
  readonly event: LocalEvent;
  readonly start: string;
  readonly end?: string | undefined;
  /** The occurrence's instant (ms), for ordering beside other calendars' events. */
  readonly at: number;
}

function occurrenceEnd(event: LocalEvent, start: string): string | undefined {
  if (!event.end || start === event.start) return event.end;
  const series = Date.parse(`${event.start.slice(0, 10)}T00:00:00Z`);
  const occurrence = Date.parse(`${start.slice(0, 10)}T00:00:00Z`);
  const endDay = Date.parse(`${event.end.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(series) || !Number.isFinite(occurrence) || !Number.isFinite(endDay)) return event.end;
  return `${new Date(endDay + (occurrence - series)).toISOString().slice(0, 10)}${event.end.slice(10)}`;
}

function instantOf(event: LocalEvent, start: string): number {
  if (event.allDay || !start.includes('T')) return new Date(`${start.slice(0, 10)}T00:00:00`).getTime();
  return eventDateTimeEpochMs(toDateTime(start, false, event.tzid));
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'event';
}
function nextId(title: string, ids: ReadonlySet<string>): string {
  const base = slug(title);
  if (!ids.has(base)) return base;
  for (;;) {
    const candidate = `${base}-${randomBytes(3).toString('hex')}`;
    if (!ids.has(candidate)) return candidate;
  }
}

export interface LocalEventInput {
  readonly title: string;
  readonly start: string;
  readonly end?: string | undefined;
  readonly location?: string | undefined;
  readonly notes?: string | undefined;
}

export interface LocalImportResult {
  readonly imported: readonly LocalEvent[];
  readonly duplicates: number;
  readonly secretSkipped: number;
  readonly untitled: number;
  readonly notParsed: readonly string[];
  readonly unexpandedSeries: readonly string[];
}

/** The events kept on this computer. */
export class LocalCalendarEvents {
  constructor(private readonly path: string) {}

  read(): StoreRead<LocalEvent> {
    return readStore(this.path, 'events', parseEvent);
  }

  list(): readonly LocalEvent[] {
    return [...this.read().entries].sort((a, b) => a.start.localeCompare(b.start));
  }

  get(id: string): LocalEvent | null {
    const lookup = id.trim().toLowerCase();
    return this.list().find((event) => event.id.toLowerCase() === lookup) ?? null;
  }

  /** Every occurrence from `from` to `to`, in local calendar days, a repeating event at each of its occurrences. */
  occurrences(from: Date, to: Date): readonly LocalOccurrence[] {
    const first = localDate(from);
    const last = localDate(to);
    const window = { from: shiftDate(first, -1), to: shiftDate(last, 1) };
    const rows: LocalOccurrence[] = [];
    for (const event of this.list()) {
      for (const occurrence of expandEvent(toCalendarEvent(event), window)) {
        const at = instantOf(event, occurrence.start);
        const day = Number.isFinite(at) ? localDate(new Date(at)) : occurrence.start.slice(0, 10);
        if (day < first || day > last) continue;
        rows.push({ event, start: occurrence.start, end: occurrenceEnd(event, occurrence.start), at });
      }
    }
    return rows.sort((a, b) => a.at - b.at);
  }

  create(input: LocalEventInput): LocalEvent {
    const title = input.title.trim();
    const start = input.start.trim();
    if (!title) throw new Error('An event needs a title.');
    if (!start) throw new Error('An event needs a start.');
    if (secretLike([title, input.notes ?? '', input.location ?? ''])) throw new Error('A calendar event cannot keep a secret-looking value; remove the sensitive text.');
    const read = this.read();
    const now = new Date().toISOString();
    const event: LocalEvent = {
      id: nextId(title, new Set(read.entries.map((entry) => entry.id))), title, start,
      end: input.end?.trim() || undefined, allDay: !start.includes('T'), location: input.location?.trim() || undefined,
      notes: input.notes?.trim() || undefined, createdAt: now, updatedAt: now,
    };
    writeStore(this.path, 'events', read, [...read.entries, event]);
    return event;
  }

  update(id: string, changes: Partial<LocalEventInput>): LocalEvent | null {
    const read = this.read();
    const lookup = id.trim().toLowerCase();
    const existing = read.entries.find((entry) => entry.id.toLowerCase() === lookup);
    if (!existing) return null;
    const title = changes.title?.trim() || existing.title;
    const start = changes.start?.trim() || existing.start;
    if (secretLike([title, changes.notes ?? '', changes.location ?? ''])) throw new Error('A calendar event cannot keep a secret-looking value; remove the sensitive text.');
    const changed: LocalEvent = {
      ...existing, title, start, allDay: !start.includes('T'),
      ...(changes.end !== undefined ? { end: changes.end.trim() || undefined } : {}),
      ...(changes.location !== undefined ? { location: changes.location.trim() || undefined } : {}),
      ...(changes.notes !== undefined ? { notes: changes.notes.trim() || undefined } : {}),
      updatedAt: new Date().toISOString(),
    };
    writeStore(this.path, 'events', read, read.entries.map((entry) => (entry === existing ? changed : entry)));
    return changed;
  }

  delete(id: string): LocalEvent | null {
    const read = this.read();
    const lookup = id.trim().toLowerCase();
    const existing = read.entries.find((entry) => entry.id.toLowerCase() === lookup);
    if (!existing) return null;
    writeStore(this.path, 'events', read, read.entries.filter((entry) => entry !== existing));
    return existing;
  }

  /** Add a file's events; one already imported (its UID, or its content when it has none) is skipped. */
  importIcs(content: string): LocalImportResult {
    const parsed = parseIcs(content);
    const read = this.read();
    const ids = new Set(read.entries.map((entry) => entry.id));
    const known = new Set(read.entries.map((entry) => entry.sourceProvenance).filter((value): value is string => Boolean(value)));
    const now = new Date().toISOString();
    const imported: LocalEvent[] = [];
    let duplicates = 0, secretSkipped = 0, untitled = 0;
    const unexpandedSeries: string[] = [];
    for (const icsEvent of parsed.events) {
      const base = icsEvent.uid.startsWith('synthetic:')
        ? `no-uid-${createHash('sha256').update(JSON.stringify([icsEvent.start.value, icsEvent.end?.value ?? '', icsEvent.summary, icsEvent.location ?? ''])).digest('hex').slice(0, 16)}`
        : icsEvent.uid;
      const identity = icsEvent.isOverride && icsEvent.recurrenceId ? `${base}@${icsEvent.recurrenceId.value}` : base;
      if (known.has(identity)) { duplicates += 1; continue; }
      const summary = icsEvent.summary.trim();
      const hasTitle = summary !== '' && summary !== '(no title)';
      if (secretLike([summary, icsEvent.description ?? '', icsEvent.location ?? '', icsEvent.uid])) { secretSkipped += 1; continue; }
      if (!hasTitle) untitled += 1;
      const title = hasTitle ? summary : UNTITLED_EVENT_TITLE;
      if (icsEvent.recurrence?.expansion === 'unsupported') unexpandedSeries.push(title);
      const recurrence: LocalRecurrence | undefined = icsEvent.recurrence || icsEvent.rdates?.length
        ? { ...(icsEvent.recurrence ?? { rule: '', expansion: 'full' as const }), ...(icsEvent.exdates?.length ? { exdates: icsEvent.exdates } : {}), ...(icsEvent.rdates?.length ? { rdates: icsEvent.rdates } : {}) }
        : undefined;
      const event: LocalEvent = {
        id: nextId(title, ids), title, start: icsEvent.start.value, end: icsEvent.end?.value, allDay: icsEvent.start.kind === 'date',
        location: icsEvent.location?.trim() || undefined, notes: icsEvent.description?.trim() || undefined,
        tzid: icsEvent.start.zone === 'tzid' ? icsEvent.start.tzid : undefined, ...(recurrence ? { recurrence } : {}),
        sourceProvenance: identity, createdAt: now, updatedAt: now,
      };
      ids.add(event.id);
      known.add(identity);
      imported.push(event);
    }
    if (imported.length > 0) writeStore(this.path, 'events', read, [...read.entries, ...imported]);
    return { imported, duplicates, secretSkipped, untitled, notParsed: parsed.skipped.map((entry) => entry.message), unexpandedSeries };
  }

  /** Every event kept here as iCalendar text. */
  exportIcs(): string {
    return renderIcs(this.list());
  }
}

// ── iCalendar writing (the stored forms: all day, UTC, a named zone, floating) ──

function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function foldLine(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let offset = 0;
  let first = true;
  while (offset < bytes.length) {
    let end = Math.min(offset + (first ? 75 : 74), bytes.length);
    while (end > offset + 1 && (bytes[end]! & 0xc0) === 0x80) end--;
    chunks.push(decoder.decode(bytes.slice(offset, end)));
    offset = end;
    first = false;
  }
  return chunks.join('\r\n ');
}
function compactDateTime(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(value.trim());
  if (!match) return value.replace(/[-:]/g, '');
  const [, y, mo, d, h, mi, s] = match;
  return `${y}${mo}${d}T${h}${mi}${s ?? '00'}${value.trim().endsWith('Z') ? 'Z' : ''}`;
}
const compactDate = (value: string): string => value.trim().slice(0, 10).replace(/-/g, '');
const line = (name: string, value: string, params?: string): string => foldLine(`${params ? `${name};${params}` : name}:${value}`);
function timeLine(name: 'DTSTART' | 'DTEND', value: string, event: LocalEvent): string {
  if (event.allDay || !value.includes('T')) return line(name, compactDate(value), 'VALUE=DATE');
  if (value.trim().endsWith('Z')) return line(name, compactDateTime(value));
  if (event.tzid) return line(name, compactDateTime(value), `TZID=${event.tzid}`);
  return line(name, compactDateTime(value));
}
function listLine(name: 'EXDATE' | 'RDATE', value: EventDateTime): string {
  if (value.kind === 'date') return line(name, compactDate(value.value), 'VALUE=DATE');
  if (value.zone === 'tzid' && value.tzid) return line(name, compactDateTime(value.value), `TZID=${value.tzid}`);
  return line(name, compactDateTime(value.value));
}
function renderIcs(events: readonly LocalEvent[]): string {
  const lines = ['BEGIN:VCALENDAR', 'PRODID:-//GoodVibes//Calendar//EN', 'VERSION:2.0', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const event of events) {
    const updated = new Date(event.updatedAt);
    lines.push('BEGIN:VEVENT', line('UID', escapeText(event.sourceProvenance ?? event.id)),
      line('DTSTAMP', `${(Number.isNaN(updated.getTime()) ? new Date() : updated).toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`),
      line('SUMMARY', escapeText(event.title)), timeLine('DTSTART', event.start, event));
    if (event.end) lines.push(timeLine('DTEND', event.end, event));
    if (event.notes) lines.push(line('DESCRIPTION', escapeText(event.notes)));
    if (event.location) lines.push(line('LOCATION', escapeText(event.location)));
    if (event.recurrence?.rule) lines.push(line('RRULE', event.recurrence.rule));
    for (const value of event.recurrence?.exdates ?? []) lines.push(listLine('EXDATE', value));
    for (const value of event.recurrence?.rdates ?? []) lines.push(listLine('RDATE', value));
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map((entry) => `${entry}\r\n`).join('');
}

// ── Feeds ────────────────────────────────────────────────────────────────────

interface FeedRecord {
  readonly name: string;
  /** The secret store key holding the feed's address (it can grant read access to the whole calendar). */
  readonly secretKey: string;
  readonly maskedUrl?: string | undefined;
  readonly refreshIntervalMs: number;
  readonly allowPrivateHost?: true | undefined;
  readonly lastFetchedAt?: number | undefined;
  readonly lastSucceededAt?: number | undefined;
  readonly etag?: string | undefined;
  readonly lastModified?: string | undefined;
  readonly lastResult?: 'ok' | 'not-modified' | 'unreachable' | 'parse-error' | undefined;
  readonly lastDetail?: string | undefined;
  readonly eventCount?: number | undefined;
  readonly events: readonly CalendarEvent[];
}

function parseFeed(value: unknown): FeedRecord | null {
  if (!isRecord(value)) return null;
  const name = str(value.name).trim();
  const secretKey = str(value.secretKey);
  if (!name || !secretKey) return null;
  const num = (key: string): number | undefined => (typeof value[key] === 'number' ? value[key] as number : undefined);
  const lastResult = value.lastResult === 'ok' || value.lastResult === 'not-modified' || value.lastResult === 'unreachable' || value.lastResult === 'parse-error' ? value.lastResult : undefined;
  return {
    name, secretKey, maskedUrl: str(value.maskedUrl) || undefined, refreshIntervalMs: num('refreshIntervalMs') ?? DEFAULT_REFRESH_INTERVAL_MS,
    ...(value.allowPrivateHost === true ? { allowPrivateHost: true as const } : {}),
    lastFetchedAt: num('lastFetchedAt'), lastSucceededAt: num('lastSucceededAt'), etag: str(value.etag) || undefined,
    lastModified: str(value.lastModified) || undefined, lastResult, lastDetail: str(value.lastDetail) || undefined, eventCount: num('eventCount'),
    events: Array.isArray(value.events) ? value.events.filter(isRecord) as unknown as CalendarEvent[] : [],
  };
}

/** A feed's address in the secret store, by the name the person gave it (the Agent's 3.5.0 keys). */
function secretKeyFor(name: string): string {
  const key = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  return `GOODVIBES_CALENDAR_SUB_${key || 'FEED'}`;
}

/** The secret store the feeds' addresses are kept in (the daemon's). */
export interface FeedSecrets {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** One feed as a person reads it: never its address, only its site and the end of its path. */
export interface FeedStatus {
  readonly name: string;
  readonly maskedUrl: string;
  readonly health: SubscriptionHealth;
  readonly detail?: string | undefined;
  readonly refreshIntervalMs: number;
  readonly allowPrivateHost: boolean;
  readonly lastSucceededAt?: number | undefined;
  readonly eventCount: number;
}

/** One occurrence of a feed's event, read-only. */
export interface FeedOccurrence {
  readonly feed: string;
  readonly event: CalendarEvent;
  readonly start: string;
  /** Its rule is one this version does not expand: it may repeat in the window, unshown. */
  readonly repeatsNotShown?: boolean | undefined;
}

const FEED_TIMEOUT_MS = 30_000;
const FEED_MAX_BYTES = 5 * 1024 * 1024;

/** A feed is fetched as an outward request: https or webcal only, a public host unless the owner allowed his network, time and size bounded. */
export function createFeedFetcher(options: { readonly allowPrivateHosts?: boolean; readonly send?: (url: string, init: RequestInit) => Promise<Response> } = {}): FeedFetcher {
  const send = options.send ?? (options.allowPrivateHosts ? (url: string, init: RequestInit) => fetch(url, init) : (url: string, init: RequestInit) => postToPublicWebhook(url, init));
  const target = (raw: string): { url: string } | { problem: string } => {
    let parsed: URL;
    try { parsed = new URL(raw.trim().replace(/^webcals?:\/\//i, 'https://')); } catch { return { problem: 'The feed address is not a valid address' }; }
    if (parsed.protocol !== 'https:') return { problem: `A feed address must use https or webcal, not ${parsed.protocol.replace(/:$/, '')}` };
    return { url: parsed.toString() };
  };
  return async (request) => {
    try {
      const headers: Record<string, string> = { Accept: 'text/calendar, text/plain, */*' };
      if (request.etag) headers['If-None-Match'] = request.etag;
      if (request.lastModified) headers['If-Modified-Since'] = request.lastModified;
      const signal = AbortSignal.timeout(FEED_TIMEOUT_MS);
      let at = target(request.url);
      let response: Response | undefined;
      for (let hop = 0; hop <= 5; hop += 1) {
        if ('problem' in at) return { kind: 'error', message: at.problem };
        response = await send(at.url, { method: 'GET', headers, signal, redirect: 'manual' });
        const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
        if (location === null) break;
        await response.body?.cancel();
        at = target(new URL(location, at.url).toString());
        response = undefined;
      }
      if (!response) return { kind: 'error', message: 'The feed redirected more than 5 times' };
      const validators = { ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}), ...(response.headers.get('last-modified') ? { lastModified: response.headers.get('last-modified')! } : {}) };
      if (response.status === 304) return { kind: 'not-modified', ...validators };
      if (!response.ok) return { kind: 'error', status: response.status, message: response.statusText || `HTTP ${response.status}` };
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > FEED_MAX_BYTES) { await response.body?.cancel(); return { kind: 'error', message: 'The feed is larger than 5 MiB' }; }
      const body = await response.text();
      if (body.length > FEED_MAX_BYTES) return { kind: 'error', message: 'The feed is larger than 5 MiB' };
      return { kind: 'ok', body, ...validators };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { kind: 'error', message: !options.allowPrivateHosts && /host is not allowed|resolves to .*address|private/.test(message)
        ? `${message.replace(/^Webhook URL/, 'The feed address')}. If this calendar server is on your own network, subscribe again choosing "Allow my private network"`
        : message.replace(/^Webhook URL/, 'The feed address') };
    }
  };
}

/** The calendar feeds subscribed to: their addresses in the secret store, their events cached here. */
export class LocalCalendarFeeds {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly secrets: FeedSecrets,
    private readonly fetchers: { readonly public: FeedFetcher; readonly privateNetwork: FeedFetcher } = { public: createFeedFetcher(), privateNetwork: createFeedFetcher({ allowPrivateHosts: true }) },
    private readonly recordUntrustedIngest?: CalendarUntrustedIngestRecorder,
  ) {}

  read(): StoreRead<FeedRecord> {
    return readStore(this.path, 'subscriptions', parseFeed);
  }

  /** One write at a time: the slow fetches run outside it, the read-merge-write inside. */
  private locked<T>(run: () => Promise<T> | T): Promise<T> {
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  names(): readonly string[] {
    return this.read().entries.map((feed) => feed.name);
  }

  find(name: string): FeedRecord | undefined {
    const lookup = name.trim().toLowerCase();
    return this.read().entries.find((feed) => feed.name.toLowerCase() === lookup);
  }

  statuses(now = Date.now()): readonly FeedStatus[] {
    return this.read().entries.map((feed) => {
      const health = healthOf(feed, now);
      const detail = health === 'stale' && feed.lastSucceededAt !== undefined
        ? `Last read ${Math.round((now - feed.lastSucceededAt) / 60_000)} min ago (past its ${Math.round(feed.refreshIntervalMs / 60_000)} min).`
        : feed.lastDetail;
      return {
        name: feed.name, maskedUrl: feed.maskedUrl ?? 'its address is in the secret store', health, ...(detail ? { detail } : {}),
        refreshIntervalMs: feed.refreshIntervalMs, allowPrivateHost: feed.allowPrivateHost === true,
        ...(feed.lastSucceededAt !== undefined ? { lastSucceededAt: feed.lastSucceededAt } : {}), eventCount: feed.eventCount ?? feed.events.length,
      };
    });
  }

  /** Subscribe: read the feed once, keep its address in the secret store and its events here. */
  async subscribe(url: string, options: { readonly name?: string | undefined; readonly everyMinutes?: number | undefined; readonly privateNetwork?: boolean | undefined }): Promise<
    { readonly ok: true; readonly name: string; readonly eventCount: number } | { readonly ok: false; readonly detail: string }> {
    const interval = options.everyMinutes !== undefined ? Math.max(15, Math.floor(options.everyMinutes)) * 60_000 : DEFAULT_REFRESH_INTERVAL_MS;
    const store = new SubscriptionStore({ fetcher: options.privateNetwork ? this.fetchers.privateNetwork : this.fetchers.public, defaultRefreshIntervalMs: interval });
    const added = await store.add({ url, ...(options.name?.trim() ? { name: options.name.trim() } : {}), refreshIntervalMs: interval });
    if (!added.ok) return { ok: false, detail: added.detail };
    const subscription = added.subscription;
    const events = store.events(subscription.name);
    return this.locked(async () => {
      const read = this.read();
      const secretKey = secretKeyFor(subscription.name);
      const clash = read.entries.find((feed) => feed.name.toLowerCase() === subscription.name.toLowerCase() || feed.secretKey === secretKey);
      if (clash) return { ok: false as const, detail: `A feed named "${clash.name}" is already subscribed to; give this one another name.` };
      await this.secrets.set(secretKey, url);
      const record: FeedRecord = {
        name: subscription.name, secretKey, maskedUrl: maskFeedUrl(url), refreshIntervalMs: subscription.refreshIntervalMs,
        ...(options.privateNetwork ? { allowPrivateHost: true as const } : {}),
        lastFetchedAt: subscription.lastFetchedAt, lastSucceededAt: subscription.lastSucceededAt, etag: subscription.etag, lastModified: subscription.lastModified,
        lastResult: 'ok', lastDetail: subscription.detail, eventCount: events.length, events: [...events],
      };
      try { writeStore(this.path, 'subscriptions', read, [...read.entries, record]); } catch (error) {
        await this.secrets.delete(secretKey).catch(() => undefined);
        throw error;
      }
      return { ok: true as const, name: subscription.name, eventCount: events.length };
    });
  }

  /** Stop subscribing: the feed, its events and its stored address go. */
  async unsubscribe(name: string): Promise<{ readonly removed: boolean; readonly addressDeleted: boolean }> {
    return this.locked(async () => {
      const read = this.read();
      const target = read.entries.find((feed) => feed.name.toLowerCase() === name.trim().toLowerCase());
      if (!target) return { removed: false, addressDeleted: false };
      writeStore(this.path, 'subscriptions', read, read.entries.filter((feed) => feed !== target));
      try { await this.secrets.delete(target.secretKey); return { removed: true, addressDeleted: true }; } catch { return { removed: true, addressDeleted: false }; }
    });
  }

  /** Read the feeds (or the one named) again: every one when `force`, else those older than their interval. */
  async refresh(name?: string, options: { readonly force?: boolean } = {}): Promise<readonly { readonly name: string; readonly outcome: string; readonly detail?: string | undefined; readonly eventCount?: number | undefined }[]> {
    const read = this.read();
    const targets = name ? read.entries.filter((feed) => feed.name.toLowerCase() === name.trim().toLowerCase()) : read.entries;
    const refreshed = new Map<string, FeedRecord>();
    const outcomes: { name: string; outcome: string; detail?: string | undefined; eventCount?: number | undefined }[] = [];
    for (const target of targets) {
      const url = await this.secrets.get(target.secretKey).catch(() => null);
      if (url === null) {
        const detail = 'Its address is not in the secret store: subscribe to it again.';
        // Said on the feed too, so its row shows it was not reached (its events are kept).
        refreshed.set(target.name, { ...target, lastResult: 'unreachable', lastDetail: detail });
        outcomes.push({ name: target.name, outcome: 'unreachable', detail });
        continue;
      }
      const store = new SubscriptionStore({ fetcher: target.allowPrivateHost ? this.fetchers.privateNetwork : this.fetchers.public });
      store.restore([{ name: target.name, url, refreshIntervalMs: target.refreshIntervalMs, ...(target.lastFetchedAt !== undefined ? { lastFetchedAt: target.lastFetchedAt } : {}),
        ...(target.lastSucceededAt !== undefined ? { lastSucceededAt: target.lastSucceededAt } : {}), ...(target.etag !== undefined ? { etag: target.etag } : {}),
        ...(target.lastModified !== undefined ? { lastModified: target.lastModified } : {}) }], { callerKeepsEvents: true });
      const report = await store.refresh(target.name, { force: options.force ?? true });
      if (report.outcome === 'skipped') continue;
      const sub = store.get(target.name)!;
      const events = report.outcome === 'updated' ? store.events(target.name) : target.events;
      refreshed.set(target.name, {
        ...target, maskedUrl: maskFeedUrl(url), lastFetchedAt: sub.lastFetchedAt, lastSucceededAt: sub.lastSucceededAt, etag: sub.etag, lastModified: sub.lastModified,
        lastResult: report.outcome === 'updated' ? 'ok' : report.outcome === 'not-modified' ? 'not-modified' : report.outcome === 'parse-error' ? 'parse-error' : 'unreachable',
        lastDetail: report.detail, eventCount: events.length, events: [...events],
      });
      outcomes.push({ name: target.name, outcome: report.outcome, ...(report.detail ? { detail: report.detail } : {}), eventCount: events.length });
    }
    if (refreshed.size > 0) {
      await this.locked(() => {
        const fresh = this.read();
        writeStore(this.path, 'subscriptions', fresh, fresh.entries.map((feed) => refreshed.get(feed.name) ?? feed));
      });
    }
    return outcomes;
  }

  /** Every feed's events (each event once, a repeating one at its first date), read by a person or a turn. */
  seeds(): readonly FeedOccurrence[] {
    const rows: FeedOccurrence[] = [];
    for (const feed of this.read().entries) {
      this.recordRead(feed);
      for (const event of feed.events) rows.push({ feed: feed.name, event, start: event.start.value });
    }
    return rows.sort((a, b) => a.start.localeCompare(b.start));
  }

  /** The feeds' occurrences from `from` to `to` (local calendar days), read by a person or a turn. */
  occurrences(from: Date, to: Date): readonly FeedOccurrence[] {
    const window = { from: localDate(from), to: localDate(to) };
    const rows: FeedOccurrence[] = [];
    for (const feed of this.read().entries) {
      this.recordRead(feed);
      const { occurrences, unexpandedSeries } = expandEvents(feed.events, window);
      for (const occurrence of occurrences) rows.push({ feed: feed.name, event: occurrence.event, start: occurrence.start });
      const shown = new Set(occurrences.map((occurrence) => occurrence.event));
      for (const series of unexpandedSeries) if (!shown.has(series)) rows.push({ feed: feed.name, event: series, start: series.start.value, repeatsNotShown: true });
    }
    return rows.sort((a, b) => a.start.localeCompare(b.start));
  }

  private recordRead(feed: FeedRecord): void {
    if (!this.recordUntrustedIngest) return;
    recordCalendarEventIngest({
      record: this.recordUntrustedIngest,
      provenance: { kind: 'subscription', name: feed.name, maskedUrl: feed.maskedUrl ?? '(feed address in the secret store)' },
      events: feed.events, at: new Date().toISOString(),
    });
  }
}

function healthOf(feed: FeedRecord, now: number): SubscriptionHealth {
  if (feed.lastResult === undefined) return 'never-fetched';
  if (feed.lastResult === 'unreachable') return 'unreachable';
  if (feed.lastResult === 'parse-error') return 'parse-error';
  if (feed.lastSucceededAt === undefined) return 'never-fetched';
  return now - feed.lastSucceededAt > feed.refreshIntervalMs * 2 ? 'stale' : 'ok';
}

// ── The daemon's one local calendar ─────────────────────────────────────────

export interface DaemonLocalCalendar {
  readonly events: LocalCalendarEvents;
  readonly feeds: LocalCalendarFeeds;
  readonly paths: LocalCalendarPaths;
}

const LOCAL_CALENDARS = new Map<string, DaemonLocalCalendar>();

/**
 * The daemon's local calendar for a home folder, one per process however many compositions reach it (the calendar
 * methods, the capabilities); the Agent's 3.5.0 calendar is carried into it on the first reach.
 */
export function daemonLocalCalendar(homeDirectory: string, secrets: FeedSecrets, recordUntrustedIngest?: CalendarUntrustedIngestRecorder): DaemonLocalCalendar {
  const paths = localCalendarPaths(homeDirectory);
  const known = LOCAL_CALENDARS.get(paths.events);
  if (known) return known;
  try { carryAgentCalendar(homeDirectory); } catch { /* the Agent's files stay where they are; the daemon's start empty */ }
  const calendar: DaemonLocalCalendar = {
    events: new LocalCalendarEvents(paths.events),
    feeds: new LocalCalendarFeeds(paths.feeds, secrets, undefined, recordUntrustedIngest),
    paths,
  };
  LOCAL_CALENDARS.set(paths.events, calendar);
  return calendar;
}
