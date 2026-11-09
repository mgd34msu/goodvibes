import type { SubscriptionManager } from '@goodvibes-jev/engine/platform/platform/config';
export function deriveConfiguredVia(
  providerId: string,
  configuredIds: Set<string>,
  subscriptionManager: Pick<SubscriptionManager, 'list'>,
  preResolvedSecretKeys?: ReadonlySet<string> | undefined,
): 'env' | 'secrets' | 'subscription' | 'anonymous' | undefined {
  if (!configuredIds.has(providerId)) return undefined;
  // Tier 1: subscription check (most specific, subscription overrides env for this provider)
  const subs = subscriptionManager.list();
  if (subs.some((s) => s.provider === providerId)) return 'subscription';
  // Tier 2: env-var present (process.env check; anonymous providers don't appear in configuredIds)
  // We don't have BUILTIN_PROVIDER_ENV_KEYS here; if env was used the configuredIds path covers it.
  // The presence in configuredIds and no subscription → either env or secrets.
  // Tier 3: secrets-manager backed (pre-resolved async batch)
  if (preResolvedSecretKeys && preResolvedSecretKeys.has(providerId)) return 'secrets';
  return 'env';
}
export function buildConfiguredViaMap(
  providers: string[],
  configuredIds: Set<string>,
  subscriptionManager: Pick<SubscriptionManager, 'list'>,
  preResolvedSecretKeys?: ReadonlySet<string> | undefined,
): Map<string, 'env' | 'secrets' | 'subscription' | 'anonymous'> {
  const map = new Map<string, 'env' | 'secrets' | 'subscription' | 'anonymous'>();
  for (const p of providers) {
    const via = deriveConfiguredVia(p, configuredIds, subscriptionManager, preResolvedSecretKeys);
    if (via !== undefined) map.set(p, via);
  }
  return map;
}
export async function resolveSecretProviderIds(
  getConfiguredProviderIds: () => readonly string[],
  secretsManager?:
    | {
        readonly get: (key: string) => Promise<string | null>;
      }
    | undefined,
): Promise<ReadonlySet<string>> {
  if (!secretsManager) return new Set<string>();
  const configuredIds = new Set(getConfiguredProviderIds());
  // For each configured provider, check if secretsManager has a key for it by provider ID.
  // We use provider ID as the lookup key since we don't have BUILTIN_PROVIDER_ENV_KEYS here.
  const results = await Promise.all(
    [...configuredIds].map(async (providerId) => {
      const val = await secretsManager.get(providerId).catch(() => null);
      return val !== null ? providerId : null;
    }),
  );
  return new Set(results.filter((v): v is string => v !== null));
}
