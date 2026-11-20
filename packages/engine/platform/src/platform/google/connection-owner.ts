/**
 * One Google connection held for the life of a process or session.
 *
 * The token manager caches the access token, shares one refresh among callers
 * that arrive together and latches a refresh token Google has declared dead.
 * None of that holds when a manager is built for one call and dropped, which
 * is what every caller did: each calendar verb, tool call and command began
 * with a token request, and a revoked grant was asked about (and diagnosed)
 * again on every attempt. The daemon holds one owner, and each Agent session
 * holds one, so calls share the manager.
 *
 * The held manager is replaced when the credential it was built from changes.
 * With `onCredentialChange` (the secret store's per-key change and its watcher
 * for another process's rewrite, and the OAuth client settings), the held
 * connection is reused with no store read until that fires; then the next
 * `connection()` resolves the stored credential once and keeps the manager
 * only while client id, client secret and refresh token are the same values.
 * Without it, every `connection()` resolves the stored credential. A new
 * consent writes a new refresh token, so it gets a new manager and a latched
 * dead grant does not outlive it.
 */

import { buildGoogleConnection, resolveGoogleCredentials, type GoogleConnection, type GoogleConnectionSources } from './connection.js';
import type { GoogleApiFetchPort } from './api-client.js';
import type { GoogleFetchPort } from './oauth-loopback.js';
import type { GoogleOAuthCredentials } from './credential-adoption.js';
import { checkGoogleCredentialsAtBoot, type GoogleBootCheckResult } from './token-manager.js';
import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS } from './setup-plan.js';
import type { ConfigManager } from '../config/manager.js';
import type { ConfigKey } from '../config/schema-types.js';

export interface GoogleConnectionOwnerOptions {
  /** Where the credential is read from when a call does not supply its own guarded sources. */
  readonly sources: GoogleConnectionSources;
  /** Used for the token refresh; a call's API requests may go through its own port. */
  readonly fetch: GoogleFetchPort & GoogleApiFetchPort;
  readonly now?: () => number;
  /** Calls the listener when a Google credential or the OAuth client setting changes; see {@link subscribeGoogleCredentialChanges}. */
  readonly onCredentialChange?: ((listener: () => void) => () => void) | undefined;
}

/** The settings and secrets a Google connection is built from. */
const GOOGLE_CONNECTION_CONFIG_KEYS: readonly string[] = [
  GOOGLE_CONFIG_KEYS.oauthClientId, GOOGLE_CONFIG_KEYS.oauthClientSecretRef, GOOGLE_CONFIG_KEYS.oauthRefreshToken,
];
const GOOGLE_CONNECTION_SECRET_KEYS: ReadonlySet<string> = new Set([GOOGLE_SECRET_KEYS.oauthClientSecret, GOOGLE_SECRET_KEYS.oauthRefreshToken]);

/**
 * One subscription that fires when the Google OAuth client settings or the two
 * Google credentials change, here or (through the secret store watcher) in
 * another process. Nothing is read per call.
 */
export function subscribeGoogleCredentialChanges(owners: {
  readonly config?: Pick<ConfigManager, 'subscribe'> | undefined;
  readonly secrets?: {
    readonly onDidChange?: ((listener: (key: string) => void) => () => void) | undefined;
    readonly onDidChangeElsewhere?: ((listener: () => void) => () => void) | undefined;
  } | undefined;
}, listener: () => void): () => void {
  const stops: Array<() => void> = [];
  for (const key of GOOGLE_CONNECTION_CONFIG_KEYS) if (owners.config) stops.push(owners.config.subscribe(key as ConfigKey, () => listener()));
  if (owners.secrets?.onDidChange) stops.push(owners.secrets.onDidChange((key) => { if (GOOGLE_CONNECTION_SECRET_KEYS.has(key)) listener(); }));
  if (owners.secrets?.onDidChangeElsewhere) stops.push(owners.secrets.onDidChangeElsewhere(listener));
  return () => { for (const stop of stops.splice(0)) { try { stop(); } catch { /* already stopped */ } } };
}

function sameGrant(a: GoogleOAuthCredentials, b: GoogleOAuthCredentials): boolean {
  return a.clientId === b.clientId
    && a.clientSecret === b.clientSecret
    && a.refreshToken === b.refreshToken
    && a.origin === b.origin;
}

