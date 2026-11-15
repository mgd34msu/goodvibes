/**
 * auto-register.ts
 *
 * Automatically registers providers when their API keys are detected in the environment.
 *
 * When a user has an API key set in their environment (e.g. COHERE_API_KEY),
 * auto-register that provider using catalog data, zero manual configuration.
 * Only the environment is read, once at startup: a key stored in the secrets
 * store does not activate these providers.
 *
 * Multi-endpoint providers (e.g. ZenMux) are handled by registering separate
 * provider instances for each endpoint, routed by the model's native API format.
 */

import { OpenAICompatProvider } from './openai-compat.js';
import { AnthropicCompatProvider } from './anthropic-compat.js';
import type { LLMProvider } from './interface.js';
import type { ProviderRegistry } from './registry.js';
import { hasKeyForProvider } from './model-catalog.js';
import type { CatalogProvider } from './model-catalog.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** API wire format used by a provider endpoint. */
export type ApiFormat = 'openai' | 'anthropic';

/**
 * Extended provider descriptor used internally for auto-registration.
 * Extends CatalogProvider with routing metadata.
 */
export interface AutoRegisterEntry extends CatalogProvider {
  /**
   * Wire format used by this endpoint.
   * Defaults to 'openai' (OpenAI-compatible).
   */
  apiFormat?: ApiFormat | undefined;
  /**
   * Default model ID sent when no model is specified in a request.
   * Auto-register uses the first entry from the catalog where available;
   * falls back to this value.
   */
  defaultModel: string;
  /**
   * Model IDs pre-seeded for this provider.
   * Auto-registered providers start with an empty list; these seeds allow the
   * provider to be usable immediately without waiting for a catalog fetch.
   */
  seedModels?: string[] | undefined;
}

// ---------------------------------------------------------------------------
// Catalog of auto-registerable providers
// ---------------------------------------------------------------------------

/**
 * Well-known providers that can be auto-registered from environment variables.
 *
 * Each entry maps to one registered LLM provider instance. Multi-endpoint
 * providers (e.g. ZenMux) appear multiple times, once per endpoint, with
 * distinct `id` and `name` values (e.g. 'zenmux' and 'zenmux-anthropic').
 *
 * Order determines registration priority when multiple providers offer the
 * same model. Earlier entries take precedence in the auto-registration log.
 */
export const AUTO_REGISTER_CATALOG: AutoRegisterEntry[] = [
  // Only providers the builtin registry does not already register belong here: a
  // second entry for a builtin id would be skipped today and silently swap
  // that provider's settings if the call order ever changed.
  {
    id: 'cohere',
    name: 'Cohere',
    envVars: ['COHERE_API_KEY', 'CO_API_KEY'],
    baseUrl: 'https://api.cohere.com/v2',
    apiFormat: 'openai',
    defaultModel: 'command-a-03-2025',
    seedModels: [
      'command-a-03-2025',
      'command-r-plus-08-2024',
    ],
  },
  {
    id: 'deepinfra',
    name: 'DeepInfra',
    envVars: ['DEEPINFRA_API_KEY'],
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    apiFormat: 'openai',
    defaultModel: 'moonshotai/Kimi-K2-Instruct',
    seedModels: [
      'moonshotai/Kimi-K2-Instruct',
      'meta-llama/Llama-4-Maverick-17B-128E-Instruct',
    ],
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    envVars: ['PERPLEXITY_API_KEY'],
    baseUrl: 'https://api.perplexity.ai',
    apiFormat: 'openai',
    defaultModel: 'sonar-pro',
    seedModels: [
      'sonar-pro',
      'sonar',
      'r1-1776',
    ],
  },
  {
    id: 'sambanova',
    name: 'SambaNova',
    envVars: ['SAMBANOVA_API_KEY'],
    baseUrl: 'https://fast-api.snova.ai/v1',
    apiFormat: 'openai',
    defaultModel: 'Llama-4-Maverick-17B-128E-Instruct',
    seedModels: [
      'Llama-4-Maverick-17B-128E-Instruct',
      'Meta-Llama-3.3-70B-Instruct',
    ],
  },
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen',
    envVars: ['OPENCODE_ZEN_API_KEY', 'ZEN_API_KEY'],
    baseUrl: 'https://zenmux.ai/api/v1',
    apiFormat: 'openai',
    defaultModel: 'kimi-k2.5-free',
    seedModels: [
      'kimi-k2.5-free',
      'gpt-oss-120b-free',
    ],
  },

  // -------------------------------------------------------------------------
  // ZenMux: multi-endpoint provider
  // OpenAI-compatible endpoint (primary)
  // -------------------------------------------------------------------------
  {
    id: 'zenmux',
    name: 'ZenMux',
    envVars: ['ZENMUX_API_KEY'],
    baseUrl: 'https://zenmux.ai/api/v1',
    apiFormat: 'openai',
    defaultModel: 'gpt-5.4',
    seedModels: [
      'gpt-5.4',
      'gpt-5-mini',
      'kimi-k2-instruct',
    ],
  },
  // ZenMux: Anthropic-compatible endpoint (secondary)
  {
    id: 'zenmux-anthropic',
    name: 'ZenMux (Anthropic)',
    envVars: ['ZENMUX_API_KEY'],
    baseUrl: 'https://zenmux.ai/api/anthropic/v1',
    apiFormat: 'anthropic',
    defaultModel: 'claude-opus-4-6',
    seedModels: [
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ],
  },
];

