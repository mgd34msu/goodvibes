import { existsSync, readFileSync } from 'node:fs';
import { AgentCalendarRegistry, localIsoDate, UNTITLED_EVENT_TITLE } from '../../agent/calendar-registry.ts';
import { formatJsonStoreWriteReport } from '@goodvibes-jev/engine/terminal-shell/agent-turn/store-file';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { parseAgentLocalLibraryArgs, resolveCommandFilePath } from './agent-local-library-args.ts';
import { requireShellPaths } from './runtime-services.ts';
import { LOCAL_WRITE_VERB, OUTWARD_VERB, READ_VERB, ownerOnlyVerb, withCommandVerbs, type CommandVerbs } from './command-verbs.ts';
import {
  CALENDAR_SUBSCRIPTION_VERBS,
  renderSubscribedSection,
  runCalendarSubscriptionCommand,
  subscriptionRegistryForRead,
} from './calendar-subscription-runtime.ts';
import {
  fetchProviderUpcoming,
  runCalendarAccounts,
  runCalendarConnect,
  runCalendarDisconnect,
  sourceLabel,
} from './calendar-connect-runtime.ts';
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

/**
 * F7b: the old unknown-subcommand usage line was one 13-verb run-on
 * ("list|upcoming ...|connect ...|disconnect ...|accounts|import ...|export
 * ...|add ...|delete ...|subscribe ...|unsubscribe ...|subscriptions|refresh
 * ..."), unreadable at a glance. Grouped by what each verb is FOR instead.
 */
const CALENDAR_USAGE_MESSAGE = [
  'Usage: /calendar <command>',
  '  Viewing         list | upcoming [--days N]',
  '  Connecting      connect <google|outlook> [--device | --code <address>] | disconnect <google|outlook> | accounts',
  '  Subscriptions   subscribe <ics-url> [--name N] [--every MIN] [--yes] | unsubscribe <name> --yes | subscriptions | refresh [name]',
  '  Local events    add --title <title> --start <ISO> | delete <id> --yes | import <path> | export [--dest <path>]',
].join('\n');

const CALENDAR_VALUE_FLAGS = ['title', 'start', 'end', 'location', 'notes', 'dest', 'path', 'days'] as const;

function parseCalendarArgs(args: readonly string[]) {
  return parseAgentLocalLibraryArgs(args, { valueFlags: CALENDAR_VALUE_FLAGS });
}

function registryFromContext(ctx: CommandContext): AgentCalendarRegistry {
  return AgentCalendarRegistry.fromShellPaths(requireShellPaths(ctx));
}

/** A failed step is the command's failed result: a refusal passes through, anything else is reported as failed. */
function printError(_ctx: CommandContext, error: unknown): never {
  if (readRefusal(error)) throw error;
  throw commandRefusal(`Error: ${error instanceof Error ? error.message : String(error)}`, undefined, 'COMMAND_FAILED');
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
      '  No events yet. Add one with /calendar add --title <title> --start <ISO>',
    ].join('\n');
  }
  return [
    `Local calendar events (${events.length})`,
    `  store ${path}`,
    ...events.map(formatEventLine),
  ].join('\n');
}

