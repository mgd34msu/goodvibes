/**
 * calendar-runtime.ts, `/calendar`, the terminal surface over the daemon's
 * calendar capability.
 *
 * As with `/mail`, no calendar logic lives here. CalDAV, ICS parsing, settings
 * resolution and the confirmation gate are all in
 * `src/daemon/handlers/calendar/`; this file parses arguments, renders results,
 * and refuses honestly when the capability is not set up.
 *
 * ## What is exposed, and what is not
 *
 * `list` (the agenda) and `get` are exposed: knowing what is next without
 * leaving the terminal is the whole value of a calendar on this surface.
 * `create`, `update` and `delete` each ask once before they run (the command
 * registry's one confirmation, showing the event or the change with its times
 * in this machine's zone), because each reaches the calendar's guests, and the
 * daemon gates the call on both `body.confirm` and an explicit user request.
 *
 * `calendar.ics.import` and `calendar.ics.export` are deliberately NOT given a
 * command. They are bulk file-level transfers of a whole calendar, an
 * operation whose natural home is a file path and a scheduled job, not a line
 * typed into a coding session. They stay available to any surface through the
 * same catalog; this product simply does not claim to be the right place for
 * them. That is a scoping decision, recorded here so it reads as a choice
 * rather than an omission.
 */

import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { splitLeadingFlags } from './mail-runtime.ts';
import { rawRestAfterLeadingFlags } from '@goodvibes-jev/engine/terminal-shell/slash-command-parser';
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

const DEFAULT_LIST_LIMIT = 20;
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
  lines.push('', '  /calendar get <id>: open one event   /calendar update <id> …   /calendar delete <id>');
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

/**
 * Read `title | start | end`: the start and end are the last two fields (a
 * time holds no pipe) and the title is everything before them, pipes included.
 * Same separator as `/mail`, for the same reason: titles contain spaces.
 */
export function parseEventArgs(raw: string): { title: string; start: string; end: string } | null {
  const last = raw.lastIndexOf('|');
  const middle = last < 0 ? -1 : raw.lastIndexOf('|', last - 1);
  if (middle < 0) return null;
  const title = raw.slice(0, middle).trim();
  const start = raw.slice(middle + 1, last).trim();
  const end = raw.slice(last + 1).trim();
  if (!title || !start || !end) return null;
  return { title, start, end };
}

/**
 * Read the fields of `/calendar update <id> <title | start | end>`. Any field
 * may be left empty to keep it; the start and end are the last two fields and
 * the title is everything before them. Null when the line is not three fields
 * or changes nothing.
 */
export function parseEventUpdateArgs(raw: string): { title?: string; start?: string; end?: string } | null {
  const last = raw.lastIndexOf('|');
  const middle = last < 0 ? -1 : raw.lastIndexOf('|', last - 1);
  if (middle < 0) return null;
  const title = raw.slice(0, middle).trim();
  const start = raw.slice(middle + 1, last).trim();
  const end = raw.slice(last + 1).trim();
  if (!title && !start && !end) return null;
  return { ...(title ? { title } : {}), ...(start ? { start } : {}), ...(end ? { end } : {}) };
}

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `--again` creates an event identical to one already created; `--confirm` was the old second step and has no effect. */
const CREATE_FLAGS: ReadonlySet<string> = new Set(['--again', '--confirm']);

function parseLimit(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(MAX_LIST_LIMIT, Math.floor(parsed));
}

const createRawRest = rawRestAfterLeadingFlags(['create'], new Set(['--yes', ...CREATE_FLAGS]));

const USAGE = [
  'Usage:',
  '  /calendar                   connection status and the agenda ahead',
  '  /calendar status            connection status only',
  '  /calendar list [n]          the next n events (default 20)',
  '  /calendar get <id>          open one event',
  '  /calendar create [--yes] [--again] <title | start | end>   shows the event and asks once, then creates it',
  '  /calendar update [--yes] <id> <title | start | end>       shows the change and asks once; leave a field empty to keep it',
  '  /calendar delete [--yes] <id>                             asks once, then removes the event',
  '',
  '  --yes and --again go before the title or id; the same words inside the title are text.',
  '  Guests are told of a change or a removal by the calendar.',
  '  Times are ISO-8601, e.g. 2026-08-01T14:00:00Z or 2026-08-01T09:00:00-05:00;',
  '  a time without a zone is read in this machine\'s zone, which the question names.',
].join('\n');

