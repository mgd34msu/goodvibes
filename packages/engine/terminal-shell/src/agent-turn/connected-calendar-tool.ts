/**
 * The `connected_calendar` tool: the calendars the daemon reaches (the Google and Microsoft accounts signed in under
 * Calendar accounts, the CalDAV server, the calendar kept on the daemon's computer), and creating an event on one.
 *
 * The calendars are the daemon's: every call runs the daemon's calendar method as a nested `capability_run` call of
 * this one (`calendar.calendars.list`, `calendar.events.create`), judged by the method's own declarations, the one gate
 * a model's daemon call goes through. This call only routes it and is classed a read; creating an event is the method's
 * own question, asked once. Nothing is read from or sent to a provider from this process.
 *
 * Creating an event is an outward effect: its title, location and description are checked against what this turn read
 * from untrusted sources, and against card material, before anything is sent. Times: a date is all-day (one day when
 * no end is given); a date and time with no zone is the owner's wall clock (the daemon's); one with `Z` or an offset is
 * that instant; `timeZone` names the zone a wall time is written in.
 */

import { assertCurrentToolInvocation, ToolInputProjectionError, type ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import type { Tool } from '@goodvibes/engine/platform/platform/types';
import { evaluateOutwardEffect, getProcessUntrustedContentLedger } from '@goodvibes/engine/platform/platform/security';
import { CardMaterialRefusedError, screenOutboundForCardMaterial } from './payments-channel-guard.js';
import { runDaemonMethodNested } from './capability-tools.js';
import { readString } from './tool-args.js';

const ACTIONS = ['calendars', 'create'] as const;
type Action = (typeof ACTIONS)[number];

type ToolOutput = { readonly success: true; readonly output: string } | { readonly success: false; readonly error: string };

function failure(message: string): ToolOutput {
  return { success: false, error: message };
}

function ok(output: string): ToolOutput {
  return { success: true, output };
}

/** The start of every Outlook calendar and event id the daemon hands out (calendar/microsoft-gateway-service.ts). */
const OUTLOOK_PREFIX = 'outlook:';
/** The calendar kept on the daemon's computer (control-plane/routes/calendar-composition.ts). */
const LOCAL_CALENDAR = 'local';

function readProvider(value: unknown): 'google' | 'outlook' | undefined | null {
  const word = readString(value).toLowerCase();
  if (!word) return undefined;
  if (word === 'google') return 'google';
  if (word === 'microsoft' || word === 'outlook') return 'outlook';
  return null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WALL = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

/** The offset of `zone` at `utcMs`, in milliseconds (what a wall clock there reads minus UTC). */
function zoneOffsetMs(zone: string, utcMs: number): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]));
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return wall - utcMs;
}

/**
 * One time argument as the daemon's calendar method takes it: a date for an all-day event, an instant (UTC) for a
 * time with a zone or an offset, a wall time (the daemon's clock) for a time with neither.
 */
