import type { Secret } from '../security/secret.js';
import { listBuiltinSubscriptionProviders } from '../config/subscription-providers.js';
import { subscriptionAuthFreshness } from '../config/subscriptions.js';
import type { ProviderAuthRouteDescriptor, ProviderRuntimeMetadataDeps } from './interface.js';
import { SECRET_STORE_UNREADABLE, unreadableSecretStore } from '../config/secret-store-unreadable.js';

/** A key no store holds: reading it walks every store, so an unreadable one throws (secret-store-unreadable.ts). */
const STORE_CHECK_KEY = 'GOODVIBES_STORE_READABLE_CHECK';

export interface StandardProviderAuthOptions {
  readonly providerId: string;
  readonly apiKeyEnvVars?: readonly string[] | undefined;
  readonly secretKeys?: readonly string[] | undefined;
  readonly serviceNames?: readonly string[] | undefined;
  readonly subscriptionProviderId?: string | undefined;
  readonly allowAnonymous?: boolean | undefined;
  readonly anonymousConfigured?: boolean | undefined;
  readonly anonymousDetail?: string | undefined;
}

/**
 * The conventional API-key env var for a provider that declared none:
 * uppercase, runs of non-alphanumerics to a single underscore, `_API_KEY`
 * suffix. `abacusai` derives `ABACUSAI_API_KEY`.
 */
/**
 * One reading of the stores for a whole listing: every provider's
 * `describeRuntime` asks the same questions (which keys are stored, which
 * services exist, which subscriptions), so a listing answers each once and
 * hands the same answers to every provider.
 */
export function snapshotRuntimeMetadataDeps(deps: ProviderRuntimeMetadataDeps): ProviderRuntimeMetadataDeps {
  let listed: ReturnType<ProviderRuntimeMetadataDeps['secretsManager']['listDetailed']> | undefined;
  const values = new Map<string, Promise<Secret | null>>();
  let services: ReturnType<ProviderRuntimeMetadataDeps['serviceRegistry']['getAll']> | undefined;
  const inspections = new Map<string, ReturnType<ProviderRuntimeMetadataDeps['serviceRegistry']['inspect']>>();
  const subscriptions = new Map<string, ReturnType<ProviderRuntimeMetadataDeps['subscriptionManager']['get']>>();
  const pending = new Map<string, ReturnType<ProviderRuntimeMetadataDeps['subscriptionManager']['getPending']>>();
  const once = <K, V>(map: Map<K, V>, key: K, read: () => V): V => {
    if (map.has(key)) return map.get(key)!;
    const value = read();
    map.set(key, value);
    return value;
  };
  let unreadable: Promise<string | null> | undefined;
  return {
    secretsManager: {
      listDetailed: () => (listed ??= deps.secretsManager.listDetailed()),
      get: (key: string) => once(values, key, () => deps.secretsManager.get(key)),
      // Read once for the whole listing (a decrypt of each store), only when a provider has no key in sight.
      storeUnreadable: () => (unreadable ??= deps.secretsManager.storeUnreadable?.()
        ?? unreadableSecretStore(deps.secretsManager, STORE_CHECK_KEY, 'stored API keys')),
    },
    serviceRegistry: {
      getAll: () => (services ??= deps.serviceRegistry.getAll()),
      inspect: (name: string) => once(inspections, name, () => deps.serviceRegistry.inspect(name)),
    },
    subscriptionManager: {
      get: (provider: string) => once(subscriptions, provider, () => deps.subscriptionManager.get(provider)),
      getPending: (provider: string) => once(pending, provider, () => deps.subscriptionManager.getPending(provider)),
    },
  };
}

/** A route a request can be sent over now: set up, not refused, not expired or pending. */
export function isProviderAuthRouteUsable(route: ProviderAuthRouteDescriptor): boolean {
  return route.configured
    && route.usable !== false
    && route.freshness !== 'expired'
    && route.freshness !== 'pending'
    && route.freshness !== 'unconfigured';
}

