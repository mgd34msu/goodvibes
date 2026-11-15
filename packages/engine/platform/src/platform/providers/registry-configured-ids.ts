import type { LLMProvider } from './interface.js';
import { getConfiguredApiKeys } from '../config/index.js';
import type { CatalogModel } from './model-catalog.js';
import { CATALOG_PROVIDER_NAME_ALIASES } from './provider-aliases.js';

type ConfiguredApiKeyLoader = () => Record<string, string>;

/**
 * Compute the set of provider IDs that are currently configured
 * (have an API key in env, config, or self-report as configured).
 *
 * Extracted from ProviderRegistry to keep the class focused on provider
 * management. Called via a thin delegate on ProviderRegistry.
 *
 * @param catalogModels - Current catalog model list (read-only).
 * @param providers - Live provider map (read-only).
 * @param getSyntheticBackendModelIds - Delegate to check synthetic model count.
 * @param loadConfiguredApiKeys - API-key loader; failures are authoritative and propagate.
 */
export function computeConfiguredProviderIds(
  catalogModels: readonly CatalogModel[],
  providers: ReadonlyMap<string, LLMProvider>,
  getSyntheticBackendModelIds: () => Set<string>,
  loadConfiguredApiKeys: ConfiguredApiKeyLoader = getConfiguredApiKeys,
): string[] {
  const configured = new Set<string>();
  const providerEnvMap = new Map<string, string[]>();

  for (const model of catalogModels) {
    if (!providerEnvMap.has(model.providerId)) {
      providerEnvMap.set(model.providerId, model.providerEnvVars);
    }
  }

  for (const [providerId, envVars] of providerEnvMap) {
    if (envVars.length === 0) {
      configured.add(providerId);
    } else if (envVars.some((envVar) => {
      const value = process.env[envVar]!;
      return typeof value === 'string' && value.length > 0;
    })) {
      configured.add(providerId);
    }
  }

  const configApiKeys = loadConfiguredApiKeys();
  // A key configures the provider under the name it is registered by (its
  // models carry that name, and the route planner matches models to configured
  // providers by it) and under the catalog's name where that differs.
  for (const [configName, key] of Object.entries(configApiKeys)) {
    if (key) {
      configured.add(configName);
      configured.add(CATALOG_PROVIDER_NAME_ALIASES[configName] ?? configName);
      // Catalog-only spellings of this provider. A name that is a provider of its own
      // (openai-subscriber, copilot) is a separate connection and is not configured by this key.
      for (const [alias, canonical] of Object.entries(CATALOG_PROVIDER_NAME_ALIASES)) {
        if (canonical === configName && !providers.has(alias)) configured.add(alias);
      }
    }
  }

  if (getSyntheticBackendModelIds().size > 0) {
    configured.add('synthetic');
  }

  for (const [name, provider] of providers) {
    if (typeof provider.isConfigured === 'function' && provider.isConfigured()) {
      configured.add(name);
    }
  }

  return [...configured];
}
