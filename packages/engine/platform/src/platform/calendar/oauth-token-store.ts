/**
 * oauth-token-store.ts, token persistence + honest lifecycle over the injected
 * secret store. Tokens (access + refresh) live ONLY in the secret store or in
 * memory, never in plain config and never echoed. The store computes an honest
 * connection state from the stored set + the clock, auto-refreshes when the
 * access token is due, and, when a refresh fails, records that the account has
 * to be connected again so every later read is honest about it.
 *
 * Google has ONE connection on a machine: the refresh token under
 * `google.oauth.refreshToken`, which the daemon's calendar and mail, the
 * `google` tool and `/calendar` all use, and beside it the account it belongs
 * to under `google.oauth.account` (label, scopes granted at connect, and a
 * digest of the token it describes, never the token). A Google access token is
 * held in this process's memory only, as the daemon's token manager holds its
 * own. Microsoft keeps its token record under `calendar.microsoft.tokens`.
 *
 * Up to 3.4.4, `/calendar connect google` kept a second Google connection under
 * `calendar.google.tokens` that nothing in the daemon read. The daemon moves it
 * into the one place on its first start of this version
 * ({@link carryGoogleCalendarConnectionForward}).
 */

import { noteCarriedForward, noteCarriedForwardChange } from '../state/carried-forward.js';
import { OAuthFlowError, refreshAccessToken, revokeToken } from './oauth-flow.js';
import { daemonSecretKeyFor } from '../config/daemon-secret-keys.js';
import { GOOGLE_SECRET_KEYS } from '../google/setup-plan.js';
import type {
  CalendarProviderId,
  Clock,
  ConnectedAccount,
  ConnectionState,
  HttpFetch,
  ResolvedClientConfig,
  SecretStoreSlice,
  StoredTokenSet,
} from './oauth-types.js';

const DEFAULT_REFRESH_LEEWAY_MS = 60_000;

/**
 * The key names of a provider's token record and reconnect marker, DERIVED
 * with `daemonSecretKeyFor` so they are daemon-owned by construction. Google's
 * are read only by the carry below; Microsoft's are its connection.
 */
function tokenKey(provider: CalendarProviderId): string {
  return daemonSecretKeyFor(`calendar.${provider}.tokens`);
}
function statusKey(provider: CalendarProviderId): string {
  return daemonSecretKeyFor(`calendar.${provider}.status`);
}
/** Where 3.3.1 kept a connection's account, beside its token record. */
function previousAccountKey(provider: CalendarProviderId): string {
  return daemonSecretKeyFor(`calendar.${provider}.account`);
}

/** The one Google connection: its refresh token, and the account it belongs to. */
const GOOGLE_GRANT_KEY = GOOGLE_SECRET_KEYS.oauthRefreshToken;
const GOOGLE_ACCOUNT_KEY = GOOGLE_SECRET_KEYS.oauthAccount;

const ALL_PROVIDERS: readonly CalendarProviderId[] = ['google', 'microsoft'];

/**
 * Google access tokens obtained in this process, by the refresh token they came
 * from. Memory only: the refresh token is the connection, an access token is a
 * one-hour copy each process gets for itself. Module-level because `/calendar`
 * builds a store per command, and each command would otherwise ask Google for
 * a new access token.
 */
const googleAccessTokens = new Map<string, StoredTokenSet>();
/** Google refresh tokens Google refused in this process: never sent again, reported as reconnect needed. */
const refusedGoogleGrants = new Set<string>();

export interface CalendarTokenStoreOptions {
  readonly secrets: SecretStoreSlice;
  readonly clock?: Clock;
  /** How long before expiry a token counts as due for refresh. */
  readonly refreshLeewayMs?: number;
}

/** A refresh failure the caller turns into a "reconnect needed" surface. */
export class TokenRefreshError extends Error {
  readonly provider: CalendarProviderId;
  constructor(provider: CalendarProviderId, message: string) {
    super(message);
    this.name = 'TokenRefreshError';
    this.provider = provider;
  }
}

