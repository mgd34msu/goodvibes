/**
 * routes/provider-sign-in.ts, a subscription sign-in started from any client
 * (the web UI's "Sign in again"), run by the daemon on the same code path the
 * terminal's `/provider sign-in` uses (config/subscription-sign-in.ts).
 *
 * begin answers the address to open and how it finishes: on its own, when the
 * browser comes back to the daemon's machine (the daemon then stores the
 * sign-in and announces it with PROVIDERS_CHANGED), or by pasting the code or
 * the address the provider shows into finish. Tokens go to the subscription
 * store; no answer and no log carries them. An API-key provider is signed in
 * by storing its key with credentials.set.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler, GatewayMethodInvocation } from '../method-catalog-shared.js';
import { readInvocationParams, requireStringValue } from './invocation-params.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import {
  beginSubscriptionSignIn, finishSubscriptionSignIn, SubscriptionSignInUnavailableError, type StartedSubscriptionSignIn, type SubscriptionSignInDeps,
} from '../../config/subscription-sign-in.js';
import type { ProviderSubscription } from '../../config/subscriptions.js';
import type { SecretsManager } from '../../config/secrets.js';
import { resolveSecretWriteScope } from '../../config/secrets.js';
import { findCredentialScopeDeclaration } from '../../config/credential-scope-registry.js';
import { BUILTIN_PROVIDER_ENV_KEYS } from '../../config/provider-credential-catalog.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

export interface ProviderSignInDeps extends SubscriptionSignInDeps {
  /** Told when a sign-in was stored (the registry recomputes and announces PROVIDERS_CHANGED). */
  readonly signedIn: (provider: string) => void;
  /** For providers.apiKey.set: the registry (to find the provider's key name and read credentials again) and the secret store. */
  readonly apiKeys?: {
    readonly registry: Pick<ProviderRegistry, 'tryGet' | 'refreshProviderCredentials'>;
    readonly secrets: Pick<SecretsManager, 'set'>;
  } | undefined;
}

function requirePrincipal(invocation: GatewayMethodInvocation): void {
  if (!invocation.context.principalId) {
    throw new GatewayVerbError('Sign in first: a provider sign-in needs a signed-in user or a paired device', 'UNAUTHENTICATED', 401);
  }
}

/** What a stored sign-in says: never a token. */
function signedInAnswer(provider: string, record: ProviderSubscription): Record<string, unknown> {
  return { provider, signedIn: true, tokenType: record.tokenType, ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}) };
}

function refusal(error: unknown, provider: string): never {
  if (error instanceof SubscriptionSignInUnavailableError) {
    throw new GatewayVerbError(`${provider} has no subscription sign-in; an API-key provider is signed in by storing its key (credentials.set).`, 'NOT_FOUND', 404, 'provider');
  }
  throw new GatewayVerbError(`The sign-in to ${provider} did not finish: ${summarizeError(error)}`, 'INVALID_ARGUMENT', 400);
}

/** One sign-in waiting on its browser per provider: a new begin replaces it. */
const listening = new Map<string, StartedSubscriptionSignIn>();

function createBeginHandler(deps: ProviderSignInDeps): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    const provider = requireStringValue(readInvocationParams(invocation).provider, 'provider');
    listening.get(provider)?.close();
    listening.delete(provider);
    let started: StartedSubscriptionSignIn;
    try {
      started = await beginSubscriptionSignIn(deps, provider, true);
    } catch (error) { return refusal(error, provider); }
    if (started.completion) {
      listening.set(provider, started);
      started.completion.then((record) => {
        deps.signedIn(provider);
        logger.info('[providers] a subscription sign-in finished on its own', { provider, tokenType: record.tokenType });
      }, (error: unknown) => {
        logger.info('[providers] a subscription sign-in did not finish on its own; finish takes a pasted code', { provider, error: summarizeError(error) });
      }).finally(() => { if (listening.get(provider) === started) listening.delete(provider); });
    }
    return {
      provider,
      authorizationUrl: started.authorizationUrl,
      finishes: started.finishes,
      ...(started.listenerNote ? { listenerNote: started.listenerNote } : {}),
    };
  };
}

function createFinishHandler(deps: ProviderSignInDeps): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    const params = readInvocationParams(invocation);
    const provider = requireStringValue(params.provider, 'provider');
    const code = requireStringValue(params.code, 'code');
    let record: ProviderSubscription;
    try {
      record = await finishSubscriptionSignIn(deps, provider, code);
    } catch (error) { return refusal(error, provider); }
    listening.get(provider)?.close();
    listening.delete(provider);
    deps.signedIn(provider);
    return signedInAnswer(provider, record);
  };
}

/**
 * providers.apiKey.set: an API-key provider signed in from any client. The key
 * is stored under the provider's own key name (its first one the credential
 * scope registry classifies) at the scope the ownership rules resolve, then the
 * registry reads its credentials again. Neither the key nor any part of it is
 * answered or logged: the answer names the provider, the key name and the scope.
 */
function createApiKeyHandler(deps: ProviderSignInDeps): GatewayMethodHandler {
  return async (invocation) => {
    requirePrincipal(invocation);
    const keys = deps.apiKeys;
    if (!keys) throw new GatewayVerbError('This daemon cannot store provider keys.', 'NOT_IMPLEMENTED', 501);
    const params = readInvocationParams(invocation);
    const provider = requireStringValue(params.provider, 'provider');
    const value = typeof params.key === 'string' ? params.key.trim() : '';
    if (!value) throw new GatewayVerbError('key is required: the provider\'s API key.', 'INVALID_ARGUMENT', 400, 'key');
    if (value.startsWith('goodvibes://')) throw new GatewayVerbError('key must be the key itself, not a goodvibes:// reference.', 'INVALID_ARGUMENT', 400, 'key');
    const registered = keys.registry.tryGet(provider);
    if (!registered) throw new GatewayVerbError(`No provider named ${provider} is registered.`, 'NOT_FOUND', 404, 'provider');
    // The built-in catalog's key names (the ones the scope registry files), then the provider's own.
    const names = [...new Set([...(BUILTIN_PROVIDER_ENV_KEYS[provider] ?? []), ...(registered.describeAuthState?.().authEnvVars ?? [])])];
    const keyName = names.find((name) => findCredentialScopeDeclaration(name) !== null);
    if (!keyName) {
      throw new GatewayVerbError(names.length === 0
        ? `${provider} takes no API key; sign it in with providers.subscription.signIn.begin, or it needs none.`
        : `${provider}'s key name (${names.join(', ')}) is not one the daemon files; store it where the provider's file says (its apiKeyEnv).`, 'INVALID_ARGUMENT', 400, 'provider');
    }
    const scope = resolveSecretWriteScope(keyName);
    await keys.secrets.set(keyName, value, { scope });
    await keys.registry.refreshProviderCredentials();
    const signedIn = keys.registry.tryGet(provider)?.isConfigured?.() ?? false;
    deps.signedIn(provider);
    logger.info('[providers] a provider key was stored from a client', { provider, keyName, scope, signedIn });
    return { provider, keyName, scope, signedIn };
  };
}

export function registerProviderSignInGatewayMethods(catalog: GatewayMethodCatalog, deps: ProviderSignInDeps): void {
  for (const [id, factory] of [['providers.subscription.signIn.begin', createBeginHandler], ['providers.subscription.signIn.finish', createFinishHandler], ['providers.apiKey.set', createApiKeyHandler]] as const) {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, factory(deps), { replace: true });
  }
}