export class GoogleConnectionOwner {
  readonly #options: GoogleConnectionOwnerOptions;
  readonly #now: () => number;
  #held: GoogleConnection | null = null;
  /**
   * One resolution at a time, so callers arriving together share one manager.
   * Joined only by a caller at the revision it started at: one that arrives
   * after a credential change starts its own resolution.
   */
  #pending: { readonly promise: Promise<GoogleConnection | null>; readonly revision: number } | null = null;
  /** Moves when a Google credential or client setting changes; a held connection is current while it is unchanged. */
  #revision = 0;
  /** The revision the held connection (or the stored absence) was resolved at; -1 when it must be resolved again. */
  #resolvedAt = -1;
  #subscribed = false;

  /** Moves when the Google credentials or the OAuth client settings change (with `onCredentialChange`); compare it, never re-read the store. */
  get revision(): number { return this.#revision; }

  constructor(options: GoogleConnectionOwnerOptions) {
    this.#options = options;
    this.#now = options.now ?? ((): number => Date.now());
  }

  /**
   * The live connection, or null when no complete credential is stored.
   *
   * `sources` lets a caller read the credential through its own guarded
   * readers; `signedInAccount` feeds the dead-grant diagnosis when a new
   * manager is built.
   */
  async connection(options: {
    readonly sources?: GoogleConnectionSources;
    readonly signedInAccount?: string | null;
  } = {}): Promise<GoogleConnection | null> {
    const watch = this.#options.onCredentialChange;
    if (watch && !this.#subscribed) {
      this.#subscribed = true;
      watch(() => { this.#revision++; });
    }
    if (watch && this.#resolvedAt === this.#revision) return this.#held;
    const pending = this.#pending;
    if (pending !== null && pending.revision === this.#revision) return pending.promise;
    const attempt = this.#resolve(options);
    const entry = { promise: attempt, revision: this.#revision };
    this.#pending = entry;
    try {
      return await attempt;
    } finally {
      if (this.#pending === entry) this.#pending = null;
    }
  }

  async #resolve(options: {
    readonly sources?: GoogleConnectionSources;
    readonly signedInAccount?: string | null;
  }, retried = false): Promise<GoogleConnection | null> {
    const sources = options.sources ?? this.#options.sources;
    const revision = this.#revision;
    const credentials = await resolveGoogleCredentials(sources);
    // A change landed while the store was read: what was read may mix the old and new grant, so read once more.
    if (this.#revision !== revision && !retried) return this.#resolve(options, true);
    // A change that landed while the store was read leaves this resolution unmarked, so the next call reads again.
    const settle = (): void => { if (this.#revision === revision) this.#resolvedAt = revision; };
    if (credentials === null) {
      this.#held = null;
      settle();
      return null;
    }
    const held = this.#held;
    if (held !== null && sameGrant(held.credentials, credentials)) { settle(); return held; }
    const built = buildGoogleConnection(credentials, sources, {
      fetch: this.#options.fetch,
      ...(options.signedInAccount === undefined ? {} : { signedInAccount: options.signedInAccount }),
    }, this.#now());
    this.#held = built;
    settle();
    return built;
  }

  /**
   * The start-up check: one token refresh that reads and changes nothing, so a
   * revoked grant is found and latched once, at start, and the refreshed token
   * serves the first real call.
   */
  async checkAtBoot(signal?: AbortSignal): Promise<GoogleBootCheckResult> {
    const connection = await this.connection();
    return checkGoogleCredentialsAtBoot(connection?.tokens ?? null, signal);
  }
}

const sharedOwners = new WeakMap<object, GoogleConnectionOwner>();

/**
 * The connection owner of one scope (an Agent session's secret store), made
 * on first use, so the `google` tool and the `/google` commands of a session
 * share one token manager.
 */
export function sharedGoogleConnectionOwner(scope: object, create: () => GoogleConnectionOwner): GoogleConnectionOwner {
  const existing = sharedOwners.get(scope);
  if (existing !== undefined) return existing;
  const owner = create();
  sharedOwners.set(scope, owner);
  return owner;
}

/** The connection owner of one scope when one was made, without making one. */
export function existingGoogleConnectionOwner(scope: object): GoogleConnectionOwner | undefined {
  return sharedOwners.get(scope);
}