/** The provider answered the refresh and refused the grant (invalid_grant, 401), as opposed to being unreachable or failing. */
function isGrantRejection(error: OAuthFlowError): boolean {
  if (error.reason !== 'token-request-rejected') return false;
  const status = error.status;
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** A short digest of a refresh token, so the account record names which grant it describes without holding it. */
async function grantDigest(refreshToken: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(refreshToken)));
  return Array.from(digest.slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** What is kept under `google.oauth.account`. */
interface GoogleAccountRecord {
  readonly account: ConnectedAccount;
  /** {@link grantDigest} of the refresh token this account record describes. */
  readonly grant: string;
}

function syntheticAccount(provider: CalendarProviderId, scopes: readonly string[], connectedAt: number): ConnectedAccount {
  return {
    provider,
    accountId: provider,
    label: provider === 'google' ? 'Google account' : 'Microsoft Outlook',
    scopes,
    connectedAt,
  };
}

function parseAccount(raw: string | null): ConnectedAccount | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ConnectedAccount | null;
    return parsed && typeof parsed === 'object' && typeof parsed.label === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The account the stored Google refresh token belongs to. A record written for
 * another grant (the setup flow or the `google` tool stored a new refresh token
 * since) does not describe this one, so the account is then named generically.
 */
async function readGoogleAccountRecord(get: (key: string) => Promise<string | null>, refreshToken: string): Promise<ConnectedAccount | null> {
  const raw = await get(GOOGLE_ACCOUNT_KEY);
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as GoogleAccountRecord | null;
    if (record && typeof record === 'object' && record.grant === await grantDigest(refreshToken)
      && record.account && typeof record.account.label === 'string') return record.account;
  } catch {
    // An unreadable record names nothing.
  }
  return null;
}

/** {@link readGoogleAccountRecord}, or the account named generically when no record describes this grant. */
async function readGoogleAccount(get: (key: string) => Promise<string | null>, refreshToken: string): Promise<ConnectedAccount> {
  return (await readGoogleAccountRecord(get, refreshToken)) ?? syntheticAccount('google', [], 0);
}

async function readGoogleGrant(get: (key: string) => Promise<string | null>): Promise<string | null> {
  const raw = (await get(GOOGLE_GRANT_KEY))?.trim();
  return raw ? raw : null;
}

/**
 * Whether the stored Google grant is the calendar's alone: its account record (written by a calendar sign-in)
 * describes this grant and names only calendar scopes. False when no record describes it (the Google tab's own
 * connection asks for mail and calendar together, and an adopted grant is read by its check), or nothing is stored.
 */
export async function googleGrantIsCalendarOnly(get: (key: string) => Promise<string | null>): Promise<boolean> {
  const grant = await readGoogleGrant(get);
  if (!grant) return false;
  const account = await readGoogleAccountRecord(get, grant);
  const scopes = Array.isArray(account?.scopes) ? account.scopes : [];
  return scopes.length > 0 && scopes.every((scope) => scope.includes('/auth/calendar'));
}

/**
 * The calendar accounts on record on this machine, read without writing
 * anything and without any token in the answer: the one Google connection and
 * a Microsoft connection made with `/calendar connect outlook`. For a report of
 * which accounts exist (the daemon's answer when it has no calendar to read).
 */
export async function readCalendarAccountsOnRecord(get: (key: string) => Promise<string | null>): Promise<ConnectedAccount[]> {
  const out: ConnectedAccount[] = [];
  const grant = await readGoogleGrant(get);
  if (grant !== null) out.push(await readGoogleAccount(get, grant));
  const microsoft = await get(tokenKey('microsoft'));
  if (microsoft) {
    let parsed: StoredConnection | null = null;
    try { parsed = JSON.parse(microsoft) as StoredConnection; } catch { parsed = null; }
    if (parsed && typeof parsed === 'object' && typeof parsed.accessToken === 'string') {
      out.push(parsed.account ?? parseAccount(await get(previousAccountKey('microsoft'))) ?? syntheticAccount('microsoft', parsed.scopes ?? [], typeof parsed.obtainedAt === 'number' ? parsed.obtainedAt : 0));
    }
  }
  return out;
}

