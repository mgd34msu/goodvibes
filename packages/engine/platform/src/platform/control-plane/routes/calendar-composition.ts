/**
 * routes/calendar-composition.ts, the daemon's own calendar connection.
 *
 * Assembling it here rather than in the runtime composition root keeps one
 * property visible: the daemon reads the connection from the DAEMON tier and
 * from nowhere else. `configManager.get` and `secretsManager.get` both resolve
 * against the daemon's own stores, and every path and secret name the
 * connector uses is daemon-owned (see `config/config-ownership.ts`), so a
 * setup performed in any surface, the agent, the TUI, the web UI, is
 * readable here the moment it lands, and stays readable after that surface has
 * exited. That is the whole point: the runtime that has to answer mail at 3am
 * is not the one the operator did the setup in.
 *
 * Returns `null` when the composition is too narrow to reach a real store, so
 * the verbs simply stay unregistered rather than half-wired.
 *
 * Two backends can answer the default calendar, and this is where one is
 * chosen: a CalDAV server when `surfaces.calendar.caldavUrl`/`caldavUser` are
 * set, a connected Google account otherwise. A Microsoft Outlook account
 * connected with `/calendar connect outlook` is served beside either: its
 * events and calendars carry ids that start with `outlook:`, a read of the
 * default calendars returns both, and a call that names an Outlook id goes to
 * Outlook. With Outlook the only account, it is the calendar. The verbs behave
 * identically whichever answers, that is the point of the
 * `CalendarGatewayService` slice, so the choice is invisible above this line.
 */
import {
  createGoogleCalendarGatewayService,
  type GoogleCalendarGatewayServiceOptions,
} from '../../google/gateway-calendar-service.js';
import { revealOrNull, type Secret } from '../../security/secret.js';
import { createFetchCalDavHttpPort, nodeGoogleFilePort } from '../../google/node.js';
import { daemonGoogleConnectionOwner } from '../../google/daemon-connection.js';
import type { CalDavHttpPort } from '../../google/caldav-client.js';
import {
  CALDAV_URL_KEY,
  CALDAV_USER_KEY,
  createCalDavSecretPort,
} from '../../calendar/caldav-gateway-config.js';
import { createCalDavCalendarGatewayService } from '../../calendar/caldav-gateway-service.js';
import { readCalendarAccountsOnRecord } from '../../calendar/oauth-token-store.js';
import { createMicrosoftCalendarGatewayService, isOutlookId } from '../../calendar/microsoft-gateway-service.js';
import { fetchAdapter } from '../../calendar/http-fetch-adapter.js';
import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS } from '../../google/setup-plan.js';
import { unreadableSecretStore, type StoredSecretReader } from '../../config/secret-store-unreadable.js';
import type { CalendarUntrustedIngestRecorder } from '../../calendar/untrusted-events.js';
import {
  getProcessUntrustedContentLedger,
  type UntrustedContentLedger,
} from '../../security/untrusted-content.js';
import type {
  CalendarGatewayCreateInput, CalendarGatewayCreated, CalendarGatewayEventDetail, CalendarGatewayEventSummary, CalendarGatewayIcsImport,
  CalendarGatewayListInput, CalendarGatewayService,
} from './calendar.js';
import { daemonLocalCalendar, type DaemonLocalCalendar } from '../../calendar/local-calendar.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { noteListChanged } from '../../runtime/list-changes.js';

