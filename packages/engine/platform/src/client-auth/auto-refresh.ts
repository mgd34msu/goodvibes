/**
 * AutoRefreshCoordinator, automatic token refresh with in-flight request queuing.
 *
 * Prevents user-visible 401s by:
 *   1. Pre-flight leeway check: if the token expires within refreshLeewayMs,
 *      trigger an automatic refresh before the request is dispatched.
 *   2. Reactive 401 retry: if a request returns 401 and the token wasn't
 *      already known expired, trigger a refresh then retry the request once.
 *   3. In-flight queuing: while a refresh is in progress, subsequent refresh
 *      attempts queue on the same promise, one refresh call for all waiters.
 *
 * When no refresh endpoint is available (the coordinator has no `refresh`
 * function), the pre-flight check is a graceful no-op and the reactive path
 * triggers a token re-read (which may succeed if the store was updated externally).
 *
 * Error messages use this three-part format:
 *   [what happened] · [why] · [what to do]
 */

import { GoodVibesError, structuredTransience } from '@goodvibes-jev/engine/errors';
import type { GoodVibesTokenStore } from './types.js';
import type { PlatformObserver } from '../observer/index.js';
import { invokeObserver } from '../observer/index.js';
import { sha256Base64Url } from '../platform/utils/sha256.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AutoRefreshOptions {
  /**
   * Enable or disable automatic token refresh. Default: `true`.
   * When `false`, 401 responses propagate immediately without retry.
   */
  readonly autoRefresh?: boolean | undefined;

  /**
   * Milliseconds before token expiry to trigger an automatic refresh.
   * Default: 60_000 (1 minute).
   */
  readonly refreshLeewayMs?: number | undefined;

  /**
   * Clock used for the expiry comparisons. Defaults to `Date.now`.
   *
   * Exists so a caller, in practice a test, can drive the leeway and
   * expired-token branches deterministically instead of constructing tokens
   * whose real timestamps happen to straddle the window. Not a behaviour knob:
   * anything other than a monotonic wall clock makes expiry meaningless.
   */
  readonly now?: (() => number) | undefined;

  /**
   * Consumer-provided callback invoked to obtain a new token when the current
   * token is near expiry (pre-flight leeway check) or a 401 is received
   * (reactive retry path).
   *
   * The callback must return the new token string and, optionally, its expiry
   * timestamp in Unix milliseconds. When provided, the coordinator calls this
   * to perform the actual token refresh and persists the result via
   * `setTokenEntry` (or `setToken` on stores that don't implement
   * `setTokenEntry`).
   *
   * When absent, the coordinator's pre-flight check is a graceful no-op and
   * the reactive 401 path re-reads the token store without making a network
   * call (useful when an external party updates the store).
   *
   * @example
   * const store = createMemoryTokenStore(initialToken);
   * const platform = createGoodVibesPlatform({
   *   baseUrl: 'https://daemon.example.com',
   *   tokenStore: store,
   *   autoRefresh: {
   *     refresh: async () => {
   *       const res = await fetch('/api/auth/refresh', { method: 'POST' });
   *       const { token, expiresAt } = await res.json();
   *       return { token, expiresAt };
   *     },
   *   },
   * });
   */
  readonly refresh?: (() => Promise<{ token: string; expiresAt?: number }>) | undefined;
}

export interface AutoRefreshCoordinatorOptions {
  readonly tokenStore: GoodVibesTokenStore;
  readonly autoRefresh: boolean;
  readonly refreshLeewayMs: number;
  /** Clock for expiry comparisons; defaults to `Date.now`. See AutoRefreshOptions.now. */
  readonly now?: (() => number) | undefined;
  /**
   * Optional refresh function. Called to acquire a new token when the current
   * one is near expiry or a 401 was received.
   *
   * If undefined, the coordinator performs a graceful no-op (does not
   * error), in-flight queuing and leeway checks are still respected, but
   * no network call is made. Reactive 401 retry still re-reads the token
   * store in case an external party updated it.
   */
  readonly refresh?: (() => Promise<{ token: string; expiresAt?: number | undefined }>) | undefined;
  readonly observer?: PlatformObserver | undefined;
}

