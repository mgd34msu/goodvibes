/**
 * calendar-connector.ts, the high-level connector the agent drives. It ties the
 * provider profiles, the OAuth flows, the secret-backed token store, and the two API
 * clients into one surface: connect (auth-code or device-code), disconnect, list
 * accounts + their honest state, list calendars, list events (normalized + source-
 * labeled, calendars read side by side, one failing calendar reported beside the
 * rest) across a window, and create an event routed to an explicitly chosen
 * provider. Headless connect is the device code for Microsoft and a pasted
 * authorization code for Google. The network and (for the loopback flow) the redirect listener are
 * injected, so the whole thing runs against fakes with no real network or port.
 */

import {
  beginAuthCodeFlow,
  beginDeviceCodeFlow,
  beginPastedCodeFlow,
  completeAuthCodeFlow,
  OAuthFlowError,
  pollDeviceCodeFlow,
  readPastedAuthorization,
  type Sleep,
} from './oauth-flow.js';
import {
  readCalendarClientOverrides,
  type CalendarConfigReader,
  type CalendarSecretReader,
} from './oauth-client-config.js';
import { providerProfile, resolveClientConfig } from './oauth-providers.js';
import { CalendarTokenStore, type CalendarTokenStoreOptions } from './oauth-token-store.js';
import {
  createGoogleEvent,
  listGoogleCalendars,
  listGoogleEvents,
} from './google-calendar-api.js';
import {
  createGraphEvent,
  listGraphCalendars,
  listGraphEvents,
} from './microsoft-graph-api.js';
import { compareMergedCalendarEventsByStart } from './merged-calendar-model.js';
import { CalendarApiError } from './calendar-api-shared.js';
import {
  recordCalendarEventIngest,
  type CalendarUntrustedIngestRecorder,
} from './untrusted-events.js';
import type {
  ApiDegradedState,
  AuthCodeFlowStart,
  CalendarCreateResult,
  CalendarProviderId,
  CalendarRequestOptions,
  Clock,
  ConnectedAccount,
  ConnectionState,
  DeviceCodeFlowStart,
  HttpFetch,
  LoopbackListenerFactory,
  LoopbackWaiter,
  MergedCalendarEvent,
  NewCalendarEvent,
  OAuthClientOverrides,
  ProviderCalendar,
  ResolvedClientConfig,
  SecretStoreSlice,
  StoredTokenSet,
} from './oauth-types.js';

export interface CalendarConnectorOptions {
  readonly secrets: SecretStoreSlice;
  readonly fetchImpl: HttpFetch;
  readonly clock?: Clock;
  /** Required only for the auth-code (loopback) flow; device-code needs no listener. */
  readonly listenerFactory?: LoopbackListenerFactory;
  /** Injected delay for device-code polling; defaults to a real timer. */
  readonly sleep?: Sleep;
  readonly refreshLeewayMs?: number;
  /**
   * Records that a turn read untrusted event content.
   *
   * Called from `listEvents`, a read someone asked for, and from nowhere
   * else. An event the provider says the owner organized is not recorded; an
   * invitation somebody else sent is. See untrusted-events.ts.
   */
  readonly recordUntrustedIngest?: CalendarUntrustedIngestRecorder;
}

/** A time window for event listing, as ISO strings. */
export interface EventWindow {
  readonly timeMin: string;
  readonly timeMax: string;
}

/** One calendar whose events could not be read, reported beside the others' events. */
export interface CalendarReadFailure {
  readonly calendarId: string;
  readonly calendarLabel: string;
  readonly degraded: ApiDegradedState;
}

/** Events across a provider's calendars, and the calendars that could not be read. */
export interface CalendarEventsRead {
  readonly events: MergedCalendarEvent[];
  readonly failures: readonly CalendarReadFailure[];
}

/** Calendars read at once per account: enough to hide latency, few enough not to trip a provider limit. */
const CALENDAR_READ_CONCURRENCY = 4;

