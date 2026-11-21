/**
 * calendar-oauth-service.ts, the Agent's bridge to the platform calendar OAuth connector.
 *
 * It wires the platform CalendarConnector with the REAL runtime adapters the platform module
 * deliberately leaves injected (so the platform stays pure and testable): the runtime
 * fetch, and a loopback redirect listener built on the platform's createOAuthLocalListener.
 * It lives with the Agent turn tools because a turn the daemon hosts for the Agent
 * writes to the same connected calendars as the Agent's own process does.
 * Tokens persist through the process's secret manager. The OAuth app is the operator's
 * own, no client id ships with the product, so the client id is read from config
 * and the client secret from the secret store, under the keys the platform profile names.
 * With none set, every connect returns an honest config-stage refusal naming the key.
 *
 * Every connect returns an honest STAGED result ({ ok, stage, error }), config,
 * authorize, or token, the same honesty shape the email connect wizard uses. The
 * connector is injectable so tests drive the whole flow against fakes with no real
 * network, port, or browser.
 *
 * Headless connect: Microsoft uses the device code; Google's device grant does
 * not cover calendar scopes, so Google prints the sign-in link and the person
 * pastes back the address the browser landed on (`beginPastedCode` /
 * `completePastedCode`). The pending sign-in is held in this process for ten
 * minutes, so the two steps can be two commands.
 *
 * Writing: `createEvent` creates an event on a connected Google or Microsoft
 * calendar; a time given without a zone is read in the owner's zone
 * (`daemon.timezone`, or this machine's zone when that is unset).
 */

import { revealOrNull, type Secret } from '@goodvibes/engine/platform/platform/security';
import {
  CalendarApiError,
  CalendarConnector,
  fetchAdapter,
  providerProfile,
  resolveClientConfig,
  type AuthCodeFlowStart,
  type CalendarCreateResult,
  type CalendarEventsRead,
  type CalendarProviderId,
  type CalendarRequestOptions,
  type ConnectedAccount,
  type ConnectionState,
  type DeviceCodeFlowStart,
  type EventWindow,
  type LoopbackListenerFactory,
  type MergedCalendarEvent,
  type NewCalendarEvent,
  type OAuthClientOverrides,
  type ProviderCalendar,
  type ResolvedClientConfig,
} from '@goodvibes/engine/platform/platform/calendar';
import {
  createOAuthLocalListener,
  readConsumerSetting,
  resolveSecretWriteScope,
  type SecretScope,
} from '@goodvibes/engine/platform/platform/config';

/** The narrow config-manager slice this service reads. */
export interface CalendarConfigReader {
  get(key: string): unknown;
  /** The profile-filled value of an unset key (the owner's zone); see `ConfigManager.resolveForConsumer`. */
  resolveForConsumer?(key: string): unknown;
}

/**
 * The narrow secret slice used for token storage + reading a stored client secret.
 *
 * `set` takes the store's write options because the OAuth token set has to be
 * filed where the DAEMON can read it, see `daemonScopedSecrets` below. Tests
 * that pass a Map-backed fake can keep ignoring the second argument; the
 * parameter is optional so the fake's two-argument shape still satisfies this.
 */
export interface CalendarSecretSlice {
  get(key: string): Promise<Secret | null>;
  set(key: string, value: string, options?: { readonly scope?: SecretScope }): Promise<void>;
  delete(key: string, options?: { readonly scope?: SecretScope }): Promise<void>;
}

/** The slice the connector and its token store read: each value revealed for the calendar service it is sent to. */
export interface CalendarSecretTextSlice {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { readonly scope?: SecretScope }): Promise<void>;
  delete(key: string, options?: { readonly scope?: SecretScope }): Promise<void>;
}

