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
 * The held manager is replaced when the credential it was built from changes:
 * every `connection()` resolves the stored credential (the same secret-store
 * reads a call made before) and keeps the manager only while client id, client
 * secret and refresh token are the same values. A new consent writes a new
 * refresh token, so it gets a new manager and a latched dead grant does not
 * outlive it. The store is read rather than watched because the daemon and the
 * Agent write the same daemon-tier store from two processes, and the store's
 * change signal reaches only writers in this process.
 */

import { buildGoogleConnection, resolveGoogleCredentials, type GoogleConnection, type GoogleConnectionSources } from './connection.js';
import type { GoogleApiFetchPort } from './api-client.js';
import type { GoogleFetchPort } from './oauth-loopback.js';
import type { GoogleOAuthCredentials } from './credential-adoption.js';
import { checkGoogleCredentialsAtBoot, type GoogleBootCheckResult } from './token-manager.js';

export interface GoogleConnectionOwnerOptions {
  /** Where the credential is read from when a call does not supply its own guarded sources. */
  readonly sources: GoogleConnectionSources;
  /** Used for the token refresh; a call's API requests may go through its own port. */
  readonly fetch: GoogleFetchPort & GoogleApiFetchPort;
  readonly now?: () => number;
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
  /** One resolution at a time, so callers arriving together share one manager. */
  #pending: Promise<GoogleConnection | null> | null = null;

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
    const pending = this.#pending;
    if (pending !== null) return pending;
    const attempt = this.#resolve(options);
    this.#pending = attempt;
    try {
      return await attempt;
    } finally {
      if (this.#pending === attempt) this.#pending = null;
    }
  }

  async #resolve(options: {
    readonly sources?: GoogleConnectionSources;
    readonly signedInAccount?: string | null;
  }): Promise<GoogleConnection | null> {
    const sources = options.sources ?? this.#options.sources;
    const credentials = await resolveGoogleCredentials(sources);
    if (credentials === null) {
      this.#held = null;
      return null;
    }
    const held = this.#held;
    if (held !== null && sameGrant(held.credentials, credentials)) return held;
    const built = buildGoogleConnection(credentials, sources, {
      fetch: this.#options.fetch,
      ...(options.signedInAccount === undefined ? {} : { signedInAccount: options.signedInAccount }),
    }, this.#now());
    this.#held = built;
    return built;
  }

  /**
   * The start-up check: one token refresh that reads and changes nothing, so a
   * revoked grant is found and latched once, at start, and the refreshed token
   * serves the first real call.
   */
  async checkAtBoot(): Promise<GoogleBootCheckResult> {
    const connection = await this.connection();
    return checkGoogleCredentialsAtBoot(connection?.tokens ?? null);
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