/**
 * What a refresh attempt did to the stored token.
 * - `'refreshed'`: a new token was stored.
 * - `'cleared'`: the refresh was rejected for good (revoked or invalid
 *   credentials) and the stored token was cleared.
 * - `'not-refreshed'`: nothing changed (no refresh endpoint, a transient
 *   failure that keeps the token, the token was not near expiry, or the store
 *   was changed by someone else while the refresh was in flight).
 */
export type RefreshOutcome = 'refreshed' | 'cleared' | 'not-refreshed';

/** What one refresh did, with the token it left in the store when that is known without another read. */
interface RefreshResult {
  readonly outcome: RefreshOutcome;
  /** The stored token after the refresh; undefined when someone else changed the store meanwhile. */
  readonly token: string | null | undefined;
}

// ---------------------------------------------------------------------------
// Coordinator implementation
// ---------------------------------------------------------------------------

export class AutoRefreshCoordinator {
  readonly #tokenStore: GoodVibesTokenStore;
  readonly #autoRefresh: boolean;
  readonly #refreshLeewayMs: number;
  readonly #refresh: (() => Promise<{ token: string; expiresAt?: number | undefined }>) | undefined;
  readonly #observer: PlatformObserver | undefined;

  /** Promise shared across all waiters during an active refresh. */
  #refreshingPromise: Promise<RefreshResult> | null = null;

  /**
   * True from the moment a refresh was rejected for good and this coordinator
   * cleared the store, until a read finds a token in it again.
   */
  #sessionCleared = false;

  readonly #now: () => number;

  /**
   * The sign-in each token belongs to, by token fingerprint: a token this
   * coordinator obtained by refreshing another belongs to that token's
   * sign-in; any other token (a new login, a token stored from outside) is a
   * sign-in of its own. A request refused with 401 is repeated only under a
   * token of the sign-in it was sent with, never under someone's newer login.
   */
  readonly #signIns = new Map<string, string>();

  constructor(options: AutoRefreshCoordinatorOptions) {
    this.#tokenStore = options.tokenStore;
    this.#autoRefresh = options.autoRefresh;
    this.#refreshLeewayMs = options.refreshLeewayMs;
    this.#refresh = options.refresh;
    this.#observer = options.observer;
    this.#now = options.now ?? Date.now;
  }

  // ---------------------------------------------------------------------------
  // Token expiry helpers
  // ---------------------------------------------------------------------------