/** The slice of the verb-group deps this composition needs. */
export interface CalendarCompositionDeps {
  readonly configManager: { get(key: never): unknown };
  /**
   * The daemon's secret store. `set` and `delete` let the Outlook account's
   * token record be written back when Microsoft rotates it on a refresh; a
   * composition without them serves no Outlook account.
   */
  readonly secretsManager: {
    get(key: string): Promise<Secret | null>;
    set?(key: string, value: string): Promise<void>;
    delete?(key: string): Promise<void>;
  };
  /** Absent in narrow compositions; the adoption probe needs a real home. */
  readonly homeDirectory?: string | undefined;
  /** Test seam: overrides the whole service, so no real store is touched. */
  readonly calendarGateway?: CalendarGatewayService | undefined;
  /** Test seam: overrides the injected fetch. */
  readonly calendarFetch?: GoogleCalendarGatewayServiceOptions['fetch'] | undefined;
  /** Test seam: overrides the CalDAV transport, so no socket is opened. */
  readonly caldavHttp?: CalDavHttpPort | undefined;
  /**
   * Test seam: the ledger calendar reads are recorded into. Defaults to the
   * process-wide one, which is what production wants; tests pass their own so
   * one case's calendar read cannot make the next case's outward action refuse.
   */
  readonly untrustedContentLedger?: UntrustedContentLedger | undefined;
}