export class CalendarConnector {
  private readonly secrets: SecretStoreSlice;
  private readonly fetchImpl: HttpFetch;
  private readonly clock: Clock;
  private readonly listenerFactory?: LoopbackListenerFactory;
  private readonly sleep: Sleep;
  private readonly store: CalendarTokenStore;
  private readonly recordUntrustedIngest?: CalendarUntrustedIngestRecorder;

  constructor(options: CalendarConnectorOptions) {
    this.secrets = options.secrets;
    this.fetchImpl = options.fetchImpl;
    this.clock = options.clock ?? (() => Date.now());
    if (options.listenerFactory) this.listenerFactory = options.listenerFactory;
    if (options.recordUntrustedIngest) this.recordUntrustedIngest = options.recordUntrustedIngest;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const storeOptions: CalendarTokenStoreOptions = {
      secrets: options.secrets,
      clock: this.clock,
      ...(typeof options.refreshLeewayMs === 'number' ? { refreshLeewayMs: options.refreshLeewayMs } : {}),
    };
    this.store = new CalendarTokenStore(storeOptions);
  }

  /** Resolve the client config for a provider (profile + the operator's credentials). */
  resolveConfig(provider: CalendarProviderId, overrides?: OAuthClientOverrides): ResolvedClientConfig {
    return resolveClientConfig(providerProfile(provider), overrides);
  }

  /**
   * Resolve the client config from the operator's SETTINGS, the normal path.
   *
   * `resolveConfig` takes credentials a caller already holds; this reads them
   * from `calendar.<provider>.clientId` and the client-secret reference beside
   * it, which is where registering your own OAuth app puts them. A config with
   * nothing set resolves to `isConfigured: false`, so a status view can render
   * "not set up" and a connect attempt refuses naming the key, neither of them
   * has to know the key string itself.
   */
  async resolveConfigFromSettings(
    provider: CalendarProviderId,
    sources: {
      readonly config: CalendarConfigReader;
      readonly secretGet?: CalendarSecretReader | undefined;
      readonly extra?: Omit<OAuthClientOverrides, 'clientId' | 'clientSecret'> | undefined;
    },
  ): Promise<ResolvedClientConfig> {
    const profile = providerProfile(provider);
    return resolveClientConfig(profile, await readCalendarClientOverrides(profile, sources));
  }

  // --- Accounts / state -----------------------------------------------------

  listAccounts(): Promise<ConnectedAccount[]> {
    return this.store.listAccounts();
  }

  connectionState(provider: CalendarProviderId): Promise<ConnectionState> {
    return this.store.connectionState(provider);
  }

  // --- Connect: authorization-code (loopback) flow --------------------------