/**
 * Wrap a secret slice so every WRITE it receives is filed at the tier the
 * credential's reader actually reads from.
 *
 * The platform's `CalendarTokenStore` writes `GOODVIBES_CALENDAR_<PROVIDER>_TOKENS`,
 * `_ACCOUNT` and `_STATUS` through a two-argument `set(key, value)`, it has no
 * scope parameter to pass, and nothing in the chain from
 * `/calendar connect google` down to that call ever named one. The store's own
 * default for a name it does not recognize is the project tier, so an OAuth
 * REFRESH TOKEN for a calendar the daemon reads on a schedule ended up in a
 * silo the daemon never opens: the operator connects a calendar here, closes
 * the terminal, and the daemon reports no calendar account connected.
 *
 * Wrapping at this seam rather than changing the call is what makes it work
 * without a platform change, the token store keeps its two-argument call and the
 * scope is decided by the name, one layer down, where the answer is known.
 * `resolveSecretWriteScope` is what holds that answer, for these names and
 * for the platform-derived ones alike.
 *
 * Reads and deletes pass straight through: `SecretsManager.get` already reads
 * across tiers, and a delete with no scope sweeps all of them, which is what a
 * disconnect wants when a token stored before this fix is still sitting in the
 * project tier.
 */
export function daemonScopedSecrets(secrets: CalendarSecretSlice): CalendarSecretTextSlice {
  return {
    get: async (key) => revealOrNull(await secrets.get(key), 'dispatch'),
    set: (key, value, options) => secrets.set(key, value, {
      ...options,
      scope: resolveSecretWriteScope(key, options?.scope),
    }),
    delete: (key, options) => secrets.delete(key, options),
  };
}

export type ConnectStage = 'config' | 'authorize' | 'token';

export interface ConnectResult {
  readonly ok: boolean;
  readonly stage?: ConnectStage;
  readonly error?: string;
  readonly account?: ConnectedAccount;
  readonly transport?: 'loopback' | 'device-code' | 'pasted-code';
  /**
   * Present when the sign-in waits for the person: the link to open on any
   * device, after which they paste back where the browser landed with
   * `/calendar connect <provider> --code <address>`.
   */
  readonly pendingAuthorizationUrl?: string;
}

/** A pasted-code sign-in waiting for its code. */
interface PendingPastedSignIn {
  readonly start: AuthCodeFlowStart;
  readonly clientId: string;
  readonly expiresAt: number;
}

/** How long a printed sign-in link stays completable. */
const PASTED_SIGN_IN_TTL_MS = 10 * 60 * 1000;

/**
 * Pending pasted-code sign-ins, by provider. Module-level because a command
 * builds a fresh service per call and the link and the code arrive in two
 * commands; in memory only, so the PKCE verifier never reaches a disk.
 */
const pendingPastedSignIns = new Map<CalendarProviderId, PendingPastedSignIn>();

/** One calendar of a connected account. */
export interface ConnectedCalendar extends ProviderCalendar {
  readonly accountLabel: string;
}

/** What `createEvent` did, with the calendar it wrote to. */
export interface CreateEventOutcome {
  readonly result: CalendarCreateResult;
  readonly calendar: ProviderCalendar;
  readonly ownerZone: string;
}

/**
 * The create request went out and no answer came back (the connection dropped
 * or the write deadline passed): the provider may hold the event or may not.
 */
export class CalendarCreateUnconfirmedError extends Error {
  readonly calendar: ProviderCalendar;
  readonly detail: string;
  constructor(calendar: ProviderCalendar, detail: string) {
    super(`It is not known whether the event was created on "${calendar.name}": ${detail}`);
    this.name = 'CalendarCreateUnconfirmedError';
    this.calendar = calendar;
    this.detail = detail;
  }
}

/** Events across every connected account, and what could not be read, per account or per calendar. */
export interface ConnectedEventsRead {
  readonly events: MergedCalendarEvent[];
  readonly failures: readonly { readonly provider: CalendarProviderId; readonly calendarLabel?: string; readonly error: string }[];
}

export interface AccountStatus {
  readonly account: ConnectedAccount;
  readonly state: ConnectionState;
}

