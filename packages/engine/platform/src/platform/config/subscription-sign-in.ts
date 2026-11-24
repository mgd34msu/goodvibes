/**
 * subscription-sign-in.ts, a subscription sign-in (a provider reached through
 * a link the person opens), the one code path the terminal's `/provider
 * sign-in` and the daemon's `providers.subscription.signIn.*` methods share.
 *
 * Begin: the authorization address, and, when the provider returns to a local
 * address and the person is on this machine, a listener that finishes the
 * sign-in on its own when the browser comes back. Finish: a pasted code or
 * redirect address. The tokens go to the subscription store (the secret
 * store) and are never returned or logged: the result names the provider,
 * the token type and when it ends.
 */
import { createOAuthLocalListener } from './oauth-local-listener.js';
import { getSubscriptionProviderConfig } from './subscription-providers.js';
import type { OAuthProviderConfig, ProviderSubscription, SubscriptionManager } from './subscriptions.js';
import type { ServiceConfig } from './service-registry.js';

export type AuthorizationInput =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Read what a user pasted to finish a sign-in: a redirect URL or a bare code.
 * A redirect URL must carry a code, must not report a provider error, and, when
 * the login's pending state is known, must echo that state.
 */
export function readAuthorizationInput(input: string, pendingState?: string | undefined): AuthorizationInput {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'No authorization code was given.' };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: true, code: trimmed };
  }
  // Only a web redirect is a URL here; a code such as `abc:def` is still a code.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: true, code: trimmed };
  const error = url.searchParams.get('error');
  if (error) {
    const description = url.searchParams.get('error_description');
    return { ok: false, reason: `The provider returned an error: ${error}${description ? ` (${description})` : ''}. Start the login again.` };
  }
  const state = url.searchParams.get('state');
  if (pendingState !== undefined && state !== null && state !== pendingState) {
    return { ok: false, reason: 'The pasted address belongs to a different login attempt (state mismatch). Paste the redirect from the latest start, or start again.' };
  }
  const code = url.searchParams.get('code');
  if (!code) return { ok: false, reason: 'The pasted address has no code parameter. Paste the full redirect address or the code itself.' };
  return { ok: true, code };
}

/** What a sign-in needs from its host. */
export interface SubscriptionSignInDeps {
  readonly manager: Pick<SubscriptionManager, 'beginOAuthLogin' | 'completeOAuthLogin' | 'getPending'>;
  /** The provider's own service entry, when the person declared one. */
  readonly service: (provider: string) => ServiceConfig | null | undefined;
}

/** Refused before anything starts: the provider has no subscription sign-in. */
export class SubscriptionSignInUnavailableError extends Error {
  constructor(readonly provider: string) {
    super(`${provider} has no subscription sign-in.`);
    this.name = 'SubscriptionSignInUnavailableError';
  }
}

/** The address a sign-in returns to: the local listener's, or the address the provider shows the code at. */
function returnConfig(config: OAuthProviderConfig, listens: boolean): OAuthProviderConfig {
  if (!listens || !config.localCallback) return config.manualRedirectUri ? { ...config, redirectUri: config.manualRedirectUri } : config;
  return config;
}

export interface StartedSubscriptionSignIn {
  readonly provider: string;
  readonly source: 'service' | 'builtin';
  /** The address the person opens to sign in. */
  readonly authorizationUrl: string;
  /**
   * `on-its-own`: the browser comes back to a listener on this machine and the
   * sign-in finishes then (`completion` settles); `paste`: the page shows a
   * code or an address to paste into finish.
   */
  readonly finishes: 'on-its-own' | 'paste';
  /** Why it cannot finish on its own, when it was meant to. */
  readonly listenerNote?: string | undefined;
  /** Settles when the listener finished it (or failed); null when it finishes by paste. */
  readonly completion: Promise<ProviderSubscription> | null;
  /** Stop listening (the paste path stays open). */
  close(): void;
}

/**
 * Begin a sign-in. `listen`: wait for the browser to come back to this machine
 * (only when the provider returns to a local address).
 */
export async function beginSubscriptionSignIn(deps: SubscriptionSignInDeps, provider: string, listen: boolean): Promise<StartedSubscriptionSignIn> {
  const resolved = getSubscriptionProviderConfig(provider, deps.service(provider));
  if (!resolved) throw new SubscriptionSignInUnavailableError(provider);
  const listens = listen && Boolean(resolved.oauth.localCallback);
  let config = returnConfig(resolved.oauth, listens);
  let listener: Awaited<ReturnType<typeof createOAuthLocalListener>> | null = null;
  let listenerNote: string | undefined;
  if (listens && resolved.oauth.localCallback) {
    listener = await createOAuthLocalListener({
      expectedState: '',
      host: resolved.oauth.localCallback.host,
      port: resolved.oauth.localCallback.port,
      path: resolved.oauth.localCallback.path,
    }).catch((error: unknown) => {
      listenerNote = `It cannot finish on its own (${error instanceof Error ? error.message : String(error)}).`;
      return null;
    });
  }
  if (listener) config = { ...config, redirectUri: listener.redirectUri };
  let started: Awaited<ReturnType<SubscriptionSignInDeps['manager']['beginOAuthLogin']>>;
  try {
    started = await deps.manager.beginOAuthLogin(provider, config);
  } catch (error) {
    listener?.close();
    throw error;
  }
  listener?.setExpectedState(started.pending.state);
  const autoComplete = Boolean(listener) && (resolved.oauth.localCallback?.autoComplete ?? true);
  const finalConfig = config;
  const completion = autoComplete && listener
    ? listener.waitForCode().then((callback) => deps.manager.completeOAuthLogin(provider, finalConfig, callback.code)).finally(() => listener?.close())
    : null;
  if (!autoComplete) listener?.close();
  // A caller that does not wait (the paste path won, the listener was closed) leaves no unhandled rejection.
  void completion?.catch(() => {});
  return {
    provider,
    source: resolved.source,
    authorizationUrl: started.authorizationUrl,
    finishes: completion ? 'on-its-own' : 'paste',
    ...(listenerNote ? { listenerNote } : {}),
    completion,
    close: () => listener?.close(),
  };
}

/** Finish a sign-in with what the person pasted (a code or the redirect address). */
export async function finishSubscriptionSignIn(deps: SubscriptionSignInDeps, provider: string, codeOrAddress: string): Promise<ProviderSubscription> {
  const resolved = getSubscriptionProviderConfig(provider, deps.service(provider));
  if (!resolved) throw new SubscriptionSignInUnavailableError(provider);
  const authorization = readAuthorizationInput(codeOrAddress, deps.manager.getPending(provider)?.state);
  if (!authorization.ok) throw new Error(authorization.reason);
  return deps.manager.completeOAuthLogin(provider, returnConfig(resolved.oauth, false), authorization.code);
}
