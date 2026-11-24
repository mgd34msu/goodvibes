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
    const pendingProviders = new Set<string>();
    for (const pending of manager.listPending()) {
        pendingProviders.add(pending.provider);
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
        // A sign-in started over the stored session is finished, not started
        // again: a new start replaces the pending attempt and its code.
        const signInPending = pendingProviders.has(subscription.provider);
        const nextActions = signInPending
            ? [hints.finish(subscription.provider)]
            : lifecycle === 'revoked' || lifecycle === 'expired'
                ? [hints.login(subscription.provider)]
                : lifecycle === 'expiring'
                    ? [`Sign in to ${subscription.provider} again before it expires: ${hints.login(subscription.provider)}`]
                    : [];
        const routeReason = subscription.overrideAmbientApiKeys
            ? 'Subscription route overrides ambient API-key resolution for this provider.'
            : 'Subscription route is stored for supported flows without automatically replacing ambient API-key resolution.';
        providers.set(subscription.provider, {
            provider: subscription.provider,
            state: 'active',
            tokenType: subscription.tokenType,
            expiresAt: subscription.expiresAt,
            oauthConfigured: providers.get(subscription.provider)?.oauthConfigured ?? builtinProviders.has(subscription.provider),
            activeRoute: freshness === 'expired' ? 'unconfigured' : 'subscription',
            preferredRoute: 'subscription',
            authFreshness: freshness,
            routeReason: signInPending
                ? `${routeReason} A new sign-in is waiting to be finished; the stored session stays in use until it is.`
                : routeReason,
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

/** What the settings screen says when a sign-out removed the record but its tokens stayed in the secret store; `reason` is the failure, summarized. */
export function subscriptionTokensNotRemovedMessage(provider: string, reason: string): string {
  return `Signed out ${provider}, but its sign-in tokens could not be removed from the secret store: ${reason} Run /provider sign-out ${provider} to try again.`;
}

