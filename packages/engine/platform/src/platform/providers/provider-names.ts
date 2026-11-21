/**
 * Which provider a saved model reference names, answered from names alone:
 * the built-in provider names, the custom provider files' names and the saved
 * scan's server names. `status` says which provider and model a run would use
 * without building the provider registry, whose construction loads every
 * provider implementation.
 *
 * The answer is the registry's own (`ProviderRegistry.getCurrentModel` and
 * `resolveProviderReference`) wherever this returns one; where the names
 * cannot settle it (a bare model id, which resolves against the model list; a
 * provider half that names no provider, whose message lists the registered
 * ones; a provider sharing its model catalog with another) it returns null and
 * the caller asks the registry.
 */
import { CATALOG_PROVIDER_NAME_ALIASES } from '@goodvibes/engine/contracts';
import { BUILTIN_COMPAT_PROVIDERS } from './builtin-catalog.js';
import { DEFAULT_CONFIG } from '../config/schema.js';
import type { CustomProviderName } from './custom-provider-files.js';

/**
 * The providers `registerBuiltinProviders` registers under a name of their
 * own (the rest are BUILTIN_COMPAT_PROVIDERS), plus the Decision Router. The
 * registry checks its builtins against {@link builtinProviderNames} when it is
 * built, so this list cannot drift from what is registered.
 */
const NAMED_BUILTIN_PROVIDERS = [
  'inceptionlabs', 'openrouter', 'aihubmix', 'groq', 'cerebras', 'mistral', 'ollama-cloud',
  'openai', 'anthropic', 'gemini', 'huggingface', 'nvidia', 'llm7',
  'amazon-bedrock', 'amazon-bedrock-mantle', 'anthropic-vertex', 'github-copilot', 'synthetic',
  'decision-router',
] as const;

/** Every provider a freshly built registry holds before custom files and the saved scan load. */
export function builtinProviderNames(): ReadonlySet<string> {
  return new Set<string>([...NAMED_BUILTIN_PROVIDERS, ...BUILTIN_COMPAT_PROVIDERS.map((definition) => definition.id)]);
}


export interface SavedProviderNames {
  /** {@link builtinProviderNames}. */
  readonly builtin: ReadonlySet<string>;
  /** The custom providers a load registers (readCustomProviderNames, built-in names reserved). */
  readonly custom: readonly CustomProviderName[];
  /** The saved scanned servers the product registers: trusted, with models, under a name no other provider holds. */
  readonly scanned: readonly string[];
}

export interface SavedModelInUse {
  readonly registryKey: string;
  readonly provider: string;
}

const catalogOf = (name: string): string => CATALOG_PROVIDER_NAME_ALIASES[name] ?? name;

/**
 * The model `provider.model` (`configured`) resolves to, as the registry
 * resolves it, or null when only the registry can say (see the file comment).
 */
export function resolveSavedModelInUse(configured: unknown, names: SavedProviderNames): SavedModelInUse | null {
  // An empty value lands where the registry's does: the setting's default.
  const raw = typeof configured === 'string' && configured.trim() ? configured.trim() : DEFAULT_CONFIG.provider.model;
  const separator = raw.indexOf(':');
  if (separator <= 0 || separator === raw.length - 1) return null;
  const half = raw.slice(0, separator);
  const registered = new Set<string>([...names.builtin, ...names.custom.map((entry) => entry.name), ...names.scanned]);
  // resolveProviderReference: the id exactly, a catalog alias, a unique id without regard to case, a custom display name.
  let provider: string | undefined;
  if (registered.has(half)) provider = half;
  else {
    const aliased = CATALOG_PROVIDER_NAME_ALIASES[half];
    if (aliased !== undefined && registered.has(aliased)) provider = aliased;
    else {
      const lowered = half.toLowerCase();
      const byId = [...registered].filter((name) => name.toLowerCase() === lowered);
      if (byId.length > 1) return null;
      if (byId.length === 1) provider = byId[0];
      else {
        const byDisplayName = names.custom.filter((entry) => entry.displayName.trim().toLowerCase() === lowered);
        if (byDisplayName.length === 1) provider = byDisplayName[0]!.name;
      }
    }
  }
  if (provider === undefined) return null;
  // findModelDefinition also matches a model of another provider in the same
  // catalog; whether one exists is in the model list, so the registry decides.
  const catalog = catalogOf(provider);
  if ([...registered].some((name) => name !== provider && catalogOf(name) === catalog)) return null;
  if (catalogOf(half) !== half && catalogOf(half) !== catalog) return null;
  return { registryKey: `${provider}:${raw.slice(separator + 1)}`, provider };
}
