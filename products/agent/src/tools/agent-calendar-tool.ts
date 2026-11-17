/**
 * The `connected_calendar` tool: the calendars of the Google and Microsoft
 * accounts connected with `/calendar connect`, and creating an event on one.
 *
 * The connector behind it (`agent/calendar/calendar-oauth-service.ts`) already
 * requests write scopes at consent (Google `calendar.events`, Graph
 * `Calendars.ReadWrite`); without this tool a connected Outlook calendar could
 * be read and never written. Reading events stays with `/calendar upcoming`.
 *
 * Creating an event is an outward effect: its title, location and description
 * are checked against what this turn read from untrusted sources, and against
 * card material, before anything is sent. Times: a date is all-day (one day
 * when no end is given); a date and time with no zone is the owner's wall
 * clock; one with `Z` or an offset is that instant; `timeZone` names a zone.
 */

import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import {
  CalendarApiError,
  NewEventTimeError,
  type CalendarProviderId,
  type EventDateTime,
  type NewCalendarEvent,
} from '@goodvibes-jev/engine/platform/platform/calendar';
import {
  CalendarOAuthService,
  type CalendarConfigReader,
  type CalendarSecretSlice,
} from '../agent/calendar/calendar-oauth-service.ts';
import { CardMaterialRefusedError, screenOutboundForCardMaterial } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { evaluateOutwardEffect, getSessionUntrustedContentLedger } from '../trust/untrusted-content.ts';

const ACTIONS = ['calendars', 'create'] as const;
type Action = (typeof ACTIONS)[number];

export interface AgentCalendarToolOptions {
  readonly config: CalendarConfigReader;
  readonly secrets: CalendarSecretSlice;
  /** Injected in tests; production builds the service over the runtime fetch. */
  readonly service?: CalendarOAuthService;
}

type ToolOutput = { readonly success: true; readonly output: string } | { readonly success: false; readonly error: string };

function failure(message: string): ToolOutput {
  return { success: false, error: message };
}

