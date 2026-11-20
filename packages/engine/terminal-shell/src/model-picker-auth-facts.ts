import type { Secret } from '@goodvibes-jev/engine/platform/platform/security';
import type { SubscriptionManager } from '@goodvibes-jev/engine/platform/platform/config';
import { BUILTIN_PROVIDER_ENV_KEYS } from '@goodvibes-jev/engine/platform/platform/providers';
import { customProviderKeyName } from './local-provider-commands.js';
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
const declaredEnvNames = (providerId: string): readonly string[] =>
  Object.hasOwn(BUILTIN_PROVIDER_ENV_KEYS, providerId) ? BUILTIN_PROVIDER_ENV_KEYS[providerId]! : [];
export async function resolveSecretProviderIds(
  getConfiguredProviderIds: () => readonly string[],
  secretsManager?:
    | {
        readonly get: (key: string) => Promise<Secret | null>;
      }
    | undefined,
  /** Extra secret names a provider's key may be stored under, beyond the two derived from its id. Defaults to the provider's declared environment names. */
  extraKeyNames: (providerId: string) => readonly string[] = declaredEnvNames,
): Promise<ReadonlySet<string>> {
  if (!secretsManager) return new Set<string>();
  const configuredIds = new Set(getConfiguredProviderIds());
  // Keys are stored under their environment-variable style names (OPENAI_API_KEY,
  // <NAME>_API_KEY), not under the bare provider id, so every plausible name is tried.
  const results = await Promise.all(
    [...configuredIds].map(async (providerId) => {
      const names = new Set([providerId, customProviderKeyName(providerId), ...extraKeyNames(providerId)]);
      for (const name of names) {
        const val = await secretsManager.get(name).catch(() => null);
        if (val !== null && !val.empty) return providerId;
      }
      return null;
    }),
  );
  return new Set(results.filter((v): v is string => v !== null));
}