// ---------------------------------------------------------------------------
// Provider auto-registration helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a provider ID is already registered in the provider registry.
 */
export function isProviderRegistered(
  providerRegistry: Pick<ProviderRegistry, 'has'>,
  providerId: string,
): boolean {
  return providerRegistry.has(providerId);
}

/**
 * Resolve the API key to use for a provider entry.
 * Returns the first non-empty env var value, or empty string.
 */
export function resolveApiKey(entry: AutoRegisterEntry): string {
  for (const varName of entry.envVars) {
    const val = process.env[varName]!;
    if (typeof val === 'string' && val.length > 0) {
      return val;
    }
  }
  return '';
}

/**
 * Create an LLMProvider instance from an AutoRegisterEntry.
 * Routes to the correct provider class based on apiFormat.
 */
export function createProviderFromEntry(entry: AutoRegisterEntry, apiKey: string): LLMProvider {
  const models = entry.seedModels ?? [entry.defaultModel];

  if (entry.apiFormat === 'anthropic') {
    return new AnthropicCompatProvider({
      name: entry.id,
      baseURL: entry.baseUrl,
      apiKey,
      defaultModel: entry.defaultModel,
      models,
    });
  }

  // Default: OpenAI-compatible
  return new OpenAICompatProvider({
    name: entry.id,
    baseURL: entry.baseUrl,
    apiKey,
    defaultModel: entry.defaultModel,
    models,
    reasoningFormat: 'none',
  });
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * autoRegisterProviders, scan catalog providers, check env vars, register
 * any providers not already in the registry.
 *
 * Called during startup after `initCatalog()`. Safe to call multiple times;
 * already-registered providers are skipped.
 *
 * @param catalog - Optional override for the provider catalog entries.
 *   Defaults to AUTO_REGISTER_CATALOG. Pass a custom list in tests.
 * @returns Array of display names that were newly registered.
 *
 * @example
 * // Startup sequence:
 * // const names = autoRegisterProviders();
 * // if (names.length > 0) {
 * //   conversation.addSystemMessage(`Auto-registered ${names.length} providers: ${names.join(', ')}`);
 * // }
 */
export function autoRegisterProviders(
  providerRegistry: Pick<ProviderRegistry, 'has' | 'register'>,
  catalog: AutoRegisterEntry[] = AUTO_REGISTER_CATALOG,
): string[] {
  const registered: string[] = [];

  for (const entry of catalog) {
    // Skip if env var not set (no key available)
    if (!hasKeyForProvider(entry)) {
      continue;
    }

    // Skip if provider is already registered (built-in or previously auto-registered)
    if (isProviderRegistered(providerRegistry, entry.id)) {
      continue;
    }

    const apiKey = resolveApiKey(entry);

    try {
      const provider = createProviderFromEntry(entry, apiKey);
      providerRegistry.register(provider);
      registered.push(entry.name);
    } catch (err) {
      const errMsg = summarizeError(err);
      // IMPORTANT: Use logger (NOT process.stderr.write) for all output here.
      // process.stderr.write bypasses the TUI renderer and writes directly to the
      // terminal, corrupting the cell-based display. All diagnostic output in a TUI
      // app must go through the logger, which writes to the log file without
      // disrupting the screen.
      logger.warn(`[auto-register] Failed to register ${entry.name}: ${errMsg}`);
    }
  }

  if (registered.length > 0) {
    const noun = registered.length === 1 ? 'provider' : 'providers';
    logger.info(`[auto-register] Auto-registered ${registered.length} ${noun}: ${registered.join(', ')}`);
  }

  return registered;
}
