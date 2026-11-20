/**
 * SessionManager, Focused responsibility: session lifecycle.
 *
 * Manages the login/logout lifecycle and ties token persistence to login
 * results. Decoupled from transport and token storage implementations.
 */

import type { OperatorApiClient } from '@goodvibes/engine/operator-client';
import type {
  GoodVibesAuthLoginOptions,
  GoodVibesCurrentAuth,
  GoodVibesLoginInput,
  GoodVibesLoginOutput,
} from './types.js';
import { TokenStore } from './token-store.js';
import type { PlatformObserver } from '../observer/index.js';

export class SessionManager {
  readonly #operator: OperatorApiClient;
  readonly #tokenStore: TokenStore | null;
  readonly #observer: PlatformObserver | undefined;

  constructor(operator: OperatorApiClient, tokenStore: TokenStore | null, observer?: PlatformObserver) {
    this.#operator = operator;
    this.#tokenStore = tokenStore;
    this.#observer = observer;
  }

  /**
   * Return the current auth state from the daemon control plane.
   * Does not require a writable token store.
   */
  async current(): Promise<GoodVibesCurrentAuth> {
    return this.#operator.control.auth.current();
  }

  /**
   * Perform a login and, when `persistToken` is not false, automatically
   * persist the returned token into the configured token store.
   * The `expiresAt` from the login response is also persisted when the store
   * supports `setTokenEntry`.
   */
  async login(
    input: GoodVibesLoginInput,
    options: GoodVibesAuthLoginOptions = {},
  ): Promise<GoodVibesLoginOutput> {
    return (await this.loginReporting(input, options)).result;
  }

  /**
   * {@link SessionManager.login}, also saying whether the token was stored: `persisted` is
   * true only when it was written to the token store, so an observer never
   * reads a login that stored nothing as a stored token.
   */
  async loginReporting(
    input: GoodVibesLoginInput,
    options: GoodVibesAuthLoginOptions = {},
  ): Promise<{ readonly result: GoodVibesLoginOutput; readonly persisted: boolean }> {
    const result = await this.#operator.control.auth.login(input);
    let persisted = false;
    if ((options.persistToken ?? true) && this.#tokenStore) {
      // Prefer setTokenEntry to persist expiry alongside the token.
      if (result.expiresAt) {
        await this.#tokenStore.setTokenEntry(result.token, result.expiresAt);
      } else {
        await this.#tokenStore.setToken(result.token);
      }
      persisted = true;
    }
    // Note: observer notification is intentionally NOT emitted here. The
    // `createGoodVibesAuthClient` facade in `../auth.ts` owns the observer
    // wiring with full priorToken awareness (anonymous→token vs token→token);
    // emitting here would produce duplicate transitions. The `#observer` field
    // is retained for future use cases that bypass the facade.
    return { result, persisted };
  }

  /**
   * Whether this session manager has a writable token store.
   * Read-only instances (using a raw `getAuthToken` resolver) return false.
   */
  get writable(): boolean {
    return this.#tokenStore !== null;
  }

  /** Access the underlying TokenStore (null when using a read-only resolver). */
  get tokenStore(): TokenStore | null {
    return this.#tokenStore;
  }
}
