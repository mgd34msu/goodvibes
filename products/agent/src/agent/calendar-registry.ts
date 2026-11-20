import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  eventDateTimeEpochMs,
  expandEvent,
  parseIcs,
  type CalendarEvent,
  type EventDateTime,
  type RecurrenceInfo,
} from '@goodvibes/engine/platform/platform/calendar';
import { readJsonStore, updateJsonStore, type JsonStoreSpec, type JsonStoreWriteReport } from '@goodvibes/engine/terminal-shell/agent-turn/store-file';
import type { ShellPathService } from '@/runtime/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { assertNoSecretLikeText } from '@goodvibes/engine/terminal-shell/agent-turn/persona-registry';
import { renderIcs } from './ics-calendar.ts';

// ──────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────

/** How a stored event repeats: the platform's recurrence reading plus its exceptions. */
export interface AgentCalendarRecurrence extends RecurrenceInfo {
  /** Occurrences the series does not produce (EXDATE, and the starts of moved occurrences). */
  readonly exdates?: readonly EventDateTime[];
  /** Extra occurrences (RDATE). */
  readonly rdates?: readonly EventDateTime[];
}

export interface AgentCalendarEvent {
  readonly id: string;
  readonly title: string;
  /**
   * The stored start: `YYYY-MM-DD` for all-day; `YYYY-MM-DDTHH:MM:SS` for a
   * wall-clock time (in `tzid` when set, otherwise in the local zone);
   * the same with a trailing `Z` for UTC. In a list of upcoming events this is
   * the start of that occurrence.
   */
  readonly start: string;
  /** ISO-8601 end, optional, in the same form as `start`. */
  readonly end?: string;
  readonly allDay: boolean;
  readonly location?: string;
  readonly notes?: string;
  /** IANA zone of a TZID-qualified start; `start` then holds the wall-clock time in it. */
  readonly tzid?: string;
  /** Present when the event repeats. */
  readonly recurrence?: AgentCalendarRecurrence;
  /** The identity of the imported .ics event this came from (its UID, or a content digest when it had none). */
  readonly sourceProvenance?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentCalendarEventCreateInput {
  readonly title: string;
  readonly start: string;
  readonly end?: string;
  readonly allDay?: boolean;
  readonly location?: string;
  readonly notes?: string;
  /** IANA timezone identifier, if the start time is wall-clock in a named zone */
  readonly tzid?: string;
  readonly recurrence?: AgentCalendarRecurrence;
  readonly sourceProvenance?: string;
}

export interface AgentCalendarSnapshot {
  readonly path: string;
  readonly events: readonly AgentCalendarEvent[];
  /** Stored entries this version cannot read; they stay in the file as found. */
  readonly unreadableEntries: number;
  /** Why the whole file could not be read, when it could not. */
  readonly unreadable?: string;
}

/** What one import did with each event the file held. */
export interface AgentCalendarImportResult {
  readonly imported: readonly AgentCalendarEvent[];
  /** Events already in the calendar from an earlier import (same UID, or same content when the file gave none). */
  readonly duplicates: number;
  /** Events not imported because a field looked like a secret. */
  readonly secretSkipped: number;
  /** Events that had no title; they are imported as {@link UNTITLED_EVENT_TITLE}. */
  readonly untitled: number;
  /** VEVENTs the reader could not use (no start date), with its reason for each. */
  readonly notParsed: readonly string[];
  /** Repeating events whose rule this version does not expand; each shows on its first date only. */
  readonly unexpandedSeries: readonly string[];
  /** What the store write reported (entries kept as found, a copy of an unreadable file). */
  readonly write?: JsonStoreWriteReport;
}

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

const STORE_VERSION = 1;
const DAY_MS = 86_400_000;

/** The title an imported event with no SUMMARY is given, so a busy block is not lost. */
export const UNTITLED_EVENT_TITLE = 'Untitled event';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function nowIso(): string {
  return new Date().toISOString();
}

function slugify(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return slug || 'event';
}

function assertNoCalendarSecretLikeText(fields: readonly string[]): void {
  try {
    assertNoSecretLikeText(fields);
  } catch {
    throw new Error('Calendar events cannot store secret-looking values. Remove the sensitive text.');
  }
}

function parseDateValue(value: unknown): EventDateTime | null {
  if (!isRecord(value)) return null;
  const raw = readString(value.value).trim();
  const kind = value.kind === 'date' ? 'date' : value.kind === 'date-time' ? 'date-time' : null;
  const zone = value.zone === 'utc' || value.zone === 'tzid' || value.zone === 'floating' ? value.zone : null;
  if (!raw || !kind || !zone) return null;
  const tzid = readString(value.tzid).trim();
  return { value: raw, kind, zone, ...(tzid ? { tzid } : {}) };
}

function parseDateList(value: unknown): EventDateTime[] {
  if (!Array.isArray(value)) return [];
  return value.map(parseDateValue).filter((entry): entry is EventDateTime => entry !== null);
}

function parseRecurrence(value: unknown): AgentCalendarRecurrence | undefined {
  if (!isRecord(value)) return undefined;
  const rule = readString(value.rule).trim();
  const exdates = parseDateList(value.exdates);
  const rdates = parseDateList(value.rdates);
  if (!rule && rdates.length === 0) return undefined;
  const expansion = value.expansion === 'unsupported' ? 'unsupported' : 'full';
  const unsupportedReason = readString(value.unsupportedReason).trim();
  return {
    rule,
    expansion,
    ...(expansion === 'unsupported' && unsupportedReason ? { unsupportedReason } : {}),
    ...(exdates.length > 0 ? { exdates } : {}),
    ...(rdates.length > 0 ? { rdates } : {}),
  };
}

function parseEvent(value: unknown): AgentCalendarEvent | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id).trim();
  const title = readString(value.title).trim();
  const start = readString(value.start).trim();
  if (!id || !title || !start) return null;
  const recurrence = parseRecurrence(value.recurrence);
  return {
    id,
    title,
    start,
    end: readString(value.end).trim() || undefined,
    allDay: value.allDay === true,
    location: readString(value.location).trim() || undefined,
    notes: readString(value.notes).trim() || undefined,
    tzid: readString(value.tzid).trim() || undefined,
    ...(recurrence ? { recurrence } : {}),
    sourceProvenance: readString(value.sourceProvenance).trim() || undefined,
    createdAt: readString(value.createdAt, nowIso()),
    updatedAt: readString(value.updatedAt, nowIso()),
  };
}

