import { ConfigurationError } from '@goodvibes/engine/errors';
import type { PlatformObserver } from './observer/index.js';
import { invokeObserver } from './observer/index.js';
import type { AuthTokenResolver } from '@goodvibes/engine/transport-http';
import type { OperatorApiClient } from '@goodvibes/engine/operator-client';
import {
  AutoRefreshCoordinator,
  PermissionResolver,
  SessionManager,
  TokenStore,
} from './client-auth/index.js';
import type { AutoRefreshOptions } from './client-auth/index.js';
import type {
  GoodVibesAuthLoginOptions,
  GoodVibesCurrentAuth,
  GoodVibesExpiringTokenStore,
  GoodVibesLoginInput,
  GoodVibesLoginOutput,
  GoodVibesTokenStore,
} from './client-auth/types.js';

// Re-export focused responsibility classes for consumers who prefer narrower,
// single-concern APIs over the combined GoodVibesAuthClient facade.
// OAuthClient is intentionally omitted from this client-side surface because it
// depends on Node runtime facilities. Daemon OAuth flows belong on the server
// side; clients receive acquired tokens via TokenStore.
export { PermissionResolver, SessionManager, TokenStore } from './client-auth/index.js';
export type { OAuthStartState, OAuthTokenPayload } from './client-auth/oauth-types.js';
export type {
  GoodVibesAuthLoginOptions,
  GoodVibesCurrentAuth,
  GoodVibesExpiringTokenStore,
  GoodVibesLoginInput,
  GoodVibesLoginOutput,
  GoodVibesTokenStore,
} from './client-auth/types.js';

export interface BrowserTokenStoreOptions {
  readonly key?: string | undefined;
  readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined;
}

/**
 * The combined auth client attached to an platform instance.
 *
 * This interface aggregates token storage and session management behind a
 * single object for convenience. For focused single-responsibility access,
 * use the split classes exposed as readonly getters on this object:
 * - `platform.auth.tokenStore`, Token persistence (`TokenStore`)
 * - `platform.auth.sessionManager`, Login / session lifecycle (`SessionManager`)
 * - `platform.auth.permissionResolver(snapshot)`, Role / scope checks (`PermissionResolver`)
 * - OAuth 2.0 flows: handle server-side (operator/daemon) and provide the acquired
 *   token to the client via TokenStore.
 */
export interface GoodVibesAuthClient {
  readonly writable: boolean;
  /** The underlying `TokenStore`, or null when using a read-only `getAuthToken` resolver. */
  readonly tokenStore: TokenStore | null;
  /** The underlying `SessionManager`, which owns login and current-auth delegation. */
  readonly sessionManager: SessionManager;
  /**
   * Build a `PermissionResolver` from a live auth snapshot.
   *
   * @example
   * const snap = await platform.auth.current();
   * const perm = platform.auth.permissionResolver(snap);
   * if (perm.hasRole('admin')) { ... }
   */
  permissionResolver(snapshot: GoodVibesCurrentAuth): PermissionResolver;
  current(): Promise<GoodVibesCurrentAuth>;
  login(input: GoodVibesLoginInput, options?: GoodVibesAuthLoginOptions): Promise<GoodVibesLoginOutput>;
  /**
   * Refresh the stored token now if it is inside the refresh window. Realtime
   * connectors call this before reading the token so a (re)connect does not
   * present an expired bearer. Does nothing when auto-refresh is off.
   */
  ensureFreshToken(): Promise<void>;
  /** Retrieve the current token. Delegates to `TokenStore.getToken()`. */
  getToken(): Promise<string | null>;
  /**
   * The token to present on a request or connection now: one store read,
   * refreshed first when it is inside the refresh window (auto-refresh on).
   */
  currentToken(): Promise<string | null>;
  /** Persist a token. Delegates to `TokenStore.setToken()`. */
  setToken(token: string | null): Promise<void>;
  /** Clear the stored token. Delegates to `TokenStore.clearToken()`. */
  clearToken(): Promise<void>;
}

/**
 * Options for the auto-refresh feature on the auth client.
 *
 * @see AutoRefreshOptions
 */
