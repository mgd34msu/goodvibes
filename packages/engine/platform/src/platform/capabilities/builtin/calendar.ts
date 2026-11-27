/**
 * The calendar's own capabilities beside its events (messages.ts: what is
 * coming up, one event, add, change, remove): the calendar kept on this
 * computer (every event, a file in and out), the feeds subscribed to, the
 * calendar accounts signed in to, and whether it is all connected. Every one
 * runs in the daemon, on its local calendar (calendar/local-calendar.ts) and
 * its calendar accounts (calendar/daemon-accounts.ts), the Agent's 3.5.0 ones
 * carried into them.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { unreadableFile } from '../path-inputs.js';
import type { DaemonLocalCalendar } from '../../calendar/local-calendar.js';
import type { DaemonCalendarAccounts } from '../../calendar/daemon-accounts.js';
import type { CalendarProviderId } from '../../calendar/oauth-types.js';
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type FixedChoice, type InputDescription, type ListName } from '../types.js';

export const CALENDAR_FEEDS_LIST = 'calendar.subscriptions' as ListName;

export interface CalendarHereCapabilityServices {
  readonly calendarHere: {
    /** The calendar kept on this computer (events and feeds). */
    local(): DaemonLocalCalendar;
    /** The calendar accounts the daemon signs in to. */
    accounts(): DaemonCalendarAccounts;
    /** Whether a CalDAV server is set (it answers the connected calendar before an account). */
    caldavSet(): boolean;
    /** A file the caller named, from the caller's project folder. */
    resolvePath(caller: CapabilityCaller, path: string): string;
    /** Every view of the calendar reads it again. */
    changed(): void;
    /**
     * Put a sign-in link in the owner inbox, for a run nobody is sitting at (as the Google connection's consent link
     * is); returns its withdrawal. Absent: the daemon keeps no owner inbox.
     */
    postSignIn?: ((title: string, detail: string) => () => void) | undefined;
  };
}

type Def = CapabilityDefinition<CalendarHereCapabilityServices>;
const READ = { done: '', touches: 'reads', lasts: 'not-a-change', risk: 'none' } as const;
// The sentences say "your {provider} calendar": the choices are the accounts' names alone.
const PROVIDERS: readonly FixedChoice[] = [{ value: 'google', label: 'Google' }, { value: 'outlook', label: 'Outlook' }];
const PROVIDER: InputDescription = { id: 'provider', label: 'Account', help: 'Which calendar account', kind: 'choice', choices: PROVIDERS, required: true, typed: { position: 1 } };
const FEED: InputDescription = { id: 'name', label: 'Feed', help: 'The calendar feeds you subscribe to', kind: 'choice', choices: { list: CALENDAR_FEEDS_LIST, allowOther: { reason: 'a feed\'s name' } }, required: true, typed: { position: 1 } };
const providerOf = (value: string | undefined): CalendarProviderId => (value === 'outlook' || value === 'microsoft' ? 'microsoft' : 'google');
const plain = (value: string): string => value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, ' ');
const failed = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const STATE_WORDS: Record<string, string> = {
  connected: 'signed in', 'refresh-due': 'signed in (its sign-in is renewed at the next read)', 'reconnect-needed': 'needs signing in again',
  disconnected: 'not signed in', unreadable: 'the secret store could not be read; nothing is asked again',
};
const HEALTH_WORDS: Record<string, string> = {
  ok: 'read', stale: 'not read lately', unreachable: 'could not be reached', 'parse-error': 'is not a calendar', 'never-fetched': 'not read yet',
};
const day = (iso: string): string => iso.replace('T', ' ').slice(0, 16);