  /** Read the raw token entry, including optional expiresAt. */
  async #readEntry(): Promise<{ token: string | null; expiresAt?: number }> {
    const store = this.#tokenStore as GoodVibesTokenStore & {
      getTokenEntry?: () => Promise<{ token: string | null; expiresAt?: number }>;
    };
    if (typeof store.getTokenEntry === 'function') {
      return store.getTokenEntry();
    }
    // Fall back to token-only stores that don't expose expiresAt.
    const token = await this.#tokenStore.getToken();
    return { token };
  }

  /** True when an expiry falls within the leeway window. */
  #isNearExpiry(expiresAt: number | undefined): boolean {
    if (expiresAt === undefined) return false;
    return this.#now() + this.#refreshLeewayMs >= expiresAt;
  }

  /** Return true if the token is definitively expired (past expiresAt). */
  async #isExpired(): Promise<boolean> {
    const { expiresAt } = await this.#readEntry();
    if (expiresAt === undefined) return false;
    return this.#now() >= expiresAt;
  }

  // ---------------------------------------------------------------------------
  // Core refresh logic (serialised via shared promise)
  // ---------------------------------------------------------------------------

  /**
   * Trigger a refresh. If one is already in progress, all callers wait on the
   * same promise, no duplicate refresh network calls.
   *
   * After a successful refresh, emits `onAuthTransition` reason='refresh'.
   * A failed refresh is classified from its structure alone, with no model:
   * an HTTP status a retry cannot clear (a 400, 401 or 403 from the auth
   * server: rejected or revoked credentials), or an error that states it is
   * not retryable, clears the token and emits `onAuthTransition`
   * reason='expire'. Anything else (a transient status, a Retry-After, a
   * network fault, a timeout, a cancellation, a parse error, an error with no
   * status at all)
   * keeps the token, which is still valid until it expires, for the next
   * pre-flight or 401 refresh. Both report the error to `onError`.
   *
   * @param knownToken - The stored token the caller has just read, so the
   *   refresh does not read it again; omitted, the store is read once.
   */
  async #doRefresh(knownToken?: string | null): Promise<RefreshResult> {
    if (this.#refreshingPromise) {
      return this.#refreshingPromise;
    }

    const promise = (async (): Promise<RefreshResult> => {
      if (!this.#refresh) {
        // No refresh endpoint, graceful no-op.
        return { outcome: 'not-refreshed', token: knownToken };
      }
      // The token this refresh replaces. A logout or a new login while it is
      // in flight changes the stored token; its answer must not overwrite that.
      // An unreadable store at the start leaves nothing to compare (undefined).
      let startedFrom: string | null | undefined = knownToken;
      if (startedFrom === undefined) {
        try { startedFrom = await this.#tokenStore.getToken(); } catch { startedFrom = undefined; }
      }
      const storeChanged = async (): Promise<boolean> => {
        if (startedFrom === undefined) return false;
        try { return (await this.#tokenStore.getToken()) !== startedFrom; } catch { return false; }
      };
      try {
        const { token, expiresAt } = await this.#refresh();
        if (await storeChanged()) return { outcome: 'not-refreshed', token: undefined };
        const store = this.#tokenStore as GoodVibesTokenStore & {
          setTokenEntry?: ((token: string | null, expiresAt?: number) => Promise<void>) | undefined;
        };
        if (typeof store.setTokenEntry === 'function') {
          await store.setTokenEntry(token, expiresAt);
        } else {
          await this.#tokenStore.setToken(token);
        }
        this.#sessionCleared = false;
        if (typeof startedFrom === 'string' && startedFrom) this.#recordRefresh(startedFrom, token);
        invokeObserver(() =>
          this.#observer?.onAuthTransition?.({
            from: 'token',
            to: 'token',
            reason: 'refresh',
          }),
        );
        return { outcome: 'refreshed', token };
      } catch (err) {
        // Only the error's own structure (the auth server's status, a stated
        // retryable flag or category) can say the credentials are gone. Without
        // it (a network fault, an HTML error page, a plain Error), or when the
        // refresh was cancelled, the token stays: it is valid until it expires.
        const transience = structuredTransience(err);
        const terminal = transience?.failureClass === 'terminal' && transience.basis !== 'cancelled';
        const refreshError = err instanceof GoodVibesError
          ? err
          : new GoodVibesError(
              terminal
                ? 'Token refresh failed; clearing to anonymous.'
                : 'Token refresh failed; keeping the token to refresh again.',
              {
                code: 'ENGINE_AUTH_REFRESH_FAILED',
                category: 'authentication',
                source: 'runtime',
                recoverable: true,
                cause: err,
              },
            );
        let result: RefreshResult = { outcome: 'not-refreshed', token: startedFrom };
        if (terminal && !await storeChanged()) {
          await this.#tokenStore.clearToken();
          this.#sessionCleared = true;
          result = { outcome: 'cleared', token: null };
          invokeObserver(() =>
            this.#observer?.onAuthTransition?.({
              from: 'token',
              to: 'anonymous',
              reason: 'expire',
            }),
          );
        }
        invokeObserver(() => this.#observer?.onError?.(refreshError), { label: 'onError' });
        return result;
      }
    })();

    this.#refreshingPromise = promise.finally(() => {
      this.#refreshingPromise = null;
    });

    return this.#refreshingPromise;
  }

  // ---------------------------------------------------------------------------
  // Pre-flight check
  // ---------------------------------------------------------------------------

  /**
   * Call before dispatching a request. If the token is near expiry (within
   * `refreshLeewayMs`), refreshes before the request goes out.
   *
   * If `autoRefresh` is disabled, this is a no-op.
   *
   * Resolves with what the refresh did to the stored token, so a caller can
   * tell `'cleared'` (the session was rejected and the token removed) from a
   * token that is simply still current (`'not-refreshed'`).
   */
  async ensureFreshToken(): Promise<RefreshOutcome> {
    if (!this.#autoRefresh) return 'not-refreshed';
    const { token, expiresAt } = await this.#readEntry();
    if (!this.#isNearExpiry(expiresAt)) return 'not-refreshed';
    return (await this.#doRefresh(token)).outcome;
  }

  /**
   * The token to send with a request: the store is read once, and a token
   * inside the leeway window is refreshed first. This is the one read of the
   * store an ordinary request makes; the transport builds its Authorization
   * header from the value returned.
   *
   * Returns null when the store holds no token, including when the refresh
   * was rejected for good and the token was cleared (see `sessionCleared`).
   */
  async currentToken(): Promise<string | null> {
    const { token, expiresAt } = await this.#readEntry();
    if (token) this.#sessionCleared = false;
    if (!this.#autoRefresh || !this.#refresh || !this.#isNearExpiry(expiresAt)) return token;
    const result = await this.#doRefresh(token);
    // Someone else changed the store while the refresh ran: send what they stored.
    return result.token === undefined ? this.#tokenStore.getToken() : result.token;
  }

  /**
   * True when the store is empty because a refresh was rejected for good and
   * this coordinator cleared it; false once a token is stored or read again.
   * A request sent in that state carries no token the daemon could accept,
   * so a 401 on it is final rather than a reason to refresh again.
   */
  get sessionCleared(): boolean {
    return this.#sessionCleared;
  }

  /**
   * True when the rejected request carried a token that is no longer the one
   * in the store: another refresh already replaced it, so refreshing again
   * would only rotate the new token away. A refresh already in flight is
   * joined instead (its result is the one to retry with).
   */
  async #usedTokenIsStale(usedToken: string | null | undefined): Promise<boolean> {
    if (!usedToken || this.#refreshingPromise) return false;
    try {
      const current = await this.#tokenStore.getToken();
      return current !== null && current !== usedToken;
    } catch {
      return false;
    }
  }

  /** The sign-in `token` belongs to: its own fingerprint, or the sign-in of the token it was refreshed from. */
  #signInOf(token: string): string {
    const fingerprint = sha256Base64Url(token).slice(0, 12);
    return this.#signIns.get(fingerprint) ?? fingerprint;
  }

  #recordRefresh(from: string, to: string): void {
    const signIn = this.#signInOf(from);
    // A few dozen refreshes a day at most; the oldest entries are dropped past 64.
    if (this.#signIns.size >= 64) this.#signIns.delete(this.#signIns.keys().next().value!);
    this.#signIns.set(sha256Base64Url(to).slice(0, 12), signIn);
  }

  /**
   * Refuses to repeat a request sent with `usedToken` when the store now holds
   * a token of another sign-in (someone logged in since): the request was
   * refused as the old account and is never replayed as the new one.
   */
  async #assertSameSignIn(usedToken: string | null | undefined): Promise<void> {
    if (!usedToken) return;
    let current: string | null;
    try { current = await this.#tokenStore.getToken(); } catch { return; }
    if (current === null || current === usedToken || this.#signInOf(current) === this.#signInOf(usedToken)) return;
    const error = new GoodVibesError(
      'Authentication failed · Signed in as someone else since this request was sent, so it was not repeated under the new sign-in · Send it again if it is meant for the account now signed in.',
      { code: 'AUTH_REQUIRED', category: 'authentication', source: 'transport', status: 401, recoverable: false },
    );
    invokeObserver(() => this.#observer?.onError?.(error));
    throw error;
  }

  // ---------------------------------------------------------------------------
  // Reactive 401 retry wrapper
  // ---------------------------------------------------------------------------

  /**
   * Execute `fn` and retry once on 401 after triggering a refresh.
   *
   * If `autoRefresh` is false, the first 401 is rethrown immediately.
   * If the retry also returns 401, throws `GoodVibesError{kind:'auth'}`.
   *
   * @param fn - The request function to execute. Must be side-effect-safe to
   *   call twice (called at most twice).
   * @param usedToken - The bearer token the first attempt was sent with. When
   *   the store already holds a different token, a refresh has completed since
   *   and `fn` is retried without refreshing again.
   */
  async withRetryOn401<T>(fn: () => Promise<T>, usedToken?: string | null): Promise<T> {
    try {
      return await fn();
    } catch (firstError) {
      if (!this.#autoRefresh || !is401Error(firstError)) {
        throw firstError;
      }

      // Trigger refresh (queued if already in progress).
      const wasExpired = await this.#isExpired();
      if (!await this.#usedTokenIsStale(usedToken)) {
        await this.#doRefresh();
      }
      await this.#assertSameSignIn(usedToken);

      // Retry once.
      try {
        return await fn();
      } catch (retryError) {
        if (is401Error(retryError)) {
          // Terminal auth failure.
          const authErr = new GoodVibesError(
            'Authentication failed · Token is invalid or has expired · ' +
            (wasExpired
              ? 'Re-login to obtain a fresh token.'
              : 'Verify your credentials and token store configuration.'),
            {
              category: 'authentication',
              source: 'transport',
              status: 401,
              recoverable: false,
            },
          );
          invokeObserver(() => this.#observer?.onError?.(authErr));
          throw authErr;
        }
        throw retryError;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Middleware-facing retry helper
  // ---------------------------------------------------------------------------

  /**
   * Refresh the token immediately and execute `fn` exactly once as the retry.
   *
   * Unlike `withRetryOn401`, this method does NOT call `fn` before refreshing,
   * it assumes the caller already received a 401 on the initial attempt. It
   * refreshes the token (serialised via the shared promise, as with
   * `withRetryOn401`) and then calls `fn` a single time.
   *
   * If `fn` throws a 401 on retry, a terminal `GoodVibesError{kind:'auth'}`
   * is thrown with the standard three-part message format.
   *
   * Used by `createAutoRefreshMiddleware` to avoid making an extra HTTP call
   * when the middleware already observed the initial 401 from `next()`.
   *
   * @param fn - The retry request to execute after the refresh completes.
   * @param usedToken - The bearer token the rejected request was sent with.
   *   When the store already holds a different token, a refresh has completed
   *   since and `fn` runs without refreshing again.
   */
  async refreshAndRetryOnce<T>(fn: () => Promise<T>, usedToken?: string | null): Promise<T> {
    const wasExpired = await this.#isExpired();
    // Refresh (serialised, if one is already in progress, join it).
    if (!await this.#usedTokenIsStale(usedToken)) {
      await this.#doRefresh();
    }
    await this.#assertSameSignIn(usedToken);
    // Single retry attempt.
    try {
      return await fn();
    } catch (retryError) {
      if (is401Error(retryError)) {
        const authErr = new GoodVibesError(
          'Authentication failed · Token is invalid or has expired · ' +
          (wasExpired
            ? 'Re-login to obtain a fresh token.'
            : 'Verify your credentials and token store configuration.'),
          {
            category: 'authentication',
            source: 'transport',
            status: 401,
            recoverable: false,
          },
        );
        invokeObserver(() => this.#observer?.onError?.(authErr));
        throw authErr;
      }
      throw retryError;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function is401Error(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as {
    status?: unknown | undefined;
    transport?: { status?: unknown } | undefined;
    response?: { status?: unknown } | undefined;
    cause?: { response?: { status?: unknown } } | undefined;
  };
  const status =
    e.status ??
    e.transport?.status ??
    e.response?.status ??
    e.cause?.response?.status;
  return status === 401;
}
