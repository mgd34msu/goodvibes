/**
 * `/calendar`, described once (command-actions/) for both terminal apps. Each
 * app gives the calendar it works with as a host: the terminal app the
 * daemon's calendar (CalDAV or the connected Google account, over the
 * `calendar.*` methods), the Agent its own events with the feeds it subscribes
 * to and the calendar accounts it signs in to. What only one app holds (the
 * terminal app's connection check and event changes; the Agent's file import
 * and export, accounts and subscriptions) is refused in the other, saying why.
 */
import { commandRefusal } from './command-confirmation.js';
import type { TerminalCommandRegistry } from './command-registry.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { ActionDescription, CommandActionContext, FixedChoice, InputDescription } from './command-actions/types.js';
import { doAction, listInput, readAction, textInput } from './described-command-kit.js';

export interface CalendarNewEvent {
  readonly title: string;
  readonly start: string;
  readonly end?: string | undefined;
  readonly location?: string | undefined;
  readonly notes?: string | undefined;
}

export interface CalendarEventChange {
  readonly title?: string | undefined;
  readonly start?: string | undefined;
  readonly end?: string | undefined;
}

export type CalendarProvider = 'google' | 'outlook';
export type CalendarSignIn = 'browser' | 'device' | 'code';

export interface CalendarSubscription {
  readonly url: string;
  readonly name?: string | undefined;
  readonly everyMinutes?: number | undefined;
  readonly privateNetwork: boolean;
}

/** The calendar one app works with. A missing reader refuses its action with the reason for that app. */
export interface CalendarHost<Ctx> {
  readonly upcoming: (ctx: Ctx, days: number) => Promise<string>;
  /** Events as rows for a choice (value: the event's id). */
  readonly events: (ctx: Ctx) => Promise<readonly ListRow[]>;
  readonly add: (ctx: Ctx, event: CalendarNewEvent, again: boolean) => Promise<string>;
  readonly remove: (ctx: Ctx, id: string) => Promise<string>;
  readonly get: (ctx: Ctx, id: string) => Promise<string>;
  readonly status?: ((ctx: Ctx) => Promise<string>) | undefined;
  readonly change?: ((ctx: Ctx, id: string, change: CalendarEventChange) => Promise<string>) | undefined;
  readonly all?: ((ctx: Ctx) => Promise<string>) | undefined;
  readonly importFile?: ((ctx: Ctx, path: string) => Promise<string>) | undefined;
  readonly exportFile?: ((ctx: Ctx, dest: string) => Promise<string>) | undefined;
  readonly accounts?: ((ctx: Ctx) => Promise<string>) | undefined;
  readonly connect?: ((ctx: Ctx, provider: CalendarProvider, how: CalendarSignIn, code: string) => Promise<string | void>) | undefined;
  readonly disconnect?: ((ctx: Ctx, provider: CalendarProvider) => Promise<string>) | undefined;
  readonly subscriptions?: ((ctx: Ctx) => Promise<string>) | undefined;
  readonly subscriptionRows?: ((ctx: Ctx) => Promise<readonly ListRow[]>) | undefined;
  readonly subscribe?: ((ctx: Ctx, subscription: CalendarSubscription) => Promise<string>) | undefined;
  readonly unsubscribe?: ((ctx: Ctx, name: string) => Promise<string>) | undefined;
  readonly refresh?: ((ctx: Ctx, name: string) => Promise<string>) | undefined;
}

const AGENT_ONLY = 'the Agent keeps its own events, feeds and calendar accounts; run it in goodvibes-agent';
const TERMINAL_ONLY = 'the terminal app works on the daemon\'s calendar; run it in goodvibes';

function missing(what: string, where: string): never {
  throw commandRefusal(`${what} is not available in this program: ${where}.`);
}

