/**
 * auto-register.ts
 *
 * Registers providers from a caller-supplied list when their API keys are set
 * in the environment. The packaged list is empty: every known provider,
 * Cohere and ZenMux included, is a builtin activated by a stored or
 * environment key (see AUTO_REGISTER_CATALOG).
 */

import { OpenAICompatProvider } from './openai-compat.js';
import { AnthropicCompatProvider } from './anthropic-compat.js';
import type { RegistrableProvider } from './interface.js';
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
 * Providers registered from an environment key alone. Empty: every known
 * provider is a builtin (providers/builtin-catalog.ts) and is activated by a
 * key from the environment or the secrets store through the credential
 * resolver, the one activation rule. A caller may still pass its own list.
 */
export const AUTO_REGISTER_CATALOG: AutoRegisterEntry[] = [];

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
export function createProviderFromEntry(entry: AutoRegisterEntry, apiKey: string): RegistrableProvider {
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
 * //   conversation.addNotice(`Auto-registered ${names.length} providers: ${names.join(', ')}`, { level: 'info' });
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
