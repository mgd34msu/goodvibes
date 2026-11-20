/**
 * oauth-token-store.ts, token persistence + honest lifecycle over the injected
 * secret store. Tokens (access + refresh) live ONLY in the secret store, never in
 * plain config and never echoed. The store computes an honest connection state from
 * the stored set + the clock, auto-refreshes when the access token is due, and, when
 * a refresh fails, records a durable `reconnect-needed` marker so every later read is
 * honest about the account being broken until the user reconnects.
 */

import { OAuthFlowError, refreshAccessToken, revokeToken } from './oauth-flow.js';
import { daemonSecretKeyFor } from '../config/daemon-secret-keys.js';
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
 * The three key names, DERIVED rather than spelled out.
 *
 * They used to be built by hand as `GOODVIBES_CALENDAR_<PROVIDER>_TOKENS`. The
 * string was right, and being right by coincidence was the problem: nothing
 * connected it to a daemon-owned config path, so the routing did not recognise
 * it as daemon-owned and a refresh token for a calendar the DAEMON polls on a
 * schedule was filed in whichever surface silo ran `/calendar connect`. The
 * connector's own client secret was daemon-owned by derivation, so the two
 * halves of one connection lived in different tiers.
 *
 * `daemonSecretKeyFor` produces the identical string and, unlike a template
 * literal, makes the credential daemon-owned by construction, the same call
 * the Google connector's key set already uses.
 */
function tokenKey(provider: CalendarProviderId): string {
  return daemonSecretKeyFor(`calendar.${provider}.tokens`);
}
function statusKey(provider: CalendarProviderId): string {
  return daemonSecretKeyFor(`calendar.${provider}.status`);
}

const ALL_PROVIDERS: readonly CalendarProviderId[] = ['google', 'microsoft'];

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
   * Bumped by `disconnect`. A refresh that was already on the wire when the
   * owner disconnected must not write its result back and so reconnect an
   * account the owner just removed.
   */
  private readonly generations = new Map<CalendarProviderId, number>();

  constructor(options: CalendarTokenStoreOptions) {
    this.secrets = options.secrets;
    this.clock = options.clock ?? (() => Date.now());
    this.leewayMs = options.refreshLeewayMs ?? DEFAULT_REFRESH_LEEWAY_MS;
  }

  /**
   * Persist a fresh token set + account metadata; clears any reconnect marker.
   * The account is kept inside the token record, so one write publishes both:
   * a failed write leaves the earlier connection whole (its token with its own
   * account), never new account details beside an old credential or an account
   * listed with no token.
   */
  async save(provider: CalendarProviderId, tokens: StoredTokenSet, account: ConnectedAccount): Promise<void> {
    await this.secrets.set(tokenKey(provider), JSON.stringify({ ...tokens, account } satisfies StoredConnection));
    await this.secrets.delete(statusKey(provider));
  }

  /** The stored token record (token set and its account), or null when there is none or it cannot be read. */
  private async loadConnection(provider: CalendarProviderId): Promise<StoredConnection | null> {
    const raw = await this.secrets.get(tokenKey(provider));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as StoredConnection;
      return parsed && typeof parsed === 'object' && typeof parsed.accessToken === 'string' ? parsed : null;
    } catch {
      return null;
    }
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
    return (await this.loadConnection(provider))?.account ?? null;
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

  /** The honest connection state, from the marker + stored set + clock. */
  async connectionState(provider: CalendarProviderId): Promise<ConnectionState> {
    if (await this.secrets.get(statusKey(provider))) return 'reconnect-needed';
    const tokens = await this.load(provider);
    if (!tokens) return 'disconnected';
    if (typeof tokens.expiresAt !== 'number') return 'connected';
    if (this.clock() < tokens.expiresAt - this.leewayMs) return 'connected';
    return tokens.refreshToken ? 'refresh-due' : 'reconnect-needed';
  }

  /**
   * Return a usable access token, refreshing first when it is due. On a refresh
   * failure this records a durable reconnect-needed marker and throws
   * TokenRefreshError, never returns a stale/invalid token as if it were good.
   */
  async getFreshAccessToken(
    provider: CalendarProviderId,
    config: ResolvedClientConfig,
    fetchImpl: HttpFetch,
  ): Promise<string> {
    const tokens = await this.load(provider);
    if (!tokens) throw new TokenRefreshError(provider, `No ${provider} account is connected.`);
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
        await this.markReconnectNeeded(provider);
      }
      const detail = error instanceof OAuthFlowError ? error.message : String(error);
      throw new TokenRefreshError(provider, `Refreshing the ${provider} token failed: ${detail}`);
    }
    if ((this.generations.get(provider) ?? 0) !== generation) {
      throw new TokenRefreshError(provider, `The ${provider} account was disconnected while its token was refreshing.`);
    }
    // The rotated token set goes first: it is the only copy of a refresh token
    // the provider has already invalidated the old one for.
    const account = (await this.loadAccount(provider)) ?? this.syntheticAccount(provider, refreshed);
    await this.secrets.set(tokenKey(provider), JSON.stringify({ ...refreshed, account } satisfies StoredConnection));
    await this.secrets.delete(statusKey(provider));
    return refreshed.accessToken;
  }

  /**
   * Disconnect a provider: revoke the token at the provider when possible, then
   * delete every stored key. Returns whether the provider-side revocation succeeded
   * (false for providers without a revocation endpoint, disconnect is still local).
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

  private syntheticAccount(provider: CalendarProviderId, tokens: StoredTokenSet): ConnectedAccount {
    return {
      provider,
      accountId: provider,
      label: provider === 'google' ? 'Google Calendar' : 'Microsoft Outlook',
      scopes: tokens.scopes ?? [],
      connectedAt: tokens.obtainedAt,
    };
  }
}

/** The one record a connection is kept in: its token set and the account it belongs to, written together. */
interface StoredConnection extends StoredTokenSet {
  readonly account?: ConnectedAccount | undefined;
}