let hostOf: CalendarHost<unknown> | undefined;
const EVENTS = defineList<unknown>({
  name: 'calendar.events',
  async read(ctx) { return hostOf ? await hostOf.events(ctx) : []; },
  operator: { method: 'calendar.events.list', input: {}, rows: { from: 'events', value: 'id', label: 'title', detail: 'start' } },
});
const FEEDS = defineList<unknown>({
  name: 'calendar.subscriptions',
  async read(ctx) { return hostOf?.subscriptionRows ? await hostOf.subscriptionRows(ctx) : []; },
  operator: { terminalOnly: AGENT_ONLY },
});

const EVENT: InputDescription = listInput({ id: 'event', label: 'Event', help: 'The events ahead', list: EVENTS, other: 'an event id shown by /calendar upcoming' });
const TIME_WHY = 'a date (2026-08-01) or an ISO-8601 time (2026-08-01T14:00, with Z or an offset for another zone)';
const PROVIDERS: readonly FixedChoice[] = [{ value: 'google', label: 'Google Calendar' }, { value: 'outlook', label: 'Outlook calendar' }];
const PROVIDER: InputDescription = { id: 'provider', label: 'Account', help: 'Which calendar account', kind: 'choice', choices: PROVIDERS, required: true, typed: { position: 1 } };
const FEED: InputDescription = listInput({ id: 'name', label: 'Feed', help: 'The calendar feeds you subscribe to', list: FEEDS });

function daysOf(raw: string | undefined): number {
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1) throw commandRefusal(`How many days: "${raw}" is not a whole number of days.`);
  return Math.min(days, 366);
}