function readTime(value: string, field: string, timeZone: string): string {
  if (DATE.test(value)) return value;
  const wall = WALL.exec(value);
  if (wall) {
    const text = `${wall[1]}T${wall[2]}:${wall[3]}:${wall[4] ?? '00'}`;
    if (!timeZone) return text;
    let guess: number;
    try {
      const asUtc = Date.parse(`${text}Z`);
      guess = asUtc - zoneOffsetMs(timeZone, asUtc);
      guess = asUtc - zoneOffsetMs(timeZone, guess);
    } catch {
      throw new Error(`timeZone '${timeZone}' is not a time zone this machine knows (an IANA name such as Europe/London).`);
    }
    return new Date(guess).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  if (INSTANT.test(value)) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  throw new Error(`${field} '${value}' is not a date (YYYY-MM-DD) or a date and time (YYYY-MM-DDTHH:mm, optionally with Z or an offset).`);
}

interface CalendarRow { readonly calendarId: string; readonly displayName: string }

function whereOf(calendarId: string): string {
  return calendarId === LOCAL_CALENDAR ? 'this computer' : calendarId.startsWith(OUTLOOK_PREFIX) ? 'outlook' : 'connected';
}

/** The tool takes no stores of its own: the calendars are the daemon's. */
export function createAgentCalendarTool(): Tool {
  async function calendars(executionOptions: Parameters<Tool['execute']>[1]): Promise<readonly CalendarRow[] | string> {
    const listed = await runDaemonMethodNested('calendar.calendars.list', {}, executionOptions);
    if (!listed.ok) return listed.error;
    const rows = (listed.body as { calendars?: unknown } | undefined)?.calendars;
    return (Array.isArray(rows) ? rows : []).filter((row): row is CalendarRow => row !== null && typeof row === 'object'
      && typeof (row as CalendarRow).calendarId === 'string' && typeof (row as CalendarRow).displayName === 'string');
  }

  async function create(args: Record<string, unknown>, executionOptions: Parameters<Tool['execute']>[1]): Promise<ToolOutput> {
    const signal = executionOptions?.signal;
    const provider = readProvider(args.provider);
    if (provider === null) return failure('provider is "google" or "outlook"; leave it out for the daemon\'s own calendar. List the calendars with action "calendars".');
    const summary = readString(args.summary);
    const start = readString(args.start);
    if (!summary || !start) return failure('create needs summary and start.');
    const timeZone = readString(args.timeZone);
    const location = readString(args.location) || undefined;
    const description = readString(args.description) || undefined;
    let when: { readonly start: string; readonly end?: string };
    try {
      const end = readString(args.end);
      when = { start: readTime(start, 'start', timeZone), ...(end ? { end: readTime(end, 'end', timeZone) } : {}) };
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
    // Which calendar: the one named (by id or by name), else the first of the provider asked for, else the daemon's own choice.
    const named = readString(args.calendarId);
    let calendarId: string | undefined = named || undefined;
    if (named || provider) {
      const listed = await calendars(executionOptions);
      if (typeof listed === 'string') return failure(`No event was created: the calendars could not be read. ${listed}`);
      const byName = named ? listed.find((row) => row.calendarId === named || row.displayName.toLowerCase() === named.toLowerCase()) : undefined;
      if (byName) calendarId = byName.calendarId;
      else if (!named && provider) {
        const first = listed.find((row) => provider === 'outlook' ? row.calendarId.startsWith(OUTLOOK_PREFIX) : row.calendarId !== LOCAL_CALENDAR && !row.calendarId.startsWith(OUTLOOK_PREFIX));
        if (!first) return failure(`No ${provider === 'outlook' ? 'Outlook' : 'Google'} calendar is connected; nothing was created. The owner signs in under Calendar accounts in Mail, calendar and channels.`);
        calendarId = first.calendarId;
      }
    }

    // The title, location and description are what a stranger's text would have to reach to plant something on the
    // owner's calendar; the times are not text and carry nothing.
    const decision = await evaluateOutwardEffect({
      request: { toolName: 'connected_calendar', action: 'calendar.create', description: `creating the event "${summary}"` },
      ledger: getProcessUntrustedContentLedger(),
      content: { summary, location, description },
      approval: null,
    });
    if (!decision.allowed) {
      return failure([decision.reason ?? 'The event was refused: its text repeats untrusted content read this turn.', decision.fix].filter(Boolean).join(' '));
    }
    const card = await screenOutboundForCardMaterial(
      { surface: 'calendar', message: [description ?? '', location ?? ''].join('\n'), title: summary },
      signal ? { signal } : {},
    );
    if (card) throw new CardMaterialRefusedError(card);
    signal?.throwIfAborted();

    // The daemon's method makes it, asked once as itself.
    const made = await runDaemonMethodNested('calendar.events.create', {
      title: summary, start: when.start, ...(when.end ? { end: when.end } : {}), ...(location ? { location } : {}), ...(description ? { description } : {}),
      ...(calendarId ? { calendarId } : {}), confirm: true,
    }, executionOptions);
    if (!made.ok) {
      // The request went out and no answer came back: creating it again could make a duplicate, so the next step is to look first.
      if (made.error.startsWith('outcome_unknown')) {
        return failure(`The calendar write could not be confirmed: "${summary}" may or may not exist. Check the calendar (the Calendar tab of Mail, calendar and channels) before creating it again.`);
      }
      return failure(`No event was created. ${made.error}`);
    }
    const eventId = (made.body as { eventId?: unknown } | undefined)?.eventId;
    const where = calendarId ? ` on ${whereOf(calendarId) === 'this computer' ? 'the calendar on this computer' : `"${calendarId}"`}` : '';
    return ok(`Created "${summary}"${where} starting ${when.start}${typeof eventId === 'string' ? ` (event ${eventId})` : ''}.`);
  }

  return {
    definition: {
      name: 'connected_calendar',
      description:
        'The calendars the daemon reaches: the Google and Microsoft accounts signed in to under Calendar accounts, a CalDAV server, and the one on the daemon\'s computer. '
        + 'calendars lists them. '
        + 'create adds an event: start/end as YYYY-MM-DD (all-day) or YYYY-MM-DDTHH:mm; a time without a zone is the owner\'s local time.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: [...ACTIONS], description: 'calendars, or create.' },
          provider: { type: 'string', enum: ['google', 'outlook'], description: 'Which connected account, for create; leave it out for the daemon\'s own calendar.' },
          calendarId: { type: 'string', description: 'Calendar id or name from calendars; defaults to the provider\'s first calendar, or the daemon\'s own.' },
          summary: { type: 'string', description: 'Event title, for create.' },
          start: { type: 'string', description: 'YYYY-MM-DD for all-day, or YYYY-MM-DDTHH:mm (optionally with Z or an offset).' },
          end: { type: 'string', description: 'Optional. All-day: the day after the last day. Timed: the end time.' },
          timeZone: { type: 'string', description: 'Optional IANA zone the start and end are written in, e.g. Europe/London.' },
          location: { type: 'string', description: 'Optional location.' },
          description: { type: 'string', description: 'Optional description.' },
        },
        required: ['action'],
      },
      // This call only routes the daemon's calendar method (a nested capability_run call, judged by the method's own
      // declarations); classed a read, so the method's question is the only one.
      sideEffects: ['state'],
      category: 'read',
      concurrency: 'serial',
    },
    execute: async (rawArgs: Record<string, unknown>, executionOptions): Promise<ToolOutput> => {
      const requested = readString(rawArgs.action).toLowerCase();
      const action = ACTIONS.find((candidate) => candidate === requested) as Action | undefined;
      if (action === undefined) return failure(`connected_calendar needs an action: ${ACTIONS.join(' or ')}.`);
      executionOptions?.signal?.throwIfAborted();
      if (!assertCurrentToolInvocation(rawArgs, executionOptions)) throw new ToolInputProjectionError('held');
      if (action === 'calendars') {
        const listed = await calendars(executionOptions);
        if (typeof listed === 'string') return failure(listed);
        if (listed.length === 0) return ok('No calendar is reachable. The owner signs in to one under Calendar accounts in Mail, calendar and channels.');
        return ok(listed.map((row) => `${whereOf(row.calendarId)}  ${row.calendarId}  "${row.displayName}"`).join('\n'));
      }
      return create(rawArgs, executionOptions);
    },
  };
}

/** Register the tool once. */
export function registerAgentCalendarTool(registry: ToolRegistry): void {
  if (!registry.has('connected_calendar')) registry.register(createAgentCalendarTool());
}
