/**
 * This app's host for `/calendar` (one description shared with the terminal
 * app, terminal-shell/calendar-command.ts): the Agent's own events (an .ics
 * store), the feeds it subscribes to, and the calendar accounts it signs in to.
 */
import { existsSync, readFileSync } from 'node:fs';
import { AgentCalendarRegistry, localIsoDate, UNTITLED_EVENT_TITLE } from '../../agent/calendar-registry.ts';
import { formatJsonStoreWriteReport } from '@goodvibes-jev/engine/terminal-shell/agent-turn/store-file';
import { registerCalendarCommand, type CalendarNewEvent } from '@goodvibes-jev/engine/terminal-shell/calendar-command';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { resolveCommandFilePath } from './agent-local-library-args.ts';
import { requireShellPaths } from './runtime-services.ts';
import {
  calendarFeedRows,
  calendarFeeds,
  refreshCalendarFeeds,
  renderSubscribedSection,
  subscribeCalendarFeed,
  subscriptionRegistryForRead,
  unsubscribeCalendarFeed,
} from './calendar-subscription-runtime.ts';
import { calendarAccounts, connectCalendar, disconnectCalendar, fetchProviderUpcoming, sourceLabel } from './calendar-connect-runtime.ts';
import { commandRefusal } from './confirmation.ts';
import { readRefusal } from '@goodvibes-jev/engine/errors';

/** Today's local calendar date, 'YYYY-MM-DD', the convention stored wall-clock times use. */
function todayIsoDate(): string {
  return localIsoDate(new Date());
}

function addDaysIsoDate(days: number): string {
  return localIsoDate(new Date(Date.now() + days * 86_400_000));
}

/** Append the merged, source-labeled subscribed section to a local-events block. */
function withSubscribedSection(localBlock: string, subscribed: string): string {
  return subscribed ? `${localBlock}\n\n${subscribed}` : localBlock;
}

function registryFromContext(ctx: CommandContext): AgentCalendarRegistry {
  return AgentCalendarRegistry.fromShellPaths(requireShellPaths(ctx));
}

/** A failed step is the action's failed result: a refusal passes through, anything else is reported as failed. */
async function plainly<T>(run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (readRefusal(error)) throw error;
    throw commandRefusal(`Error: ${error instanceof Error ? error.message : String(error)}`, undefined, 'COMMAND_FAILED');
  }
}

function formatEventLine(e: { readonly id: string; readonly title: string; readonly start: string; readonly end?: string; readonly allDay: boolean; readonly location?: string }): string {
  const when = e.allDay ? e.start : e.start.slice(0, 16).replace('T', ' ');
  const loc = e.location ? `  at ${e.location}` : '';
  return `  ${e.id}  ${when}  ${e.title}${loc}`;
}

function renderEventList(events: readonly Parameters<typeof formatEventLine>[0][], path: string): string {
  if (events.length === 0) {
    return [
      'Local calendar events',
      `  store ${path}`,
      '  No events yet. Add one with /calendar add.',
    ].join('\n');
  }
  return [
    `Local calendar events (${events.length})`,
    `  store ${path}`,
    ...events.map(formatEventLine),
  ].join('\n');
}


/** The subscription registry for the merged views; a missing secret manager never breaks a local view. */
function feedsForRead(ctx: CommandContext): ReturnType<typeof subscriptionRegistryForRead> | null {
  try {
    return subscriptionRegistryForRead(ctx);
  } catch {
    return null;
  }
}

function allEvents(ctx: CommandContext): string {
  const snap = registryFromContext(ctx).snapshot();
  const unreadable = [
    snap.unreadable ? `  The store file cannot be read (${snap.unreadable}); the next change keeps a copy of it before replacing it.` : '',
    snap.unreadableEntries > 0 ? `  ${snap.unreadableEntries} stored entr${snap.unreadableEntries === 1 ? 'y' : 'ies'} this version cannot read ${snap.unreadableEntries === 1 ? 'is' : 'are'} kept as found and not shown.` : '',
  ].filter(Boolean);
  const local = [renderEventList([...snap.events], snap.path), ...unreadable].join('\n');
  const subs = feedsForRead(ctx);
  return withSubscribedSection(local, subs ? renderSubscribedSection(subs.seeds()) : '');
}

