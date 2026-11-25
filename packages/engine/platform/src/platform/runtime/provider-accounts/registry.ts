import { listBuiltinSubscriptionProviders } from '../../config/subscription-providers.js';
import { resolveApiKeys } from '../../config/index.js';
import type { SecretsManager } from '../../config/secrets.js';
import { unreadableSecretStore, type StoredSecretReader } from '../../config/secret-store-unreadable.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import type { ProviderRuntimeMetadata } from '../../providers/interface.js';
import { decodeJwtPayload } from '../auth/oauth-core.js';
import type { ServiceRegistry } from '../../config/service-registry.js';
import { subscriptionAuthFreshness, type SubscriptionManager } from '../../config/subscriptions.js';

export type ProviderAuthRoute = 'api-key' | 'subscription' | 'service-oauth' | 'unconfigured';
export type ProviderAuthFreshness = 'healthy' | 'expiring' | 'expired' | 'pending' | 'unconfigured';

export interface ProviderUsageWindow {
  readonly label: string;
  readonly detail: string;
}

export interface ProviderRouteRecord {
  readonly route: Exclude<ProviderAuthRoute, 'unconfigured'>;
  readonly usable: boolean;
  readonly freshness: ProviderAuthFreshness;
  readonly detail: string;
  readonly issues: readonly string[];
}

/**
 * One recommended repair action. `description` states what and why;
 * `command` (when present) is the machine-executable form, a surface runs
 * it directly instead of asking the user to retype a sentence.
 */
export interface ProviderRecommendedAction {
  readonly description: string;
  readonly command?: { readonly name: string; readonly args: readonly string[] } | undefined;
}

export interface ProviderAccountRecord {
  readonly providerId: string;
  readonly active: boolean;
  readonly modelCount: number;
  readonly configured: boolean;
  readonly oauthReady: boolean;
  readonly pendingLogin: boolean;
  readonly availableRoutes: readonly ProviderAuthRoute[];
  readonly preferredRoute: ProviderAuthRoute;
  readonly activeRoute: ProviderAuthRoute;
  readonly activeRouteReason: string;
  readonly authFreshness: ProviderAuthFreshness;
  readonly fallbackRoute?: ProviderAuthRoute | undefined;
  readonly fallbackRisk?: string | undefined;
  readonly expiresAt?: number | undefined;
  readonly tokenType?: string | undefined;
  readonly notes: readonly string[];
  readonly usageWindows: readonly ProviderUsageWindow[];
  readonly issues: readonly string[];
  readonly recommendedActions: readonly ProviderRecommendedAction[];
  readonly routeRecords: readonly ProviderRouteRecord[];
}

export interface ProviderAccountSnapshot {
  readonly capturedAt: number;
  readonly providers: readonly ProviderAccountRecord[];
  readonly configuredCount: number;
  readonly issueCount: number;
  /** Set when the services file is unusable, so a missing service-backed account is not read as "none configured". */
  readonly servicesUnreadable?: string;
}

export interface ProviderAccountSnapshotDeps {
  readonly providerRegistry: Pick<ProviderRegistry, 'listModels' | 'getCurrentModel' | 'getRegistered' | 'describeRuntime'>;
  readonly serviceRegistry: Pick<ServiceRegistry, 'getAll' | 'inspect'> & Partial<Pick<ServiceRegistry, 'unreadableReason'>>;
  readonly subscriptionManager: Pick<SubscriptionManager, 'list' | 'listPending' | 'get' | 'getPending'>;
  readonly secretsManager: Pick<SecretsManager, 'get'>;
}

function builtinWindowsForProvider(providerId: string): readonly ProviderUsageWindow[] {
  if (providerId === 'openai') {
    return [
      { label: '5-hour window', detail: 'Subscription-backed Codex access may be constrained by rolling 5-hour usage limits.' },
      { label: '1-week window', detail: 'Subscription-backed Codex access may also be constrained by a rolling weekly limit.' },
    ];
  }
  return [];
}