export class CalendarTokenStore {
  private readonly secrets: SecretStoreSlice;
  private readonly clock: Clock;
  private readonly leewayMs: number;
  /**
   * In-instance single-flight dedup for concurrent refreshes of the same provider.
   * Providers that rotate refresh tokens (Microsoft) invalidate the prior refresh
   * token the moment one refresh succeeds, a second concurrent call that still
   * holds the OLD refresh token would otherwise lose the race with invalid_grant
   * and stamp reconnect-needed over a perfectly working account. Every concurrent
   * caller for a given provider instead awaits the SAME in-flight refresh.
   */
  private readonly inflightRefresh = new Map<CalendarProviderId, Promise<string>>();
  /**
   * Bumped by `disconnect` and by `save`. A refresh that was already on the
   * wire when the owner disconnected, or connected again (possibly another
   * account), must not write its result back: it would reconnect an account
   * the owner just removed, or put the old grant's tokens under the account
   * just saved and overwrite the new grant's refresh token.
   */
  private readonly generations = new Map<CalendarProviderId, number>();

  constructor(options: CalendarTokenStoreOptions) {
    this.secrets = options.secrets;
    this.clock = options.clock ?? (() => Date.now());
    this.leewayMs = options.refreshLeewayMs ?? DEFAULT_REFRESH_LEEWAY_MS;
  }

  /**
   * Persist a fresh token set + account metadata; clears any reconnect marker.
   *
   * Microsoft: the account is kept inside the token record, so one write
   * publishes both: a failed write leaves the earlier connection whole.
   *
   * Google: the refresh token becomes the one Google connection (calendar,
   * mail and the Agent), then its account record is written beside it. A
   * Google connection set aside at the carry (another account) is removed:
   * signing in here is the owner choosing the account.
   */
  async save(provider: CalendarProviderId, tokens: StoredTokenSet, account: ConnectedAccount): Promise<void> {
    // A refresh started from the earlier grant is now stale: it writes nothing,
    // and callers waiting on it start a new one from the grant saved here.
    this.generations.set(provider, (this.generations.get(provider) ?? 0) + 1);
    this.inflightRefresh.delete(provider);
    if (provider === 'google') {
      const refreshToken = tokens.refreshToken;
      if (!refreshToken) {
        throw new OAuthFlowError(
          'token-request-rejected',
          'Google returned no refresh token, so there is no lasting connection to keep. Remove the app at https://myaccount.google.com/permissions and connect again.',
        );
      }
      await this.secrets.set(GOOGLE_GRANT_KEY, refreshToken);
      await this.secrets.set(GOOGLE_ACCOUNT_KEY, JSON.stringify({ account, grant: await grantDigest(refreshToken) } satisfies GoogleAccountRecord));
      googleAccessTokens.set(refreshToken, tokens);
      refusedGoogleGrants.delete(refreshToken);
      await this.secrets.delete(tokenKey('google'));
      await this.secrets.delete(statusKey('google'));
      return;
    }
    await this.secrets.set(tokenKey(provider), JSON.stringify({ ...tokens, account } satisfies StoredConnection));
    await this.secrets.delete(statusKey(provider));
  }

  /** The stored token record (token set and its account), or null when there is none or it cannot be read. */
  private async loadConnection(provider: CalendarProviderId): Promise<StoredConnection | null> {
    if (provider === 'google') return this.loadGoogleConnection();
    const raw = await this.secrets.get(tokenKey(provider));
    if (!raw) return null;
    let parsed: StoredConnection;
    try {
      parsed = JSON.parse(raw) as StoredConnection;
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.accessToken !== 'string') return null;
    return parsed.account === undefined ? this.carryForwardAccount(provider, parsed) : parsed;
  }

