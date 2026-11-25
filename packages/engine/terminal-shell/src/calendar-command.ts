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
import { CALENDAR_ADD, CALENDAR_CHANGE, CALENDAR_DELETE, CALENDAR_GET, CALENDAR_UPCOMING, type MethodCapabilityDefinition } from '@goodvibes/engine/platform/platform/capabilities';
import { capabilityWords } from './command-actions/capability-actions.js';

/** A moved action's words and the method its capability runs through (the web UI's sheet calls it the same way). */
function movedWords<Ctx>(definition: MethodCapabilityDefinition): Omit<ActionDescription<Ctx>, 'run'> {
  return { ...capabilityWords<Ctx>(definition), operator: { method: definition.method.id, fields: definition.method.fields } };
}

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
  /** Keep the owner's own OAuth app (client id, and a client secret when the app has one) that signing in to `provider` uses. */
  readonly useApp?: ((ctx: Ctx, provider: CalendarProvider, clientId: string, clientSecret: string) => Promise<string>) | undefined;
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

/** The event list the capabilities' Event input chooses from, under the name they give it (builtin/messages.ts). */
export const CALENDAR_EVENTS = EVENTS;
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
    {
      // A handler capability in the daemon (its window of days is the handler's); the web UI's sheet lists the next 30 days.
      ...capabilityWords<Ctx>(CALENDAR_UPCOMING),
      operator: { method: 'calendar.events.list', fields: {} },
      async run(values, ctx) { return await host.upcoming(ctx, daysOf(values.days ?? '7')); },
    },
    {
      ...movedWords<Ctx>(CALENDAR_GET),
      async run(values, ctx) { return await host.get(ctx, values.event!); },
    },
    {
      ...movedWords<Ctx>(CALENDAR_ADD),
      async run(values, ctx) {
        return await host.add(ctx, {
          title: values.title!, start: values.start!,
          ...(values.end ? { end: values.end } : {}), ...(values.location ? { location: values.location } : {}), ...(values.notes ? { notes: values.notes } : {}),
        }, values.again === 'yes');
      },
    },
    {
      ...movedWords<Ctx>(CALENDAR_CHANGE),
      async run(values, ctx) {
        if (!host.change) return missing('Changing an event', 'the Agent\'s own events are removed and added again; run it in goodvibes for the daemon\'s calendar');
        if (!values.title && !values.start && !values.end) throw commandRefusal(`Nothing to change for ${values.event}: give a new title, start or end.`);
        return await host.change(ctx, values.event!, {
          ...(values.title ? { title: values.title } : {}), ...(values.start ? { start: values.start } : {}), ...(values.end ? { end: values.end } : {}),
        });
      },
    },
    {
      ...movedWords<Ctx>(CALENDAR_DELETE),
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
      id: 'use-app', label: 'Use your own calendar app to sign in', word: 'use-app',
      inputs: [
        PROVIDER,
        textInput({ id: 'clientId', label: 'Client id', help: 'The OAuth client id your Google Cloud or Azure app registration shows', why: 'an id only the provider can give you', typed: { position: 2 } }),
        { id: 'clientSecret', label: 'Client secret', help: 'Only for an app registered as a confidential client; kept in the secret store, never shown', kind: 'secret', required: { default: '', defaultMeans: 'none (a desktop app has none)' }, typed: { flag: '--secret' } },
      ],
      sentence: 'Signing in to your {provider} calendar uses your own app, client id {clientId}, until you change it; then sign in with /calendar connect.', done: '',
      touches: 'credential', lasts: 'kept', risk: 'none',
      ownerOnly: { reason: 'it keeps an app credential that signing in to a calendar uses', instead: '/calendar accounts shows what is signed in' },
      operator: { terminalOnly: AGENT_ONLY },
      example: { provider: 'google', clientId: '123-abc.apps.googleusercontent.com' },
      async run(values, ctx) { return host.useApp ? await host.useApp(ctx, values.provider as CalendarProvider, values.clientId!, values.clientSecret ?? '') : missing('Keeping a calendar app', AGENT_ONLY); },
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
        { id: 'every', label: 'Read every', help: 'Minutes after which the feed is read again when your calendar is read, at least 15', kind: 'number', required: { default: '60', defaultMeans: 'every hour' }, typed: { flag: '--every' } },
        { id: 'network', label: 'Private network', help: 'Whether the feed may be on your own network', kind: 'choice',
          choices: [{ value: 'no', label: 'Public addresses only' }, { value: 'yes', label: 'Allow my private network', risk: 'loosens-a-protection' }],
          required: { default: 'no', defaultMeans: 'public addresses only' }, typed: { flag: '--allow-private-host', switchOn: 'yes' } },
      ],
      sentence: 'Read now. It is read again whenever your calendar is shown and this feed is more than {every} minutes old; its events show read-only beside yours, until you change it.', done: '',
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
      { label: 'Connect a calendar…', actions: ['status', 'accounts', 'use-app', 'connect', 'disconnect'] },
      { label: 'Calendar feeds…', actions: ['subscriptions', 'subscribe', 'refresh', 'unsubscribe'] },
      { label: 'Every event and files…', actions: ['all', 'import', 'export'] },
    ],
    actions,
  }));
}
