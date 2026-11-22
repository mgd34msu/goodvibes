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
 * Two backends can answer, and this is where one is chosen: a CalDAV server
 * when `surfaces.calendar.caldavUrl`/`caldavUser` are set, a connected Google
 * account otherwise. The verbs behave identically either way, that is the
 * point of the `CalendarGatewayService` slice, so the choice is invisible
 * above this line.
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
import { GOOGLE_CONFIG_KEYS } from '../../google/setup-plan.js';
import type { CalendarUntrustedIngestRecorder } from '../../calendar/untrusted-events.js';
import {
  getProcessUntrustedContentLedger,
  type UntrustedContentLedger,
} from '../../security/untrusted-content.js';
import type { CalendarGatewayService } from './calendar.js';
import { GatewayVerbError } from './gateway-verb-error.js';

/** The slice of the verb-group deps this composition needs. */
export interface CalendarCompositionDeps {
  readonly configManager: { get(key: never): unknown };
  readonly secretsManager: { get(key: string): Promise<Secret | null> };
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
  const microsoft = accounts.find((account) => account.provider === 'microsoft');
  const noHome = deps.homeDirectory === undefined;
  const noClientId = configString(deps, GOOGLE_CONFIG_KEYS.oauthClientId).length === 0;
  const sentences = ['No calendar this daemon can read.'];
  if (google === undefined) sentences.push('Google: no account is connected.');
  else if (noHome) sentences.push(`Google: ${google.label} is connected, but this daemon runs without a home folder and reads only a CalDAV server.`);
  else if (noClientId) sentences.push(`Google: ${google.label} is connected, but the client id of the OAuth app it signed in with is not set (calendar.google.clientId), so it cannot be used.`);
  else sentences.push(`Google: ${google.label} is connected.`);
  if (microsoft !== undefined) {
    sentences.push(`Microsoft Outlook: ${microsoft.label} is connected for the Agent's /calendar commands; this daemon's calendar reads a CalDAV server or a Google account, not Microsoft.`);
  }
  sentences.push('CalDAV: not set (surfaces.calendar.caldavUrl and surfaces.calendar.caldavUser).');
  sentences.push(noHome
    ? 'Set the two CalDAV settings.'
    : google === undefined
      ? 'Connect Google with /calendar connect google in the Agent, or set the two CalDAV settings.'
      : 'Set calendar.google.clientId to the client id of your Google OAuth app, or set the two CalDAV settings.');
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

  // A composition with no home directory and no CalDAV server has no calendar
  // to answer with; leaving the verbs unregistered says so honestly.
  if (homeDirectory === undefined && !caldavConfigured()) return null;

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
      if (error instanceof GatewayVerbError && error.code === 'CALENDAR_NOT_CONFIGURED' && !caldavConfigured()) {
        throw new GatewayVerbError(await noUsableCalendar(deps), 'CALENDAR_NOT_CONFIGURED', error.status);
      }
      throw error;
    }
  };
  return {
    // async, so a refusal from `select` reaches the caller as a rejection like
    // every other failure of these verbs rather than as a synchronous throw.
    listEvents: (input) => explained(async () => select().listEvents(input)),
    getEvent: (eventId, calendarId) => explained(async () => select().getEvent(eventId, calendarId)),
    createEvent: (input) => explained(async () => select().createEvent(input)),
    updateEvent: (eventId, changes, calendarId) => explained(async () => {
      const backend = select();
      if (!backend.updateEvent) throw unsupported('update events');
      return backend.updateEvent(eventId, changes, calendarId);
    }),
    deleteEvent: (eventId, calendarId) => explained(async () => {
      const backend = select();
      if (!backend.deleteEvent) throw unsupported('delete events');
      return backend.deleteEvent(eventId, calendarId);
    }),
    listCalendars: () => explained(async () => {
      const backend = select();
      if (!backend.listCalendars) throw unsupported('list its calendars; set surfaces.calendar.defaultCalendarId to the calendar to use');
      return backend.listCalendars();
    }),
    exportIcs: (input) => explained(async () => select().exportIcs(input)),
    importIcs: (icsContent, calendarId, options) => explained(async () => select().importIcs(icsContent, calendarId, options)),
  };
}