export async function runCalendarRuntimeCommand(args: readonly string[], ctx: CommandContext): Promise<void> {
  const sub = (args[0] ?? 'list').toLowerCase();

  // Connected-provider verbs (OAuth). Handled before the local-store registry so a
  // connect/accounts call never touches the local .ics file.
  if (sub === 'connect' || sub === 'disconnect' || sub === 'accounts') {
    try {
      if (sub === 'connect') await runCalendarConnect(args, ctx);
      else if (sub === 'disconnect') await runCalendarDisconnect(args, ctx);
      else await runCalendarAccounts(ctx);
    } catch (error) {
      printError(ctx, error);
    }
    return;
  }

  const registry = registryFromContext(ctx);
  // A read-only subscription registry merges subscribed feed events into the
  // views below. Tolerant of a missing secret manager (seeds/occurrences read
  // only the on-disk cache), so a failure to build it never breaks local views.
  let subs: ReturnType<typeof subscriptionRegistryForRead> | null = null;
  try {
    subs = subscriptionRegistryForRead(ctx);
  } catch {
    subs = null;
  }

  try {
    // list / upcoming
    if (sub === 'list' || sub === 'all') {
      const snap = registry.snapshot();
      const unreadable = [
        snap.unreadable ? `  The store file cannot be read (${snap.unreadable}); the next change keeps a copy of it before replacing it.` : '',
        snap.unreadableEntries > 0 ? `  ${snap.unreadableEntries} stored entr${snap.unreadableEntries === 1 ? 'y' : 'ies'} this version cannot read ${snap.unreadableEntries === 1 ? 'is' : 'are'} kept as found and not shown.` : '',
      ].filter(Boolean);
      const local = [renderEventList([...snap.events], snap.path), ...unreadable].join('\n');
      const subscribed = subs ? renderSubscribedSection(subs.seeds()) : '';
      ctx.print(withSubscribedSection(local, subscribed));
      return;
    }

    if (sub === 'upcoming') {
      const parsed = parseCalendarArgs(args.slice(1));
      const days = parsed.flags.has('days') ? Math.max(1, parseInt(parsed.flags.get('days') ?? '7', 10) || 7) : 7;
      const snap = registry.snapshot();
      const events = registry.upcoming(days);
      const local = renderEventList([...events], snap.path);
      // A9's subscribed-feed section (ics-feed source), merged read-only.
      const subscribed = subs ? renderSubscribedSection(subs.occurrencesInWindow(todayIsoDate(), addDaysIsoDate(days))) : '';
      // A10: connected-provider events (google-api / microsoft-graph), best-effort.
      const now = new Date();
      const to = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
      const { events: providerEvents, notes } = await fetchProviderUpcoming(ctx, {
        timeMin: now.toISOString(),
        timeMax: to.toISOString(),
      });
      const providerLines = providerEvents.map((e) =>
        `  [${sourceLabel(e.source)}] ${e.start.value.slice(0, 16).replace('T', ' ')}  ${e.summary}${e.calendarLabel ? `  (${e.calendarLabel})` : ''}`,
      );
      const providerBlock = providerEvents.length > 0
        ? [`Connected calendars (${providerEvents.length})`, ...providerLines].join('\n')
        : '';
      const notesBlock = notes.length > 0 ? ['Notes', ...notes].join('\n') : '';
      ctx.print([withSubscribedSection(local, subscribed), providerBlock, notesBlock].filter(Boolean).join('\n\n'));
      return;
    }

    // import <path>: adds the file's events (an event already imported is skipped); /calendar delete removes one.
    if (sub === 'import') {
      const parsed = parseCalendarArgs(args.slice(1));
      const filePath = parsed.rest[0] ?? parsed.flags.get('path');
      if (!filePath) {
        throw commandRefusal('Usage: /calendar import <path-to-ics>');
      }
      const sourcePath = resolveCommandFilePath(ctx, filePath, 'read');
      if (sourcePath === null) return;
      if (!existsSync(sourcePath)) {
        throw commandRefusal(`File not found: ${sourcePath}`);
      }
      const content = readFileSync(sourcePath, 'utf-8');
      const result = registry.importIcs(content);
      const { imported } = result;
      ctx.print([
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
      ].filter(Boolean).join('\n'));
      return;
    }

    // export [--dest <path>]: to stdout, or a new file (an existing file is never replaced).
    if (sub === 'export') {
      const parsed = parseCalendarArgs(args.slice(1));
      const dest = parsed.flags.get('dest') ?? parsed.rest[0];
      const destPath = dest ? resolveCommandFilePath(ctx, dest, 'write') : undefined;
      if (destPath === null) return;
      const ics = registry.exportIcs(undefined, destPath);
      if (!destPath) {
        ctx.print(ics);
      } else {
        ctx.print(`Exported calendar to ${destPath}`);
      }
      return;
    }

    // add --title <title> --start <ISO> [--end <ISO>] [--location <loc>] [--notes <notes>]
    if (sub === 'add' || sub === 'create') {
      const parsed = parseCalendarArgs(args.slice(1));
      const title = parsed.flags.get('title')?.trim() ?? parsed.rest.join(' ').trim();
      const start = parsed.flags.get('start')?.trim();
      if (!title || !start) {
        throw commandRefusal('Usage: /calendar add --title <title> --start <ISO-date-or-datetime> [--end <ISO>] [--location <loc>] [--notes <notes>]');
      }
      const event = registry.create({
        title,
        start,
        end: parsed.flags.get('end')?.trim(),
        location: parsed.flags.get('location')?.trim(),
        notes: parsed.flags.get('notes')?.trim(),
      });
      ctx.print([
        `Added calendar event ${event.id}`,
        `  id    ${event.id}`,
        `  title ${event.title}`,
        `  start ${event.start}`,
        event.end ? `  end   ${event.end}` : '',
      ].filter(Boolean).join('\n'));
      return;
    }

    // delete <id> --yes
    if (sub === 'delete' || sub === 'remove') {
      const parsed = parseCalendarArgs(args.slice(1));
      const id = parsed.rest[0];
      if (!id) {
        throw commandRefusal('Usage: /calendar delete <id> --yes');
      }
      if (id.startsWith('sub:')) {
        const subName = id.split(':')[1] ?? 'a subscription';
        throw commandRefusal(`Cannot delete ${id}: it is a read-only event from the '${subName}' subscription. Edit it in the source calendar, or run /calendar unsubscribe ${subName} --yes to remove the whole feed.`);
      }
      if (!parsed.yes) {
        const event = registry.get(id);
        if (!event) {
          throw commandRefusal(`Unknown calendar event ${id}`);
        }
        ctx.print([
          `Delete calendar event preview`,
          `  id    ${event.id}`,
          `  title ${event.title}`,
          `  start ${event.start}`,
          '  rerun with --yes to delete',
        ].join('\n'));
        return;
      }
      const removed = registry.delete(id);
      ctx.print(`Deleted calendar event ${removed.id}  ${removed.title}`);
      return;
    }

    ctx.print(CALENDAR_USAGE_MESSAGE);
  } catch (error) {
    printError(ctx, error);
  }
}

