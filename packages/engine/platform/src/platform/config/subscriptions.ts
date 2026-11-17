import { assertSecurityReadSource, fileIdentity } from '../security/read-source.js';
import { readJsonFileOrQuarantine, writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { logger } from '../utils/logger.js';
import { withSyncFileLock } from './sync-file-lock.js';
import { summarizeError } from '../utils/error-display.js';
import { captureStrictJudgmentJson } from '../gate/judgment-result.js';
import { observeImportFile, assertImportFileCurrent, type ImportFileObservation, type PreparedImportTransitionFacts } from './prepared-import.js';
import type { PreparedConfigMutationReceipt } from './prepared-mutation.js';
import {
  buildOAuthAuthorizationStart,
  createOAuthState,
  createPkceVerifier,
  exchangeOAuthAuthorizationCode,
  OAuthTokenExchangeError,
  parseOAuthScopes,
  refreshOAuthAccessToken,
} from '../runtime/auth/oauth-core.js';

/**
 * The shared tier's directory name under `~/.goodvibes/`, the same
 * surface-root-independent convention used by the config shared tier
 * (shared-config-tier.ts), the canonical memory store (canonical-memory.ts),
 * and the workspace register (shared-register-path.ts). Kept as a local
 * literal rather than an import from any of those: it is a stable, one-word
 * directory name, not a coupling any of those modules were built to share.
 */
const SUBSCRIPTIONS_SHARED_TIER_DIRECTORY = 'shared';
const SUBSCRIPTIONS_FILE_NAME = 'subscriptions.json';

/** The slice of ShellPathService {@link sharedSubscriptionsPath} needs. */
export interface SubscriptionShellPaths {
  resolveUserPath(...segments: string[]): string;
}

/**
 * Where provider subscriptions (OAuth sessions for providers like
 * 'openai-subscriber') live: `~/.goodvibes/shared/subscriptions.json`, one
 * file read and written by every surface on the machine, the daemon, the
 * TUI, the agent.
 *
 * A login is one event; every surface that later needs the token must see
 * it. Before this, each surface constructed its own `SubscriptionManager`
 * against `~/.goodvibes/<surfaceRoot>/subscriptions.json`, so a login
 * completed in the TUI was invisible to the daemon that actually hosts
 * conversation turns, the daemon kept refreshing whatever it already had
 * (or nothing), and a successful login changed nothing from its point of
 * view.
 */
export function sharedSubscriptionsPath(shellPaths: SubscriptionShellPaths): string {
  return shellPaths.resolveUserPath(SUBSCRIPTIONS_SHARED_TIER_DIRECTORY, SUBSCRIPTIONS_FILE_NAME);
}

export interface OAuthProviderConfig {
  readonly authUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly manualRedirectUri?: string | undefined;
  readonly scopes?: readonly string[] | undefined;
  readonly audience?: string | undefined;
  readonly usePkce?: boolean | undefined;
  readonly authParams?: Readonly<Record<string, string>> | undefined;
  readonly tokenRequestEncoding?: 'form' | 'json' | undefined;
  readonly includeStateInTokenRequest?: boolean | undefined;
  readonly tokenRequestExtras?: Readonly<Record<string, string | number | boolean>> | undefined;
  readonly refreshRequestEncoding?: 'form' | 'json' | undefined;
  readonly refreshRequestExtras?: Readonly<Record<string, string | number | boolean>> | undefined;
  readonly refreshScopes?: readonly string[] | undefined;
  readonly overrideAmbientApiKeys?: boolean | undefined;
  readonly localCallback?: {
    readonly host?: string | undefined;
    readonly port?: number | undefined;
    readonly path?: string | undefined;
    readonly autoComplete?: boolean | undefined;
  };
}

export interface PendingSubscriptionLogin {
  readonly provider: string;
  readonly state: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly createdAt: number;
}

export interface ProviderSubscription {
  readonly provider: string;
  readonly accessToken: string;
  readonly refreshToken?: string | undefined;
  readonly tokenType: string;
  readonly expiresAt?: number | undefined;
  readonly scopes?: readonly string[] | undefined;
  readonly authMode: 'oauth';
  readonly overrideAmbientApiKeys: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  /**
   * Set when the authorization server REFUSED this session's grant (an
   * answered 4xx on refresh): the session is over regardless of what
   * `expiresAt` says, and every surface must show it as signed-out instead
   * of deriving "healthy" from the timestamp. Cleared by a successful
   * refresh; a completed login replaces the whole record.
   */
  readonly revokedAt?: number | undefined;
  /**
   * Set while one process is spending this record's refresh token. Another
   * process that needs a fresh token waits for the answer to land instead of
   * sending the same refresh token, which the provider has rotated by then.
   * Cleared by the refresh's own write; a holder that died lets it lapse.
   */
  readonly refreshingUntil?: number | undefined;
}

/**
 * The provider refused this sign-in's grant (or there is nothing left to renew
 * it with): the session is over and only a new sign-in replaces it.
 */
export class SubscriptionSessionEndedError extends Error {
  readonly code = 'SUBSCRIPTION_SESSION_ENDED';
  constructor(readonly provider: string, options?: { readonly cause?: unknown }) {
    super(`The ${provider} sign-in has ended: the provider refused to renew it. Sign in again with /subscription login ${provider} start.`, options);
    this.name = 'SubscriptionSessionEndedError';
  }
}

/**
 * How long a refresh holds its claim on a record: the token exchange's own
 * bound (30 s in oauth-core) plus a margin, so a claim outlives the request it
 * covers and lapses soon after a holder that died.
 */
const REFRESH_LEASE_MS = 35_000;
const LEASE_POLL_FIRST_MS = 25;
const LEASE_POLL_MAX_MS = 500;

function sameGrant(a: Pick<ProviderSubscription, 'accessToken' | 'refreshToken'>, b: Pick<ProviderSubscription, 'accessToken' | 'refreshToken'>): boolean {
  return a.accessToken === b.accessToken && a.refreshToken === b.refreshToken;
}

function withoutRefreshState(record: ProviderSubscription): ProviderSubscription {
  const { refreshingUntil: _lease, revokedAt: _revoked, ...rest } = record;
  return rest;
}

/** Whether a failed token exchange is the authorization server refusing the grant itself. */
function grantRefused(error: OAuthTokenExchangeError): boolean {
  if (error.status !== 400 && error.status !== 401 && error.status !== 403) return false;
  return error.oauthError === undefined || error.oauthError === 'invalid_grant';
}

function signedOutDuringRefresh(provider: string): Error {
  return new Error(`No stored OAuth subscription for ${provider}: it was signed out while its token was being refreshed.`);
}

type RefreshClaim =
  | { readonly kind: 'settled'; readonly record: ProviderSubscription }
  | { readonly kind: 'claimed'; readonly record: ProviderSubscription }
  | { readonly kind: 'leased'; readonly record: ProviderSubscription; readonly until: number };
type RefreshWrite =
  | { readonly kind: 'saved' | 'newer'; readonly record: ProviderSubscription }
  | { readonly kind: 'gone' };
type FailedRefreshSettlement =
  | { readonly kind: 'released' | 'gone' }
  | { readonly kind: 'newer'; readonly record: ProviderSubscription };

interface SubscriptionStore {
  readonly version: 1;
  readonly subscriptions: Record<string, ProviderSubscription>;
  readonly pending: Record<string, PendingSubscriptionLogin>;
}

declare const subscriptionImportBrand: unique symbol;
declare const subscriptionImportTransitionBrand: unique symbol;
export interface PreparedSubscriptionImport { readonly [subscriptionImportBrand]: true }
export interface PreparedSubscriptionImportTransition { readonly [subscriptionImportTransitionBrand]: true }
export type SubscriptionImportEntry =
  | { readonly kind: 'active'; readonly value: ProviderSubscription }
  | { readonly kind: 'pending'; readonly value: PendingSubscriptionLogin };
export interface PreparedSubscriptionImportFacts {
  readonly operation: 'import';
  readonly beforeGeneration: number;
  readonly items: readonly { readonly provider: string; readonly kind: 'active' | 'pending'; readonly configured: true }[];
  readonly destinations: readonly { readonly path: string; readonly operation: 'set'; readonly tier: 'shared' }[];
}
interface SubscriptionImportRecord {
  readonly facts: PreparedSubscriptionImportFacts;
  readonly store: SubscriptionStore;
  readonly methods: readonly unknown[];
  observation: ImportFileObservation;
  phase: 'prepared' | 'pending' | 'committing' | 'committed' | 'failed';
  transition?: PreparedSubscriptionImportTransition;
}

/**
 * How long a started re-login waits for its browser round trip. A re-login
 * abandoned past this, for a provider that still has a working subscription,
 * is no longer reported as pending, so it stops masking that subscription;
 * completing it means starting the login again.
 */
const PENDING_LOGIN_TTL_MS = 30 * 60_000;

function livePending(store: SubscriptionStore, provider: string, now = Date.now()): PendingSubscriptionLogin | null {
  const pending = store.pending[provider];
  if (!pending) return null;
  const abandoned = Number.isFinite(pending.createdAt) && now - pending.createdAt >= PENDING_LOGIN_TTL_MS;
  return abandoned && store.subscriptions[provider] ? null : pending;
}

function isSubscriptionExpired(expiresAt?: number, bufferMs = 60_000): boolean {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return false;
  return Date.now() + bufferMs >= expiresAt;
}

/** What a stored subscription is worth now, for every surface that shows one. */
export type SubscriptionState = 'active' | 'expiring' | 'expired' | 'revoked';

/** Within this long of `expiresAt`, a session that cannot refresh itself is shown as expiring. */
export const SUBSCRIPTION_EXPIRING_SOON_MS = 24 * 60 * 60 * 1000;

/**
 * The one statement of a subscription's state. `revoked`: the provider refused
 * the grant, so the session is over whatever `expiresAt` says. A session with a
 * refresh token renews itself on its next use, so its access token's expiry
 * is not shown. Without one: `expired` once `expiresAt` has passed, `expiring`
 * within {@link SUBSCRIPTION_EXPIRING_SOON_MS} of it. `revoked` and `expired`
 * need a new sign-in.
 */
export function subscriptionState(record: Pick<ProviderSubscription, 'expiresAt' | 'refreshToken' | 'revokedAt'>, now = Date.now()): SubscriptionState {
  if (record.revokedAt !== undefined) return 'revoked';
  if (record.refreshToken || typeof record.expiresAt !== 'number' || !Number.isFinite(record.expiresAt)) return 'active';
  if (record.expiresAt <= now) return 'expired';
  return record.expiresAt - now <= SUBSCRIPTION_EXPIRING_SOON_MS ? 'expiring' : 'active';
}

/**
 * The same state as a provider auth route's freshness, which is what the
 * token resolver acts on: a session the provider ended (`revoked`) or that
 * lapsed with no refresh token is `expired`; a lapsed access token with a
 * refresh token is renewed on the next request, so it is `healthy`.
 */
export function subscriptionAuthFreshness(record: Pick<ProviderSubscription, 'expiresAt' | 'refreshToken' | 'revokedAt'>, now = Date.now()): 'healthy' | 'expiring' | 'expired' {
  const state = subscriptionState(record, now);
  return state === 'revoked' || state === 'expired' ? 'expired' : state === 'expiring' ? 'expiring' : 'healthy';
}

/** A check that the subscription store did not change while a status read ran. */
export function captureSubscriptionReadSource(owner: SubscriptionManager): () => void {
  return owner.captureReadSource();
}

/**
 * SubscriptionManager, OAuth flows for **provider subscriptions**.
 *
 * Manages OAuth-based subscriptions to external AI providers (OpenAI,
 * Anthropic, Gemini, etc.) including authorization URL generation, code
 * exchange, token refresh, and persisting credentials to disk.
 *
 * This class handles provider-subscription OAuth on behalf of the daemon.
 * For OAuth flows that authenticate the platform client with the goodvibes daemon
 * itself, see {@link OAuthClient} in `../runtime/auth/oauth-client.ts`.
 *
 * @see OAuthClient, OAuth flows for daemon authentication.
 */
export class SubscriptionManager {
  /**
   * A check that the store did not change while a status read ran: this
   * owner's write generation, and one `stat` of the file for a write by
   * another process (the daemon and both terminal apps share it).
   */
  captureReadSource(): () => void {
    const generation = this.importGeneration, identity = fileIdentity(this.path);
    return () => assertSecurityReadSource(this.importGeneration === generation && fileIdentity(this.path) === identity, 'subscription store');
  }
  private readonly path: string;
  private importGeneration = 0;
  /** One token refresh per provider at a time in this process; across processes the record's claim does the same. */
  private readonly refreshes = new Map<string, Promise<ProviderSubscription>>();
  private readonly preparedImports = new WeakMap<PreparedSubscriptionImport, SubscriptionImportRecord>();

  /** Capture privately without invoking legacy recovery or publishing any token. */
  prepareImport(entries: readonly SubscriptionImportEntry[]): PreparedSubscriptionImport {
    try { return this.prepareImportOwned(entries); }
    catch { throw new Error('Subscription import is unavailable.'); }
  }
  private prepareImportOwned(entries: readonly SubscriptionImportEntry[]): PreparedSubscriptionImport {
    const values = captureStrictJudgmentJson(entries);
    if (!values.length || new Set(values.map(entry => `${entry.kind}:${entry.value.provider}`)).size !== values.length) throw new Error('Invalid subscription import.');
    for (const entry of values) {
      const value = entry.value;
      if (!value || typeof value.provider !== 'string' || !value.provider || !Number.isSafeInteger(value.createdAt)
        || (entry.kind === 'active' ? !('accessToken' in value) || typeof value.accessToken !== 'string' || !('tokenType' in value) || typeof value.tokenType !== 'string' || !('authMode' in value) || value.authMode !== 'oauth'
          || !('overrideAmbientApiKeys' in value) || typeof value.overrideAmbientApiKeys !== 'boolean' || !('updatedAt' in value) || !Number.isSafeInteger(value.updatedAt)
          : entry.kind !== 'pending' || !('state' in value) || typeof value.state !== 'string' || !('verifier' in value) || typeof value.verifier !== 'string' || !('redirectUri' in value) || typeof value.redirectUri !== 'string')) throw new Error('Invalid subscription import.');
    }
    const observation = observeImportFile(this.path);
    const parsed: unknown = observation.raw === null ? { version: 1, subscriptions: {}, pending: {} } : JSON.parse(observation.raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('version' in parsed) || parsed.version !== 1 || !('subscriptions' in parsed) || !('pending' in parsed)
      || !parsed.subscriptions || typeof parsed.subscriptions !== 'object' || Array.isArray(parsed.subscriptions)
      || !parsed.pending || typeof parsed.pending !== 'object' || Array.isArray(parsed.pending)) throw new Error('Subscription store is unavailable.');
    const store = captureStrictJudgmentJson(parsed) as SubscriptionStore;
    const subscriptions = { ...store.subscriptions }, pending = { ...store.pending };
    for (const entry of values) {
      if (entry.kind === 'active') { Object.defineProperty(subscriptions, entry.value.provider, { value: entry.value, enumerable: true, writable: true, configurable: true }); delete pending[entry.value.provider]; }
      else Object.defineProperty(pending, entry.value.provider, { value: entry.value, enumerable: true, writable: true, configurable: true });
    }
    const handle = Object.freeze({}) as PreparedSubscriptionImport;
    const facts: PreparedSubscriptionImportFacts = Object.freeze({ operation: 'import', beforeGeneration: this.importGeneration,
      items: Object.freeze(values.map(entry => Object.freeze({ provider: entry.value.provider, kind: entry.kind, configured: true as const }))),
      destinations: Object.freeze([Object.freeze({ path: this.path, operation: 'set' as const, tier: 'shared' as const })]) });
    this.preparedImports.set(handle, { facts, store: captureStrictJudgmentJson({ ...store, subscriptions, pending }), observation,
      methods: [this.get, this.getPending, this.saveSubscription, this.savePending], phase: 'prepared' });
    this.assertPreparedImport(handle); return handle;
  }
  inspectPreparedImport(handle: PreparedSubscriptionImport): PreparedSubscriptionImportFacts {
    const record = this.preparedImports.get(handle); if (!record) throw new Error('Subscription import is not authentic.'); return record.facts;
  }
  private assertImportRecord(record: SubscriptionImportRecord, generation: number): void {
    if (this.importGeneration !== generation || this.path !== record.facts.destinations[0]?.path
      || [this.get, this.getPending, this.saveSubscription, this.savePending].some((method, index) => method !== record.methods[index])) throw new Error('Subscription import owner changed.');
    assertImportFileCurrent(this.path, record.observation);
  }
  assertPreparedImport(handle: PreparedSubscriptionImport): void {
    const record = this.preparedImports.get(handle);
    if (!record || record.phase !== 'prepared') throw new Error('Subscription import is unavailable.');
    this.assertImportRecord(record, record.facts.beforeGeneration);
  }
  beginPreparedImport(handle: PreparedSubscriptionImport): PreparedSubscriptionImportTransition {
    this.assertPreparedImport(handle); const record = this.preparedImports.get(handle)!;
    const transition = Object.freeze({}) as PreparedSubscriptionImportTransition;
    record.phase = 'pending'; record.transition = transition; this.importGeneration++;
    this.assertPreparedImportTransition(handle, transition); return transition;
  }
  inspectPreparedImportTransition(handle: PreparedSubscriptionImport, transition: PreparedSubscriptionImportTransition): PreparedImportTransitionFacts {
    this.assertPreparedImportTransition(handle, transition); const record = this.preparedImports.get(handle)!;
    return Object.freeze({ beforeGeneration: record.facts.beforeGeneration, afterGeneration: this.importGeneration, phase: record.phase === 'committed' ? 'committed' : 'pending' });
  }
  assertPreparedImportTransition(handle: PreparedSubscriptionImport, transition: PreparedSubscriptionImportTransition): void {
    const record = this.preparedImports.get(handle);
    if (!record || record.transition !== transition || !['pending', 'committing', 'committed'].includes(record.phase)) throw new Error('Subscription import transition is not authentic.');
    this.assertImportRecord(record, record.facts.beforeGeneration + (record.phase === 'committed' ? 2 : 1));
  }
  finishPreparedImport(handle: PreparedSubscriptionImport, transition: PreparedSubscriptionImportTransition, beforeEffect: () => void): PreparedConfigMutationReceipt {
    const record = this.preparedImports.get(handle);
    if (!record || record.phase !== 'pending' || record.transition !== transition) throw new Error('Subscription import is spent.');
    record.phase = 'committing';
    const completedPaths: string[] = [];
    try {
      const current = () => { beforeEffect(); this.assertPreparedImportTransition(handle, transition); };
      current();
      writeJsonFileAtomic(this.path, record.store, { mode: 0o600, cleanupStaleTemps: false, assertCurrent: current });
      completedPaths.push(this.path); record.observation = observeImportFile(this.path); record.phase = 'committed';
    } catch { record.phase = 'failed'; }
    finally { this.importGeneration++; }
    return Object.freeze({ status: record.phase === 'committed' ? 'committed' : completedPaths.length ? 'partial' : 'unknown', completedPaths: Object.freeze(completedPaths),
      ...(record.phase === 'failed' ? { uncertainPath: this.path } : {}) });
  }
  assertCompletedImport(handle: PreparedSubscriptionImport): void {
    const record = this.preparedImports.get(handle);
    if (!record || record.phase !== 'committed') throw new Error('Subscription import did not commit.');
    this.assertImportRecord(record, record.facts.beforeGeneration + 2);
  }

  public constructor(path: string) {
    this.path = path;
  }

  /**
   * Read the subscription store, never throwing.
   *
   * Corrupt content is quarantined (moved aside with a `.why` receipt and
   * logged at error level) instead of being silently discarded the way the
   * bare `catch` here used to discard it, the caller still gets the same
   * empty store, but the evidence of what went wrong survives on disk. A read
   * failure that leaves nothing to quarantine (permissions) also degrades to
   * the empty store, preserving this method's never-throws contract.
   */
  private read(): SubscriptionStore {
    try {
      return this.readStrict();
    } catch {
      return { version: 1, subscriptions: {}, pending: {} };
    }
  }

  /**
   * The store as a writer must see it: absent or quarantined-corrupt reads as
   * empty, but a failure to read an existing file (permissions, I/O) throws.
   * A writer that treated that as empty would rewrite the file holding only its
   * own change and erase every other provider's saved session.
   */
  private readStrict(): SubscriptionStore {
    const empty: SubscriptionStore = { version: 1, subscriptions: {}, pending: {} };
    return (
      readJsonFileOrQuarantine<SubscriptionStore>(this.path, {
        label: 'config/subscriptions',
        // The sign-in tokens are kept in this file, so the note must say they are gone from use and still on disk.
        recovery:
          'Every provider subscription sign-in was kept in this file, so each provider is signed out until you sign in again '
          + '(/subscription login <provider> start). The copy moved aside still holds those sign-in tokens; delete it once you no longer need it.',
        validate: (parsed) => {
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('subscription store is not a JSON object');
          }
          return parsed as SubscriptionStore;
        },
      }) ?? empty
    );
  }

  private write(store: SubscriptionStore): void {
    this.importGeneration++;
    try { writeJsonFileAtomic(this.path, store); } finally { this.importGeneration++; }
  }

  /**
   * One read-modify-write of the store, under a cross-process lock: the daemon,
   * the TUI and the agent share this file, and without the lock the later
   * rename drops whatever another process saved in between. `change` sees the
   * store as it is on disk now; return false from `wrote` to skip the write.
   */
  private mutate<T>(change: (store: SubscriptionStore) => T, wrote: (result: T) => boolean = () => true): T {
    return withSyncFileLock(this.path, () => {
      const store = this.readStrict();
      const result = change(store);
      if (wrote(result)) this.write(store);
      return result;
    });
  }

  public list(): ProviderSubscription[] {
    return Object.values(this.read().subscriptions).sort((a, b) => a.provider.localeCompare(b.provider));
  }

  public listPending(): PendingSubscriptionLogin[] {
    const store = this.read(), now = Date.now();
    return Object.keys(store.pending).map(provider => livePending(store, provider, now))
      .filter((pending): pending is PendingSubscriptionLogin => pending !== null).sort((a, b) => a.provider.localeCompare(b.provider));
  }

  public get(provider: string): ProviderSubscription | null {
    return this.read().subscriptions[provider] ?? null;
  }

  public getAccessToken(provider: string): string | null {
    const subscription = this.get(provider);
    if (!subscription?.overrideAmbientApiKeys) return null;
    return subscription.accessToken;
  }

  /**
   * The access token to send for `provider`, renewed first when it is at or
   * near its expiry, or when `rejectedAccessToken` names the token the
   * provider just refused (revoked mid-lifetime). A record already holding a
   * different token than the refused one was renewed by another caller, and
   * its token is returned without spending anything. Null when no sign-in is
   * stored. Throws {@link SubscriptionSessionEndedError} when the provider
   * refused the grant; any other failure leaves the session's state unknown.
   */
  public async resolveAccessToken(
    provider: string,
    config: OAuthProviderConfig,
    options: { readonly rejectedAccessToken?: string | undefined } = {},
  ): Promise<string | null> {
    const subscription = this.get(provider);
    if (!subscription) return null;
    if (subscription.revokedAt !== undefined) throw new SubscriptionSessionEndedError(provider);
    const rejected = options.rejectedAccessToken;
    const current = rejected !== undefined ? subscription.accessToken !== rejected : !isSubscriptionExpired(subscription.expiresAt);
    if (current) return subscription.accessToken;
    if (!subscription.refreshToken) {
      if (rejected !== undefined) throw new SubscriptionSessionEndedError(provider);
      return subscription.accessToken;
    }
    try {
      return (await this.refreshOAuthToken(provider, config, { heldAccessToken: subscription.accessToken })).accessToken;
    } catch (error) {
      // Signed out while the refresh was in flight: there is no token to use.
      if (this.get(provider) === null) return null;
      throw error;
    }
  }

  public async beginOAuthLogin(provider: string, config: OAuthProviderConfig): Promise<{ authorizationUrl: string; pending: PendingSubscriptionLogin }> {
    const state = createOAuthState();
    const verifier = createPkceVerifier();
    const redirectUri = config.redirectUri;
    const pending: PendingSubscriptionLogin = {
      provider,
      state,
      verifier,
      redirectUri,
      createdAt: Date.now(),
    };
    const started = await buildOAuthAuthorizationStart(config, { state, verifier, redirectUri });
    // Read after the await, so a change made meanwhile (another provider's login) is kept.
    this.mutate((store) => { store.pending[provider] = pending; });
    return {
      authorizationUrl: started.authorizationUrl,
      pending,
    };
  }

  public async completeOAuthLogin(
    provider: string,
    config: OAuthProviderConfig,
    code: string,
  ): Promise<ProviderSubscription> {
    const started = this.read();
    const pending = livePending(started, provider);
    if (!pending) {
      throw new Error(`No pending OAuth login for ${provider}${started.pending[provider] ? ' (the started login expired)' : ''}. Start with /subscription login ${provider} start.`);
    }

    const tokenResponse = await exchangeOAuthAuthorizationCode(config, {
      code,
      verifier: pending.verifier,
      redirectUri: pending.redirectUri,
      state: pending.state,
    });
    const now = Date.now();
    const subscription: ProviderSubscription = {
      provider,
      accessToken: tokenResponse.accessToken,
      ...(typeof tokenResponse.refreshToken === 'string' && tokenResponse.refreshToken.length > 0
        ? { refreshToken: tokenResponse.refreshToken }
        : {}),
      tokenType: tokenResponse.tokenType,
      ...(typeof tokenResponse.expiresAt === 'number' && Number.isFinite(tokenResponse.expiresAt)
        ? { expiresAt: tokenResponse.expiresAt }
        : {}),
      ...(tokenResponse.scopes ? { scopes: tokenResponse.scopes } : {}),
      authMode: 'oauth',
      overrideAmbientApiKeys: config.overrideAmbientApiKeys ?? true,
      createdAt: this.read().subscriptions[provider]?.createdAt ?? now,
      updatedAt: now,
    };
    // Merge only this provider into the store as it is now, after the await.
    this.mutate((store) => {
      store.subscriptions[provider] = subscription;
      if (store.pending[provider]?.state === pending.state) delete store.pending[provider];
    });
    return subscription;
  }

  /**
   * Refresh a provider's access token, for every provider and every process
   * the same way. Callers in this process share one request; across processes
   * the record itself carries the claim ({@link ProviderSubscription.refreshingUntil}),
   * taken under the store lock, so a rotating refresh token is sent once and
   * the other processes wait for its answer. `heldAccessToken` is the token
   * the caller has: a record that already holds a different one was renewed
   * meanwhile and is returned as it is. Without it the refresh is forced.
   * The answer is merged into the store as it is after the request, never
   * over a logout or a newer sign-in.
   */
  public refreshOAuthToken(
    provider: string,
    config: OAuthProviderConfig,
    options: { readonly heldAccessToken?: string | undefined } = {},
  ): Promise<ProviderSubscription> {
    const inFlight = this.refreshes.get(provider);
    if (inFlight) return inFlight;
    const refresh = this.refreshOAuthTokenOnce(provider, config, options.heldAccessToken).finally(() => {
      if (this.refreshes.get(provider) === refresh) this.refreshes.delete(provider);
    });
    this.refreshes.set(provider, refresh);
    return refresh;
  }

  private async refreshOAuthTokenOnce(
    provider: string,
    config: OAuthProviderConfig,
    heldAccessToken: string | undefined,
  ): Promise<ProviderSubscription> {
    let held = heldAccessToken;
    const deadline = Date.now() + 2 * REFRESH_LEASE_MS;
    let pause = LEASE_POLL_FIRST_MS;
    for (;;) {
      const claim = this.claimRefresh(provider, held);
      if (claim.kind === 'settled') return claim.record;
      if (claim.kind === 'claimed') return this.completeClaimedRefresh(provider, config, claim.record);
      // Another process is spending this refresh token. Its answer replaces the
      // access token (or clears the claim), which the next claim sees.
      held ??= claim.record.accessToken;
      const left = deadline - Date.now();
      if (left <= 0) {
        throw new Error(`Another GoodVibes process started renewing the ${provider} sign-in and has not finished. Try again in a moment.`);
      }
      await new Promise<void>((done) => setTimeout(done, Math.min(pause, left, Math.max(1, claim.until - Date.now()))));
      pause = Math.min(pause * 2, LEASE_POLL_MAX_MS);
    }
  }

  /** One locked read of the record: return it as it is, take the claim on it, or report another process's live claim. */
  private claimRefresh(provider: string, held: string | undefined): RefreshClaim {
    const now = Date.now();
    return this.mutate((store): RefreshClaim => {
      const current = store.subscriptions[provider];
      if (!current) throw new Error(`No stored OAuth subscription for ${provider}.`);
      if (current.revokedAt !== undefined) throw new SubscriptionSessionEndedError(provider);
      if (!current.refreshToken || (held !== undefined && current.accessToken !== held)) return { kind: 'settled', record: current };
      if (current.refreshingUntil !== undefined && current.refreshingUntil > now) {
        return { kind: 'leased', record: current, until: current.refreshingUntil };
      }
      store.subscriptions[provider] = { ...current, refreshingUntil: now + REFRESH_LEASE_MS };
      return { kind: 'claimed', record: current };
    }, (claim) => claim.kind === 'claimed');
  }

  /** Spend the claimed refresh token outside the lock, then write the answer (or the refusal) in one locked compare-and-write. */
  private async completeClaimedRefresh(
    provider: string,
    config: OAuthProviderConfig,
    claimed: ProviderSubscription,
  ): Promise<ProviderSubscription> {
    let tokenResponse: Awaited<ReturnType<typeof refreshOAuthAccessToken>>;
    try {
      tokenResponse = await refreshOAuthAccessToken(config, claimed.refreshToken!);
    } catch (error) {
      // Only the authorization server refusing the grant ends the session: a
      // 400, 401 or 403 whose body says invalid_grant, or names no code. A busy
      // or slow server (408, 425, 429), another client error, a transport
      // failure, a 5xx or a malformed answer leaves it unknown: the claim is
      // released and the next use tries again.
      const refused = error instanceof OAuthTokenExchangeError && grantRefused(error);
      const newer = this.settleFailedRefresh(provider, claimed, refused);
      if (newer) {
        // The refusal answered a refresh token another process or a new sign-in
        // already replaced; the stored record is the one to use.
        if (newer.revokedAt !== undefined) throw new SubscriptionSessionEndedError(provider, { cause: error });
        return newer;
      }
      if (refused) throw new SubscriptionSessionEndedError(provider, { cause: error });
      throw error;
    }
    let outcome: RefreshWrite;
    try {
      outcome = this.mutate((store): RefreshWrite => {
        const current = store.subscriptions[provider];
        if (!current) return { kind: 'gone' };
        // A sign-in made while the request ran is newer than this answer.
        if (!sameGrant(current, claimed)) return { kind: 'newer', record: current };
        const refreshed = this.refreshedRecord(current, claimed, tokenResponse);
        store.subscriptions[provider] = refreshed;
        return { kind: 'saved', record: refreshed };
      }, (result) => result.kind === 'saved');
    } catch (error) {
      // The provider has already rotated the old refresh token away, so
      // dropping this answer over a disk error would end a healthy session.
      // This process uses it; the store heals on the next successful save.
      logger.warn('SubscriptionManager: a renewed sign-in could not be saved; using it for this process', {
        provider,
        error: summarizeError(error),
      });
      return this.refreshedRecord(claimed, claimed, tokenResponse);
    }
    if (outcome.kind === 'gone') throw signedOutDuringRefresh(provider);
    return outcome.record;
  }

  /**
   * After a failed exchange: release the claim, stamping the session revoked
   * when the provider refused it. Returns the stored record instead when it no
   * longer holds the grant this attempt spent (renewed or replaced meanwhile).
   */
  private settleFailedRefresh(provider: string, claimed: ProviderSubscription, refused: boolean): ProviderSubscription | null {
    let settled: FailedRefreshSettlement;
    try {
      settled = this.mutate((store): FailedRefreshSettlement => {
        const current = store.subscriptions[provider];
        if (!current) return { kind: 'gone' };
        if (!sameGrant(current, claimed)) return { kind: 'newer', record: current };
        const now = Date.now();
        const { refreshingUntil: _lease, ...rest } = current;
        store.subscriptions[provider] = refused ? { ...rest, revokedAt: now, updatedAt: now } : rest;
        return { kind: 'released' };
      }, (result) => result.kind === 'released');
    } catch (error) {
      // The claim lapses on its own; the caller still learns what the provider answered.
      logger.warn('SubscriptionManager: the outcome of a failed renewal could not be saved', { provider, error: summarizeError(error) });
      return null;
    }
    if (settled.kind === 'gone') throw signedOutDuringRefresh(provider);
    return settled.kind === 'newer' ? settled.record : null;
  }

  private refreshedRecord(
    current: ProviderSubscription,
    existing: ProviderSubscription,
    tokenResponse: Awaited<ReturnType<typeof refreshOAuthAccessToken>>,
  ): ProviderSubscription {
    const now = Date.now();
    const refreshed: ProviderSubscription = {
      ...withoutRefreshState(current),
      accessToken: tokenResponse.accessToken,
      refreshToken: typeof tokenResponse.refreshToken === 'string' && tokenResponse.refreshToken.length > 0
        ? tokenResponse.refreshToken
        : existing.refreshToken,
      tokenType: typeof tokenResponse.tokenType === 'string' && tokenResponse.tokenType.length > 0
        ? tokenResponse.tokenType
        : existing.tokenType,
      ...(typeof tokenResponse.expiresAt === 'number' && Number.isFinite(tokenResponse.expiresAt)
        ? { expiresAt: tokenResponse.expiresAt }
        : typeof existing.expiresAt === 'number' ? { expiresAt: existing.expiresAt } : {}),
      ...(tokenResponse.scopes ? { scopes: tokenResponse.scopes } : existing.scopes ? { scopes: existing.scopes } : {}),
      updatedAt: now,
    };
    return refreshed;
  }

  public logout(provider: string): boolean {
    return this.mutate((store) => {
      const existed = provider in store.subscriptions || provider in store.pending;
      delete store.subscriptions[provider];
      delete store.pending[provider];
      return existed;
    });
  }

  public getPending(provider: string): PendingSubscriptionLogin | null {
    return livePending(this.read(), provider);
  }

  public savePending(pending: PendingSubscriptionLogin): void {
    this.mutate((store) => { store.pending[pending.provider] = pending; });
  }

  public clearPending(provider: string): void {
    this.mutate((store) => { delete store.pending[provider]; });
  }

  public saveSubscription(subscription: ProviderSubscription): ProviderSubscription {
    this.mutate((store) => {
      store.subscriptions[subscription.provider] = subscription;
      delete store.pending[subscription.provider];
    });
    return subscription;
  }
}