async function upcomingEvents(ctx: CommandContext, days: number): Promise<string> {
  const registry = registryFromContext(ctx);
  const local = renderEventList([...registry.upcoming(days)], registry.snapshot().path);
  const subs = feedsForRead(ctx);
  // The subscribed feeds, merged read-only.
  const subscribed = subs ? renderSubscribedSection(subs.occurrencesInWindow(todayIsoDate(), addDaysIsoDate(days))) : '';
  // The connected accounts' events, best-effort.
  const now = new Date();
  const { events: providerEvents, notes } = await fetchProviderUpcoming(ctx, { timeMin: now.toISOString(), timeMax: new Date(now.getTime() + days * 86_400_000).toISOString() });
  const providerBlock = providerEvents.length > 0
    ? [`Connected calendars (${providerEvents.length})`, ...providerEvents.map((e) =>
      `  [${sourceLabel(e.source)}] ${e.start.value.slice(0, 16).replace('T', ' ')}  ${e.summary}${e.calendarLabel ? `  (${e.calendarLabel})` : ''}`)].join('\n')
    : '';
  const notesBlock = notes.length > 0 ? ['Notes', ...notes].join('\n') : '';
  return [withSubscribedSection(local, subscribed), providerBlock, notesBlock].filter(Boolean).join('\n\n');
}

function eventDetail(ctx: CommandContext, id: string): string {
  if (id.startsWith('sub:')) throw commandRefusal(`${id} is a read-only event from a subscribed feed; /calendar all shows it with the feed's events.`);
  const event = registryFromContext(ctx).get(id);
  if (!event) throw commandRefusal(`No calendar event has the id ${id}.`, '/calendar all lists the events');
  return [
    `Title:  ${event.title}`,
    `Start:  ${event.start}${event.allDay ? ' (all day)' : ''}`,
    ...(event.end ? [`End:    ${event.end}`] : []),
    ...(event.location ? [`Where:  ${event.location}`] : []),
    ...(event.notes ? ['', event.notes] : []),
  ].join('\n');
}

/** Events added from this session: an identical one needs "Add it again". */
const addedThisSession = new Set<string>();

function addEvent(ctx: CommandContext, input: CalendarNewEvent, again: boolean): string {
  const fingerprint = `${input.title}\0${input.start}\0${input.end ?? ''}`;
  if (addedThisSession.has(fingerprint) && !again) {
    throw commandRefusal('This exact event was already added from this session, so it was not added again.', 'To add it anyway choose "Add it again" (/calendar add ... --again)');
  }
  const event = registryFromContext(ctx).create({ title: input.title, start: input.start, end: input.end, location: input.location, notes: input.notes });
  addedThisSession.add(fingerprint);
  return [`Added calendar event ${event.id}`, `  title ${event.title}`, `  start ${event.start}`, event.end ? `  end   ${event.end}` : ''].filter(Boolean).join('\n');
}

function removeEvent(ctx: CommandContext, id: string): string {
  if (id.startsWith('sub:')) {
    const subName = id.split(':')[1] ?? 'a subscription';
    throw commandRefusal(`Cannot delete ${id}: it is a read-only event from the '${subName}' subscription. Edit it in the source calendar, or remove the whole feed with /calendar unsubscribe ${subName}.`);
  }
  const removed = registryFromContext(ctx).delete(id);
  return `Deleted calendar event ${removed.id}  ${removed.title}`;
}