/** The real loopback factory, binds 127.0.0.1 and waits for the browser callback. */
const realLoopbackFactory: LoopbackListenerFactory = async ({ expectedState, host, port, timeoutMs }) => {
  const listener = await createOAuthLocalListener({
    expectedState,
    ...(host ? { host } : {}),
    ...(typeof port === 'number' ? { port } : {}),
    ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
  });
  return {
    redirectUri: listener.redirectUri,
    async waitForCode() {
      const { code } = await listener.waitForCode();
      return { code, state: expectedState };
    },
    close() {
      listener.close();
    },
  };
};

export interface CalendarOAuthServiceOptions {
  readonly config: CalendarConfigReader;
  readonly secrets: CalendarSecretSlice;
  /** Injected for tests; production builds a real connector over runtime fetch + loopback. */
  readonly connector?: CalendarConnector;
  /** Injected fetch for tests; ignored when a connector is injected. */
  readonly fetchImpl?: Parameters<typeof fetchAdapter>[0];
  /** Injected loopback factory for tests; ignored when a connector is injected. */
  readonly listenerFactory?: LoopbackListenerFactory;
}

export class CalendarOAuthService {
  private readonly config: CalendarConfigReader;
  /**
   * The scope-pinned slice, and the exact object handed to the connector below.
   *
   * Readable so a test can write through the same object the platform's token store
   * writes through and check where the value landed. That is the only way to
   * gate the wrapping from outside: the token store is built inside the
   * connector, and a service that stopped wrapping would keep every visible
   * behavior and quietly file the refresh token where the daemon cannot see it.
   */
  readonly secrets: CalendarSecretTextSlice;
  private readonly connector: CalendarConnector;

  constructor(options: CalendarOAuthServiceOptions) {
    this.config = options.config;
    // Every write this service makes, its own, and the token store's inside the
    // connector, goes through the scope-pinning wrapper, so the refresh token
    // lands where the daemon reads it. Wrapping here rather than at each call
    // means a future write added inside the platform connector is covered too.
    this.secrets = daemonScopedSecrets(options.secrets);
    this.connector = options.connector ?? new CalendarConnector({
      secrets: this.secrets,
      fetchImpl: options.fetchImpl ? fetchAdapter(options.fetchImpl) : fetchAdapter(),
      listenerFactory: options.listenerFactory ?? realLoopbackFactory,
    });
  }

  /** Resolve the client config from the operator's configured OAuth app. */
  async resolveConfig(provider: CalendarProviderId): Promise<ResolvedClientConfig> {
    const overrides = await this.resolveOverrides(provider);
    return resolveClientConfig(providerProfile(provider), overrides);
  }

  /** Read the client id (config) and client secret (secret store), when set. */
  async resolveOverrides(provider: CalendarProviderId): Promise<OAuthClientOverrides> {
    // The keys are the profile's: clientId is not a secret (RFC 8252); the
    // secret ref is secret-backed and listed in SECRET_CONFIG_KEYS.
    const profile = providerProfile(provider);
    const clientId = this.readString(profile.clientIdConfigKey);
    const clientSecret = await this.resolveSecretBacked(profile.clientSecretRefConfigKey);
    const overrides: OAuthClientOverrides = {
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
    };
    return overrides;
  }

  /** Connect via the loopback authorization-code flow. `openUrl` is best-effort. */
  async connectLoopback(
    provider: CalendarProviderId,
    hooks: { openUrl?: (url: string) => void } = {},
  ): Promise<ConnectResult> {
    const resolved = await this.resolveConfigOrFailure(provider);
    if ('failure' in resolved) return resolved.failure;
    const config = resolved.config;
    const guard = this.guardConfigured(config);
    if (guard) return guard;
    let begun;
    try {
      begun = await this.connector.beginConnectAuthCode(config);
    } catch (error) {
      return { ok: false, stage: 'authorize', error: `Could not start the sign-in flow: ${describe(error)}` };
    }
    // Best-effort: a browser that will not open must not abandon the listener
    // (or the sign-in, if the URL is shown some other way).
    try { hooks.openUrl?.(begun.start.authorizationUrl); } catch { /* the waiter below still times out and closes */ }
    let code: string;
    try {
      code = (await begun.waiter.waitForCode()).code;
    } catch (error) {
      begun.waiter.close();
      return { ok: false, stage: 'authorize', error: `The browser sign-in did not complete: ${describe(error)}` };
    }
    try {
      const account = await this.connector.completeConnectAuthCode(config, {
        code,
        verifier: begun.start.verifier,
        redirectUri: begun.start.redirectUri,
      });
      return { ok: true, account, transport: 'loopback' };
    } catch (error) {
      return { ok: false, stage: 'token', error: `The provider rejected the sign-in: ${describe(error)}` };
    } finally {
      begun.waiter.close();
    }
  }