export function registerCalendarRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'calendar',
    aliases: ['cal'],
    description: 'Calendar over the daemon: connection status, agenda, event detail, create, update, delete',
    usage: '[status|list|get|create|update|delete] …',
    argsHint: '[status|list <n>|get <id>|create|update <id>|delete <id>]',
    subcommands: {
      status: '', list: '[n]', get: '<id>', create: '[--yes] [--again] <title | start | end>',
      update: '[--yes] <id> <title | start | end>', delete: '[--yes] <id>',
    },
    // --yes counts only before the title: the same word inside the title is text.
    leadingFlagsOnly: true,
    // From the title on the line is taken as typed: the title keeps its spacing and quotes.
    rawRest: (args, upcoming) => {
      if ((args[0] ?? '').toLowerCase() !== 'update') return createRawRest(args, upcoming);
      // `update [--yes] <id>`, then the fields are taken as typed.
      const words = args.slice(1);
      const id = words.findIndex((word) => word !== '--yes');
      return id >= 0 && id === words.length - 1 ? args.length : undefined;
    },
    confirm(args) {
      const verb = (args[0] ?? '').toLowerCase();
      if (verb === 'update') {
        const plan = planEventUpdate(args.slice(1));
        if (!plan.ok) return undefined;
        return { title: `Change calendar event ${plan.eventId}?`, detail: plan.lines.join('\n'), confirmLabel: 'Change' };
      }
      if (verb === 'delete') {
        const eventId = args[1];
        if (!eventId) return undefined;
        return {
          title: `Delete calendar event ${eventId}?`,
          detail: [
            `Event id: ${eventId} (open it first with /calendar get ${eventId} to see which event this is).`,
            'It is removed from the calendar and its guests are told; this app cannot restore it.',
          ].join('\n'),
          confirmLabel: 'Delete',
        };
      }
      if (verb !== 'create') return undefined;
      const plan = planEventCreate(args.slice(1));
      if (!plan.ok) return undefined; // The handler prints the usage or the refusal; nothing is created.
      return {
        title: `Create calendar event "${plan.title}"?`,
        detail: plan.lines.join('\n'),
        confirmLabel: 'Create',
      };
    },
    async handler(args, ctx) {
      const gateway = ctx.workspace.gatewayMethods;
      const sub = (args[0] ?? '').toLowerCase();

      if (sub === 'status') {
        ctx.print(renderConnectionStatus(await probeConnection(gateway, 'calendar')));
        return;
      }

      if (!gateway) {
        ctx.print(renderConnectionStatus(await probeConnection(undefined, 'calendar')));
        return;
      }

      if (sub === '' || sub === 'list') {
        await listEvents(ctx, gateway, parseLimit(args[1]), sub === '');
        return;
      }
      if (sub === 'get') {
        await getEvent(ctx, gateway, args[1]);
        return;
      }
      if (sub === 'create') {
        await createEvent(ctx, gateway, args.slice(1));
        return;
      }
      if (sub === 'update') {
        await updateEvent(ctx, gateway, args.slice(1));
        return;
      }
      if (sub === 'delete') {
        await deleteEvent(ctx, gateway, args[1]);
        return;
      }
      ctx.print(USAGE);
    },
  });
}

type Gateway = NonNullable<CommandContext['workspace']['gatewayMethods']>;

async function withStatusOnFailure(
  ctx: CommandContext,
  gateway: Gateway,
  label: string,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    ctx.print(`[calendar ${label}] ${errorText(error)}`);
    ctx.print(renderConnectionStatus(await probeConnection(gateway, 'calendar')));
  }
}

