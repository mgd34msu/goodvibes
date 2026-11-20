/**
 * calendar-runtime.ts: this app's host for `/calendar` (one description shared
 * with the Agent, terminal-shell/calendar-command.ts), over the daemon's
 * calendar capability.
 *
 * No calendar logic lives here. CalDAV, ICS parsing, settings resolution and
 * the confirmation gate are the daemon's calendar handlers; this file reads
 * the times typed, renders results, and refuses honestly when the capability
 * is not set up. Adding, changing and removing an event reach the calendar's
 * guests: changing and removing ask first, and the daemon gates each call on
 * `body.confirm` and an explicit user request.
 *
 * `calendar.ics.import` and `calendar.ics.export` are bulk transfers of a
 * whole calendar whose natural home is a file path and a scheduled job; here
 * "Import events from a file" and "Export events to a file" are the Agent's,
 * on its own events, and this app says so.
 */

import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { registerCalendarCommand, type CalendarEventChange, type CalendarNewEvent } from '@goodvibes-jev/engine/terminal-shell/calendar-command';
import type { ListRow } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import {
  EXPLICIT_WRITE_INVOCATION_CONTEXT,
  claimIrreversibleWrite,
  READ_INVOCATION_CONTEXT,
  errorText,
  probeConnection,
  renderConnectionStatus,
} from './connection-status.ts';

/** Agenda item, exactly the daemon's `calendar.events.list` item shape. */
interface CalendarEvent {
  readonly id: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly location?: string;
  readonly description?: string;
  readonly attendees?: readonly string[];
}

const MAX_LIST_LIMIT = 200;

/** `+HH:MM` / `-HH:MM` for a `Date.getTimezoneOffset()` value (minutes west of UTC). */
function offsetLabel(minutesWest: number): string {
  const east = -minutesWest;
  const sign = east >= 0 ? '+' : '-';
  const abs = Math.abs(east);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * Render a timestamp for a terminal agenda, in this machine's zone with the
 * offset shown (`2026-08-01 09:00 -05:00`), so a reader anywhere knows which
 * hour is meant.
 *
 * An unparseable value is printed verbatim rather than replaced with a
 * placeholder, showing what the server actually returned is more useful than
 * hiding it behind "invalid date".
 */
export function formatWhen(raw: string): string {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  const pad = (value: number): string => String(value).padStart(2, '0');
  const date = `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
  return `${date} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())} ${offsetLabel(parsed.getTimezoneOffset())}`;
}

/** An ISO-8601 time ends in `Z` or a `±HH:MM` offset when it names its zone. */
const NAMES_ZONE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

/**
 * One time typed for `/calendar create`, as the instant that is sent. A time
 * without a zone is read in this machine's zone and sent with that offset, so
 * the daemon cannot read it in another one; `zoneStated` says the zone was
 * chosen here.
 */
export function normaliseEventTime(raw: string): { readonly instant: string; readonly zoneStated: boolean } | null {
  const trimmed = raw.trim();
  // A bare date is read as UTC midnight by Date; it is meant as midnight here.
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00` : trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  const pad = (value: number): string => String(value).padStart(2, '0');
  const local = `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`;
  return { instant: `${local}${offsetLabel(parsed.getTimezoneOffset())}`, zoneStated: !NAMES_ZONE.test(trimmed) };
}

function truncate(value: string, width: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

export function renderAgenda(events: readonly CalendarEvent[]): string {
  if (events.length === 0) return 'No events in this window.';
  const lines = [`Agenda: ${events.length} event${events.length === 1 ? '' : 's'}:`];
  for (const event of events) {
    const where = event.location ? `  @ ${truncate(event.location, 24)}` : '';
    lines.push(`  ${formatWhen(event.start)}  ${truncate(event.title, 44).padEnd(44)}${where}`);
  }
  lines.push('', '  /calendar get <event> opens one; /calendar change and /calendar delete act on one.');
  return lines.join('\n');
}

export function renderEvent(event: CalendarEvent): string {
  const lines = [
    `Title:  ${event.title}`,
    `Start:  ${formatWhen(event.start)}`,
    `End:    ${formatWhen(event.end)}`,
  ];
  if (event.location) lines.push(`Where:  ${event.location}`);
  const attendees = event.attendees ?? [];
  if (attendees.length > 0) lines.push(`With:   ${attendees.join(', ')}`);
  if (event.description && event.description.trim().length > 0) {
    lines.push('', event.description.trimEnd());
  }
  return lines.join('\n');
}

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

type Gateway = NonNullable<CommandContext['workspace']['gatewayMethods']>;

/** Every failure says why and, since "not set up" is the usual cause, carries the connection status with its next step. */
async function withStatusOnFailure<T>(gateway: Gateway, label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Error && 'refusal' in error) throw error;
    throw commandRefusal(`${label}: ${errorText(error)}\n${renderConnectionStatus(await probeConnection(gateway, 'calendar'))}`);
  }
}

function gatewayOf(ctx: CommandContext): Gateway {
  const gateway = ctx.workspace.gatewayMethods;
  if (!gateway) throw commandRefusal('The calendar is the daemon\'s, and this terminal is not connected to it.', '/calendar status says what to do');
  return gateway;
}

