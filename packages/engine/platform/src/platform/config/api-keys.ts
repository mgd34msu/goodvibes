/**
 * API key resolution for all supported providers.
 *
 * Platform-level code, no surface/TUI dependencies.
 * Used by every GoodVibes surface (TUI, CLI, web, etc.).
 *
 * Provides:
 * - getConfiguredApiKeys() , synchronous env-var scan, returns configured keys
 * - resolveApiKeys()       , three-tier async resolution: env → SecretsManager → skip
 */

import { SecretsManager } from './secrets.js';
import { API_KEY_PROVIDER_IDS, getBuiltinProviderEnvVars } from './provider-credential-catalog.js';

/**
 * The Bedrock providers take one stored credential, the bearer token. The
 * access key id and secret are only useful as a pair read from the environment
 * (the provider picks request signing from both), and a profile name is not a
 * key, so none of those is returned here as an "API key".
 */
const BEDROCK_PROVIDERS: readonly string[] = ['amazon-bedrock', 'amazon-bedrock-mantle'];
const BEDROCK_BEARER_TOKEN_ENV = 'AWS_BEARER_TOKEN_BEDROCK';

/**
 * Returns all provider API keys that are currently set in the environment.
 * Pure env-var read, synchronous, no I/O.
 */
export function getConfiguredApiKeys(): Record<string, string> {
  const keys: Record<string, string> = {};
  // Providers whose credential is a plain API key, from the catalog's one list; providers it lists
  // for other credential kinds (cloud IAM, project ids) are left out on purpose.
  for (const prov of API_KEY_PROVIDER_IDS) {
    for (const envVar of getBuiltinProviderEnvVars(prov)) {
      const value = process.env[envVar];
      if (value) {
        keys[prov] = value;
        break;
      }
    }
  }
  const bearer = process.env[BEDROCK_BEARER_TOKEN_ENV];
  if (bearer) {
    for (const prov of BEDROCK_PROVIDERS) keys[prov] = bearer;
  }
  return keys;
}

/**
 * resolveApiKeys, three-tier async resolution for all provider API keys.
 *
 * Resolution order per key:
 *   1. Environment variable (process.env)
 *   2. SecretsManager hierarchy-aware stores (secure preferred, plaintext policy-aware)
 *   3. Omitted from result (null → skip)
 *
 * Returns a map of provider → apiKey for all providers where a key is found.
 */
export async function resolveApiKeys(
  secrets: Pick<SecretsManager, 'get'> & Partial<Pick<SecretsManager, 'list'>>,
): Promise<Record<string, string>> {
  const mapping = API_KEY_PROVIDER_IDS.map((prov) => ({ prov, envVars: getBuiltinProviderEnvVars(prov) }));
  // One pass over the stores names every stored key; only those are read, so
  // a resolve costs one read of each store plus one per stored provider key,
  // not one per store for each of the hundred-odd variable names.
  const stored = secrets.list ? new Set(await secrets.list()) : null;
  const read = (name: string): Promise<string | null> => (stored && !stored.has(name) ? Promise.resolve(null) : secrets.get(name));

  const result: Record<string, string> = {};

  for (const { prov, envVars } of mapping) {
    // Tier 1: environment variables
    let value: string | null = null;
    for (const envVar of envVars) {
      if (process.env[envVar]) {
        value = process.env[envVar]!;
        break;
      }
    }

    // Tier 2: SecretsManager hierarchy-aware secure/plaintext stores
    if (value === null) {
      for (const envVar of envVars) {
        const fromStore = await read(envVar);
        if (fromStore !== null) {
          value = fromStore;
          break;
        }
      }
    }

    if (value !== null) {
      result[prov] = value;
    }
  }

  // The bearer token is stored under its own name, env first like every key above.
  const bearer = process.env[BEDROCK_BEARER_TOKEN_ENV] || await read(BEDROCK_BEARER_TOKEN_ENV);
  if (bearer) {
    for (const prov of BEDROCK_PROVIDERS) result[prov] = bearer;
  }

  return result;
}