function classifyRoutes(input: {
  providerId: string;
  hasApiKey: boolean;
  hasSubscription: boolean;
  hasServiceOAuth: boolean;
}): readonly ProviderAuthRoute[] {
  const routes: ProviderAuthRoute[] = [];
  if (input.hasApiKey) routes.push('api-key');
  if (input.hasSubscription) routes.push('subscription');
  if (input.hasServiceOAuth) routes.push('service-oauth');
  if (routes.length === 0) routes.push('unconfigured');
  return routes;
}

/**
 * A stored subscription is used ahead of an ambient API key only when it was set to override ambient
 * keys (`overrideAmbientApiKeys`, the rule `SubscriptionManager.getAccessToken` applies); otherwise the
 * ambient key stays the active route and the subscription is the route used when no key exists.
 */
function determineActiveRoute(routes: readonly ProviderAuthRoute[], subscriptionOverridesApiKey: boolean): ProviderAuthRoute {
  if (routes.includes('subscription') && (subscriptionOverridesApiKey || !routes.includes('api-key'))) return 'subscription';
  if (routes.includes('service-oauth')) return 'service-oauth';
  if (routes.includes('api-key')) return 'api-key';
  return 'unconfigured';
}

function defaultProviderEnvKeys(providerId: string): readonly string[] {
  const normalized = providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized ? [`${normalized}_API_KEY`, `${normalized}_KEY`] : [];
}