/** Read one config value, treating an unreachable section as unset. */
function configString(deps: CalendarCompositionDeps, key: string): string {
  let value: unknown;
  try {
    value = deps.configManager.get(key as never);
  } catch {
    return '';
  }
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The answer when no calendar can be read: which calendar accounts exist on
 * this machine and why none of them is usable here, then the one step that
 * fixes it. Read from the stores, never with a request to a provider, and with
 * no token in it.
 */
async function noUsableCalendar(deps: CalendarCompositionDeps): Promise<string> {
  const get = async (key: string): Promise<string | null> => revealOrNull(await deps.secretsManager.get(key), 'owner-screen');
  let accounts: Awaited<ReturnType<typeof readCalendarAccountsOnRecord>> = [];
  try {
    accounts = await readCalendarAccountsOnRecord(get);
  } catch {
    accounts = [];
  }
  const google = accounts.find((account) => account.provider === 'google');
  const noHome = deps.homeDirectory === undefined;
  const noClientId = configString(deps, GOOGLE_CONFIG_KEYS.oauthClientId).length === 0;
  const sentences = ['No calendar this daemon can read.'];
  if (google === undefined) sentences.push('Google: no account is connected.');
  else if (noHome) sentences.push(`Google: ${google.label} is connected, but this daemon runs without a home folder and reads only a CalDAV server.`);
  else if (noClientId) sentences.push(`Google: ${google.label} is connected, but the client id of the OAuth app it signed in with is not set (calendar.google.clientId), so it cannot be used.`);
  else sentences.push(`Google: ${google.label} is connected.`);
  // A Microsoft account on record is served beside the others; only a composition with no secret writes cannot.
  const microsoft = accounts.find((account) => account.provider === 'microsoft');
  sentences.push(microsoft === undefined
    ? 'Microsoft Outlook: no account is connected.'
    : `Microsoft Outlook: ${microsoft.label} is connected, but this daemon was started without a secret store it can write, so it cannot keep that sign-in fresh.`);
  sentences.push('CalDAV: not set (surfaces.calendar.caldavUrl and surfaces.calendar.caldavUser).');
  sentences.push(noHome
    ? 'Set the two CalDAV settings.'
    : google === undefined
      ? 'Sign in to a Google or Outlook calendar account under Calendar accounts in Mail, calendar and channels, or set the two CalDAV settings in Settings.'
      : 'Give your Google app\'s client id ("Use your own calendar app to sign in" under Calendar accounts in Mail, calendar and channels), sign in to an Outlook account there, or set the two CalDAV settings in Settings.');
  return sentences.join(' ');
}

/** The backend chosen for this call does not have the operation; the verb answers 501 with what to do. */
function unsupported(action: string): GatewayVerbError {
  return new GatewayVerbError(`The configured calendar backend cannot ${action}.`, 'CALENDAR_NOT_SUPPORTED', 501);
}

export function createDaemonCalendarGatewayService(
  deps: CalendarCompositionDeps,
): CalendarGatewayService | null {
  if (deps.calendarGateway) return deps.calendarGateway;

  // Bound here rather than left to the backend: a composition that forgot it
  // would read an inviter's words into nothing, and the exposure a later send
  // discloses would be missing exactly the half that mattered. This is the SAME
  // process-wide ledger the daemon's browser engine and mail surface record
  // into, so "read a stranger's invitation, then send mail" accrues to one
  // record rather than three that cannot see each other.
  //
  // The literal `'calendar-event'` the calendar package emits is checked
  // against `UntrustedSurface` right here, by this assignment, that is the
  // only place the two halves meet, and it is why the calendar package needs no
  // import from security.
  const ledger = deps.untrustedContentLedger ?? getProcessUntrustedContentLedger();
  const recordUntrustedIngest: CalendarUntrustedIngestRecorder = (ingest) => {
    ledger.record(ingest);
  };

  // A configured CalDAV server wins. It is the more explicit statement of
  // intent, someone typed a server address and an account name into settings
  //, where a Google credential can be present on the machine for any number of
  // other reasons, and answering an operator's own calendar server with
  // somebody's Gmail calendar would be the wrong calendar, silently.
  const caldavConfigured = (): boolean =>
    configString(deps, CALDAV_URL_KEY).length > 0 && configString(deps, CALDAV_USER_KEY).length > 0;

  let caldav: CalendarGatewayService | undefined;
  let google: CalendarGatewayService | undefined;
  const homeDirectory = deps.homeDirectory;
  const createCalDav = (): CalendarGatewayService => createCalDavCalendarGatewayService({
    config: { get: (key) => deps.configManager.get(key as never) },
    secrets: createCalDavSecretPort(deps.secretsManager),
    http: deps.caldavHttp ?? createFetchCalDavHttpPort(),
    recordUntrustedIngest,
  });
  const createGoogle = (home: string): CalendarGatewayService => createGoogleCalendarGatewayService({
    sources: {
      files: nodeGoogleFilePort,
      homeDirectory: home,
      // `get` throws on a config section that does not exist yet, the mail
      // and calendar sections are app-layer and absent on a machine where
      // nobody has run setup. The connector reads every config value through
      // its own guard (platform/google/config-access.ts), so an absent section
      // reads as "not configured" instead of surfacing Invalid config path as
      // a 500 from a route.
      configGet: (key) => deps.configManager.get(key as never),
      secretGet: async (key) => revealOrNull(await deps.secretsManager.get(key), 'dispatch'),
    },
    fetch: deps.calendarFetch ?? { fetch: (url, init) => fetch(url, init) },
    // The daemon's one token manager, shared with the Gmail reader and the start-up check.
    connectionOwner: daemonGoogleConnectionOwner({
      configManager: deps.configManager,
      secretsManager: deps.secretsManager,
      homeDirectory: home,
      files: nodeGoogleFilePort,
      ...(deps.calendarFetch === undefined ? {} : { fetch: deps.calendarFetch }),
    }),
    recordUntrustedIngest,
  });

  // The Outlook account connected with /calendar connect outlook: served
  // beside the CalDAV server or the Google account, by the same one token
  // record the Agent's /calendar reads (calendar/microsoft-gateway-service.ts).
  const secretsManager = deps.secretsManager;
  const calendarFetch = deps.calendarFetch;
  const writeSecret = secretsManager.set?.bind(secretsManager);
  const deleteSecret = secretsManager.delete?.bind(secretsManager);
  let outlook: CalendarGatewayService | undefined;
  const outlookService = (): CalendarGatewayService | null => {
    if (writeSecret === undefined || deleteSecret === undefined) return null;
    return (outlook ??= createMicrosoftCalendarGatewayService({
      secrets: {
        get: async (key) => revealOrNull(await secretsManager.get(key), 'dispatch'),
        set: (key, value) => writeSecret(key, value),
        delete: (key) => deleteSecret(key),
        unreadable: (key) => unreadableSecretStore(secretsManager as unknown as StoredSecretReader, key, 'the calendar connection'),
      },
      config: { get: (key) => deps.configManager.get(key as never) },
      fetchImpl: fetchAdapter(calendarFetch === undefined ? undefined : (url, init) => calendarFetch.fetch(url, init ?? {})),
      ownerZone: () => configString(deps, 'daemon.timezone') || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      recordUntrustedIngest,
    }));
  };
  /** Which accounts are on record: two secret reads, no request to a provider. */
  const onRecord = async (): Promise<{ readonly google: boolean; readonly outlook: boolean }> => {
    let accounts: Awaited<ReturnType<typeof readCalendarAccountsOnRecord>> = [];
    try {
      accounts = await readCalendarAccountsOnRecord(async (key) => revealOrNull(await secretsManager.get(key), 'owner-screen'));
    } catch {
      accounts = [];
    }
    return {
      google: accounts.some((account) => account.provider === 'google'),
      outlook: outlookService() !== null && accounts.some((account) => account.provider === 'microsoft'),
    };
  };

  // A composition with no home directory, no CalDAV server and no way to serve
  // Outlook has no calendar to answer with; leaving the verbs unregistered says so honestly.
  if (homeDirectory === undefined && !caldavConfigured() && outlookService() === null) return null;

  // The backend is chosen on each call, not once here: a CalDAV server entered
  // in settings after the daemon started is used by the next verb call, and
  // removing it falls back to Google, with no restart in between.
  const select = (): CalendarGatewayService => {
    if (caldavConfigured()) return (caldav ??= createCalDav());
    if (homeDirectory === undefined) {
      throw new GatewayVerbError(
        'No calendar is connected: set surfaces.calendar.caldavUrl and surfaces.calendar.caldavUser to use a CalDAV server.',
        'CALENDAR_NOT_CONFIGURED',
        400,
      );
    }
    return (google ??= createGoogle(homeDirectory));
  };
  // Every verb runs through this, so a caller with no usable calendar (the web
  // Calendar, a tool) is told which accounts exist and why none can be read,
  // not only that nothing is configured. A CalDAV server's own refusals stand.
  const explained = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      // With an Outlook account on record the refusal is that account's own (or the one backend named), and stands.
      if (error instanceof GatewayVerbError && error.code === 'CALENDAR_NOT_CONFIGURED' && !caldavConfigured() && !(await onRecord()).outlook) {
        // A secret store this computer could not read hides the accounts: said as such, and nothing is asked for.
        const unreadable = await unreadableSecretStore(deps.secretsManager as unknown as StoredSecretReader, GOOGLE_SECRET_KEYS.oauthRefreshToken, 'the calendar connections');
        if (unreadable) throw new GatewayVerbError(`No calendar this daemon can read: ${unreadable}`, 'CALENDAR_CREDENTIALS_UNREADABLE', 412);
        throw new GatewayVerbError(await noUsableCalendar(deps), 'CALENDAR_NOT_CONFIGURED', error.status);
      }
      throw error;
    }
  };
  // A write the calendar accepted: every view of the calendar reads it again.
  const written = async <T>(change: 'created' | 'changed' | 'deleted', run: () => Promise<T>): Promise<T> => {
    const result = await explained(run);
    noteListChanged({ list: 'calendar', change });
    return result;
  };
  /**
   * The backend a call goes to. An id that starts with `outlook:` (an Outlook
   * event or calendar) goes to the Outlook account; another id to the CalDAV
   * server or Google account. With no id (a new event on the default calendar)
   * it is the CalDAV server or Google account, or the Outlook account when it is
   * the only one there is.
   */
  const route = async (id: string | undefined): Promise<CalendarGatewayService> => {
    const outlookBackend = outlookService();
    if (isOutlookId(id) && outlookBackend !== null) return outlookBackend;
    if (id === undefined && outlookBackend !== null && !caldavConfigured()) {
      const accounts = await onRecord();
      if (accounts.outlook && (!accounts.google || homeDirectory === undefined)) return outlookBackend;
    }
    return select();
  };
  /** A read over the default calendars: the CalDAV server or Google account, and the Outlook account when one is connected. */
  const both = async <T>(
    read: (backend: CalendarGatewayService) => Promise<T>,
    merge: (first: T, second: T) => T,
  ): Promise<T> => {
    const outlookBackend = outlookService();
    const accounts = outlookBackend === null ? { google: false, outlook: false } : await onRecord();
    if (outlookBackend === null || !accounts.outlook) return read(select());
    const primaryConfigured = caldavConfigured() || (accounts.google && homeDirectory !== undefined);
    if (!primaryConfigured) return read(outlookBackend);
    const [first, second] = await Promise.all([
      // A Google account that cannot be used (its client id not set) leaves the Outlook account's answer.
      read(select()).catch((error: unknown) => {
        if (error instanceof GatewayVerbError && error.code === 'CALENDAR_NOT_CONFIGURED' && !caldavConfigured()) return null;
        throw error;
      }),
      read(outlookBackend),
    ]);
    return first === null ? second : merge(first, second);
  };
  const byStart = (left: { readonly start: string }, right: { readonly start: string }): number =>
    (Date.parse(left.start) || 0) - (Date.parse(right.start) || 0);
  const remote: CalendarGatewayService = {
    // async, so a refusal from `select` reaches the caller as a rejection like
    // every other failure of these verbs rather than as a synchronous throw.
    listEvents: (input) => explained(async () => (input.calendarId === undefined
      ? both((backend) => backend.listEvents(input), (first, second) => {
        const events = [...first.events, ...second.events].sort(byStart);
        const limit = input.limit ?? events.length;
        return { events: events.slice(0, limit), more: first.more || second.more || events.length > limit };
      })
      : (await route(input.calendarId)).listEvents(input))),
    getEvent: (eventId, calendarId) => explained(async () => (await route(isOutlookId(eventId) ? eventId : calendarId ?? '')).getEvent(eventId, calendarId)),
    createEvent: (input) => written('created', async () => (await route(input.calendarId)).createEvent(input)),
    updateEvent: (eventId, changes, calendarId) => written('changed', async () => {
      const backend = await route(isOutlookId(eventId) ? eventId : calendarId ?? '');
      if (!backend.updateEvent) throw unsupported('update events');
      return backend.updateEvent(eventId, changes, calendarId);
    }),
    deleteEvent: (eventId, calendarId) => written('deleted', async () => {
      const backend = await route(isOutlookId(eventId) ? eventId : calendarId ?? '');
      if (!backend.deleteEvent) throw unsupported('delete events');
      return backend.deleteEvent(eventId, calendarId);
    }),
    listCalendars: () => explained(async () => both((backend) => {
      if (!backend.listCalendars) throw unsupported('list its calendars; set surfaces.calendar.defaultCalendarId to the calendar to use');
      return backend.listCalendars();
    }, (first, second) => [...first, ...second])),
    exportIcs: (input) => explained(async () => (input.calendarId === undefined
      ? both((backend) => backend.exportIcs(input), (first, second) => ({
        icsContent: joinIcs(first.icsContent, second.icsContent),
        eventCount: first.eventCount + second.eventCount,
        ...(first.more === true || second.more === true ? { more: true } : {}),
      }))
      : (await route(input.calendarId)).exportIcs(input))),
    importIcs: (icsContent, calendarId, options) => written('changed', async () => (await route(calendarId)).importIcs(icsContent, calendarId, options)),
  };
  // The calendar kept on this computer (its events and the feeds subscribed to), served beside the connected ones.
  if (homeDirectory === undefined) return remote;
  const local = daemonLocalCalendar(homeDirectory, {
    get: async (key) => revealOrNull(await secretsManager.get(key), 'dispatch'),
    set: async (key, value) => { if (!writeSecret) throw new Error('this daemon cannot write its secret store'); await writeSecret(key, value); },
    delete: async (key) => { if (!deleteSecret) throw new Error('this daemon cannot write its secret store'); await deleteSecret(key); },
  }, recordUntrustedIngest);
  return withLocalCalendar(remote, local, () => noteListChanged({ list: 'calendar', change: 'changed' }));
}