  /**
   * Connect without a browser on this machine: the device code for a provider
   * that grants calendar access that way (Microsoft), otherwise a sign-in link
   * whose landing address the person pastes back (Google, see
   * `beginPastedCode`).
   */
  async connectDeviceCode(
    provider: CalendarProviderId,
    hooks: { onDeviceCode?: (start: DeviceCodeFlowStart) => void } = {},
  ): Promise<ConnectResult> {
    const resolved = await this.resolveConfigOrFailure(provider);
    if ('failure' in resolved) return resolved.failure;
    const config = resolved.config;
    const guard = this.guardConfigured(config);
    if (guard) return guard;
    if (!config.usesDeviceGrant) return this.beginPastedCodeWith(config);
    let start: DeviceCodeFlowStart;
    try {
      start = await this.connector.beginConnectDeviceCode(config);
    } catch (error) {
      return { ok: false, stage: 'authorize', error: `Could not start device sign-in: ${describe(error)}` };
    }
    hooks.onDeviceCode?.(start);
    try {
      const account = await this.connector.completeConnectDeviceCode(config, start);
      return { ok: true, account, transport: 'device-code' };
    } catch (error) {
      return { ok: false, stage: 'token', error: `Device sign-in was not approved: ${describe(error)}` };
    }
  }

  /**
   * Auto-select: try the loopback flow; if the listener cannot bind (headless), fall
   * back to device-code. `--device` callers use connectDeviceCode directly.
   */
  async connectAuto(
    provider: CalendarProviderId,
    hooks: { openUrl?: (url: string) => void; onDeviceCode?: (start: DeviceCodeFlowStart) => void } = {},
  ): Promise<ConnectResult> {
    const resolved = await this.resolveConfigOrFailure(provider);
    if ('failure' in resolved) return resolved.failure;
    const config = resolved.config;
    const guard = this.guardConfigured(config);
    if (guard) return guard;
    let begun: Awaited<ReturnType<typeof this.connector.beginConnectAuthCode>>;
    try {
      begun = await this.connector.beginConnectAuthCode(config);
    } catch {
      return this.connectDeviceCode(provider, hooks);
    }
    try {
      // Best-effort, as in connectLoopback: the listener is up and the link
      // can still be opened by hand.
      try { hooks.openUrl?.(begun.start.authorizationUrl); } catch { /* the waiter below still times out and closes */ }
      let code: string;
      try {
        code = (await begun.waiter.waitForCode()).code;
      } catch (error) {
        return { ok: false, stage: 'authorize', error: `The browser sign-in did not complete: ${describe(error)}` };
      }
      try {
        const account = await this.connector.completeConnectAuthCode(config, {
          code, verifier: begun.start.verifier, redirectUri: begun.start.redirectUri,
        });
        return { ok: true, account, transport: 'loopback' };
      } catch (error) {
        return { ok: false, stage: 'token', error: `Browser sign-in token exchange failed: ${describe(error)}` };
      }
    } finally {
      begun.waiter.close();
    }
  }