/** Register `/calendar` with the calendar this app works with. */
export function registerCalendarCommand<Ctx extends CommandActionContext>(registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>, host: CalendarHost<Ctx>): void {
  hostOf = host as unknown as CalendarHost<unknown>;
  const actions: ActionDescription<Ctx>[] = [
    readAction<Ctx>({
      id: 'upcoming', label: 'See what is coming up', word: 'upcoming',
      inputs: [{ id: 'days', label: 'How many days', help: 'How far ahead', kind: 'number', required: { default: '7', defaultMeans: 'the next seven days' }, typed: { flag: '--days' } }],
      sentence: 'Lists the events of the days ahead, from every calendar this program reads.', example: { days: '14' },
      operator: { method: 'calendar.events.list', fields: {} },
      async run(values, ctx) { return await host.upcoming(ctx, daysOf(values.days ?? '7')); },
    }),
    readAction<Ctx>({
      id: 'get', label: 'See one event', word: 'get', inputs: [EVENT],
      sentence: 'Shows {event} with its times, place, guests and notes.', example: { event: 'evt-42' },
      operator: { method: 'calendar.events.get', fields: { 'body.eventId': 'event' } },
      async run(values, ctx) { return await host.get(ctx, values.event!); },
    }),
    {
      id: 'add', label: 'Add an event', word: 'add',
      inputs: [
        textInput({ id: 'title', label: 'Title', help: 'What it is', why: 'your own words', typed: { flag: '--title' } }),
        textInput({ id: 'start', label: 'Starts', help: 'When it starts; a time without a zone is read in this machine\'s zone', why: TIME_WHY, typed: { flag: '--start' } }),
        textInput({ id: 'end', label: 'Ends', help: 'When it ends (the daemon\'s calendar needs one)', why: TIME_WHY, typed: { flag: '--end' }, optional: { default: '', means: 'no end time' } }),
        textInput({ id: 'location', label: 'Where', help: 'Where it is', why: 'a place in your own words', typed: { flag: '--location' }, optional: { default: '', means: 'no place' } }),
        textInput({ id: 'notes', label: 'Notes', help: 'Anything to note with it', why: 'your own words', typed: { flag: '--notes' }, optional: { default: '', means: 'no notes' } }),
        { id: 'again', label: 'Already added', help: 'Whether to add it when this exact event was already added from this session', kind: 'choice',
          choices: [{ value: 'no', label: 'Do not add it twice' }, { value: 'yes', label: 'Add it again' }],
          required: { default: 'no', defaultMeans: 'do not add it twice' }, typed: { flag: '--again', switchOn: 'yes' } },
      ],
      sentence: '"{title}" starting {start} is added to the calendar, until you change it; a shared calendar tells its guests.', done: '',
      touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'delete',
      operator: { method: 'calendar.events.create', fields: { 'body.title': 'title', 'body.start': 'start', 'body.end': 'end', 'body.location': 'location', 'body.description': 'notes', 'body.confirm': '=true' } },
      example: { title: 'Design review', start: '2026-08-01T14:00', end: '2026-08-01T15:00' },
      async run(values, ctx) {
        return await host.add(ctx, {
          title: values.title!, start: values.start!,
          ...(values.end ? { end: values.end } : {}), ...(values.location ? { location: values.location } : {}), ...(values.notes ? { notes: values.notes } : {}),
        }, values.again === 'yes');
      },
    },
    {
      id: 'change', label: 'Change an event', word: 'change',
      inputs: [
        EVENT,
        textInput({ id: 'title', label: 'Title', help: 'A new title; blank keeps it', why: 'your own words', typed: { flag: '--title' }, optional: { default: '', means: 'unchanged' } }),
        textInput({ id: 'start', label: 'Starts', help: 'A new start; blank keeps it', why: TIME_WHY, typed: { flag: '--start' }, optional: { default: '', means: 'unchanged' } }),
        textInput({ id: 'end', label: 'Ends', help: 'A new end; blank keeps it', why: TIME_WHY, typed: { flag: '--end' }, optional: { default: '', means: 'unchanged' } }),
      ],
      sentence: '{event} changes to what you gave, until you change it again; its guests are told.', done: '',
      touches: 'another-machine', lasts: 'kept', risk: 'sends-out',
      operator: { method: 'calendar.events.update', fields: { 'body.eventId': 'event', 'body.title': 'title', 'body.start': 'start', 'body.end': 'end', 'body.confirm': '=true' } },
      example: { event: 'evt-42', start: '2026-08-01T15:00' },
      async run(values, ctx) {
        if (!host.change) return missing('Changing an event', 'the Agent\'s own events are removed and added again; run it in goodvibes for the daemon\'s calendar');
        if (!values.title && !values.start && !values.end) throw commandRefusal(`Nothing to change for ${values.event}: give a new title, start or end.`);
        return await host.change(ctx, values.event!, {
          ...(values.title ? { title: values.title } : {}), ...(values.start ? { start: values.start } : {}), ...(values.end ? { end: values.end } : {}),
        });
      },
    },
    {
      id: 'delete', label: 'Remove an event', word: 'delete', inputs: [EVENT],
      sentence: '{event} is removed from the calendar; a shared calendar tells its guests.', done: '',
      touches: 'another-machine', lasts: 'kept', risk: 'cannot-be-undone',
      operator: { method: 'calendar.events.delete', fields: { 'body.eventId': 'event', 'body.confirm': '=true' } },
      example: { event: 'evt-42' },
      async run(values, ctx) { return await host.remove(ctx, values.event!); },
    },
    readAction<Ctx>({
      id: 'status', label: 'See whether the calendar is connected', word: 'status',
      sentence: 'Shows whether the daemon\'s calendar is set up and reachable, and what to do next if not.',
      operator: { terminalOnly: 'the web UI shows the calendar connection in Settings' },
      async run(_values, ctx) { return host.status ? await host.status(ctx) : missing('The connection check', TERMINAL_ONLY); },
    }),
    readAction<Ctx>({
      id: 'all', label: 'See every event', word: 'all',
      sentence: 'Lists every event this program keeps, with the events of the feeds you subscribe to.',
      operator: { terminalOnly: AGENT_ONLY },
      async run(_values, ctx) { return host.all ? await host.all(ctx) : missing('Every event', `${AGENT_ONLY}; /calendar upcoming --days 366 reads the daemon's calendar a year ahead`); },
    }),
    doAction<Ctx>({
      id: 'import', label: 'Import events from a file', word: 'import',
      inputs: [textInput({ id: 'path', label: 'File', help: 'An .ics file', why: 'a file path', kind: 'path', typed: { position: 1 } })],
      sentence: 'The events in {path} are added; one already imported is skipped.', touches: 'this-machine', example: { path: 'team.ics' },
      operator: { terminalOnly: AGENT_ONLY },
      async run(values, ctx) { return host.importFile ? await host.importFile(ctx, values.path!) : missing('Importing a file', AGENT_ONLY); },
    }),
    doAction<Ctx>({
      id: 'export', label: 'Export events to a file', word: 'export',
      inputs: [textInput({ id: 'dest', label: 'File', help: 'A new .ics file; an existing file is never replaced', why: 'a file path', kind: 'path', typed: { position: 1 }, optional: { default: '', means: 'shown here instead' } })],
      sentence: 'Every event is written as iCalendar to the file you name, or shown here.', touches: 'this-machine', example: { dest: 'calendar.ics' },
      operator: { terminalOnly: AGENT_ONLY },
      async run(values, ctx) { return host.exportFile ? await host.exportFile(ctx, values.dest ?? '') : missing('Exporting to a file', AGENT_ONLY); },
    }),
    readAction<Ctx>({
      id: 'accounts', label: 'See your calendar accounts', word: 'accounts',
      sentence: 'Lists the calendar accounts this program is signed in to and whether each still works.',
      operator: { terminalOnly: AGENT_ONLY },
      async run(_values, ctx) { return host.accounts ? await host.accounts(ctx) : missing('Calendar accounts', `${AGENT_ONLY}; the daemon's Google account is under /google`); },
    }),
    {
      id: 'connect', label: 'Sign in to a calendar account', word: 'connect',
      inputs: [
        PROVIDER,
        { id: 'how', label: 'Sign in with', help: 'A browser on this machine, a code shown here for another device, or the address the browser landed on', kind: 'choice',
          choices: [{ value: 'browser', label: 'A browser on this machine' }, { value: 'device', label: 'A code to enter on another device' }, { value: 'code', label: 'The address the browser landed on' }],
          required: { default: 'browser', defaultMeans: 'a browser on this machine' }, typed: { flag: '--with' } },
        { id: 'code', label: 'Address or code', help: 'The address the browser landed on after sign-in, or the code it showed; never shown', kind: 'secret', required: true, typed: { flag: '--code' }, showWhen: { input: 'how', is: 'code' } },
      ],
      sentence: 'This program signs in to your {provider} calendar and reads it, until you change it.', done: '',
      touches: 'credential', lasts: 'kept', risk: 'none', undoneBy: 'disconnect',
      ownerOnly: { reason: 'signing a calendar account in grants access to it', instead: '/calendar accounts shows what is signed in' },
      operator: { terminalOnly: AGENT_ONLY },
      example: { provider: 'google' },
      async run(values, ctx) {
        if (!host.connect) return missing('Signing in to a calendar account', `${AGENT_ONLY}; the daemon's Google account is under /google`);
        return await host.connect(ctx, values.provider as CalendarProvider, (values.how ?? 'browser') as CalendarSignIn, values.code ?? '');
      },
    },
    {
      id: 'disconnect', label: 'Sign out of a calendar account', word: 'disconnect', inputs: [PROVIDER],
      sentence: 'This program signs out of your {provider} calendar and forgets its sign-in.', done: '',
      touches: 'credential', lasts: 'kept', risk: 'cannot-be-undone',
      ownerOnly: { reason: 'signing a calendar account out removes its stored sign-in', instead: '/calendar accounts shows what is signed in' },
      operator: { terminalOnly: AGENT_ONLY },
      example: { provider: 'google' },
      async run(values, ctx) { return host.disconnect ? await host.disconnect(ctx, values.provider as CalendarProvider) : missing('Signing out', AGENT_ONLY); },
    },
    readAction<Ctx>({
      id: 'subscriptions', label: 'See the feeds you subscribe to', word: 'subscriptions',
      sentence: 'Lists each calendar feed, its masked address, how it is doing and how often it is read.',
      operator: { terminalOnly: AGENT_ONLY },
      async run(_values, ctx) { return host.subscriptions ? await host.subscriptions(ctx) : missing('Calendar feeds', AGENT_ONLY); },
    }),
    {
      id: 'subscribe', label: 'Subscribe to a calendar feed', word: 'subscribe',
      inputs: [
        { id: 'url', label: 'Feed address', help: 'The feed\'s https or webcal address; it can grant read access, so it is kept as a secret', kind: 'secret', required: true, typed: { position: 1 } },
        textInput({ id: 'name', label: 'Name', help: 'What to call it', why: 'a name you choose', typed: { flag: '--name' }, optional: { default: '', means: 'the feed\'s own name' } }),
        { id: 'every', label: 'Read every', help: 'Minutes between reads, at least 15', kind: 'number', required: { default: '60', defaultMeans: 'every hour' }, typed: { flag: '--every' } },
        { id: 'network', label: 'Private network', help: 'Whether the feed may be on your own network', kind: 'choice',
          choices: [{ value: 'no', label: 'Public addresses only' }, { value: 'yes', label: 'Allow my private network', risk: 'loosens-a-protection' }],
          required: { default: 'no', defaultMeans: 'public addresses only' }, typed: { flag: '--allow-private-host', switchOn: 'yes' } },
      ],
      sentence: 'The feed is read now and on each refresh, its events shown read-only beside yours, until you change it.', done: '',
      touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'unsubscribe',
      operator: { terminalOnly: AGENT_ONLY },
      example: {},
      async run(values, ctx) {
        if (!host.subscribe) return missing('Subscribing to a feed', AGENT_ONLY);
        const every = Number(values.every ?? '60');
        if (!Number.isFinite(every)) throw commandRefusal(`Read every: "${values.every}" is not a number of minutes.`);
        return await host.subscribe(ctx, { url: values.url!, ...(values.name ? { name: values.name } : {}), everyMinutes: Math.max(15, Math.floor(every)), privateNetwork: values.network === 'yes' });
      },
    },
    doAction<Ctx>({
      id: 'refresh', label: 'Read the feeds again now', word: 'refresh',
      inputs: [{ ...FEED, required: { default: '', defaultMeans: 'every feed' } }],
      sentence: 'Each feed, or the one you name, is read again now.', touches: 'another-machine', example: { name: 'team' },
      operator: { terminalOnly: AGENT_ONLY },
      async run(values, ctx) { return host.refresh ? await host.refresh(ctx, values.name ?? '') : missing('Reading the feeds', AGENT_ONLY); },
    }),
    {
      id: 'unsubscribe', label: 'Stop subscribing to a feed', word: 'unsubscribe', inputs: [FEED],
      sentence: '{name} is removed with its events and its stored address.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone',
      ownerOnly: { reason: 'it deletes a stored feed address that cannot be recovered from here', instead: '/calendar subscriptions lists the feeds' },
      operator: { terminalOnly: AGENT_ONLY },
      example: { name: 'team' },
      async run(values, ctx) { return host.unsubscribe ? await host.unsubscribe(ctx, values.name!) : missing('Removing a feed', AGENT_ONLY); },
    },
  ];
  registry.register(defineCommand<Ctx>({
    name: 'calendar',
    title: 'Calendar',
    summary: 'See what is coming up, add, change and remove events, and the feeds and accounts your calendar reads',
    group: 'Channels',
    report: 'upcoming',
    firstScreenRows: [
      'upcoming', 'get', 'add', 'change', 'delete',
      { label: 'Connect a calendar…', actions: ['status', 'accounts', 'connect', 'disconnect'] },
      { label: 'Calendar feeds…', actions: ['subscriptions', 'subscribe', 'refresh', 'unsubscribe'] },
      { label: 'Every event and files…', actions: ['all', 'import', 'export'] },
    ],
    actions,
  }));
}