  /**
   * The one Google connection as a token set: the stored refresh token, the
   * access token this process holds for it (none yet reads as due, so the
   * first call refreshes), and its account.
   */
  private async loadGoogleConnection(): Promise<StoredConnection | null> {
    const get = (key: string) => this.secrets.get(key);
    const refreshToken = await readGoogleGrant(get);
    if (refreshToken === null) return null;
    const account = await readGoogleAccount(get, refreshToken);
    const held = googleAccessTokens.get(refreshToken);
    return {
      ...(held ?? { accessToken: '', tokenType: 'Bearer', expiresAt: 0, obtainedAt: account.connectedAt }),
      ...(account.scopes.length > 0 && held?.scopes === undefined ? { scopes: account.scopes } : {}),
      refreshToken,
      account,
    };
  }

  /**
   * 3.3.1 kept the account under a key of its own beside the token record.
   * A token record without an account takes it from there once: the joined
   * record is written, and only then is the old key removed. Every record
   * this version writes carries its account, so this read happens only for a
   * connection made by 3.3.1.
   */
  private async carryForwardAccount(provider: CalendarProviderId, tokens: StoredConnection): Promise<StoredConnection> {
    const previousKey = previousAccountKey(provider);
    const account = parseAccount(await this.secrets.get(previousKey));
    if (!account) return tokens;
    const joined: StoredConnection = { ...tokens, account };
    await this.secrets.set(tokenKey(provider), JSON.stringify(joined));
    await this.secrets.delete(previousKey);
    noteCarriedForward('calendar connection');
    return joined;
  }

  /** Read the stored token set for a provider, or null when disconnected. */
  async load(provider: CalendarProviderId): Promise<StoredTokenSet | null> {
    const connection = await this.loadConnection(provider);
    if (!connection) return null;
    const { account: _account, ...tokens } = connection;
    return tokens;
  }

  /** Read the account metadata for a provider, or null: only an account whose token record reads is connected. */
  async loadAccount(provider: CalendarProviderId): Promise<ConnectedAccount | null> {
    const connection = await this.loadConnection(provider);
    if (!connection) return null;
    return connection.account ?? syntheticAccount(provider, connection.scopes ?? [], connection.obtainedAt);
  }

  /** List every connected account across providers. */
  async listAccounts(): Promise<ConnectedAccount[]> {
    const out: ConnectedAccount[] = [];
    for (const provider of ALL_PROVIDERS) {
      const account = await this.loadAccount(provider);
      if (account) out.push(account);
    }
    return out;
  }

  /**
   * The words for a secret store this computer could not read, when that is why
   * a connection reads as absent (it is then unknown, never "not connected"), or null.
   */
  async storeUnreadable(): Promise<string | null> {
    return (await this.secrets.unreadable?.(tokenKey('microsoft'))) ?? null;
  }

  /** The honest connection state, from the marker + stored set + clock. */
  async connectionState(provider: CalendarProviderId): Promise<ConnectionState> {
    if (provider === 'google') {
      // The refresh token is the connection; the access token is this process's copy.
      const refreshToken = await readGoogleGrant((key) => this.secrets.get(key));
      if (refreshToken === null) return (await this.storeUnreadable()) ? 'unreadable' : 'disconnected';
      return refusedGoogleGrants.has(refreshToken) ? 'reconnect-needed' : 'connected';
    }
    if (await this.secrets.get(statusKey(provider))) return 'reconnect-needed';
    const tokens = await this.load(provider);
    if (!tokens) return (await this.storeUnreadable()) ? 'unreadable' : 'disconnected';
    if (typeof tokens.expiresAt !== 'number') return 'connected';
    if (this.clock() < tokens.expiresAt - this.leewayMs) return 'connected';
    return tokens.refreshToken ? 'refresh-due' : 'reconnect-needed';
  }