export type { AutoRefreshOptions };
export type { AutoRefreshCoordinatorOptions } from './client-auth/index.js';
export type { ControlPlaneAuthMode, ControlPlaneAuthSnapshot } from './client-auth/control-plane-auth-snapshot.js';

function requireStorage(storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const resolved = storage ?? globalThis.localStorage;
  if (!resolved) {
    throw new ConfigurationError(
      'Browser token storage is unavailable. Pass BrowserTokenStoreOptions.storage or use createMemoryTokenStore().',
    );
  }
  return resolved;
}

/**
 * Create a simple in-memory token store.
 *
 * The token is held in a closure variable, it does not survive page
 * refreshes or process restarts. Suitable for server-side scripts and tests.
 *
 * @example
 * import { createMemoryTokenStore } from '@goodvibes/engine/platform';
 *
 * const store = createMemoryTokenStore('initial-token');
 * const platform = createGoodVibesPlatform({ baseUrl: '...', tokenStore: store });
 * await platform.auth.clearToken(); // clears only in-memory
 */
/** The one rule every token store applies to a token it is given: surrounding whitespace is dropped and a blank token is no token. */
function normalizeToken(token: string | null | undefined): string | null {
  const trimmed = token?.trim();
  return trimmed ? trimmed : null;
}

export function createMemoryTokenStore(initialToken: string | null = null, initialExpiresAt?: number): GoodVibesExpiringTokenStore {
  let token = normalizeToken(initialToken);
  // A blank initial token is no token, so it carries no expiry.
  let expiresAt: number | undefined = token === null ? undefined : initialExpiresAt;
  return {
    async getToken(): Promise<string | null> {
      return token;
    },
    async setToken(nextToken: string | null): Promise<void> {
      token = normalizeToken(nextToken);
      // When setToken is called directly (not via setTokenEntry), clear expiry
      // to avoid stale expiry data attached to a manually-set token.
      expiresAt = undefined;
    },
    async clearToken(): Promise<void> {
      token = null;
      expiresAt = undefined;
    },
    async getTokenEntry(): Promise<{ token: string | null; expiresAt?: number }> {
      return expiresAt !== undefined ? { token, expiresAt } : { token };
    },
    async setTokenEntry(nextToken: string | null, nextExpiresAt?: number): Promise<void> {
      token = normalizeToken(nextToken);
      // A blank token is a clear: it carries no expiry of its own.
      expiresAt = token === null ? undefined : nextExpiresAt;
    },
  };
}

/**
 * Create a token store backed by `localStorage` (or a custom `Storage`).
 *
 * The token is persisted across page refreshes under the key
 * `'goodvibes.token'` (overridable via `options.key`).
 * Pass `options.storage` to use `sessionStorage` or a custom adapter.
 *
 * @example
 * import { createBrowserTokenStore } from '@goodvibes/engine/platform/auth';
 * import { createBrowserGoodVibesPlatform } from '@goodvibes/engine/platform/browser';
 *
 * const tokenStore = createBrowserTokenStore({ storage: sessionStorage });
 * const platform = createBrowserGoodVibesPlatform({ tokenStore });
 * await platform.auth.login({ username: 'alice', password: 's3cr3t' });
 * // token is now stored in sessionStorage
 */