async function eventsAhead(gateway: Gateway, days: number, limit: number): Promise<{ readonly events?: readonly CalendarEvent[]; readonly more?: boolean }> {
  const from = new Date();
  return await gateway.invoke('calendar.events.list', {
    ...READ_INVOCATION_CONTEXT,
    body: { limit, from: from.toISOString(), to: new Date(from.getTime() + days * 86_400_000).toISOString() },
  }) as { readonly events?: readonly CalendarEvent[]; readonly more?: boolean };
}

/** A time typed for an event, as the instant sent, or a refusal naming the blank. */
function eventTime(label: string, raw: string): { readonly instant: string; readonly zoneStated: boolean } {
  const time = normaliseEventTime(raw);
  if (!time) throw commandRefusal(`${label}: "${raw}" is not a time. Use ISO-8601, for example 2026-08-01T14:00:00Z. Nothing was changed.`);
  return time;
}

async function addEvent(ctx: CommandContext, event: CalendarNewEvent, again: boolean): Promise<string> {
  const gateway = gatewayOf(ctx);
  if (!event.end) throw commandRefusal('The daemon\'s calendar needs an end time: give Ends (--end). Nothing was added.');
  const start = eventTime('Starts', event.start);
  const end = eventTime('Ends', event.end);
  if (!claimIrreversibleWrite(gateway, `calendar.create\0${event.title}\0${start.instant}\0${end.instant}`, again)) {
    throw commandRefusal('This exact event was already added (or an add was attempted and its outcome is unknown) from this session, so it was not added again.',
      'Check the calendar first; to add it anyway choose "Add it again" (/calendar add ... --again)');
  }
  return await withStatusOnFailure(gateway, 'The event was not added', async () => {
    const result = await gateway.invoke('calendar.events.create', {
      ...EXPLICIT_WRITE_INVOCATION_CONTEXT,
      body: {
        title: event.title, start: start.instant, end: end.instant, confirm: true,
        ...(event.location ? { location: event.location } : {}), ...(event.notes ? { description: event.notes } : {}),
      },
    }) as { readonly eventId: string; readonly createdAt: string };
    const zone = start.zoneStated || end.zoneStated ? ` A time typed without a zone was read in this machine's zone, UTC${offsetLabel(new Date(start.instant).getTimezoneOffset())}.` : '';
    return `Added "${event.title}", ${formatWhen(start.instant)} to ${formatWhen(end.instant)} (event ${result.eventId}).${zone}`;
  });
}

async function changeEvent(ctx: CommandContext, eventId: string, change: CalendarEventChange): Promise<string> {
  const gateway = gatewayOf(ctx);
  const allDay = (change.start === undefined || BARE_DATE.test(change.start)) && (change.end === undefined || BARE_DATE.test(change.end))
    && (change.start !== undefined || change.end !== undefined);
  const timeOf = (label: string, raw: string | undefined): string | undefined => raw === undefined ? undefined : allDay ? raw : eventTime(label, raw).instant;
  const start = timeOf('Starts', change.start);
  const end = timeOf('Ends', change.end);
  return await withStatusOnFailure(gateway, 'The event was not changed', async () => {
    const result = await gateway.invoke('calendar.events.update', {
      ...EXPLICIT_WRITE_INVOCATION_CONTEXT,
      body: { eventId, ...(change.title ? { title: change.title } : {}), ...(start ? { start } : {}), ...(end ? { end } : {}), confirm: true },
    }) as { readonly eventId: string; readonly updatedAt: string };
    return `Changed event ${result.eventId}. /calendar get ${result.eventId} shows it now.`;
  });
}

export function registerCalendarRuntimeCommands(registry: CommandRegistry): void {
  registerCalendarCommand<CommandContext>(registry, {
    status: async (ctx) => renderConnectionStatus(await probeConnection(ctx.workspace.gatewayMethods, 'calendar')),
    async upcoming(ctx, days) {
      const gateway = gatewayOf(ctx);
      return await withStatusOnFailure(gateway, 'The calendar could not be read', async () => {
        const result = await eventsAhead(gateway, days, MAX_LIST_LIMIT);
        return [renderAgenda(result.events ?? []), ...(result.more === true ? [`  More events follow than the ${MAX_LIST_LIMIT} shown; ask for fewer days.`] : [])].join('\n');
      });
    },
    async events(ctx) {
      const result = await eventsAhead(gatewayOf(ctx), 30, 50);
      return (result.events ?? []).map((event): ListRow => ({ value: event.id, label: truncate(event.title, 50), detail: formatWhen(event.start) }));
    },
    async get(ctx, eventId) {
      const gateway = gatewayOf(ctx);
      return await withStatusOnFailure(gateway, 'The event could not be read', async () =>
        renderEvent(await gateway.invoke('calendar.events.get', { ...READ_INVOCATION_CONTEXT, body: { eventId } }) as CalendarEvent));
    },
    add: addEvent,
    change: changeEvent,
    async remove(ctx, eventId) {
      const gateway = gatewayOf(ctx);
      return await withStatusOnFailure(gateway, 'The event was not removed', async () => {
        const result = await gateway.invoke('calendar.events.delete', { ...EXPLICIT_WRITE_INVOCATION_CONTEXT, body: { eventId, confirm: true } }) as { readonly eventId: string; readonly deleted: boolean };
        return result.deleted ? `Removed event ${result.eventId}.` : `Event ${result.eventId} was not on the calendar any more, so nothing was removed.`;
      });
    },
  });
}