async function listEvents(ctx: CommandContext, gateway: Gateway, limit: number, withStatus: boolean): Promise<void> {
  await withStatusOnFailure(ctx, gateway, 'list', async () => {
    const result = await gateway.invoke('calendar.events.list', {
      ...READ_INVOCATION_CONTEXT,
      body: { limit, from: new Date().toISOString() },
    }) as { readonly events?: readonly CalendarEvent[] };
    if (withStatus) {
      ctx.print(renderConnectionStatus({
        surface: 'calendar',
        state: 'ready',
        detail: 'Calendar is connected: the daemon reached the server and returned a result.',
        nextActions: [],
      }));
    }
    ctx.print(renderAgenda(result.events ?? []));
  });
}

async function getEvent(ctx: CommandContext, gateway: Gateway, eventId: string | undefined): Promise<void> {
  if (!eventId) {
    ctx.print('Usage: /calendar get <id>; the id from /calendar list.');
    return;
  }
  await withStatusOnFailure(ctx, gateway, 'get', async () => {
    const event = await gateway.invoke('calendar.events.get', {
      ...READ_INVOCATION_CONTEXT,
      body: { eventId },
    }) as CalendarEvent;
    ctx.print(renderEvent(event));
  });
}

/** A `/calendar create` line read into the event it creates, or why it creates nothing. */
type EventCreatePlan =
  | { readonly ok: true; readonly title: string; readonly start: string; readonly end: string; readonly again: boolean; readonly lines: readonly string[] }
  | { readonly ok: false; readonly problem: string };

function planEventCreate(rest: readonly string[]): EventCreatePlan {
  // Flags are read only before the title, so the same word inside the title is text.
  const line = splitLeadingFlags(rest, CREATE_FLAGS);
  const parsed = parseEventArgs(line.text);
  if (parsed === null) {
    return {
      ok: false,
      problem: [
        'Usage: /calendar create [--again] <title | start | end>',
        '  Three fields separated by |; start and end are the last two. For example:',
        '  /calendar create Design review | 2026-08-01T14:00:00Z | 2026-08-01T15:00:00Z',
      ].join('\n'),
    };
  }
  const start = normaliseEventTime(parsed.start);
  const end = normaliseEventTime(parsed.end);
  if (!start || !end) {
    return { ok: false, problem: `Not created: ${!start ? `start "${parsed.start}"` : `end "${parsed.end}"`} is not a time. Use ISO-8601, for example 2026-08-01T14:00:00Z.` };
  }
  const lines = [
    `Title: ${parsed.title}`,
    `Start: ${formatWhen(start.instant)}`,
    `End:   ${formatWhen(end.instant)}`,
    ...(start.zoneStated || end.zoneStated
      ? [`A time typed without a zone is read in this machine's zone, UTC${offsetLabel(new Date(start.instant).getTimezoneOffset())}.`]
      : []),
    'Change it later with /calendar update <id>, or remove it with /calendar delete <id>.',
  ];
  return { ok: true, title: parsed.title, start: start.instant, end: end.instant, again: line.flags.has('--again'), lines };
}

async function createEvent(ctx: CommandContext, gateway: Gateway, rest: readonly string[]): Promise<void> {
  const plan = planEventCreate(rest);
  if (!plan.ok) {
    ctx.print(plan.problem);
    return;
  }
  // The registry has asked the owner by now (or the owner typed --yes), so this is the user's own explicit request.
  if (!claimIrreversibleWrite(gateway, `calendar.create\0${plan.title}\0${plan.start}\0${plan.end}`, plan.again)) {
    ctx.print('This exact event was already created (or a create was attempted and its outcome is unknown) from this session, so it was not created again. Check the calendar first; to create it anyway put --again before the title: /calendar create --again <title | start | end>.');
    return;
  }

  await withStatusOnFailure(ctx, gateway, 'create', async () => {
    const result = await gateway.invoke('calendar.events.create', {
      ...EXPLICIT_WRITE_INVOCATION_CONTEXT,
      body: { title: plan.title, start: plan.start, end: plan.end, confirm: true },
    }) as { readonly eventId: string; readonly createdAt: string };
    ctx.print(`Created "${plan.title}", ${formatWhen(plan.start)} to ${formatWhen(plan.end)} (event id ${result.eventId}).`);
  });
}

/** A `/calendar update` line read into the change it makes, or why it makes none. */
type EventUpdatePlan =
  | { readonly ok: true; readonly eventId: string; readonly fields: { readonly title?: string; readonly start?: string; readonly end?: string }; readonly lines: readonly string[] }
  | { readonly ok: false; readonly problem: string };