const CALENDAR_STORE: JsonStoreSpec<AgentCalendarEvent> = {
  label: 'calendar store',
  entriesKey: 'events',
  version: STORE_VERSION,
  parseEntry: parseEvent,
};

type AgentLocalStorePaths = Pick<ShellPathService, 'resolveUserPath'>;

export function calendarStorePath(shellPaths: AgentLocalStorePaths): string {
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'calendar', 'events.json');
}

/** The local calendar date of an instant, `YYYY-MM-DD`: the convention stored wall-clock values use. */
export function localIsoDate(at: Date): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** `YYYY-MM-DD` plus `days` calendar days. */
function shiftIsoDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** A stored start or end as the platform's date value. */
function toEventDateTime(value: string, allDay: boolean, tzid: string | undefined): EventDateTime {
  const trimmed = value.trim();
  if (allDay || !trimmed.includes('T')) return { value: trimmed.slice(0, 10), kind: 'date', zone: 'floating' };
  if (trimmed.endsWith('Z')) return { value: trimmed, kind: 'date-time', zone: 'utc' };
  if (tzid) return { value: trimmed, kind: 'date-time', zone: 'tzid', tzid };
  return { value: trimmed, kind: 'date-time', zone: 'floating' };
}

function toCalendarEvent(event: AgentCalendarEvent): CalendarEvent {
  const { exdates, rdates, ...info } = event.recurrence ?? { rule: '', expansion: 'full' as const };
  return {
    uid: event.id,
    summary: event.title,
    start: toEventDateTime(event.start, event.allDay, event.tzid),
    ...(event.end ? { end: toEventDateTime(event.end, event.allDay, event.tzid) } : {}),
    ...(event.recurrence ? { recurrence: info } : {}),
    ...(exdates ? { exdates } : {}),
    ...(rdates ? { rdates } : {}),
  };
}

