import type { ProviderAuthFreshness, ProviderAuthRoute } from '@goodvibes/engine/platform/platform/runtime/shell';
import { listBuiltinSubscriptionProviders, subscriptionAuthFreshness, subscriptionState } from '@goodvibes/engine/platform/platform/config';
import type { SubscriptionManager } from '@goodvibes/engine/platform/platform/config';
import type { ServiceInspectionQuery } from '@goodvibes/engine/platform/platform/runtime/ui';
export interface SubscriptionEntry {
    provider: string;
    state: 'active' | 'pending' | 'available';
    tokenType?: string | undefined;
    expiresAt?: number | undefined;
    oauthConfigured: boolean;
    activeRoute?: ProviderAuthRoute | undefined;
    preferredRoute?: ProviderAuthRoute | undefined;
    authFreshness?: ProviderAuthFreshness | undefined;
    routeReason?: string | undefined;
    issues?: string[] | undefined;
    nextActions?: string[] | undefined;
}
export interface SubscriptionEntryHints {
    readonly login: (provider: string) => string;
    readonly finish: (provider: string) => string;
}
const DEFAULT_HINTS: SubscriptionEntryHints = {
    login: provider => `Use /provider sign-in ${provider} to begin browser sign-in.`,
    finish: provider => `Finish with /provider finish ${provider} <code> to activate this session.`,
};
export function buildSubscriptionEntries(manager: SubscriptionManager | null, serviceRegistry: Pick<ServiceInspectionQuery, 'getAll'> | null, hints: SubscriptionEntryHints = DEFAULT_HINTS): SubscriptionEntry[] {
    if (!manager)
        return [];
    const services = serviceRegistry?.getAll() ?? {};
    const providers = new Map<string, SubscriptionEntry>();
    const builtinProviders = new Set(listBuiltinSubscriptionProviders().map((builtin) => builtin.provider));
    for (const provider of builtinProviders) {
        providers.set(provider, {
            provider,
            state: 'available',
            oauthConfigured: true,
            preferredRoute: 'subscription',
            activeRoute: 'unconfigured',
            authFreshness: 'unconfigured',
            routeReason: 'Built-in subscription adapter is available, but no active subscription session is stored yet.',
            nextActions: [hints.login(provider)],
        });
    }
    for (const service of Object.values(services)) {
        if (service.authType !== 'oauth' || !service.oauth)
            continue;
        const provider = service.providerId ?? service.name;
        providers.set(provider, {
            provider,
            state: 'available',
            oauthConfigured: true,
            preferredRoute: 'subscription',
            activeRoute: providers.get(provider)?.activeRoute ?? 'unconfigured',
            authFreshness: providers.get(provider)?.authFreshness ?? 'unconfigured',
            routeReason: providers.get(provider)?.routeReason ?? 'OAuth metadata is configured for this provider.',
            nextActions: providers.get(provider)?.nextActions ?? [hints.login(provider)],
        });
    }
    for (const pending of manager.listPending()) {
        providers.set(pending.provider, {
            provider: pending.provider,
            state: 'pending',
            oauthConfigured: providers.get(pending.provider)?.oauthConfigured ?? false,
            preferredRoute: 'subscription',
            activeRoute: 'unconfigured',
            authFreshness: 'pending',
            routeReason: 'OAuth login is pending completion for this provider.',
            nextActions: [hints.finish(pending.provider)],
        });
    }
    for (const subscription of manager.list()) {
        // The platform's one reading of a stored session: a revoked one is
        // ended, and a lapsed access token with a refresh token renews itself.
        const lifecycle = subscriptionState(subscription);
        const freshness = subscriptionAuthFreshness(subscription);
        const issues = lifecycle === 'revoked'
            ? ['The provider ended this subscription session; it can no longer be used.']
            : lifecycle === 'expired'
                ? ['Stored subscription session is expired and has no refresh token.']
                : lifecycle === 'expiring'
                    ? ['Stored subscription session expires within 24 hours and cannot renew itself.']
                    : [];
        const nextActions = lifecycle === 'revoked' || lifecycle === 'expired'
            ? [hints.login(subscription.provider)]
            : lifecycle === 'expiring'
                ? [`Sign in to ${subscription.provider} again before it expires: ${hints.login(subscription.provider)}`]
                : [];
        providers.set(subscription.provider, {
            provider: subscription.provider,
            state: 'active',
            tokenType: subscription.tokenType,
            expiresAt: subscription.expiresAt,
            oauthConfigured: providers.get(subscription.provider)?.oauthConfigured ?? builtinProviders.has(subscription.provider),
            activeRoute: freshness === 'expired' ? 'unconfigured' : 'subscription',
            preferredRoute: 'subscription',
            authFreshness: freshness,
            routeReason: subscription.overrideAmbientApiKeys
                ? 'Subscription route overrides ambient API-key resolution for this provider.'
                : 'Subscription route is stored for supported flows without automatically replacing ambient API-key resolution.',
            issues,
            nextActions,
        });
    }
    return [...providers.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}
export function inferSubscriptionRouteReason(entry: SubscriptionEntry): string | undefined {
  if (entry.routeReason?.trim()) return entry.routeReason;
  if (entry.state === 'active' && entry.oauthConfigured) {
    return 'ambient key override enabled for this provider.';
  }
  if (entry.state === 'pending' && entry.oauthConfigured) {
    return 'oauth configuration present; ambient key override will apply after activation.';
  }
  return undefined;
}

export type AuthorizationInput =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Read what a user pasted for `login ... finish`: a redirect URL or a bare code.
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