function planEventUpdate(rest: readonly string[]): EventUpdatePlan {
  const usage = [
    'Usage: /calendar update <id> <title | start | end>',
    '  Leave a field empty to keep it. For example, to move an event and keep its title:',
    '  /calendar update <id> | 2026-08-01T15:00:00Z | 2026-08-01T16:00:00Z',
  ].join('\n');
  const eventId = rest[0];
  const parsed = parseEventUpdateArgs(rest.slice(1).join(' '));
  if (!eventId || parsed === null) return { ok: false, problem: usage };
  // A bare date on both ends keeps or makes the event all-day; any other time is read as an instant.
  const allDay = (parsed.start === undefined || BARE_DATE.test(parsed.start)) && (parsed.end === undefined || BARE_DATE.test(parsed.end))
    && (parsed.start !== undefined || parsed.end !== undefined);
  const timeOf = (raw: string | undefined): { readonly instant: string; readonly zoneStated: boolean } | null | undefined => {
    if (raw === undefined) return undefined;
    if (allDay) return { instant: raw, zoneStated: false };
    return normaliseEventTime(raw);
  };
  const start = timeOf(parsed.start);
  const end = timeOf(parsed.end);
  if (start === null || end === null) {
    return { ok: false, problem: `Not changed: ${start === null ? `start "${parsed.start ?? ''}"` : `end "${parsed.end ?? ''}"`} is not a time. Use ISO-8601, for example 2026-08-01T14:00:00Z, or a date for an all-day event.` };
  }
  const shown = (time: { readonly instant: string }): string => (allDay ? `${time.instant} (all day)` : formatWhen(time.instant));
  const fields = {
    ...(parsed.title === undefined ? {} : { title: parsed.title }),
    ...(start === undefined ? {} : { start: start.instant }),
    ...(end === undefined ? {} : { end: end.instant }),
  };
  const lines = [
    `Event id: ${eventId}`,
    ...(parsed.title === undefined ? [] : [`Title: ${parsed.title}`]),
    ...(start === undefined ? [] : [`Start: ${shown(start)}`]),
    ...(end === undefined ? [] : [`End:   ${shown(end)}`]),
    'Fields left empty keep their value. Guests are told of the change.',
    ...(start?.zoneStated || end?.zoneStated
      ? [`A time typed without a zone is read in this machine's zone, UTC${offsetLabel(new Date().getTimezoneOffset())}.`]
      : []),
  ];
  return { ok: true, eventId, fields, lines };
}

async function updateEvent(ctx: CommandContext, gateway: Gateway, rest: readonly string[]): Promise<void> {
  const plan = planEventUpdate(rest);
  if (!plan.ok) {
    ctx.print(plan.problem);
    return;
  }
  // The registry has asked the owner by now (or the owner typed --yes), so this is the user's own explicit request.
  await withStatusOnFailure(ctx, gateway, 'update', async () => {
    const result = await gateway.invoke('calendar.events.update', {
      ...EXPLICIT_WRITE_INVOCATION_CONTEXT,
      body: { eventId: plan.eventId, ...plan.fields, confirm: true },
    }) as { readonly eventId: string; readonly updatedAt: string };
    ctx.print(`Changed event ${result.eventId}. /calendar get ${result.eventId} shows it now.`);
  });
}

async function deleteEvent(ctx: CommandContext, gateway: Gateway, eventId: string | undefined): Promise<void> {
  if (!eventId) {
    ctx.print('Usage: /calendar delete <id>; the id from /calendar list.');
    return;
  }
  await withStatusOnFailure(ctx, gateway, 'delete', async () => {
    const result = await gateway.invoke('calendar.events.delete', {
      ...EXPLICIT_WRITE_INVOCATION_CONTEXT,
      body: { eventId, confirm: true },
    }) as { readonly eventId: string; readonly deleted: boolean };
    ctx.print(result.deleted
      ? `Deleted event ${result.eventId}.`
      : `Event ${result.eventId} was not on the calendar any more, so nothing was deleted.`);
  });
}