/** The id of the local calendar, and of each event in it: `local:<event>` (`@<start>` for one occurrence of a series). */
export const LOCAL_CALENDAR_ID = 'local';
const LOCAL_PREFIX = 'local:';
const FEED_PREFIX = 'feed:';

function localEventId(id: string, start: string, repeats: boolean): string {
  return `${LOCAL_PREFIX}${id}${repeats ? `@${start}` : ''}`;
}
/** A local event's own id from a listed id (an occurrence's `@<start>` dropped). */
function localIdOf(eventId: string): string {
  const id = eventId.slice(LOCAL_PREFIX.length);
  const at = id.indexOf('@');
  return at === -1 ? id : id.slice(0, at);
}

/** A remote calendar that is not connected is no calendar at all here: the local one answers alone. */
function notConnected(error: unknown): boolean {
  return error instanceof GatewayVerbError && (error.code === 'CALENDAR_NOT_CONFIGURED' || error.code === 'CALENDAR_CREDENTIALS_UNREADABLE');
}

function readOnlyFeed(): GatewayVerbError {
  return new GatewayVerbError('This event is from a calendar feed you subscribe to, which is read-only here; change it in the calendar it comes from.', 'CALENDAR_EVENT_READ_ONLY', 409);
}

/**
 * The one calendar: the connected remote calendars and the calendar on this computer (its events and the feeds
 * subscribed to). A read with no calendar named lists all of them in one list; a new event goes to the connected
 * calendar, or here when none is connected or `calendarId` is `local`; an event is changed or removed where it is kept.
 */