  /**
   * Begin a pasted-code sign-in: returns the link to open on any device. After
   * approving, the browser lands on a local address that does not load; that
   * address goes back through `completePastedCode`.
   */
  async beginPastedCode(provider: CalendarProviderId): Promise<ConnectResult> {
    const resolved = await this.resolveConfigOrFailure(provider);
    if ('failure' in resolved) return resolved.failure;
    const guard = this.guardConfigured(resolved.config);
    if (guard) return guard;
    return this.beginPastedCodeWith(resolved.config);
  }

  /** Complete the pending pasted-code sign-in with what the person pasted (the address, or the code). */
  async completePastedCode(provider: CalendarProviderId, pasted: string): Promise<ConnectResult> {
    const pending = pendingPastedSignIns.get(provider);
    if (pending === undefined || pending.expiresAt < Date.now()) {
      pendingPastedSignIns.delete(provider);
      return {
        ok: false,
        stage: 'authorize',
        error: `No ${provider === 'google' ? 'Google' : 'Microsoft'} sign-in is waiting for a code (none was started, it expired after ten minutes, or the app restarted). `
          + `Run /calendar connect ${provider === 'google' ? 'google' : 'outlook'} --device for a new link.`,
      };
    }
    const resolved = await this.resolveConfigOrFailure(provider);
    if ('failure' in resolved) return resolved.failure;
    if (resolved.config.clientId !== pending.clientId) {
      pendingPastedSignIns.delete(provider);
      return { ok: false, stage: 'config', error: 'The OAuth client id changed after the sign-in link was printed. Run the connect command again for a new link.' };
    }
    try {
      const account = await this.connector.completeConnectPastedCode(resolved.config, pending.start, pasted);
      pendingPastedSignIns.delete(provider);
      return { ok: true, account, transport: 'pasted-code' };
    } catch (error) {
      return { ok: false, stage: 'token', error: `The sign-in could not be completed: ${describe(error)}` };
    }
  }

  private async beginPastedCodeWith(config: ResolvedClientConfig): Promise<ConnectResult> {
    let start: AuthCodeFlowStart;
    try {
      start = await this.connector.beginConnectPastedCode(config);
    } catch (error) {
      return { ok: false, stage: 'authorize', error: `Could not start the sign-in: ${describe(error)}` };
    }
    pendingPastedSignIns.set(config.provider, { start, clientId: config.clientId, expiresAt: Date.now() + PASTED_SIGN_IN_TTL_MS });
    return {
      ok: false,
      stage: 'authorize',
      transport: 'pasted-code',
      pendingAuthorizationUrl: start.authorizationUrl,
      error: 'Waiting for the sign-in to be approved and its address pasted back.',
    };
  }

  /** Disconnect a provider: revoke where possible + clear stored tokens. */
  async disconnect(provider: CalendarProviderId): Promise<{ readonly revokedRemotely: boolean }> {
    // The stored token is always deleted: a client secret that cannot be read
    // (a malformed reference) leaves the client id alone, which is all token
    // revocation needs; revokedRemotely says whether revocation happened.
    let overrides: OAuthClientOverrides;
    try {
      overrides = await this.resolveOverrides(provider);
    } catch {
      const clientId = this.readString(providerProfile(provider).clientIdConfigKey);
      overrides = clientId ? { clientId } : {};
    }
    return this.connector.disconnect(provider, overrides);
  }

  /** List connected accounts with their honest connection state. */
  async listAccounts(): Promise<AccountStatus[]> {
    const accounts = await this.connector.listAccounts();
    const out: AccountStatus[] = [];
    for (const account of accounts) {
      out.push({ account, state: await this.connector.connectionState(account.provider) });
    }
    return out;
  }

  /** Events for one already-resolved provider config over a window, with the calendars that could not be read. */
  async listEventsForProvider(config: ResolvedClientConfig, window: EventWindow, options: CalendarRequestOptions = {}): Promise<CalendarEventsRead> {
    return this.connector.listEvents(config, window, options);
  }

  /** Merged, source-labeled events across every connected provider in a window. */
  async listEvents(window: EventWindow, options: CalendarRequestOptions = {}): Promise<MergedCalendarEvent[]> {
    return (await this.listEventsDetailed(window, options)).events;
  }