export const CALENDAR_STATUS: Def = {
  capability: { id: 'calendar.status', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'status', word: 'status', label: 'See whether the calendar is connected', inputs: [], ...READ,
  sentence: 'Shows which calendars the daemon reads (this computer\'s, its feeds, a CalDAV server, Google, Outlook) and what to do next for one that is not connected.', example: {},
  async run(_values, services) {
    const local = services.calendarHere.local();
    const events = local.events.list().length;
    const feeds = local.feeds.statuses();
    const accounts = await services.calendarHere.accounts().list();
    const google = accounts.accounts.find((row) => row.account.provider === 'google');
    const outlook = accounts.accounts.find((row) => row.account.provider === 'microsoft');
    const lines = [
      `On this computer: ${events} event${events === 1 ? '' : 's'}.`,
      feeds.length === 0 ? 'Feeds: none subscribed to.' : `Feeds: ${feeds.map((feed) => `${feed.name} (${HEALTH_WORDS[feed.health] ?? feed.health})`).join(', ')}.`,
      `CalDAV server: ${services.calendarHere.caldavSet() ? 'set' : 'not set'}.`,
      accounts.unreadable ? `Google and Outlook: ${accounts.unreadable}` : `Google: ${google ? `${plain(google.account.label)}, ${STATE_WORDS[google.state] ?? google.state}` : 'not signed in'}.`,
      ...(accounts.unreadable ? [] : [`Outlook: ${outlook ? `${plain(outlook.account.label)}, ${STATE_WORDS[outlook.state] ?? outlook.state}` : 'not signed in'}.`]),
      ...(!google && !outlook && !services.calendarHere.caldavSet() && !accounts.unreadable
        ? ['New events are kept on this computer. To use a Google or Outlook calendar, sign in under Calendar accounts.'] : []),
    ];
    return { text: lines.join('\n'), data: { events, feeds: feeds.length, caldav: services.calendarHere.caldavSet(), accounts: accounts.accounts.map((row) => ({ provider: row.account.provider, state: row.state })) } };
  },
};

export const CALENDAR_ALL: Def = {
  capability: { id: 'calendar.all', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'all', word: 'all', label: 'See every event', inputs: [], ...READ,
  sentence: 'Lists every event kept on this computer, past and future, with the events of the feeds you subscribe to.', example: {},
  async run(_values, services) {
    const local = services.calendarHere.local();
    const own = local.events.list();
    const fed = local.feeds.seeds();
    const read = local.events.read();
    const lines = [
      own.length === 0 ? 'No event is kept on this computer.' : `${own.length} event${own.length === 1 ? '' : 's'} on this computer:`,
      ...own.map((event) => `  ${day(event.start)}  ${plain(event.title)}${event.location ? `  at ${plain(event.location)}` : ''}${event.recurrence ? '  (repeats)' : ''}`),
      ...(read.unreadable ? [`The events file could not be read (${read.unreadable}); the next change keeps a copy of it before replacing it.`] : []),
      ...(read.kept.length > 0 ? [`${read.kept.length} stored entr${read.kept.length === 1 ? 'y' : 'ies'} this version cannot read ${read.kept.length === 1 ? 'is' : 'are'} kept as found and not shown.`] : []),
      ...(fed.length > 0 ? ['', `${fed.length} event${fed.length === 1 ? '' : 's'} from your feeds (read-only):`, ...fed.map((row) => `  ${day(row.start)}  ${plain(row.event.summary || 'Untitled event')}  (${plain(row.feed)})`)] : []),
    ];
    return { text: lines.join('\n'), data: { events: own.length, fromFeeds: fed.length } };
  },
};

/**
 * Where the file is: on the daemon's machine, or on the machine of the program asking, which reads and writes it
 * there itself and sends its text (`content`) or writes the text that comes back (`data.file`) (terminal-shell
 * bundle-file-work.ts). Filled by the program asking, never asked of a person.
 */
const FILES_AT: InputDescription = {
  id: 'filesAt', label: 'Where the file is', help: 'On the daemon\'s machine, or on the machine of the program asking (which sends and writes the file itself)',
  kind: 'choice', choices: [{ value: 'daemon', label: 'On the daemon\'s machine' }, { value: 'program', label: 'On the machine of the program asking' }],
  required: { default: 'daemon', defaultMeans: 'on the daemon\'s machine' }, typed: { flag: '--files-at' }, showWhen: { suppliedBy: 'the program asking' },
};
const CONTENT: InputDescription = {
  id: 'content', label: 'What the file holds', help: 'The file\'s text, sent by the program asking when the file is on its machine',
  kind: 'long-text', freeTextReason: 'filled by the program asking', required: { default: '', defaultMeans: 'read from the path' },
  typed: { flag: '--content' }, showWhen: { suppliedBy: 'the program asking' },
};

export const CALENDAR_IMPORT: Def = {
  capability: { id: 'calendar.import', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'import', word: 'import', label: 'Import events from a file',
  inputs: [{ id: 'path', label: 'File', help: 'An .ics file on this computer', kind: 'path', freeTextReason: 'a file path', required: true, typed: { position: 1 } }, FILES_AT, CONTENT],
  sentence: 'The events in {path} are added to the calendar on this computer; one already imported is skipped.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { path: 'team.ics' },
  async run(values, services, caller) {
    // The file on the asking program's machine: its text was sent; the daemon reads no path.
    const sent = values.filesAt === 'program';
    const path = sent ? '' : services.calendarHere.resolvePath(caller, values.path ?? '');
    let text: string;
    try { text = sent ? values.content ?? '' : readFileSync(path, 'utf8'); } catch (error) {
      // Never the system's words (capabilities/path-inputs.ts).
      throw unreadableFile(values.path ?? '', 'an .ics file', caller, error, 'Nothing was imported.');
    }
    const result = services.calendarHere.local().events.importIcs(text);
    // An entry that could not be read is quoted only to the person or the program that sent the text: it is the file's own.
    const quoteEntry = sent || caller.personAsked === true;
    if (result.imported.length > 0) services.calendarHere.changed();
    return {
      text: [
        `Imported ${result.imported.length} event${result.imported.length === 1 ? '' : 's'}.`,
        ...(result.duplicates > 0 ? [`${result.duplicates} already in the calendar from an earlier import ${result.duplicates === 1 ? 'was' : 'were'} skipped.`] : []),
        ...(result.secretSkipped > 0 ? [`${result.secretSkipped} with a secret-looking field ${result.secretSkipped === 1 ? 'was' : 'were'} not imported.`] : []),
        ...(result.untitled > 0 ? [`${result.untitled} had no title and ${result.untitled === 1 ? 'was' : 'were'} imported as "Untitled event".`] : []),
        ...(result.notParsed.length > 0 ? [`${result.notParsed.length} entr${result.notParsed.length === 1 ? 'y' : 'ies'} could not be read${quoteEntry ? `: ${result.notParsed[0] ?? ''}` : '.'}`] : []),
        ...(result.unexpandedSeries.length > 0 ? [`${result.unexpandedSeries.length} repeating event${result.unexpandedSeries.length === 1 ? '' : 's'} show on the first date only.`] : []),
      ].join(' '),
      data: { imported: result.imported.length, duplicates: result.duplicates },
    };
  },
};

export const CALENDAR_EXPORT: Def = {
  capability: { id: 'calendar.export', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'export', word: 'export', label: 'Export events to a file',
  inputs: [{ id: 'dest', label: 'File', help: 'A new .ics file; an existing file is never replaced', kind: 'path', file: 'written', freeTextReason: 'a file path', required: { default: '', defaultMeans: 'shown here instead' }, typed: { position: 1 } }, FILES_AT],
  sentence: 'Every event kept on this computer is written as iCalendar to the file you name, or shown here.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { dest: 'calendar.ics' },
  async run(values, services, caller) {
    const ics = services.calendarHere.local().events.exportIcs();
    if (!values.dest) return { text: ics, data: { written: false } };
    // The file on the asking program's machine: its text goes back, and that program writes it there (it checked that
    // nothing is at that place first, as here).
    if (values.filesAt === 'program') return { text: `The calendar on this computer is written to ${values.dest}.`, data: { written: true, file: { content: ics } } };
    const path = services.calendarHere.resolvePath(caller, values.dest);
    if (existsSync(path)) throw new CapabilityRefusal(`${values.dest} already exists and is never replaced; nothing was written.`, 'Name a new file');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, ics, 'utf8');
    return { text: `The calendar on this computer is written to ${values.dest}.`, data: { written: true } };
  },
};

export const CALENDAR_ACCOUNTS: Def = {
  capability: { id: 'calendar.accounts', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'accounts', word: 'accounts', label: 'See your calendar accounts', inputs: [], ...READ,
  sentence: 'Lists the calendar accounts (Google, Outlook) the daemon is signed in to and whether each still works.', example: {},
  async run(_values, services) {
    const accounts = services.calendarHere.accounts();
    const listed = await accounts.list();
    const rows = (['google', 'microsoft'] as const).map((provider) => {
      const found = listed.accounts.find((row) => row.account.provider === provider);
      const ended = listed.ended.find((entry) => entry.provider === provider && !entry.ok);
      // A Google grant made by a calendar sign-in names only calendar scopes: the calendar alone, no mail.
      const scopes = found?.account.scopes ?? [];
      const calendarOnly = provider === 'google' && scopes.length > 0 && scopes.every((scope) => scope.includes('/auth/calendar'));
      return {
        provider: provider === 'microsoft' ? 'outlook' : 'google', name: accounts.label(provider),
        state: listed.unreadable ? 'unreadable' : found ? found.state : 'disconnected',
        ...(found ? { account: plain(found.account.label) } : {}), ...(ended && !found ? { lastTry: ended.detail } : {}),
        ...(calendarOnly ? { calendarOnly: true } : {}),
      };
    });
    const text = listed.unreadable
      ? `Calendar accounts: ${listed.unreadable}`
      : rows.map((row) => `${row.name}: ${row.account ? `${row.account}, ` : ''}${STATE_WORDS[row.state] ?? row.state}${row.lastTry ? ` (${row.lastTry})` : ''}`).join('\n');
    return { text, data: { accounts: rows } };
  },
};

type SignInStep = Awaited<ReturnType<DaemonCalendarAccounts['signIn']>>;

/**
 * What the person does next, without the link: the link is handed to the person who pressed as the capability's
 * reveal (its own pane), or put in the owner inbox for a run nobody is sitting at; never in a line, a list or a log.
 */
function stepText(step: SignInStep, label: string, toPerson: boolean): string {
  const where = toPerson ? 'the sign-in link' : 'the sign-in link in Waiting for you';
  switch (step.kind) {
    case 'connected': return `${label}: ${plain(step.account.label)} is signed in.`;
    case 'shared': return `${label}: the Google connection (${plain(step.account.label)}) on the Google tab already covers the calendar; it is read with nothing more to approve.`;
    case 'browser': return `${step.opened ? 'A browser opened on the daemon\'s computer with the sign-in page' : `Open ${where} in a browser on the daemon's computer`}. Approve it there; the account is signed in when you do, and Calendar accounts shows it.`;
    case 'device': return `On any device, open ${where} and enter the code ${step.code}. The account is signed in when you approve it, and Calendar accounts shows it.`;
    case 'paste': return `Open ${where} on any device and approve it. The browser then lands on an address that does not load; sign in again with "The address the browser landed on" and paste that address. It is good for ten minutes.`;
  }
}

const SIGN_IN_REVEAL = {
  label: 'Sign-in link',
  note: 'Open it in a browser on the daemon\'s computer (any device, when you chose a code for another device) and approve it with the account to sign in; it works once, for ten minutes. Calendar accounts shows the account once it is signed in.',
} as const;

export const CALENDAR_CONNECT: Def = {
  capability: { id: 'calendar.connect', group: 'messages', home: 'daemon', repeat: 'unsafe' },
  actionId: 'connect', word: 'connect', label: 'Sign in to a calendar account',
  inputs: [
    PROVIDER,
    { id: 'how', label: 'Sign in with', help: 'A browser on this computer, a code for another device, or the address the browser landed on', kind: 'choice',
      choices: [{ value: 'browser', label: 'A browser on this computer' }, { value: 'device', label: 'A code to enter on another device' }, { value: 'code', label: 'The address the browser landed on' }],
      required: { default: 'browser', defaultMeans: 'a browser on this computer' }, typed: { flag: '--with' } },
    { id: 'code', label: 'Address or code', help: 'The address the browser landed on after sign-in, or the code it showed; never shown', kind: 'secret', required: true, typed: { flag: '--code' }, showWhen: { input: 'how', is: 'code' } },
  ],
  sentence: 'The daemon signs in to {provider} and reads it beside the calendar on this computer, until you sign out; Google already connected on the Google tab is read with nothing more asked.', done: '',
  touches: 'credential', lasts: 'kept', risk: 'none', undoneBy: 'disconnect',
  // Signing in keeps a sign-in token: the owner's alone, as `/calendar connect` was at v3.5.0; a model's call is put to the owner.
  ownerOnly: { reason: 'signing a calendar account in grants access to it', instead: 'The Calendar accounts list shows what is signed in.' },
  effects: ['control-plane.write', 'secret.write'],
  reveals: SIGN_IN_REVEAL,
  example: { provider: 'google' },
  async run(values, services, caller) {
    const provider = providerOf(values.provider);
    const accounts = services.calendarHere.accounts();
    const how = values.how === 'device' || values.how === 'code' ? values.how : 'browser';
    const toPerson = caller.personAsked === true;
    // A run nobody is sitting at (the owner approved a model's or a script's call): its link waits in the owner
    // inbox until the sign-in is over.
    let withdraw: (() => void) | undefined;
    const ended = (): void => { withdraw?.(); withdraw = undefined; };
    let step: SignInStep;
    try { step = await accounts.signIn(provider, how, values.code ?? '', ended); } catch (error) {
      throw new CapabilityRefusal(`${accounts.label(provider)} was not signed in: ${failed(error)}`);
    }
    const link = step.kind === 'browser' || step.kind === 'device' || step.kind === 'paste' ? step.link : undefined;
    if (link && !toPerson) {
      if (!services.calendarHere.postSignIn) throw new CapabilityRefusal(`${accounts.label(provider)} was not signed in: nobody asked here to be handed the sign-in link, and this daemon keeps no owner inbox to put it in.`);
      withdraw = services.calendarHere.postSignIn(`Sign in to ${accounts.label(provider)}`,
        `${stepText(step, accounts.label(provider), true)}\n${step.kind === 'device' ? `Code: ${step.code}\n` : ''}${link}`);
    }
    return {
      text: stepText(step, accounts.label(provider), toPerson), data: { step: step.kind },
      ...(link && toPerson ? { reveal: { value: link } } : {}),
    };
  },
};

export const CALENDAR_USE_APP: Def = {
  capability: { id: 'calendar.use-app', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'use-app', word: 'use-app', label: 'Use your own calendar app to sign in',
  inputs: [
    PROVIDER,
    { id: 'clientId', label: 'Client id', help: 'The OAuth client id your Google Cloud or Azure app registration shows', kind: 'text', freeTextReason: 'an id only the provider can give you', required: true, typed: { position: 2 } },
    { id: 'clientSecret', label: 'Client secret', help: 'Only for an app registered as a confidential client; kept in the secret store, never shown', kind: 'secret', required: { default: '', defaultMeans: 'none (a desktop app has none)' }, typed: { flag: '--secret' } },
  ],
  sentence: 'Signing in to {provider} uses your own app, client id {clientId}, until you change it.', done: '',
  touches: 'credential', lasts: 'kept', risk: 'none',
  // The owner's alone, as `/calendar use-app` was at v3.5.0.
  ownerOnly: { reason: 'it keeps an app credential that signing in to a calendar uses', instead: 'The Calendar accounts list shows what is signed in.' },
  effects: ['control-plane.write', 'secret.write'],
  example: { provider: 'google', clientId: '123-abc.apps.googleusercontent.com' },
  async run(values, services) {
    const provider = providerOf(values.provider);
    const accounts = services.calendarHere.accounts();
    const clientId = (values.clientId ?? '').trim();
    if (!clientId) throw new CapabilityRefusal('Nothing was kept: the client id is empty.');
    try { await accounts.useApp(provider, clientId, values.clientSecret ?? ''); } catch (error) {
      throw new CapabilityRefusal(`Your ${accounts.label(provider)} app was not kept: ${failed(error)}`);
    }
    // The client id is not repeated in the line: a place leaves out a line holding a long id.
    return { text: `Your own ${accounts.label(provider)} app is kept${values.clientSecret ? ', its secret in the secret store' : ''}. Sign in to the account under Calendar accounts.`, data: { provider: values.provider, clientId } };
  },
};

export const CALENDAR_DISCONNECT: Def = {
  capability: { id: 'calendar.disconnect', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'disconnect', word: 'disconnect', label: 'Sign out of a calendar account', inputs: [PROVIDER],
  sentence: 'The daemon signs out of {provider} and forgets its sign-in; its events are no longer read.', done: '',
  touches: 'credential', lasts: 'kept', risk: 'cannot-be-undone', example: { provider: 'google' },
  // The owner's alone, as `/calendar disconnect` was at v3.5.0.
  ownerOnly: { reason: 'signing a calendar account out removes its stored sign-in', instead: 'The Calendar accounts list shows what is signed in.' },
  async run(values, services) {
    const provider = providerOf(values.provider);
    const accounts = services.calendarHere.accounts();
    const { revokedRemotely } = await accounts.signOut(provider);
    return {
      text: `${accounts.label(provider)} is signed out${provider === 'google' ? ' (it was the one Google connection, so the daemon\'s Gmail access stops too)' : ''}. ${revokedRemotely ? 'The provider revoked the access.' : 'The stored sign-in is deleted; the provider offers no revocation, so revoke it in your account settings if you want.'}`,
      data: { revokedRemotely },
    };
  },
};

export const CALENDAR_SUBSCRIPTIONS: Def = {
  capability: { id: 'calendar.subscriptions', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'subscriptions', word: 'subscriptions', label: 'See the feeds you subscribe to', inputs: [], ...READ,
  sentence: 'Lists each calendar feed you subscribe to, its site, whether it was read, and how often it is read.', example: {},
  async run(_values, services) {
    const feeds = services.calendarHere.local().feeds.statuses();
    if (feeds.length === 0) return { text: 'No calendar feed is subscribed to.', data: { feeds: [] } };
    return {
      text: feeds.map((feed) => `${plain(feed.name)}: ${HEALTH_WORDS[feed.health] ?? feed.health}, ${feed.eventCount} event${feed.eventCount === 1 ? '' : 's'}, read every ${Math.round(feed.refreshIntervalMs / 60_000)} minutes (${plain(feed.maskedUrl)})${feed.detail ? `. ${plain(feed.detail)}` : ''}`).join('\n'),
      data: { feeds: feeds.map((feed) => ({ name: feed.name, health: feed.health, eventCount: feed.eventCount, site: feed.maskedUrl, everyMinutes: Math.round(feed.refreshIntervalMs / 60_000), ...(feed.detail ? { detail: feed.detail } : {}) })) },
    };
  },
};

export const CALENDAR_SUBSCRIBE: Def = {
  capability: { id: 'calendar.subscribe', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'subscribe', word: 'subscribe', label: 'Subscribe to a calendar feed',
  inputs: [
    { id: 'url', label: 'Feed address', help: 'The feed\'s https or webcal address; it can grant read access, so it is kept as a secret', kind: 'secret', required: true, typed: { position: 1 } },
    { id: 'name', label: 'Name', help: 'What to call it', kind: 'text', freeTextReason: 'a name you choose', required: { default: '', defaultMeans: 'the feed\'s own name' }, typed: { flag: '--name' } },
    { id: 'every', label: 'Read every', help: 'Minutes after which the feed is read again when your calendar is read, at least 15', kind: 'number', required: { default: '60', defaultMeans: 'every hour' }, typed: { flag: '--every' } },
    { id: 'network', label: 'Private network', help: 'Whether the feed may be on your own network', kind: 'choice',
      choices: [{ value: 'no', label: 'Public addresses only' }, { value: 'yes', label: 'Allow my private network', risk: 'loosens-a-protection' }],
      required: { default: 'no', defaultMeans: 'public addresses only' }, typed: { flag: '--allow-private-host', switchOn: 'yes' } },
  ],
  sentence: 'The feed is read now and again whenever your calendar is read and it is more than {every} minutes old; its events show read-only beside yours, until you stop subscribing.', done: '',
  touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'unsubscribe', example: {},
  async run(values, services) {
    const every = Number(values.every ?? '60');
    if (!Number.isFinite(every)) throw new CapabilityRefusal(`Read every: "${values.every}" is not a number of minutes.`);
    let result;
    try {
      result = await services.calendarHere.local().feeds.subscribe(values.url ?? '', { name: values.name, everyMinutes: every, privateNetwork: values.network === 'yes' });
    } catch (error) { throw new CapabilityRefusal(`The feed could not be read: ${failed(error)}`); }
    if (!result.ok) throw new CapabilityRefusal(result.detail);
    services.calendarHere.changed();
    return { text: `Subscribed to "${plain(result.name)}": ${result.eventCount} event${result.eventCount === 1 ? '' : 's'} read; the address is kept in the secret store.`, data: { name: result.name, eventCount: result.eventCount } };
  },
};

export const CALENDAR_REFRESH: Def = {
  capability: { id: 'calendar.refresh', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'refresh', word: 'refresh', label: 'Read the feeds again now',
  inputs: [{ ...FEED, required: { default: '', defaultMeans: 'every feed' } }],
  sentence: 'Each feed, or the one you name, is read again now.', done: '', touches: 'another-machine', lasts: 'not-a-change', risk: 'none', example: { name: 'team' },
  async run(values, services) {
    const outcomes = await services.calendarHere.local().feeds.refresh(values.name || undefined, { force: true });
    if (outcomes.length === 0) return { text: values.name ? `No feed is named ${values.name}.` : 'No calendar feed is subscribed to; nothing was read.', data: { outcomes: [] } };
    services.calendarHere.changed();
    const words: Record<string, string> = { updated: 'read', 'not-modified': 'read, unchanged', unreachable: 'could not be reached', 'parse-error': 'is not a calendar' };
    return { text: outcomes.map((outcome) => `${plain(outcome.name)}: ${words[outcome.outcome] ?? outcome.outcome}${outcome.eventCount !== undefined ? `, ${outcome.eventCount} events` : ''}${outcome.detail ? ` (${plain(outcome.detail)})` : ''}`).join('\n'), data: { outcomes } };
  },
};

export const CALENDAR_UNSUBSCRIBE: Def = {
  capability: { id: 'calendar.unsubscribe', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'unsubscribe', word: 'unsubscribe', label: 'Stop subscribing to a feed', inputs: [FEED],
  sentence: '{name} is removed with its events and its stored address.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone', example: { name: 'team' },
  // The owner's alone, as `/calendar unsubscribe` was at v3.5.0.
  ownerOnly: { reason: 'it deletes a stored feed address that cannot be recovered from here', instead: 'The Feeds list shows the feeds you subscribe to.' },
  async run(values, services) {
    const result = await services.calendarHere.local().feeds.unsubscribe(values.name ?? '');
    if (!result.removed) throw new CapabilityRefusal(`No feed is named ${values.name}; nothing was removed.`);
    services.calendarHere.changed();
    return { text: `"${values.name}" is removed with its events${result.addressDeleted ? ' and its stored address' : '; its stored address could not be deleted from the secret store'}.`, data: { removed: true } };
  },
};

/** The calendar's handler capabilities of this file. */
export const CALENDAR_HERE_CAPABILITIES: readonly Def[] = [
  CALENDAR_STATUS, CALENDAR_ALL, CALENDAR_IMPORT, CALENDAR_EXPORT, CALENDAR_ACCOUNTS, CALENDAR_CONNECT, CALENDAR_USE_APP, CALENDAR_DISCONNECT,
  CALENDAR_SUBSCRIPTIONS, CALENDAR_SUBSCRIBE, CALENDAR_REFRESH, CALENDAR_UNSUBSCRIBE,
];