export function withLocalCalendar(remote: CalendarGatewayService, local: DaemonLocalCalendar, changed: () => void): CalendarGatewayService {
  const windowOf = (input: CalendarGatewayListInput): { from: Date; to: Date } => {
    const from = input.from ? new Date(input.from) : new Date(Date.now() - 86_400_000);
    const to = input.to ? new Date(input.to) : new Date(Date.now() + 30 * 86_400_000);
    return { from: Number.isNaN(from.getTime()) ? new Date() : from, to: Number.isNaN(to.getTime()) ? new Date(Date.now() + 30 * 86_400_000) : to };
  };
  const localEvents = (input: CalendarGatewayListInput): CalendarGatewayEventSummary[] => {
    const { from, to } = windowOf(input);
    // The feeds older than their interval are read again first; a feed that cannot be read keeps its last events.
    const own = local.events.occurrences(from, to).map((occurrence): CalendarGatewayEventSummary => ({
      id: localEventId(occurrence.event.id, occurrence.start, occurrence.event.recurrence !== undefined), seriesId: occurrence.event.id, title: occurrence.event.title,
      start: occurrence.start, end: occurrence.end ?? occurrence.start, ...(occurrence.event.allDay ? { allDay: true } : {}),
      ...(occurrence.event.location ? { location: occurrence.event.location } : {}), ...(occurrence.event.notes ? { description: occurrence.event.notes } : {}),
    }));
    const fed = local.feeds.occurrences(from, to).map((occurrence): CalendarGatewayEventSummary => ({
      id: `${FEED_PREFIX}${occurrence.feed}:${occurrence.event.uid}@${occurrence.start}`, seriesId: `${FEED_PREFIX}${occurrence.feed}:${occurrence.event.uid}`, title:`${occurrence.event.summary || 'Untitled event'} (${occurrence.feed})`,
      start: occurrence.start, end: occurrence.event.end?.value ?? occurrence.start, ...(occurrence.event.start.kind === 'date' ? { allDay: true } : {}),
      ...(occurrence.event.location ? { location: occurrence.event.location } : {}),
      ...(occurrence.repeatsNotShown ? { description: 'It repeats by a rule this version does not expand; it may also fall on other days.' } : {}),
    }));
    return [...own, ...fed];
  };
  const startOf = (event: { readonly start: string }): number => {
    const at = Date.parse(event.start.includes('T') ? event.start : `${event.start}T00:00:00`);
    return Number.isNaN(at) ? 0 : at;
  };
  const merged = async (input: CalendarGatewayListInput): Promise<{ events: CalendarGatewayEventSummary[]; more: boolean }> => {
    // Feeds whose interval passed are read again before the calendar is shown (no timer: a read is the occasion).
    await local.feeds.refresh(undefined, { force: false }).catch(() => undefined);
    let remoteEvents: readonly CalendarGatewayEventSummary[] = [];
    let more = false;
    try {
      const page = await remote.listEvents(input);
      remoteEvents = page.events;
      more = page.more;
    } catch (error) {
      if (!notConnected(error)) throw error;
    }
    const events = [...remoteEvents, ...localEvents(input)].sort((left, right) => startOf(left) - startOf(right));
    const limit = input.limit ?? events.length;
    return { events: events.slice(0, limit), more: more || events.length > limit };
  };
  const detailOfLocal = (eventId: string): CalendarGatewayEventDetail => {
    const event = local.events.get(localIdOf(eventId));
    if (!event) throw new GatewayVerbError(`No event ${eventId} is kept on this computer.`, 'CALENDAR_EVENT_NOT_FOUND', 404);
    const at = eventId.indexOf('@');
    const start = at === -1 ? event.start : eventId.slice(at + 1);
    return {
      id: eventId, uid: event.sourceProvenance ?? event.id, title: event.title, start, end: event.end ?? start, ...(event.allDay ? { allDay: true } : {}),
      ...(event.location ? { location: event.location } : {}), ...(event.notes ? { description: event.notes } : {}),
      ...(event.recurrence?.rule ? { recurrence: event.recurrence.rule } : {}), revision: event.updatedAt,
    };
  };
  const detailOfFeed = (eventId: string): CalendarGatewayEventDetail => {
    const rest = eventId.slice(FEED_PREFIX.length);
    const at = rest.lastIndexOf('@');
    const head = at === -1 ? rest : rest.slice(0, at);
    const colon = head.indexOf(':');
    const feed = head.slice(0, colon);
    const uid = head.slice(colon + 1);
    const found = local.feeds.seeds().find((row) => row.feed === feed && row.event.uid === uid);
    if (!found) throw new GatewayVerbError(`No event ${eventId} is in the feeds you subscribe to.`, 'CALENDAR_EVENT_NOT_FOUND', 404);
    const start = at === -1 ? found.event.start.value : rest.slice(at + 1);
    return {
      id: eventId, uid, title: `${found.event.summary || 'Untitled event'} (${feed})`, start, end: found.event.end?.value ?? start,
      ...(found.event.start.kind === 'date' ? { allDay: true } : {}), ...(found.event.location ? { location: found.event.location } : {}),
      ...(found.event.description ? { description: found.event.description } : {}),
    };
  };
  const createLocal = (input: CalendarGatewayCreateInput): CalendarGatewayCreated => {
    let event;
    try {
      event = local.events.create({ title: input.title, start: input.start, end: input.end, location: input.location, notes: input.description });
    } catch (error) {
      throw new GatewayVerbError(error instanceof Error ? error.message : String(error), 'INVALID_ARGUMENT', 400);
    }
    changed();
    return { eventId: localEventId(event.id, event.start, false), uid: event.id, createdAt: event.createdAt };
  };
  return {
    listEvents: async (input) => {
      if (input.calendarId === LOCAL_CALENDAR_ID) {
        const events = localEvents(input).sort((left, right) => startOf(left) - startOf(right));
        const limit = input.limit ?? events.length;
        return { events: events.slice(0, limit), more: events.length > limit };
      }
      return input.calendarId === undefined ? merged(input) : remote.listEvents(input);
    },
    getEvent: async (eventId, calendarId) => {
      if (eventId.startsWith(LOCAL_PREFIX)) return detailOfLocal(eventId);
      if (eventId.startsWith(FEED_PREFIX)) return detailOfFeed(eventId);
      return remote.getEvent(eventId, calendarId);
    },
    createEvent: async (input) => {
      if (input.calendarId === LOCAL_CALENDAR_ID) return createLocal(input);
      try {
        return await remote.createEvent(input);
      } catch (error) {
        // No calendar is connected: the event is kept on this computer.
        if (input.calendarId === undefined && notConnected(error)) return createLocal(input);
        throw error;
      }
    },
    updateEvent: async (eventId, changes, calendarId) => {
      if (eventId.startsWith(FEED_PREFIX)) throw readOnlyFeed();
      if (eventId.startsWith(LOCAL_PREFIX)) {
        let event;
        try {
          event = local.events.update(localIdOf(eventId), {
            ...(changes.title !== undefined ? { title: changes.title } : {}), ...(changes.start !== undefined ? { start: changes.start } : {}),
            ...(changes.end !== undefined ? { end: changes.end } : {}), ...(changes.location !== undefined ? { location: changes.location } : {}),
            ...(changes.description !== undefined ? { notes: changes.description } : {}),
          });
        } catch (error) {
          throw new GatewayVerbError(error instanceof Error ? error.message : String(error), 'INVALID_ARGUMENT', 400);
        }
        if (!event) throw new GatewayVerbError(`No event ${eventId} is kept on this computer.`, 'CALENDAR_EVENT_NOT_FOUND', 404);
        changed();
        return { eventId: localEventId(event.id, event.start, false), updatedAt: event.updatedAt };
      }
      if (!remote.updateEvent) throw new GatewayVerbError('The configured calendar backend cannot update events.', 'CALENDAR_NOT_SUPPORTED', 501);
      return remote.updateEvent(eventId, changes, calendarId);
    },
    deleteEvent: async (eventId, calendarId) => {
      if (eventId.startsWith(FEED_PREFIX)) throw readOnlyFeed();
      if (eventId.startsWith(LOCAL_PREFIX)) {
        const removed = local.events.delete(localIdOf(eventId));
        if (removed) changed();
        return { eventId, deleted: removed !== null };
      }
      if (!remote.deleteEvent) throw new GatewayVerbError('The configured calendar backend cannot delete events.', 'CALENDAR_NOT_SUPPORTED', 501);
      return remote.deleteEvent(eventId, calendarId);
    },
    listCalendars: async () => {
      const own = [{ calendarId: LOCAL_CALENDAR_ID, displayName: 'On this computer' }];
      if (!remote.listCalendars) return own;
      try { return [...own, ...await remote.listCalendars()]; } catch (error) {
        if (notConnected(error) || (error instanceof GatewayVerbError && error.code === 'CALENDAR_NOT_SUPPORTED')) return own;
        throw error;
      }
    },
    exportIcs: async (input) => {
      if (input.calendarId === LOCAL_CALENDAR_ID) {
        const icsContent = local.events.exportIcs();
        return { icsContent, eventCount: local.events.list().length };
      }
      return remote.exportIcs(input);
    },
    importIcs: async (icsContent, calendarId, options) => {
      const importLocal = (): CalendarGatewayIcsImport => {
        const result = local.events.importIcs(icsContent);
        if (result.imported.length > 0) changed();
        return {
          imported: result.imported.length, eventIds: result.imported.map((event) => localEventId(event.id, event.start, false)),
          errors: [...result.notParsed, ...(result.secretSkipped > 0 ? [`${result.secretSkipped} event(s) with a secret-looking field were not imported.`] : [])],
        };
      };
      if (calendarId === LOCAL_CALENDAR_ID) return importLocal();
      try {
        return await remote.importIcs(icsContent, calendarId, options);
      } catch (error) {
        if (calendarId === undefined && notConnected(error)) return importLocal();
        throw error;
      }
    },
  };
}

/** Two exported calendars as one file: the second file's events placed before the first's end. */
function joinIcs(first: string, second: string): string {
  const events = second.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT\r?\n/g) ?? [];
  if (events.length === 0) return first;
  const end = first.lastIndexOf('END:VCALENDAR');
  return end === -1 ? first : `${first.slice(0, end)}${events.join('')}${first.slice(end)}`;
}