  /**
   * Return a usable access token, refreshing first when it is due. On a refresh
   * failure this records that the account needs reconnecting and throws
   * TokenRefreshError, never returns a stale/invalid token as if it were good.
   */
  async getFreshAccessToken(
    provider: CalendarProviderId,
    config: ResolvedClientConfig,
    fetchImpl: HttpFetch,
  ): Promise<string> {
    const tokens = await this.load(provider);
    // A store this computer could not read is said as such, never as "not connected".
    const unreadable = tokens ? null : await this.storeUnreadable();
    if (unreadable) throw new TokenRefreshError(provider, unreadable);
    if (!tokens) throw new TokenRefreshError(provider, `No ${provider} account is connected.`);
    if (provider === 'google' && tokens.refreshToken && refusedGoogleGrants.has(tokens.refreshToken)) {
      throw new TokenRefreshError(provider, 'Google refused this connection earlier. Connect Google again with "connect" on the Google tab of Mail, calendar and channels.');
    }
    const due = typeof tokens.expiresAt === 'number' && this.clock() >= tokens.expiresAt - this.leewayMs;
    if (!due) return tokens.accessToken;
    if (!tokens.refreshToken) {
      await this.markReconnectNeeded(provider);
      throw new TokenRefreshError(provider, `The ${provider} access token expired and no refresh token is stored.`);
    }
    // Single-flight: a refresh already in progress for this provider serves every
    // concurrent caller instead of each racing the provider with the same (possibly
    // about-to-be-rotated) refresh token.
    const existing = this.inflightRefresh.get(provider);
    if (existing) return existing;
    const refreshToken = tokens.refreshToken;
    const generation = this.generations.get(provider) ?? 0;
    const inFlight = this.performRefresh(provider, config, fetchImpl, refreshToken, generation)
      .finally(() => {
        if (this.inflightRefresh.get(provider) === inFlight) this.inflightRefresh.delete(provider);
      });
    this.inflightRefresh.set(provider, inFlight);
    return inFlight;
  }

  private async performRefresh(
    provider: CalendarProviderId,
    config: ResolvedClientConfig,
    fetchImpl: HttpFetch,
    refreshToken: string,
    generation: number,
  ): Promise<string> {
    let refreshed: StoredTokenSet;
    try {
      refreshed = await refreshAccessToken(config, fetchImpl, refreshToken, this.clock());
    } catch (error) {
      // Only an answer from the provider that refuses the grant means the owner
      // has to reconnect. A dropped connection or a 5xx says nothing about the
      // grant, and the next call retries on its own.
      if (error instanceof OAuthFlowError && isGrantRejection(error)) {
        if (provider === 'google') refusedGoogleGrants.add(refreshToken);
        else await this.markReconnectNeeded(provider);
      }
      const detail = error instanceof OAuthFlowError ? error.message : String(error);
      throw new TokenRefreshError(provider, `Refreshing the ${provider} token failed: ${detail}`);
    }
    if ((this.generations.get(provider) ?? 0) !== generation) {
      throw new TokenRefreshError(provider, `The ${provider} account was connected again or disconnected while its token was refreshing.`);
    }
    if (provider === 'google') return this.keepGoogleRefresh(refreshToken, refreshed, generation);
    // The rotated token set goes first: it is the only copy of a refresh token
    // the provider has already invalidated the old one for.
    const account = (await this.loadAccount(provider)) ?? syntheticAccount(provider, refreshed.scopes ?? [], refreshed.obtainedAt);
    // Checked again after the read: a save or disconnect during it supersedes this refresh.
    if ((this.generations.get(provider) ?? 0) !== generation) {
      throw new TokenRefreshError(provider, `The ${provider} account was connected again or disconnected while its token was refreshing.`);
    }
    await this.secrets.set(tokenKey(provider), JSON.stringify({ ...refreshed, account } satisfies StoredConnection));
    await this.secrets.delete(statusKey(provider));
    return refreshed.accessToken;
  }