/** The local calendar date an occurrence falls on. */
function occurrenceLocalDate(event: AgentCalendarEvent, start: string): string {
  if (event.allDay || !start.includes('T')) return start.slice(0, 10);
  const ms = eventDateTimeEpochMs(toEventDateTime(start, false, event.tzid));
  return Number.isFinite(ms) ? localIsoDate(new Date(ms)) : start.slice(0, 10);
}

/** The occurrence's end, moved by the same amount its start moved from the series start. */
function occurrenceEnd(event: AgentCalendarEvent, start: string): string | undefined {
  if (!event.end || start === event.start) return event.end;
  const seriesStart = Date.parse(`${event.start.slice(0, 10)}T00:00:00Z`);
  const occurrenceStart = Date.parse(`${start.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(seriesStart) || !Number.isFinite(occurrenceStart)) return event.end;
  const endDay = Date.parse(`${event.end.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(endDay)) return event.end;
  return `${new Date(endDay + (occurrenceStart - seriesStart)).toISOString().slice(0, 10)}${event.end.slice(10)}`;
}

function startSortKey(event: AgentCalendarEvent): number {
  const ms = eventDateTimeEpochMs(toEventDateTime(event.start, event.allDay, event.tzid));
  if (!event.allDay) return ms;
  // An all-day event sorts at local midnight of its day.
  return new Date(`${event.start.slice(0, 10)}T00:00:00`).getTime();
}

/** The identity an imported event is recognised by on the next import. */
function importIdentity(event: CalendarEvent): string {
  const base = event.uid.startsWith('synthetic:')
    // The reader numbers events without a UID per parse, so the content stands in for it.
    ? `no-uid-${createHash('sha256').update(JSON.stringify([event.start.value, event.end?.value ?? '', event.summary, event.location ?? ''])).digest('hex').slice(0, 16)}`
    : event.uid;
  return event.isOverride && event.recurrenceId ? `${base}@${event.recurrenceId.value}` : base;
}

/** A start value as the local store keeps it. */
function storedValue(value: EventDateTime): string {
  return value.value;
}

// ──────────────────────────────────────────────────────────────────
// Registry
// ──────────────────────────────────────────────────────────────────

export class AgentCalendarRegistry {
  public constructor(private readonly storePath: string) {}

  public static fromShellPaths(shellPaths: AgentLocalStorePaths): AgentCalendarRegistry {
    return new AgentCalendarRegistry(calendarStorePath(shellPaths));
  }

  public snapshot(): AgentCalendarSnapshot {
    const store = readJsonStore(this.storePath, CALENDAR_STORE);
    const events = [...store.entries].sort((a, b) => a.start.localeCompare(b.start));
    return {
      path: this.storePath,
      events,
      unreadableEntries: store.keptAsFound.length,
      ...(store.unreadable === undefined ? {} : { unreadable: store.unreadable }),
    };
  }

  public list(): readonly AgentCalendarEvent[] {
    return this.snapshot().events;
  }

  public get(id: string): AgentCalendarEvent | null {
    const lookup = id.trim().toLowerCase();
    if (!lookup) return null;
    return this.list().find((e) => e.id.toLowerCase() === lookup) ?? null;
  }

  /**
   * The occurrences from today through `rangeDays` days ahead, in local
   * calendar days (the convention the stored wall-clock values use). A
   * repeating event yields each of its occurrences in the window, with its
   * exceptions applied; each row's `start` is that occurrence's start.
   */
  public upcoming(rangeDays = 7, now: Date = new Date()): readonly AgentCalendarEvent[] {
    const today = localIsoDate(now);
    const horizon = localIsoDate(new Date(now.getTime() + rangeDays * DAY_MS));
    // One day of margin each side: an instant's local date can differ from the date it is written with.
    const window = { from: shiftIsoDate(today, -1), to: shiftIsoDate(horizon, 1) };
    const rows: AgentCalendarEvent[] = [];
    for (const event of this.list()) {
      for (const occurrence of expandEvent(toCalendarEvent(event), window)) {
        const day = occurrenceLocalDate(event, occurrence.start);
        if (day < today || day > horizon) continue;
        const end = occurrenceEnd(event, occurrence.start);
        rows.push({ ...event, start: occurrence.start, ...(end === undefined ? {} : { end }) });
      }
    }
    return rows.sort((a, b) => startSortKey(a) - startSortKey(b));
  }

  public create(input: AgentCalendarEventCreateInput): AgentCalendarEvent {
    const title = input.title.trim();
    const start = input.start.trim();
    if (!title) throw new Error('Event title is required.');
    if (!start) throw new Error('Event start is required.');
    assertNoCalendarSecretLikeText([title, input.notes ?? '', input.location ?? '']);
    return updateJsonStore(this.storePath, CALENDAR_STORE, (store) => {
      const ids = new Set(store.entries.map((e) => e.id));
      const event = this.buildEvent(input, title, start, ids, nowIso());
      return { value: event, entries: [...store.entries, event] };
    }).value;
  }

  public delete(id: string): AgentCalendarEvent {
    return updateJsonStore(this.storePath, CALENDAR_STORE, (store) => {
      const lookup = id.trim().toLowerCase();
      const existing = lookup ? store.entries.find((e) => e.id.toLowerCase() === lookup) : undefined;
      if (!existing) throw new Error(`Unknown calendar event ${id}`);
      return { value: existing, entries: store.entries.filter((e) => e.id !== existing.id) };
    }).value;
  }

  /**
   * Import events from iCalendar (.ics) text, in one store transaction: one
   * read, one write, whatever the file's size.
   *
   * The file is read with the platform's reader, the one feed subscriptions use,
   * so a repeating event keeps its rule and its exceptions and is listed through
   * the same expansion. An event already imported (its UID, or its content when
   * the file gave no UID) is counted as a duplicate; one with a secret-looking
   * field is not imported and is counted; one with no title is imported under
   * {@link UNTITLED_EVENT_TITLE} and counted.
   */
  public importIcs(content: string): AgentCalendarImportResult {
    const parsed = parseIcs(content);
    let duplicates = 0;
    let secretSkipped = 0;
    let untitled = 0;
    const unexpandedSeries: string[] = [];
    const update = updateJsonStore(this.storePath, CALENDAR_STORE, (store) => {
      const ids = new Set(store.entries.map((e) => e.id));
      const known = new Set(store.entries.map((e) => e.sourceProvenance).filter((p): p is string => p !== undefined));
      const timestamp = nowIso();
      const imported: AgentCalendarEvent[] = [];
      for (const icsEvent of parsed.events) {
        const identity = importIdentity(icsEvent);
        if (known.has(identity)) {
          duplicates++;
          continue;
        }
        const summary = icsEvent.summary.trim();
        const hasTitle = summary !== '' && summary !== '(no title)';
        try {
          assertNoCalendarSecretLikeText([summary, icsEvent.description ?? '', icsEvent.location ?? '', icsEvent.uid]);
        } catch {
          secretSkipped++;
          continue;
        }
        if (!hasTitle) untitled++;
        if (icsEvent.recurrence?.expansion === 'unsupported') unexpandedSeries.push(hasTitle ? summary : UNTITLED_EVENT_TITLE);
        const allDay = icsEvent.start.kind === 'date';
        const tzid = icsEvent.start.zone === 'tzid' ? icsEvent.start.tzid : undefined;
        const recurrence: AgentCalendarRecurrence | undefined = icsEvent.recurrence || icsEvent.rdates?.length
          ? {
            ...(icsEvent.recurrence ?? { rule: '', expansion: 'full' as const }),
            ...(icsEvent.exdates?.length ? { exdates: icsEvent.exdates } : {}),
            ...(icsEvent.rdates?.length ? { rdates: icsEvent.rdates } : {}),
          }
          : undefined;
        const event = this.buildEvent({
          title: hasTitle ? summary : UNTITLED_EVENT_TITLE,
          start: storedValue(icsEvent.start),
          ...(icsEvent.end ? { end: storedValue(icsEvent.end) } : {}),
          allDay,
          ...(icsEvent.location?.trim() ? { location: icsEvent.location.trim() } : {}),
          ...(icsEvent.description?.trim() ? { notes: icsEvent.description.trim() } : {}),
          ...(tzid ? { tzid } : {}),
          ...(recurrence ? { recurrence } : {}),
          sourceProvenance: identity,
        }, hasTitle ? summary : UNTITLED_EVENT_TITLE, storedValue(icsEvent.start), ids, timestamp);
        ids.add(event.id);
        known.add(identity);
        imported.push(event);
      }
      return imported.length > 0
        ? { value: imported, entries: [...store.entries, ...imported] }
        : { value: imported };
    });
    return {
      imported: update.value,
      duplicates,
      secretSkipped,
      untitled,
      notParsed: parsed.skipped.map((entry) => entry.message),
      unexpandedSeries,
      ...(update.write ? { write: update.write } : {}),
    };
  }

  /**
   * Export events as iCalendar text.
   * @param eventIds - if provided, export only those IDs; otherwise exports all.
   * @param destPath - if provided, write to disk; throws if file already exists.
   */
  public exportIcs(eventIds?: readonly string[], destPath?: string): string {
    const all = this.list();
    const toExport = eventIds
      ? all.filter((e) => eventIds.includes(e.id))
      : all;

    const icsContent = renderIcs(
      toExport.map((e) => ({
        uid: e.sourceProvenance ?? e.id,
        summary: e.title,
        description: e.notes,
        location: e.location,
        dtstart: e.start,
        dtend: e.end,
        allDay: e.allDay,
        tzid: e.tzid,
        rrule: e.recurrence?.rule || undefined,
        exdates: e.recurrence?.exdates,
        rdates: e.recurrence?.rdates,
        dtstamp: e.updatedAt,
      })),
    );

    if (destPath) {
      const abs = resolve(destPath);
      if (existsSync(abs)) throw new Error(`File already exists: ${abs}. Remove it or choose a different path.`);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, icsContent, 'utf-8');
    }

    return icsContent;
  }

  private buildEvent(
    input: AgentCalendarEventCreateInput,
    title: string,
    start: string,
    ids: ReadonlySet<string>,
    timestamp: string,
  ): AgentCalendarEvent {
    return {
      id: nextId(title, ids),
      title,
      start,
      end: input.end?.trim() || undefined,
      allDay: input.allDay ?? !start.includes('T'),
      location: input.location?.trim() || undefined,
      notes: input.notes?.trim() || undefined,
      tzid: input.tzid?.trim() || undefined,
      ...(input.recurrence ? { recurrence: input.recurrence } : {}),
      sourceProvenance: input.sourceProvenance?.trim() || undefined,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }
}

/** The title's slug, or the slug and a short random suffix when that id is taken. */
function nextId(title: string, ids: ReadonlySet<string>): string {
  const base = slugify(title);
  if (!ids.has(base)) return base;
  for (;;) {
    const candidate = `${base}-${randomBytes(3).toString('hex')}`;
    if (!ids.has(candidate)) return candidate;
  }
}