/**
 * What each /calendar verb does. Signing an account in or out grants or removes
 * access, and unsubscribing deletes a stored private feed address: those are
 * the owner's to type. Subscribing to a public feed and refreshing one are
 * outward reads the tool admission covers for a model-run command; letting a
 * feed be fetched from the owner's private network (--allow-private-host)
 * loosens the network guard, so that subscription is his to type.
 */
export const CALENDAR_VERBS: CommandVerbs = {
  defaultVerb: 'list',
  verbs: {
    list: READ_VERB, all: READ_VERB, upcoming: READ_VERB, subscriptions: READ_VERB, subs: READ_VERB, accounts: READ_VERB,
    add: LOCAL_WRITE_VERB, create: LOCAL_WRITE_VERB, delete: LOCAL_WRITE_VERB, remove: LOCAL_WRITE_VERB, import: LOCAL_WRITE_VERB, export: LOCAL_WRITE_VERB,
    subscribe: (rest) => rest.some((arg) => arg === '--allow-private-host' || arg.startsWith('--allow-private-host='))
      ? ownerOnlyVerb('outward', 'lets a feed be fetched from a private-network address')
      : OUTWARD_VERB,
    refresh: OUTWARD_VERB,
    unsubscribe: ownerOnlyVerb('local-write', 'removes a stored feed address that cannot be recovered from here'),
    connect: ownerOnlyVerb('credential', 'signs a calendar account in, which grants access'),
    disconnect: ownerOnlyVerb('credential', 'signs a calendar account out and removes its stored credential'),
  },
  otherwise: READ_VERB,
};

/** Where a `/calendar subscribe` line holds the feed address (positional or `--url`). */
function calendarFeedAddressPositions(args: readonly string[]): number[] {
  if ((args[0] ?? '').toLowerCase() !== 'subscribe') return [];
  const positions: number[] = [];
  for (let index = 1; index < args.length; index++) {
    if (/^(?:https?|webcals?):\/\//i.test(args[index]!) || (args[index - 1] === '--url' && index > 1)) positions.push(index);
  }
  return positions;
}

export function registerCalendarRuntimeCommands(registry: CommandRegistry): void {
  registry.register(withCommandVerbs({
    name: 'calendar',
    effect: 'mixed',
    aliases: ['cal'],
    description: 'Manage local calendar events, external calendar subscriptions, and connected calendar accounts',
    usage: '[list|upcoming [--days N]|connect <google|outlook> [--device | --code <address>]|disconnect <google|outlook>|accounts|import <path>|export [--dest <path>]|add --title <title> --start <ISO> [--end <ISO>] [--location <loc>] [--notes <notes>]|delete <id> --yes|subscribe <ics-url> [--name N] [--every MIN] [--yes]|unsubscribe <name> --yes|subscriptions|refresh [name]]',
    // A feed address can be a private one that grants read access; account sign-in takes no typed secret.
    secretArgs: { select: (args) => calendarFeedAddressPositions(args) },
    handler: async (args: readonly string[], ctx: CommandContext) => {
      const sub = (args[0] ?? 'list').toLowerCase();
      if (CALENDAR_SUBSCRIPTION_VERBS.has(sub)) {
        await runCalendarSubscriptionCommand(sub, args.slice(1), ctx);
        return;
      }
      await runCalendarRuntimeCommand(args, ctx);
    },
  }, CALENDAR_VERBS));
}