  /**
   * A Google refresh: the access token stays in memory. Google keeps the
   * refresh token on refresh; when it does send a new one, that becomes the
   * stored connection, with the account record moved onto it.
   */
  private async keepGoogleRefresh(previous: string, refreshed: StoredTokenSet, generation: number): Promise<string> {
    const current = refreshed.refreshToken ?? previous;
    if (current !== previous) {
      const account = await readGoogleAccount((key) => this.secrets.get(key), previous);
      if ((this.generations.get('google') ?? 0) !== generation) {
        throw new TokenRefreshError('google', 'The google account was connected again or disconnected while its token was refreshing.');
      }
      await this.secrets.set(GOOGLE_GRANT_KEY, current);
      await this.secrets.set(GOOGLE_ACCOUNT_KEY, JSON.stringify({ account, grant: await grantDigest(current) } satisfies GoogleAccountRecord));
      googleAccessTokens.delete(previous);
    }
    googleAccessTokens.set(current, refreshed);
    return refreshed.accessToken;
  }

  /**
   * Disconnect a provider: revoke the token at the provider when possible, then
   * delete every stored key. Returns whether the provider-side revocation succeeded
   * (false for providers without a revocation endpoint, disconnect is still local).
   * For Google this ends the one Google connection: calendar and mail alike.
   */
  async disconnect(
    provider: CalendarProviderId,
    config: ResolvedClientConfig,
    fetchImpl: HttpFetch,
  ): Promise<{ readonly revokedRemotely: boolean }> {
    this.generations.set(provider, (this.generations.get(provider) ?? 0) + 1);
    this.inflightRefresh.delete(provider);
    const tokens = await this.load(provider);
    let revokedRemotely = false;
    if (tokens) {
      revokedRemotely = await revokeToken(config, fetchImpl, tokens.refreshToken ?? tokens.accessToken);
    }
    if (provider === 'google') {
      if (tokens?.refreshToken) {
        googleAccessTokens.delete(tokens.refreshToken);
        refusedGoogleGrants.delete(tokens.refreshToken);
      }
      await this.secrets.delete(GOOGLE_GRANT_KEY);
      await this.secrets.delete(GOOGLE_ACCOUNT_KEY);
    }
    await this.secrets.delete(tokenKey(provider));
    await this.secrets.delete(statusKey(provider));
    return { revokedRemotely };
  }

  /**
   * Stamp the durable reconnect-needed marker, UNLESS a valid (non-expired) token
   * set already exists. A refresh can fail here while a concurrent winner (this
   * instance's own single-flight already prevents an in-process race, but a
   * separate process/instance sharing the same secret store is not covered by
   * that) has already stored a fresh, working token set for the same provider.
   * Re-reading state immediately before writing the marker means a genuinely
   * working account is never overwritten with a false "reconnect needed".
   */
  private async markReconnectNeeded(provider: CalendarProviderId): Promise<void> {
    const current = await this.load(provider);
    if (current) {
      const stillValid = typeof current.expiresAt !== 'number' || this.clock() < current.expiresAt - this.leewayMs;
      if (stillValid) return;
    }
    await this.secrets.set(statusKey(provider), 'reconnect-needed');
  }
}

/** The one record a connection is kept in: its token set and the account it belongs to, written together. */
interface StoredConnection extends StoredTokenSet {
  readonly account?: ConnectedAccount | undefined;
}

/** A Google connection 3.4.4 kept under `calendar.google.tokens`, as read at the carry. */
interface PreviousGoogleConnection extends StoredConnection {
  /** Set by the carry when another account already held the one Google connection: kept, not read. */
  readonly setAside?: true;
}

/** What the carry did, for the daemon's log line. Never carries a token. */
export type GoogleCarryOutcome =
  /** No earlier Google connection (or one already set aside). */
  | 'nothing'
  /** The earlier connection is now the one Google connection. */
  | 'moved'
  /** The one Google connection already held the same grant; the earlier record was removed. */
  | 'same-grant'
  /** Another grant already held the one Google connection; the earlier one is kept, unused, and the owner told. */
  | 'set-aside';