export function createBrowserTokenStore(options: BrowserTokenStoreOptions = {}): GoodVibesExpiringTokenStore {
  const storage = requireStorage(options.storage);
  const key = options.key?.trim() || 'goodvibes.token';
  const expiresAtKey = `${key}.expiresAt`;
  return {
    async getToken(): Promise<string | null> {
      return normalizeToken(storage.getItem(key));
    },
    async setToken(token: string | null): Promise<void> {
      const normalized = normalizeToken(token);
      if (!normalized) {
        storage.removeItem(key);
        storage.removeItem(expiresAtKey);
        return;
      }
      // The token and its expiry are two entries, and another tab can read between
      // the writes. Drop the old expiry first so a reader never pairs the new token
      // with the previous token's expiry (this call carries none).
      storage.removeItem(expiresAtKey);
      storage.setItem(key, normalized);
    },
    async clearToken(): Promise<void> {
      storage.removeItem(key);
      storage.removeItem(expiresAtKey);
    },
    async getTokenEntry(): Promise<{ token: string | null; expiresAt?: number }> {
      const token = normalizeToken(storage.getItem(key));
      const expiresAtStr = storage.getItem(expiresAtKey);
      const expiresAtRaw = expiresAtStr ? Number(expiresAtStr) : NaN;
      const finalExpiresAt = Number.isFinite(expiresAtRaw) && expiresAtRaw > 0
        ? expiresAtRaw
        : undefined;
      return finalExpiresAt !== undefined ? { token, expiresAt: finalExpiresAt } : { token };
    },
    async setTokenEntry(token: string | null, expiresAt?: number): Promise<void> {
      const normalized = normalizeToken(token);
      if (!normalized) {
        storage.removeItem(key);
        storage.removeItem(expiresAtKey);
        return;
      }
      // The expiry goes first. A reader that lands between the writes then sees the
      // old token with the new expiry, which at worst costs a 401 and a refresh;
      // the other order pairs the new token with an expired old expiry and starts
      // a refresh the new token never needed.
      if (expiresAt !== undefined) {
        storage.setItem(expiresAtKey, String(expiresAt));
      } else {
        storage.removeItem(expiresAtKey);
      }
      storage.setItem(key, normalized);
    },
  };
}

async function readToken(
  tokenStore: GoodVibesTokenStore | null,
  getAuthToken?: AuthTokenResolver,
): Promise<string | null> {
  if (tokenStore) {
    return await tokenStore.getToken();
  }
  if (getAuthToken) {
    return (await getAuthToken()) ?? null;
  }
  return null;
}

function assertWritableTokenStore(tokenStore: GoodVibesTokenStore | null): GoodVibesTokenStore {
  if (!tokenStore) {
    throw new ConfigurationError(
      'This platform instance uses a read-only auth token resolver. Pass tokenStore to enable token persistence and mutation.',
    );
  }
  return tokenStore;
}

/**
 * Create the auth client attached to an platform instance.
 *
 * Normally called internally by `createGoodVibesPlatform`. Access the result via
 * `platform.auth`.
 *
 * @example
 * import { createGoodVibesPlatform, createBrowserTokenStore } from '@goodvibes/engine/platform';
 *
 * const platform = createGoodVibesPlatform({
 *   baseUrl: 'https://daemon.example.com',
 *   tokenStore: createBrowserTokenStore(),
 * });
 *
 * // Login and persist the token automatically:
 * const { token } = await platform.auth.login({ username: 'alice', password: 's3cr3t' });
 * console.log('logged in, token stored:', token.slice(0, 8) + '...');
 *
 * // Later: clear the session
 * await platform.auth.clearToken();
 */