  /**
   * {@link listEvents} that also says what could not be read: a provider that
   * failed outright, or one calendar of an account, so one broken calendar
   * neither hides the others' events nor goes unmentioned. Accounts are read
   * side by side.
   */
  async listEventsDetailed(window: EventWindow, options: CalendarRequestOptions = {}): Promise<ConnectedEventsRead> {
    const accounts = await this.connector.listAccounts();
    type AccountRead =
      | { readonly provider: CalendarProviderId; readonly read: CalendarEventsRead }
      | { readonly provider: CalendarProviderId; readonly error: string };
    const reads = await Promise.all(accounts.map(async (account): Promise<AccountRead> => {
      try {
        const config = await this.resolveConfig(account.provider);
        return { provider: account.provider, read: await this.connector.listEvents(config, window, options) };
      } catch (error) {
        if (options.signal?.aborted) throw error;
        return { provider: account.provider, error: describe(error) };
      }
    }));
    const events: MergedCalendarEvent[] = [];
    const failures: { provider: CalendarProviderId; calendarLabel?: string; error: string }[] = [];
    for (const entry of reads) {
      if ('error' in entry) {
        failures.push({ provider: entry.provider, error: entry.error });
        continue;
      }
      events.push(...entry.read.events);
      for (const failure of entry.read.failures) {
        failures.push({ provider: entry.provider, calendarLabel: failure.calendarLabel, error: failure.degraded.detail });
      }
    }
    return { events, failures };
  }

  /** The calendars of every connected account, with whether each can be written to. */
  async listCalendars(options: CalendarRequestOptions = {}): Promise<{
    readonly calendars: readonly ConnectedCalendar[];
    readonly failures: readonly { readonly provider: CalendarProviderId; readonly error: string }[];
  }> {
    const accounts = await this.connector.listAccounts();
    const calendars: ConnectedCalendar[] = [];
    const failures: { provider: CalendarProviderId; error: string }[] = [];
    for (const account of accounts) {
      try {
        const config = await this.resolveConfig(account.provider);
        for (const calendar of await this.connector.listCalendars(config, options)) {
          calendars.push({ ...calendar, accountLabel: account.label });
        }
      } catch (error) {
        if (options.signal?.aborted) throw error;
        failures.push({ provider: account.provider, error: describe(error) });
      }
    }
    return { calendars, failures };
  }

  /**
   * Create an event on a connected account's calendar: the one named by
   * `calendarId`, else the account's primary calendar when it can be written,
   * else the first writable one. A floating time is read in the owner's zone.
   */
  async createEvent(
    provider: CalendarProviderId,
    event: NewCalendarEvent,
    target: { readonly calendarId?: string | undefined } = {},
    options: CalendarRequestOptions = {},
  ): Promise<CreateEventOutcome> {
    const config = await this.resolveConfig(provider);
    const calendars = await this.connector.listCalendars(config, options);
    // By id; by name only when exactly one calendar has that name, never the first of several.
    const byName = target.calendarId ? calendars.filter((candidate) => candidate.name === target.calendarId) : [];
    if (target.calendarId && !calendars.some((candidate) => candidate.id === target.calendarId) && byName.length > 1) {
      throw new CalendarApiError({
        kind: 'provider-error',
        status: 409,
        detail: `${byName.length} calendars on the connected ${provider} account are named '${target.calendarId}', so nothing was created. Name the calendar by its id: ${byName.map((candidate) => candidate.id).join(', ')}.`,
      });
    }
    const calendar = target.calendarId
      ? calendars.find((candidate) => candidate.id === target.calendarId) ?? byName[0]
      : calendars.find((candidate) => candidate.primary === true && candidate.canWrite) ?? calendars.find((candidate) => candidate.canWrite);
    if (calendar === undefined) {
      throw new CalendarApiError({
        kind: 'provider-error',
        status: 404,
        detail: target.calendarId
          ? `No calendar '${target.calendarId}' on the connected ${provider} account. List the calendars to pick one.`
          : `The connected ${provider} account has no calendar it may write to. Reconnect with /calendar connect ${provider === 'google' ? 'google' : 'outlook'} and allow calendar writes.`,
      });
    }
    if (!calendar.canWrite) {
      throw new CalendarApiError({
        kind: 'insufficient-scope',
        missingScope: provider === 'google' ? 'https://www.googleapis.com/auth/calendar.events' : 'Calendars.ReadWrite',
        detail: `The calendar '${calendar.name}' is read-only for this account. Pick a calendar it can write to.`,
      });
    }
    const ownerZone = this.ownerZone();
    let result: CalendarCreateResult;
    try {
      result = await this.connector.createEvent(config, calendar.id, calendar.name, event, ownerZone, options);
    } catch (error) {
      // A lost connection or the write deadline at this step may come after the
      // provider accepted the event, so the caller must not read it as "nothing
      // was created". A refusal the provider answered (any status) did create nothing.
      if (error instanceof CalendarApiError && error.degraded.kind === 'network-error') {
        throw new CalendarCreateUnconfirmedError(calendar, error.degraded.detail);
      }
      throw error;
    }
    return { result, calendar, ownerZone };
  }