/**
 * Move a Google connection `/calendar connect google` stored up to 3.4.4
 * (`calendar.google.tokens`, with 3.3.1's account under its own key) into the
 * one Google connection, once. Run by the daemon at start.
 *
 * - Nothing in the one place: the refresh token is written there and read back,
 *   the account record is written beside it, and only then are the earlier keys
 *   removed. A failed write or read-back throws with the earlier record intact,
 *   so the next start tries again.
 * - The same refresh token already there: the account record is written and the
 *   earlier keys removed.
 * - Another refresh token already there (another account, or the same account
 *   signed in twice): the one already there stays, because the daemon's mail
 *   and calendar have been using it, and switching them to another account
 *   unasked would be worse than asking. The earlier record is kept as it was,
 *   marked set aside so it is not looked at again, and the owner is told which
 *   account each was and how to choose the other. Nothing is discarded; the
 *   set-aside record is removed when Google is next connected or disconnected
 *   with `/calendar`.
 *
 * `daemonAccountHint` names the account the daemon already used when no account
 * record says so (the mailbox address in settings).
 */
export async function carryGoogleCalendarConnectionForward(
  secrets: SecretStoreSlice,
  options: { readonly daemonAccountHint?: string | null | undefined } = {},
): Promise<GoogleCarryOutcome> {
  const previousKey = tokenKey('google');
  const raw = await secrets.get(previousKey);
  if (!raw) return 'nothing';
  let previous: PreviousGoogleConnection | null;
  try {
    previous = JSON.parse(raw) as PreviousGoogleConnection | null;
  } catch {
    return 'nothing';
  }
  if (!previous || typeof previous !== 'object' || previous.setAside === true) return 'nothing';
  const refreshToken = typeof previous.refreshToken === 'string' ? previous.refreshToken.trim() : '';
  // A record with no refresh token was never a lasting connection: its access token has long expired.
  if (refreshToken.length === 0) return 'nothing';
  const account = previous.account
    ?? parseAccount(await secrets.get(previousAccountKey('google')))
    ?? syntheticAccount('google', previous.scopes ?? [], typeof previous.obtainedAt === 'number' ? previous.obtainedAt : 0);

  const current = await readGoogleGrant((key) => secrets.get(key));
  if (current !== null && current !== refreshToken) {
    await secrets.set(previousKey, JSON.stringify({ ...previous, account, setAside: true } satisfies PreviousGoogleConnection));
    await secrets.delete(previousAccountKey('google'));
    const held = await readGoogleAccountRecord((key) => secrets.get(key), current);
    const heldLabel = held?.label ?? (options.daemonAccountHint?.trim() || '');
    const sameAccount = heldLabel.length > 0 && heldLabel.toLowerCase() === account.label.toLowerCase();
    noteCarriedForwardChange(sameAccount
      ? `The Google account ${account.label} was connected twice: once by the Agent's calendar of an earlier version and once for the daemon's calendar and mail. The daemon's connection is now the one Google connection for calendar, mail and the Agent; the other is kept unused until Google is connected again.`
      : `Two Google accounts were connected: ${account.label} by the Agent's calendar of an earlier version, and ${heldLabel || 'the account the daemon\'s calendar and mail use'} for the daemon. `
        + `${heldLabel || 'The daemon\'s account'} stays the one Google connection for calendar, mail and the Agent; ${account.label} is kept unused until Google is connected again. `
        + `To use ${account.label} everywhere instead, disconnect Google on the Google tab of Mail, calendar and channels, then "connect" there and sign in as it.`);
    return 'set-aside';
  }
  if (current === null) {
    await secrets.set(GOOGLE_GRANT_KEY, refreshToken);
    if ((await readGoogleGrant((key) => secrets.get(key))) !== refreshToken) {
      throw new Error('The Google connection did not read back from the secret store after it was written; the earlier record is kept and the move is tried again at the next start.');
    }
  }
  await secrets.set(GOOGLE_ACCOUNT_KEY, JSON.stringify({ account, grant: await grantDigest(refreshToken) } satisfies GoogleAccountRecord));
  await secrets.delete(previousKey);
  await secrets.delete(statusKey('google'));
  await secrets.delete(previousAccountKey('google'));
  noteCarriedForward('Google connection');
  return current === null ? 'moved' : 'same-grant';
}