  /** Begin the loopback auth-code flow; returns the URL to open and the waiter. */
  async beginConnectAuthCode(
    config: ResolvedClientConfig,
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<{ readonly start: AuthCodeFlowStart; readonly waiter: LoopbackWaiter }> {
    if (!this.listenerFactory) {
      throw new Error('No loopback listener is available on this machine; connect headless instead (a device code for Microsoft, a pasted code for Google).');
    }
    options.signal?.throwIfAborted();
    const flow = await beginAuthCodeFlow(config, this.listenerFactory);
    // The listener holds a port until it is closed. When the caller cancels the
    // attempt it is closed here, so a caller that never reaches `close()` does
    // not leave the port bound.
    const { signal } = options;
    if (signal) {
      if (signal.aborted) {
        flow.waiter.close();
        signal.throwIfAborted();
      }
      signal.addEventListener('abort', () => flow.waiter.close(), { once: true });
    }
    return flow;
  }

  /** Complete the auth-code flow after the redirect delivered a code; saves tokens. */
  async completeConnectAuthCode(
    config: ResolvedClientConfig,
    input: { readonly code: string; readonly verifier: string; readonly redirectUri: string },
  ): Promise<ConnectedAccount> {
    const tokens = await completeAuthCodeFlow(config, this.fetchImpl, input, this.clock());
    return this.persistConnection(config, tokens);
  }

  // --- Connect: device-code (headless) flow ---------------------------------

  /**
   * Begin the device-code flow; returns the user code + verification URL to show.
   * Only for a provider whose device grant covers calendar scopes (Microsoft);
   * Google's does not, and headless Google connect uses the pasted code below.
   */
  beginConnectDeviceCode(config: ResolvedClientConfig): Promise<DeviceCodeFlowStart> {
    // An unconfigured client is refused by name inside the flow, first.
    if (config.isConfigured && !config.usesDeviceGrant) {
      return Promise.reject(new OAuthFlowError(
        'token-request-rejected',
        `${config.provider} does not grant calendar access through a device code. Connect by opening the sign-in link on any device and pasting back the address it lands on.`,
      ));
    }
    return beginDeviceCodeFlow(config, this.fetchImpl, this.clock());
  }

  // --- Connect: pasted authorization code (headless, no listener) -------------

  /** Begin a sign-in whose code the person pastes back; returns the link to open. */
  beginConnectPastedCode(config: ResolvedClientConfig): Promise<AuthCodeFlowStart> {
    return beginPastedCodeFlow(config);
  }

  /** Complete a pasted-code sign-in from what the person pasted; saves tokens. */
  async completeConnectPastedCode(
    config: ResolvedClientConfig,
    start: AuthCodeFlowStart,
    pasted: string,
  ): Promise<ConnectedAccount> {
    const code = readPastedAuthorization(pasted, start.state);
    return this.completeConnectAuthCode(config, { code, verifier: start.verifier, redirectUri: start.redirectUri });
  }

  /** Poll until the device code is approved, then save tokens. */
  async completeConnectDeviceCode(
    config: ResolvedClientConfig,
    start: DeviceCodeFlowStart,
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<ConnectedAccount> {
    const tokens = await pollDeviceCodeFlow(config, this.fetchImpl, start, this.clock, this.sleep, options.signal);
    return this.persistConnection(config, tokens);
  }

  // --- Disconnect -----------------------------------------------------------

  disconnect(
    provider: CalendarProviderId,
    overrides?: OAuthClientOverrides,
  ): Promise<{ readonly revokedRemotely: boolean }> {
    return this.store.disconnect(provider, this.resolveConfig(provider, overrides), this.fetchImpl);
  }

  // --- Read: calendars + events ---------------------------------------------

  /** List the provider's calendars (refreshing the token first when due). */
  async listCalendars(config: ResolvedClientConfig, options: CalendarRequestOptions = {}): Promise<ProviderCalendar[]> {
    options.signal?.throwIfAborted();
    const token = await this.store.getFreshAccessToken(config.provider, config, this.fetchImpl);
    return config.provider === 'google'
      ? listGoogleCalendars(this.fetchImpl, token, options)
      : listGraphCalendars(this.fetchImpl, token, options);
  }

  /**
   * List events across all of the provider's calendars in a window, normalized into
   * the merged model, source-labeled, and sorted chronologically through
   * `compareMergedCalendarEventsByStart`. Calendars are read a few at a time, and
   * a calendar that fails (unshared, a 403, a 404) is reported in `failures`
   * beside the events of the others instead of discarding them. Failing to list
   * the calendars at all, or to get a token, still throws: there is nothing to
   * report beside.
   */
  async listEvents(config: ResolvedClientConfig, window: EventWindow, options: CalendarRequestOptions = {}): Promise<CalendarEventsRead> {
    options.signal?.throwIfAborted();
    const token = await this.store.getFreshAccessToken(config.provider, config, this.fetchImpl);
    const calendars = config.provider === 'google'
      ? await listGoogleCalendars(this.fetchImpl, token, options)
      : await listGraphCalendars(this.fetchImpl, token, options);
    type CalendarRead =
      | { readonly calendar: ProviderCalendar; readonly events: MergedCalendarEvent[] }
      | { readonly calendar: ProviderCalendar; readonly failure: ApiDegradedState };
    const perCalendar = await mapWithLimit(calendars, CALENDAR_READ_CONCURRENCY, async (calendar): Promise<CalendarRead> => {
      try {
        const events = config.provider === 'google'
          ? await listGoogleEvents(this.fetchImpl, token, {
              calendarId: calendar.id,
              calendarLabel: calendar.name,
              timeMin: window.timeMin,
              timeMax: window.timeMax,
            }, options)
          : await listGraphEvents(this.fetchImpl, token, {
              calendarId: calendar.id,
              calendarLabel: calendar.name,
              start: window.timeMin,
              end: window.timeMax,
            }, options);
        return { calendar, events };
      } catch (error) {
        if (!(error instanceof CalendarApiError)) throw error;
        return { calendar, failure: error.degraded };
      }
    });
    const events: MergedCalendarEvent[] = [];
    const failures: CalendarReadFailure[] = [];
    for (const result of perCalendar) {
      if ('failure' in result) {
        failures.push({ calendarId: result.calendar.id, calendarLabel: result.calendar.name, degraded: result.failure });
        continue;
      }
      events.push(...result.events);
      // Recorded here, at the READ, and per calendar so the label in an origin
      // names the calendar the invitation landed on. Nothing records at fetch
      // time on a timer, see untrusted-events.ts.
      recordCalendarEventIngest({
        record: this.recordUntrustedIngest,
        provenance: {
          kind: 'provider',
          provider: config.provider,
          calendarLabel: result.calendar.name,
        },
        events: result.events,
        at: new Date(this.clock()).toISOString(),
      });
    }
    return { events: events.sort(compareMergedCalendarEventsByStart), failures };
  }

  // --- Write: create an event on an explicitly chosen provider --------------

  /**
   * Create an event on one calendar. `ownerZone` (IANA, 'UTC' when unknown) is
   * the zone a floating time is read in. A `created-but-unreadable` result means
   * the provider has the event: report it as created, do not retry.
   */
  async createEvent(
    config: ResolvedClientConfig,
    calendarId: string,
    calendarLabel: string,
    event: NewCalendarEvent,
    ownerZone: string,
    options: CalendarRequestOptions = {},
  ): Promise<CalendarCreateResult> {
    options.signal?.throwIfAborted();
    const token = await this.store.getFreshAccessToken(config.provider, config, this.fetchImpl);
    return config.provider === 'google'
      ? createGoogleEvent(this.fetchImpl, token, calendarId, calendarLabel, event, ownerZone, options)
      : createGraphEvent(this.fetchImpl, token, calendarId, calendarLabel, event, ownerZone, options);
  }

  // --- internals ------------------------------------------------------------

  /** Save tokens + a best-effort enriched account label, and return the account. */
  private async persistConnection(config: ResolvedClientConfig, tokens: StoredTokenSet): Promise<ConnectedAccount> {
    const account: ConnectedAccount = {
      provider: config.provider,
      accountId: config.provider,
      label: await this.deriveLabel(config, tokens),
      scopes: tokens.scopes ?? config.scopes,
      connectedAt: this.clock(),
    };
    await this.store.save(config.provider, tokens, account);
    return account;
  }

  /**
   * Best-effort account label: the primary calendar id is the account email for
   * Google, and the primary calendar's name is a reasonable Outlook label. A failure
   * here must NOT fail the connection (the token is already valid), so it falls back
   * to the provider display name.
   */
  private async deriveLabel(config: ResolvedClientConfig, tokens: StoredTokenSet): Promise<string> {
    try {
      const calendars = config.provider === 'google'
        ? await listGoogleCalendars(this.fetchImpl, tokens.accessToken)
        : await listGraphCalendars(this.fetchImpl, tokens.accessToken);
      const primary = calendars.find((c) => c.primary) ?? calendars[0];
      if (primary) return config.provider === 'google' ? primary.id : primary.name;
    } catch {
      // fall through to the honest default
    }
    return config.provider === 'google' ? 'Google Calendar' : 'Microsoft Outlook';
  }
}

/** Run `fn` over `items` with at most `limit` in flight, keeping input order. */
async function mapWithLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
