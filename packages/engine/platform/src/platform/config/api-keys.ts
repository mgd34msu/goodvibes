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
import { getBuiltinProviderEnvVars } from './provider-credential-catalog.js';

/**
 * Providers whose credential is a plain API key. The environment variable names
 * come from the provider credential catalog, so a name added there is read here
 * and in the daemon's credential status without a second edit. Providers the
 * catalog lists for other credential kinds (cloud IAM, project ids) are left out
 * on purpose: an access-key id is not an API key.
 */
const API_KEY_PROVIDERS: readonly string[] = [
  'openai', 'anthropic', 'gemini', 'inceptionlabs', 'openrouter', 'aihubmix', 'groq', 'cerebras', 'mistral',
  'ollama-cloud', 'huggingface', 'nvidia', 'llm7', 'deepseek', 'fireworks', 'github-copilot', 'microsoft-foundry',
  'minimax', 'moonshot', 'qianfan', 'qwen', 'sglang', 'stepfun', 'together', 'venice', 'volcengine', 'xai',
  'xiaomi', 'zai', 'cloudflare-ai-gateway', 'vercel-ai-gateway', 'litellm', 'copilot-proxy',
];

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
  for (const prov of API_KEY_PROVIDERS) {
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
  secrets: Pick<SecretsManager, 'get'>,
): Promise<Record<string, string>> {
  const mapping = API_KEY_PROVIDERS.map((prov) => ({ prov, envVars: getBuiltinProviderEnvVars(prov) }));

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
        const stored = await secrets.get(envVar);
        if (stored !== null) {
          value = stored;
          break;
        }
      }
    }

    if (value !== null) {
      result[prov] = value;
    }
  }

  // The bearer token is stored under its own name, env first like every key above.
  const bearer = process.env[BEDROCK_BEARER_TOKEN_ENV] || await secrets.get(BEDROCK_BEARER_TOKEN_ENV);
  if (bearer) {
    for (const prov of BEDROCK_PROVIDERS) result[prov] = bearer;
  }

  return result;
}