/** Adds the file's events (an event already imported is skipped); /calendar delete removes one. */
function importEvents(ctx: CommandContext, filePath: string): string {
  const sourcePath = resolveCommandFilePath(ctx, filePath, 'read');
  if (sourcePath === null) throw commandRefusal(`${filePath} cannot be read from here.`);
  if (!existsSync(sourcePath)) throw commandRefusal(`File not found: ${sourcePath}`);
  const result = registryFromContext(ctx).importIcs(readFileSync(sourcePath, 'utf-8'));
  const { imported } = result;
  return [
    `Imported ${imported.length} event${imported.length === 1 ? '' : 's'} from ${sourcePath}`,
    ...imported.slice(0, 10).map((e) => `  ${e.id}  ${e.start}  ${e.title}${e.recurrence ? '  (repeats)' : ''}`),
    imported.length > 10 ? `  ... and ${imported.length - 10} more` : '',
    result.duplicates > 0 ? `Skipped ${result.duplicates} event${result.duplicates === 1 ? '' : 's'} already in the calendar from an earlier import.` : '',
    result.secretSkipped > 0 ? `Did not import ${result.secretSkipped} event${result.secretSkipped === 1 ? '' : 's'} with a secret-looking field; remove the sensitive text from the file to import ${result.secretSkipped === 1 ? 'it' : 'them'}.` : '',
    result.untitled > 0 ? `${result.untitled} event${result.untitled === 1 ? ' had' : 's had'} no title and ${result.untitled === 1 ? 'was' : 'were'} imported as "${UNTITLED_EVENT_TITLE}".` : '',
    result.notParsed.length > 0 ? `Could not read ${result.notParsed.length} entr${result.notParsed.length === 1 ? 'y' : 'ies'}: ${result.notParsed[0] ?? ''}` : '',
    result.unexpandedSeries.length > 0
      ? `${result.unexpandedSeries.length} repeating event${result.unexpandedSeries.length === 1 ? '' : 's'} use a rule this version does not expand and show on the first date only: ${result.unexpandedSeries.slice(0, 3).join(', ')}${result.unexpandedSeries.length > 3 ? ', ...' : ''}`
      : '',
    formatJsonStoreWriteReport(result.write, 'calendar'),
  ].filter(Boolean).join('\n');
}

/** To this screen, or a new file (an existing file is never replaced). */
function exportEvents(ctx: CommandContext, dest: string): string {
  const destPath = dest ? resolveCommandFilePath(ctx, dest, 'write') : undefined;
  if (destPath === null) throw commandRefusal(`${dest} cannot be written from here.`);
  const ics = registryFromContext(ctx).exportIcs(undefined, destPath);
  return destPath ? `Exported calendar to ${destPath}` : ics;
}

export function registerCalendarRuntimeCommands(registry: CommandRegistry): void {
  registerCalendarCommand<CommandContext>(registry, {
    upcoming: (ctx, days) => plainly(() => upcomingEvents(ctx, days)),
    all: (ctx) => plainly(() => allEvents(ctx)),
    events: async (ctx) => registryFromContext(ctx).upcoming(60).map((event) => ({ value: event.id, label: event.title, detail: event.start })),
    get: (ctx, id) => plainly(() => eventDetail(ctx, id)),
    add: (ctx, event, again) => plainly(() => addEvent(ctx, event, again)),
    remove: (ctx, id) => plainly(() => removeEvent(ctx, id)),
    importFile: (ctx, path) => plainly(() => importEvents(ctx, path)),
    exportFile: (ctx, dest) => plainly(() => exportEvents(ctx, dest)),
    accounts: (ctx) => plainly(() => calendarAccounts(ctx)),
    connect: (ctx, provider, how, code) => plainly(() => connectCalendar(ctx, provider, how, code)),
    disconnect: (ctx, provider) => plainly(() => disconnectCalendar(ctx, provider)),
    subscriptions: (ctx) => plainly(() => calendarFeeds(ctx)),
    subscriptionRows: (ctx) => calendarFeedRows(ctx),
    subscribe: (ctx, subscription) => plainly(() => subscribeCalendarFeed(ctx, subscription)),
    unsubscribe: (ctx, name) => plainly(() => unsubscribeCalendarFeed(ctx, name)),
    refresh: (ctx, name) => plainly(() => refreshCalendarFeeds(ctx, name)),
  });
}