  /** The owner's zone: `daemon.timezone` when set, else the owner profile's zone, else this machine's zone, else UTC. */
  ownerZone(): string {
    const configured = this.readString('daemon.timezone', true);
    if (configured) return configured;
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }

  // --- internals ------------------------------------------------------------

  /** The client config, or the staged config failure the connect methods promise instead of a thrown error. */
  private async resolveConfigOrFailure(provider: CalendarProviderId): Promise<
    { readonly config: ResolvedClientConfig } | { readonly failure: ConnectResult }
  > {
    try {
      return { config: await this.resolveConfig(provider) };
    } catch (error) {
      return { failure: { ok: false, stage: 'config', error: `The ${provider} calendar sign-in settings could not be read: ${describe(error)}` } };
    }
  }

  private guardConfigured(config: ResolvedClientConfig): ConnectResult | null {
    if (config.isConfigured) return null;
    const label = config.provider === 'google' ? 'Google Calendar' : 'Microsoft Outlook';
    const cardLabel = config.provider === 'google' ? 'Connect Google Calendar' : 'Connect Microsoft Outlook';
    return {
      ok: false,
      stage: 'config',
      error:
        `No ${label} client id is configured. GoodVibes ships none of its own: register your own OAuth app ` +
        `with the provider and set ${config.clientIdConfigKey} to its client id. ` +
        `Run /calendar connect for the provider-console steps, or open "${cardLabel}" under /agent personal-ops and paste your client id in.`,
    };
  }

  /** `forConsumer` reads the value the owner profile fills when the setting is unset. */
  private readString(key: string, forConsumer = false): string | undefined {
    // get() throws when the config section does not exist yet (nothing has seeded
    // 'calendar'). Treat that as "unset", an environment where nobody has registered
    // an OAuth app yet is a normal state that reads as not-configured, not a schema
    // error surfaced to the operator.
    let value: unknown;
    try {
      value = forConsumer ? readConsumerSetting(this.config, key) : this.config.get(key);
    } catch {
      return undefined;
    }
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  }

  /** Read a secret-backed config value: resolve a goodvibes:// ref to its secret. */
  private async resolveSecretBacked(configKey: string): Promise<string | undefined> {
    const ref = this.readString(configKey);
    if (!ref) return undefined;
    const prefix = 'goodvibes://secrets/goodvibes/';
    if (!ref.startsWith(prefix)) return ref; // a literal value (unusual, but honored)
    let secretKey: string;
    try { secretKey = decodeURIComponent(ref.slice(prefix.length)); }
    catch { throw new Error(`${configKey} holds a malformed secret reference (a bad % sequence)`); }
    const value = await this.secrets.get(secretKey);
    return value ?? undefined;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