export function deriveProviderApiKeyEnvVar(providerId: string): string {
  const stem = providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${stem}_API_KEY`;
}

/**
 * Fold the per-route truth into the aggregate `auth.configured` / `auth.detail`
 * pair a provider reports.
 *
 * The aggregate used to be computed from the provider's own local signal alone
 * (usually "is the API key env var set"), while the routes array right next to
 * it reported a usable subscription-oauth session. A caller reading only the
 * aggregate then saw `configured: false` with "OPENAI_API_KEY or OPENAI_KEY not
 * set" on a provider whose subscription route was healthy and serving turns.
 *
 * When the local signal says configured, it stands. Otherwise the first route
 * a request can be sent over now (`isProviderAuthRouteUsable`, the same rule
 * the picker and the runtime snapshot use) makes the aggregate configured and
 * the detail names that route instead of a missing env key. An expired,
 * revoked or pending session does not count; its route's own detail and
 * repair hint say what to do.
 */
export function summarizeProviderAuth(
  base: { readonly configured: boolean; readonly detail: string },
  routes: readonly ProviderAuthRouteDescriptor[],
): { readonly configured: boolean; readonly detail: string } {
  if (base.configured) return base;
  const winner = routes.find((route) => route.route !== 'none' && isProviderAuthRouteUsable(route));
  if (winner === undefined) {
    // A key that may sit in a secret store this computer could not read: said as such, never "not set".
    const unreadable = routes.find((route) => route.detail?.startsWith(SECRET_STORE_UNREADABLE));
    return unreadable?.detail !== undefined ? { configured: false, detail: unreadable.detail } : base;
  }
  return {
    configured: true,
    detail: winner.detail === undefined ? winner.label : `${winner.label}: ${winner.detail}`,
  };
}

export async function buildStandardProviderAuthRoutes(
  options: StandardProviderAuthOptions,
  deps: ProviderRuntimeMetadataDeps,
): Promise<readonly ProviderAuthRouteDescriptor[]> {
  // A provider that names the keys it can read from the store gets only those: its other
  // environment names (a signing key pair, a region) are not usable from a stored copy.
  const secretKeys = [...new Set<string>((options.secretKeys?.length ?? 0) > 0 ? options.secretKeys : options.apiKeyEnvVars)];
  const detailedSecrets = await deps.secretsManager.listDetailed();
  const builtinSubscriptions = new Set(listBuiltinSubscriptionProviders().map((entry) => entry.provider));
  const subscriptionProviderId = options.subscriptionProviderId ?? options.providerId;
  const subscription = deps.subscriptionManager.get(subscriptionProviderId);
  const pendingSubscription = deps.subscriptionManager.getPending(subscriptionProviderId);
  const hasSubscriptionRoute = builtinSubscriptions.has(subscriptionProviderId) || subscription != null || pendingSubscription != null;
  // A stored session is judged on its own state even while a new login is
  // pending; the pending state stands alone only when there is no session.
  const subscriptionFreshness = subscription
    ? subscriptionAuthFreshness(subscription)
    : pendingSubscription
      ? 'pending'
      : 'unconfigured';
  const serviceNames = options.serviceNames && options.serviceNames.length > 0
    ? [...new Set(options.serviceNames)]
    : Object.values(deps.serviceRegistry.getAll())
      .filter((service) => service.authType === 'oauth' && (service.providerId ?? service.name) === options.providerId)
      .map((service) => service.name);
  const serviceInspections = await Promise.all(serviceNames.map(async (name) => ({
    name,
    inspection: await deps.serviceRegistry.inspect(name),
  })));
  const hasServiceConfig = serviceInspections.some(({ inspection }) => inspection?.config.authType === 'oauth');
  const hasUsableServiceOauth = serviceInspections.some(({ inspection }) => Boolean(inspection?.hasPrimaryCredential));

  const routes: ProviderAuthRouteDescriptor[] = [];
  // A provider with no key in sight while a secret store could not be read: its key is unknown, not missing.
  const keyInSight = (envVars: readonly string[], keys: readonly string[]): boolean =>
    detailedSecrets.some((record) => keys.includes(record.key) && record.source !== 'env')
    || envVars.some((envVar) => { const value = process.env[envVar]; return typeof value === 'string' && value.length > 0; });
  const declaredEnv: readonly string[] = options.apiKeyEnvVars ?? [];
  const derived: readonly string[] = [deriveProviderApiKeyEnvVar(options.providerId)];
  const declares = declaredEnv.length > 0 || secretKeys.length > 0;
  const storeUnreadable: string | null = keyInSight(declares ? declaredEnv : derived, declares ? secretKeys : derived) ? null
    : await (deps.secretsManager.storeUnreadable?.() ?? unreadableSecretStore(deps.secretsManager, STORE_CHECK_KEY, 'stored API keys'));
  const pushApiKeyRoutes = (envVars: readonly string[], keys: readonly string[]): void => {
    const matchingSecretRecords = detailedSecrets.filter((record) => keys.includes(record.key) && record.source !== 'env');
    const hasSecretRef = matchingSecretRecords.some((record) => Boolean(record.refSource));
    const hasStoredDirectSecret = matchingSecretRecords.some((record) => !record.refSource);
    const hasEnv = envVars.some((envVar) => {
      const value = process.env[envVar]!;
      return typeof value === 'string' && value.length > 0;
    });
    const unreadableWords = !hasEnv && !hasStoredDirectSecret ? storeUnreadable : null;
    const unknown = unreadableWords !== null;
    routes.push({
      route: 'api-key',
      label: 'Ambient API key',
      configured: hasEnv || hasStoredDirectSecret,
      usable: hasEnv || hasStoredDirectSecret,
      freshness: hasEnv || hasStoredDirectSecret ? 'healthy' : 'unconfigured',
      detail: hasEnv
        ? 'Environment-backed API key is available.'
        : hasStoredDirectSecret
          ? 'GoodVibes secret store contains a direct API key value.'
          : unreadableWords ?? 'No direct API key is configured.',
      ...(envVars.length > 0 ? { envVars } : {}),
      ...(keys.length > 0 ? { secretKeys: keys } : {}),
      // A key that may be stored in a store that could not be read is not asked for again.
      repairHints: unknown ? [] : [
        ...(envVars.length > 0
          ? [
            keys.length > 0 && !envVars.every((envVar) => keys.includes(envVar))
              ? `Set ${envVars.join(' or ')} in the process environment; only ${keys.join(' or ')} can be stored in /secrets.`
              : `Set ${envVars.join(' or ')} or store one of those keys in /secrets.`,
          ]
          : ['Store the provider API key in /secrets or the process environment.']),
      ],
    });
    routes.push({
      route: 'secret-ref',
      label: 'SecretRef-backed API key',
      configured: hasSecretRef,
      usable: hasSecretRef,
      freshness: hasSecretRef ? 'healthy' : 'unconfigured',
      detail: hasSecretRef
        ? 'A GoodVibes SecretRef is configured for this provider.'
        : 'No SecretRef-backed credential is configured.',
      ...(keys.length > 0 ? { secretKeys: keys } : {}),
      repairHints: [
        'Use /secrets link <KEY> <secret-ref> to attach Bitwarden, Vaultwarden, BWS, or another supported SecretRef.',
      ],
    });
  };
  if ((options.apiKeyEnvVars?.length ?? 0) > 0 || secretKeys.length > 0) {
    pushApiKeyRoutes(options.apiKeyEnvVars ?? [], secretKeys);
  }

  if (hasServiceConfig || serviceNames.length > 0) {
    routes.push({
      route: 'service-oauth',
      label: 'Service OAuth',
      configured: hasServiceConfig,
      usable: hasUsableServiceOauth,
      freshness: hasUsableServiceOauth ? 'healthy' : 'unconfigured',
      detail: hasUsableServiceOauth
        ? 'A service-owned OAuth credential is available for this provider.'
        : 'Service OAuth metadata exists, but the credential path is incomplete.',
      ...(serviceNames.length > 0 ? { serviceNames } : {}),
      repairHints: ['Repair the provider service credential in /services or the settings surface.'],
    });
  }

  if (hasSubscriptionRoute) {
    routes.push({
      route: 'subscription-oauth',
      label: 'Subscription OAuth',
      configured: subscription != null || pendingSubscription != null || builtinSubscriptions.has(subscriptionProviderId),
      // A login that has not completed gives the provider nothing to send with.
      usable: subscriptionFreshness !== 'expired' && subscriptionFreshness !== 'unconfigured' && subscriptionFreshness !== 'pending',
      freshness: subscriptionFreshness,
      detail: pendingSubscription
        ? subscription
          ? 'A new subscription OAuth login is pending completion; the stored session stays in use until it completes.'
          : 'Subscription OAuth login is pending completion.'
        : subscription?.revokedAt !== undefined
          ? 'The provider ended this subscription session; it must be signed in again.'
          : subscription
            ? 'A stored subscription OAuth session is available for this provider.'
            : 'A built-in subscription OAuth adapter is available, but no session is stored yet.',
      providerId: subscriptionProviderId,
      repairHints: subscription?.revokedAt !== undefined
        ? [`Sign in to ${subscriptionProviderId} again in Models and providers; the stored session was ended by the provider.`]
        : [`Sign in to ${subscriptionProviderId} in Models and providers, or refresh the stored subscription session.`],
    });
  }

  if (options.allowAnonymous) {
    routes.push({
      route: 'anonymous',
      label: 'Anonymous / local access',
      configured: Boolean(options.anonymousConfigured),
      usable: Boolean(options.anonymousConfigured),
      freshness: options.anonymousConfigured ? 'healthy' : 'unconfigured',
      detail: options.anonymousDetail ?? 'This provider can be used without an API key.',
    });
  }

  if (routes.length === 0) {
    // A catalog-derived provider can arrive with no declared auth metadata at
    // all: no env vars, no secret keys, no service, no subscription, no
    // anonymous access. The old answer was a single dead-end 'none' route,
    // which meant a stored key under the provider's conventional env name
    // could never register anywhere. Such a provider now gets the api-key and
    // secret-ref routes under the derived convention, so it can be
    // credentialed and reported like any other. A provider that DOES declare
    // an auth surface (a subscription-only provider) never
    // reaches this branch.
    const derivedEnvVar = deriveProviderApiKeyEnvVar(options.providerId);
    pushApiKeyRoutes([derivedEnvVar], [derivedEnvVar]);
  }

  return routes;
}