export function createGoodVibesAuthClient(
  operator: OperatorApiClient,
  tokenStore: GoodVibesTokenStore | null,
  getAuthToken?: AuthTokenResolver,
  observer?: PlatformObserver | undefined,
  autoRefreshOptions?: AutoRefreshOptions,
  /**
   * Optional pre-built `AutoRefreshCoordinator`. When provided, it is reused
   * directly (no new coordinator is constructed) and it must be the one the
   * operator's transport runs as its auto-refresh middleware, as
   * `createGoodVibesPlatform` installs it: the transport then owns the
   * pre-flight refresh and the one refresh-and-retry on a 401, and `current()`
   * adds no second retry of its own. `null` means no coordinator at all.
   */
  existingCoordinator?: AutoRefreshCoordinator | null,
): GoodVibesAuthClient {
  // Construct the split-class instances that own each concern.
  // The facade delegates to these rather than duplicating logic.
  const ts: TokenStore | null = tokenStore ? new TokenStore(tokenStore) : null;
  const sm: SessionManager = new SessionManager(operator, ts, observer);
  // A caller's coordinator already runs as the transport's middleware, so the
  // transport refreshes and retries; only a coordinator built here wraps calls.
  const transportRefreshes = existingCoordinator !== undefined && existingCoordinator !== null;

  // Use the provided coordinator if available; otherwise build one.
  // `existingCoordinator !== undefined` handles the null case: null means
  // "caller explicitly decided no coordinator"; undefined means "not provided, build one".
  const coordinator: AutoRefreshCoordinator | null = existingCoordinator !== undefined
    ? existingCoordinator
    : (() => {
        const autoRefresh = autoRefreshOptions?.autoRefresh ?? true;
        const refreshLeewayMs = autoRefreshOptions?.refreshLeewayMs ?? 60_000;
        return tokenStore && autoRefresh
          ? new AutoRefreshCoordinator({
              tokenStore,
              autoRefresh,
              refreshLeewayMs,
              ...(autoRefreshOptions?.refresh !== undefined ? { refresh: autoRefreshOptions.refresh } : {}),
              ...(autoRefreshOptions?.now !== undefined ? { now: autoRefreshOptions.now } : {}),
              observer,
            })
          : null;
      })();

  return {
    get writable(): boolean {
      return sm.writable;
    },
    get tokenStore(): TokenStore | null {
      return ts;
    },
    get sessionManager(): SessionManager {
      return sm;
    },
    permissionResolver(snapshot: GoodVibesCurrentAuth): PermissionResolver {
      // Passed unconverted on purpose. The contract-derived shape of
      // `control.auth.current` must stay assignable to ControlPlaneAuthSnapshot,
      // the shape PermissionResolver reads; the `as unknown as` that used to sit
      // here hid any drift between them from the compiler.
      return new PermissionResolver(snapshot);
    },
    async current(): Promise<GoodVibesCurrentAuth> {
      if (coordinator && !transportRefreshes) {
        await coordinator.ensureFreshToken();
        return coordinator.withRetryOn401(() => sm.current());
      }
      return sm.current();
    },
    async login(
      input: GoodVibesLoginInput,
      options: GoodVibesAuthLoginOptions = {},
    ): Promise<GoodVibesLoginOutput> {
      // Capture prior auth state BEFORE the login mutation so the observer's
      // `from` field reflects the actual pre-login state (anonymous vs token
      // refresh), not the post-login state.
      const priorToken = await ts?.getToken();
      const { result, persisted } = await sm.loginReporting(input, options);
      // Notify observer of the auth state transition. Observer errors are
      // isolated and reported by invokeObserver. `to` is what the session
      // manager did: 'token' only when it stored the token.
      invokeObserver(() =>
        observer?.onAuthTransition?.({
          from: priorToken ? 'token' : 'anonymous',
          to: persisted ? 'token' : 'credential',
          reason: 'login',
        }),
        { label: 'onAuthTransition' },
      );
      return result;
    },
    async ensureFreshToken(): Promise<void> {
      if (coordinator) await coordinator.ensureFreshToken();
    },
    async getToken(): Promise<string | null> {
      if (ts) {
        return ts.getToken();
      }
      return await readToken(null, getAuthToken);
    },
    async currentToken(): Promise<string | null> {
      if (coordinator) return coordinator.currentToken();
      if (ts) return ts.getToken();
      return await readToken(null, getAuthToken);
    },
    async setToken(token: string | null): Promise<void> {
      const priorToken = await ts?.getToken();
      await assertWritableTokenStore(ts).setToken(token);
      // A token the caller sets is never an automatic refresh: it starts a
      // session, replaces one, or (null) ends it.
      invokeObserver(() =>
        observer?.onAuthTransition?.({
          from: priorToken ? 'token' : 'anonymous',
          to: token ? 'token' : 'anonymous',
          reason: !token ? 'logout' : priorToken ? 'replace' : 'login',
        }),
        { label: 'onAuthTransition' },
      );
    },
    async clearToken(): Promise<void> {
      // assertWritableTokenStore first: throws ConfigurationError when no tokenStore,
      // regardless of current token value (read-only resolvers have no store at all).
      const store = assertWritableTokenStore(ts);
      const currentToken = await ts?.getToken();
      await store.clearToken();
      // Notify observer of the auth state transition. Always fire, even for
      // anonymous→anonymous, so callers that explicitly call clearToken receive
      // the expected transition event.
      invokeObserver(() =>
        observer?.onAuthTransition?.({
          from: currentToken ? 'token' : 'anonymous',
          to: 'anonymous',
          reason: 'logout',
        }),
        { label: 'onAuthTransition' },
      );
    },
  };
}