function ok(output: string): ToolOutput {
  return { success: true, output };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readProvider(value: unknown): CalendarProviderId | null {
  const word = readString(value).toLowerCase();
  if (word === 'google') return 'google';
  if (word === 'microsoft' || word === 'outlook') return 'microsoft';
  return null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WALL = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * One time argument as the shared model reads it. A date is all-day; a wall
 * time is floating unless `timeZone` names its zone; a time with `Z` or an
 * offset is an instant, sent as UTC.
 */
function readTime(value: string, field: string, timeZone: string): EventDateTime {
  if (DATE.test(value)) return { value, kind: 'date', zone: 'floating' };
  const wall = WALL.exec(value);
  if (wall) {
    const text = `${wall[1]}T${wall[2]}:${wall[3]}:${wall[4] ?? '00'}`;
    return timeZone ? { value: text, kind: 'date-time', zone: 'tzid', tzid: timeZone } : { value: text, kind: 'date-time', zone: 'floating' };
  }
  if (INSTANT.test(value)) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return { value: new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'), kind: 'date-time', zone: 'utc' };
  }
  throw new NewEventTimeError(`${field} '${value}' is not a date (YYYY-MM-DD) or a date and time (YYYY-MM-DDTHH:mm, optionally with Z or an offset).`);
}

function describeError(error: unknown): string {
  if (error instanceof CalendarApiError) return error.degraded.detail;
  return error instanceof Error ? error.message : String(error);
}

export function createAgentCalendarTool(options: AgentCalendarToolOptions): Tool {
  const service = (): CalendarOAuthService =>
    options.service ?? new CalendarOAuthService({ config: options.config, secrets: options.secrets });

  async function listCalendars(signal: AbortSignal | undefined): Promise<ToolOutput> {
    const { calendars, failures } = await service().listCalendars(signal ? { signal } : {});
    if (calendars.length === 0 && failures.length === 0) {
      return ok('No Google or Microsoft calendar account is connected. The owner connects one with /calendar connect google or /calendar connect outlook.');
    }
    const lines = calendars.map((calendar) =>
      `${calendar.provider === 'google' ? 'google' : 'outlook'}  ${calendar.id}  "${calendar.name}"${calendar.primary ? ' (primary)' : ''}  ${calendar.canWrite ? 'writable' : 'read-only'}`);
    for (const entry of failures) lines.push(`${entry.provider === 'google' ? 'google' : 'outlook'}: could not list calendars, ${entry.error}`);
    return ok(lines.join('\n'));
  }

  async function create(args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<ToolOutput> {
    const provider = readProvider(args.provider);
    if (provider === null) return failure('create needs provider: "google" or "outlook". List the connected calendars with action "calendars".');
    const summary = readString(args.summary);
    const start = readString(args.start);
    if (!summary || !start) return failure('create needs summary and start.');
    const timeZone = readString(args.timeZone);
    const location = readString(args.location) || undefined;
    const description = readString(args.description) || undefined;
    let event: NewCalendarEvent;
    try {
      const end = readString(args.end);
      event = {
        summary,
        start: readTime(start, 'start', timeZone),
        ...(end ? { end: readTime(end, 'end', timeZone) } : {}),
        ...(location ? { location } : {}),
        ...(description ? { description } : {}),
      };
    } catch (error) {
      return failure(describeError(error));
    }

    // The title, location and description are what a stranger's text would
    // have to reach to plant something on the owner's calendar; the times are
    // not text and carry nothing.
    const decision = await evaluateOutwardEffect({
      request: { toolName: 'connected_calendar', action: 'calendar.create', description: `creating the event "${summary}"` },
      ledger: getSessionUntrustedContentLedger(),
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

    let outcome: Awaited<ReturnType<CalendarOAuthService['createEvent']>>;
    try {
      outcome = await service().createEvent(provider, event, { calendarId: readString(args.calendarId) || undefined }, signal ? { signal } : {});
    } catch (error) {
      if (signal?.aborted) throw error;
      // A failure before the provider answered (a refusal, a network error)
      // created nothing; the message says which.
      return failure(`No event was created. ${describeError(error)}`);
    }
    if (outcome.result.kind === 'created-but-unreadable') {
      return ok(`Created "${summary}" on "${outcome.calendar.name}". ${outcome.result.detail}${outcome.result.providerEventId ? ` Provider id: ${outcome.result.providerEventId}.` : ''}`);
    }
    const created = outcome.result.event;
    const zoneNote = event.start.kind === 'date-time' && event.start.zone === 'floating' ? ` (read in ${outcome.ownerZone})` : '';
    return ok(`Created "${created.summary}" on "${outcome.calendar.name}" starting ${created.start.value}${zoneNote}.`);
  }

  return {
    definition: {
      name: 'connected_calendar',
      description:
        'The Google and Microsoft calendars connected with /calendar connect. '
        + 'calendars lists them and whether each can be written. '
        + 'create adds an event: start/end as YYYY-MM-DD (all-day) or YYYY-MM-DDTHH:mm; a time without a zone is the owner\'s local time.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: [...ACTIONS], description: 'calendars, or create.' },
          provider: { type: 'string', enum: ['google', 'outlook'], description: 'Which connected account, for create.' },
          calendarId: { type: 'string', description: 'Calendar id or name from calendars; defaults to the primary writable calendar.' },
          summary: { type: 'string', description: 'Event title, for create.' },
          start: { type: 'string', description: 'YYYY-MM-DD for all-day, or YYYY-MM-DDTHH:mm (optionally with Z or an offset).' },
          end: { type: 'string', description: 'Optional. All-day: the day after the last day. Timed: the end time.' },
          timeZone: { type: 'string', description: 'Optional IANA zone the start and end are written in, e.g. Europe/London.' },
          location: { type: 'string', description: 'Optional location.' },
          description: { type: 'string', description: 'Optional description.' },
        },
        required: ['action'],
      },
      sideEffects: ['network'],
      category: 'write',
      concurrency: 'serial',
    },
    execute: async (rawArgs: Record<string, unknown>, executionOptions): Promise<ToolOutput> => {
      const requested = readString(rawArgs.action).toLowerCase();
      const action = ACTIONS.find((candidate) => candidate === requested) as Action | undefined;
      if (action === undefined) return failure(`connected_calendar needs an action: ${ACTIONS.join(' or ')}.`);
      const signal = executionOptions?.signal;
      signal?.throwIfAborted();
      if (action === 'calendars') return listCalendars(signal);
      return create(rawArgs, signal);
    },
  };
}

/** Register the tool once. */
export function registerAgentCalendarTool(registry: ToolRegistry, options: AgentCalendarToolOptions): void {
  if (!registry.has('connected_calendar')) registry.register(createAgentCalendarTool(options));
}