export async function buildProviderAccountSnapshot(
  deps: ProviderAccountSnapshotDeps,
): Promise<ProviderAccountSnapshot> {
  const providerRegistry = deps.providerRegistry;
  const allModels = providerRegistry.listModels();
  // Read-only display path: an unresolved current model (e.g. a fresh isolated
  // home whose pricing catalog has not hydrated, leaving the configured default
  // with no materialized definition) must not turn this snapshot into a 500. Fall
  // back to "no active provider" instead of letting getCurrentModel() throw.
  let currentModel: ReturnType<NonNullable<typeof providerRegistry.getCurrentModel>> | undefined;
  try {
    currentModel = providerRegistry.getCurrentModel?.();
  } catch {
    currentModel = undefined;
  }
  // A store that cannot be read says nothing about a key; the environment answer stands.
  const secrets: Pick<SecretsManager, 'get'> = {
    get: async (key) => { try { return await deps.secretsManager.get(key); } catch { return null; } },
  };
  const apiKeys = await resolveApiKeys(secrets);
  const subscriptions = deps.subscriptionManager;
  const builtinSubscriptionProviders = new Set(listBuiltinSubscriptionProviders().map((entry) => entry.provider));
  const serviceRegistry = deps.serviceRegistry;
  const serviceConfigs = serviceRegistry.getAll();
  const servicesUnreadable = serviceRegistry.unreadableReason?.() ?? null;
  const services = Object.values(serviceConfigs);
  const serviceInspections = await Promise.all(Object.keys(serviceConfigs).map(async (name) => ({
    name,
    inspection: await serviceRegistry.inspect(name),
  })));
  const serviceOauthByProvider = new Map<string, { configured: boolean; usable: boolean }>();
  for (const { inspection } of serviceInspections) {
    if (!inspection || inspection.config.authType !== 'oauth') continue;
    const providerId = inspection.config.providerId ?? inspection.config.name;
    const existing = serviceOauthByProvider.get(providerId);
    serviceOauthByProvider.set(providerId, {
      configured: true,
      usable: Boolean(existing?.usable || inspection.hasPrimaryCredential),
    });
  }
  const providerIds = new Set<string>([
    ...allModels.map((model) => model.provider),
    ...Object.keys(apiKeys),
    ...subscriptions.list().map((entry) => entry.provider),
    ...subscriptions.listPending().map((entry) => entry.provider),
    ...services.map((service) => service.providerId ?? service.name),
    ...builtinSubscriptionProviders,
  ]);
  const providers = await Promise.all([...providerIds]
    .sort((a, b) => a.localeCompare(b))
    .map(async (providerId) => {
      const subscription = subscriptions.get(providerId);
      const pending = subscriptions.getPending(providerId);
      // Only the token's own claims (account and plan) are read, to show the owner which sign-in this is.
      const jwtPayload = subscription ? decodeJwtPayload(subscription.accessToken.reveal('owner-screen')) : null;
      const serviceOauth = serviceOauthByProvider.get(providerId);
      let runtimeMetadata: ProviderRuntimeMetadata | undefined;
      try {
        runtimeMetadata = await providerRegistry.describeRuntime(providerId) ?? undefined;
      } catch {
        runtimeMetadata = undefined;
      }
      // The state the token resolver acts on: ended by the provider or lapsed
      // without a refresh token is expired; a refreshable session is healthy.
      const subscriptionFreshness: ProviderAuthFreshness = subscription ? subscriptionAuthFreshness(subscription) : 'unconfigured';
      const subscriptionEnded = subscription?.revokedAt !== undefined;
      // A provider outside the built-in key table (a custom or service-backed
      // one) has its key under the service's token name, the names its runtime
      // declares, or the conventional <ID>_API_KEY; environment first, then the store.
      let hasApiKey = providerId in apiKeys;
      // A secret store this computer could not read: whether a key is stored there is not known. Said as such, and no
      // key is asked for (secret-store-unreadable.ts).
      let keyUnreadable: string | null = null;
      if (!hasApiKey) {
        const serviceConfig = services.find((entry) => (entry.providerId ?? entry.name) === providerId);
        const candidates = new Set<string>([
          ...(serviceConfig?.tokenKey ? [serviceConfig.tokenKey] : []),
          ...(runtimeMetadata?.auth?.envVars ?? []),
          ...defaultProviderEnvKeys(providerId),
        ]);
        hasApiKey = (await Promise.all([...candidates].map(async (key) => {
          if (process.env[key]) return true;
          return (await secrets.get(key)) !== null;
        }))).some(Boolean);
        const firstKey = [...candidates][0];
        if (!hasApiKey && firstKey !== undefined) keyUnreadable = await unreadableSecretStore(deps.secretsManager as unknown as StoredSecretReader, firstKey, `the ${providerId} API key`);
      }
      const routes = classifyRoutes({
        providerId,
        hasApiKey,
        hasSubscription: subscription != null,
        hasServiceOAuth: Boolean(serviceOauth?.configured),
      });
      const usableRoutes = classifyRoutes({
        providerId,
        hasApiKey,
        hasSubscription: subscription != null && subscriptionFreshness !== 'expired',
        hasServiceOAuth: Boolean(serviceOauth?.usable),
      });
      const issues: string[] = [];
      const notes: string[] = [];
      const recommendedActions: ProviderRecommendedAction[] = [];
      const routeRecords: ProviderRouteRecord[] = [];
      const subscriptionOverridesApiKey = subscription?.overrideAmbientApiKeys === true;
      const preferredRoute = determineActiveRoute(routes, subscriptionOverridesApiKey);
      const activeRoute = determineActiveRoute(usableRoutes, subscriptionOverridesApiKey);
      let activeRouteReason = 'No usable auth route is configured for this provider.';
      let authFreshness: ProviderAuthFreshness = 'unconfigured';

      if (hasApiKey) {
        routeRecords.push({
          route: 'api-key',
          usable: true,
          freshness: 'healthy',
          detail: 'Ambient API key is available for direct provider access.',
          issues: [],
        });
      } else if (keyUnreadable) {
        routeRecords.push({ route: 'api-key', usable: false, freshness: 'unconfigured', detail: keyUnreadable, issues: [] });
        issues.push(keyUnreadable);
      }

      if (subscription) {
        const subscriptionIssues: string[] = [];
        if (subscriptionEnded) {
          subscriptionIssues.push('The provider ended this subscription session; it is signed out.');
        } else if (subscriptionFreshness === 'expired') {
          subscriptionIssues.push('Stored subscription session has expired and has no refresh token.');
        } else if (subscriptionFreshness === 'expiring') {
          subscriptionIssues.push('Stored subscription session expires within 24 hours and cannot renew itself.');
        }
        routeRecords.push({
          route: 'subscription',
          usable: subscriptionFreshness !== 'expired',
          freshness: pending ? 'pending' : subscriptionFreshness,
          detail: subscription.overrideAmbientApiKeys
            ? 'Subscription route is configured to override ambient API-key resolution.'
            : 'Subscription route is configured, but ambient API keys remain active unless selected explicitly.',
          issues: subscriptionIssues,
        });
      }

      if (serviceOauth?.configured) {
        const serviceOauthIssues = serviceOauth.usable
          ? []
          : ['Service OAuth path is configured but has no usable stored credential.'];
        routeRecords.push({
          route: 'service-oauth',
          usable: serviceOauth.usable,
          freshness: serviceOauth.usable ? 'healthy' : 'unconfigured',
          detail: serviceOauth.usable
            ? 'Service OAuth credential is available for this provider.'
            : 'Service OAuth metadata exists, but the credential path is incomplete.',
          issues: serviceOauthIssues,
        });
      }

      if (routes.includes('subscription') && routes.includes('api-key')) {
        // Both routes stored is an ordinary configuration, not an issue: the
        // subscription's override setting decides which one is sent.
        notes.push(subscriptionOverridesApiKey
          ? 'Both a subscription and an API key are stored; the subscription overrides the API key.'
          : 'Both a subscription and an API key are stored; the API key is used because the subscription does not override ambient keys.');
      }
      if (subscriptionEnded) {
        issues.push('The provider ended the stored subscription session; sign in again to use it.');
        recommendedActions.push({ description: `Sign in to ${providerId} again; the provider ended the stored session.`, command: { name: 'subscription', args: ['login', providerId, 'start'] } });
      } else if (subscriptionFreshness === 'expired') {
        issues.push('Stored subscription session has expired and cannot refresh itself; sign in again to use it.');
        recommendedActions.push({ description: `Sign in to ${providerId} again; the stored session expired and holds no refresh token.`, command: { name: 'subscription', args: ['login', providerId, 'start'] } });
      } else if (subscriptionFreshness === 'expiring') {
        issues.push('Stored subscription session expires within 24 hours and cannot refresh itself.');
        recommendedActions.push({ description: `Sign in to ${providerId} again before the stored session expires.`, command: { name: 'subscription', args: ['login', providerId, 'start'] } });
      }
      if (pending) {
        issues.push('Provider has a pending OAuth login that has not been completed yet.');
        recommendedActions.push({ description: `Finish the pending ${providerId} subscription login (or clear it).`, command: { name: 'subscription', args: ['login', providerId, 'finish'] } });
      }
      if (serviceOauth?.configured && !serviceOauth.usable) {
        issues.push('Service OAuth is configured but missing a usable credential.');
        recommendedActions.push({ description: `Repair service OAuth credentials for ${providerId}.`, command: { name: 'services', args: [providerId] } });
      }
      if (keyUnreadable) {
        // Nothing is asked for again: the key may well be stored; the store is what needs repair.
        recommendedActions.push({ description: `Make the secret store on this computer readable (its key file must be the one the store was written with); the ${providerId} key is not asked for again.` });
      } else if (!routes.includes('api-key') && !routes.includes('subscription') && !routes.includes('service-oauth')) {
        recommendedActions.push({ description: `Configure an API key or OAuth-backed route for ${providerId}.`, command: { name: 'secrets', args: ['set', ...(runtimeMetadata?.auth?.envVars?.slice(0, 1) ?? [])] } });
      } else if (activeRoute === 'unconfigured') {
        recommendedActions.push({ description: `No currently usable auth path exists for ${providerId}; repair the preferred route.` });
      }
      if (preferredRoute !== 'unconfigured' && activeRoute !== preferredRoute && activeRoute !== 'unconfigured') {
        issues.push(`Preferred ${preferredRoute} path is unavailable; current usable route is ${activeRoute}.`);
        recommendedActions.push({ description: `Review why ${providerId} fell back from ${preferredRoute} to ${activeRoute}.` });
      }
      if (jwtPayload && typeof jwtPayload['iss'] === 'string') {
        notes.push(`issuer=${jwtPayload['iss']}`);
      }
      if (runtimeMetadata?.notes) {
        notes.push(...runtimeMetadata.notes);
      }
      if (runtimeMetadata?.usage?.notes) {
        notes.push(...runtimeMetadata.usage.notes);
      }
      if (runtimeMetadata?.policy?.notes) {
        notes.push(...runtimeMetadata.policy.notes);
      }
      if (builtinSubscriptionProviders.has(providerId)) {
        notes.push('Built-in subscription adapter available.');
        if (!subscription && !pending) {
          recommendedActions.push({ description: `Start a ${providerId} subscription login to enable the built-in subscription path.`, command: { name: 'subscription', args: ['login', providerId, 'start'] } });
        }
      }
      for (const route of runtimeMetadata?.auth?.routes ?? []) {
        if (!route.usable || !route.configured) {
          for (const hint of route.repairHints ?? []) {
            recommendedActions.push({ description: hint });
          }
        }
      }
      if (pending) {
        authFreshness = 'pending';
        activeRouteReason = 'OAuth login is pending completion.';
      } else if (activeRoute === 'subscription') {
        authFreshness = subscriptionFreshness;
        activeRouteReason = subscriptionFreshness === 'expiring'
          ? 'Subscription route is active but nearing expiry.'
          : 'Subscription route is the preferred usable path.';
      } else if (activeRoute === 'service-oauth') {
        authFreshness = 'healthy';
        activeRouteReason = preferredRoute === 'subscription'
          ? 'Subscription route is unavailable, so service OAuth is the current usable path.'
          : 'Service OAuth is the current usable route.';
      } else if (activeRoute === 'api-key') {
        authFreshness = 'healthy';
        activeRouteReason = preferredRoute === 'subscription'
          ? 'Subscription route is unavailable, so ambient API-key access is the current usable path.'
          : preferredRoute === 'service-oauth'
            ? 'Service OAuth is unavailable, so ambient API-key access is the current usable path.'
            : routes.includes('subscription')
              ? 'Ambient API-key access is the active route; the stored subscription does not override ambient API keys.'
              : 'Ambient API-key access is the current usable route.';
      } else if (preferredRoute === 'subscription') {
        authFreshness = subscriptionFreshness;
        activeRouteReason = subscriptionEnded
          ? `The provider ended the stored subscription session; sign in again with /provider sign-in ${providerId} (from a shell: goodvibes subscription login ${providerId} start).`
          : `The stored subscription session ended or expired; sign in again with /provider sign-in ${providerId} (from a shell: goodvibes subscription login ${providerId} start).`;
      } else if (preferredRoute === 'service-oauth') {
        activeRouteReason = 'Service OAuth is configured, but its credential is missing; no usable auth route remains.';
      } else if (keyUnreadable) {
        activeRouteReason = keyUnreadable;
      }
      const fallbackRoute = preferredRoute !== activeRoute && activeRoute !== 'unconfigured'
        ? activeRoute
        : undefined;
      const fallbackRisk = fallbackRoute
        ? `Provider is using ${fallbackRoute} because the preferred ${preferredRoute} path is not currently usable.`
        : undefined;
      return Object.freeze({
        providerId,
        active: currentModel?.provider === providerId,
        modelCount: allModels.filter((model) => model.provider === providerId).length,
        configured: routes[0] !== 'unconfigured',
        oauthReady: builtinSubscriptionProviders.has(providerId) || Boolean(serviceOauth?.configured),
        pendingLogin: pending != null,
        availableRoutes: routes,
        preferredRoute,
        activeRoute,
        activeRouteReason,
        authFreshness,
        ...(fallbackRoute ? { fallbackRoute } : {}),
        ...(fallbackRisk ? { fallbackRisk } : {}),
        ...(subscription?.expiresAt ? { expiresAt: subscription.expiresAt } : {}),
        ...(subscription?.tokenType ? { tokenType: subscription.tokenType } : {}),
        notes,
        usageWindows: builtinWindowsForProvider(providerId),
        issues,
        recommendedActions: [...new Map(recommendedActions.map((action) => [JSON.stringify(action), action])).values()],
        routeRecords,
      }) satisfies ProviderAccountRecord;
    }));

  return Object.freeze({
    capturedAt: Date.now(),
    providers,
    configuredCount: providers.filter((provider) => provider.configured).length,
    issueCount: providers.reduce((sum, provider) => sum + provider.issues.length, 0) + (servicesUnreadable ? 1 : 0),
    ...(servicesUnreadable ? { servicesUnreadable } : {}),
  });
}
