import { declaredProviderCatalogId } from '@goodvibes/engine/contracts';
import { asRecord, bestId, bestTitle, firstArrayAtPath, firstString, readPath } from './object';
import { deriveProviderStatus } from './provider-status';

export interface ProviderOption {
  id: string;
  label: string;
  value: unknown;
}

/**
 * In three bands, alphabetical within each: a provider whose sign-in expired or
 * is about to (it needs the person), then the configured ones, then the ones not
 * set up. Every provider list the operator picks from (composer picker,
 * Providers sidebar) orders this way: the provider someone can actually use
 * must not sit below a scroll of forty they cannot, and one that needs a new
 * sign-in must not sit among those never set up.
 */
export function sortProvidersConfiguredFirst(options: readonly ProviderOption[]): ProviderOption[] {
  const band = (option: ProviderOption): number => {
    const status = deriveProviderStatus(option.value);
    if (status.freshness === 'expired' || status.freshness === 'expiring') return 0;
    return status.configured ? 1 : 2;
  };
  return [...options].sort((a, b) => band(a) - band(b) || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}

export interface ModelOption {
  id: string;
  label: string;
  value: unknown;
  providerId: string;
  rawModelId: string;
  registryKey: string;
}

/** Provider rows from a providers.list or models.list response: both answer `{ providers: [...] }`. */
export function providerOptionsFromResponse(value: unknown): ProviderOption[] {
  return firstArrayAtPath(value, [['providers']])
    .map((provider) => {
      const id = bestId(provider);
      return id ? { id, label: bestTitle(provider, id), value: provider } : null;
    })
    .filter((provider): provider is ProviderOption => provider !== null);
}

/**
 * Tolerant read of a model entry's reasoning-effort options (models.list
 * serves `reasoningOptions: { levels, source }` per model from platform 2.0.23).
 * Null when the daemon predates the field or the model reports none, the
 * caller renders no effort control rather than a fabricated ladder.
 */
export function reasoningOptionsForModel(
  providers: readonly unknown[],
  registryKey: string,
): { levels: readonly string[]; source: string; effectiveByRequested?: Readonly<Record<string, string | null>> } | null {
  if (!registryKey) return null;
  for (const provider of providers) {
    const models = asRecord(provider).models;
    if (!Array.isArray(models)) continue;
    for (const model of models) {
      const record = asRecord(model);
      const key = firstString(record, ['registryKey', 'key']);
      if (key !== registryKey) continue;
      const options = asRecord(record.reasoningOptions);
      const levels = Array.isArray(options.levels)
        ? options.levels.filter((level): level is string => typeof level === 'string' && level.length > 0)
        : [];
      if (levels.length === 0) return null;
      const effectiveByRequested = Object.fromEntries(Object.entries(asRecord(options.effectiveByRequested))
        .filter((entry): entry is [string, string | null] => entry[1] === null || typeof entry[1] === 'string' && levels.includes(entry[1])));
      return { levels, source: firstString(options, ['source']) || 'unknown',
        ...(Object.hasOwn(options, 'effectiveByRequested') ? { effectiveByRequested } : {}) };
    }
  }
  return null;
}

/**
 * The model's registry key under `providerId`. A model id may itself hold a colon
 * (`llama3:latest`), and so may a discovered provider's name
 * (`local-192.168.1.50:8080`), so an id counts as qualified only when it starts
 * with this provider's own prefix.
 */
function providerQualifiedKey(providerId: string, modelId: string, registryKey: string): string {
  if (registryKey) return registryKey;
  if (!providerId || !modelId) return '';
  return modelId.startsWith(`${providerId}:`) ? modelId : `${providerId}:${modelId}`;
}

/** `value` without this provider's `provider:` prefix, when it has one. */
function withoutProviderPrefix(providerId: string, value: string): string {
  return providerId && value.startsWith(`${providerId}:`) ? value.slice(providerId.length + 1) : value;
}

function normalizeModel(providerId: string, model: unknown): ModelOption | null {
  if (typeof model === 'string') {
    const rawModelId = withoutProviderPrefix(providerId, model.trim());
    const registryKey = providerQualifiedKey(providerId, rawModelId, '');
    return registryKey ? { id: registryKey, label: rawModelId, value: model, providerId, rawModelId, registryKey } : null;
  }

  const explicitRegistryKey = firstString(model, ['registryKey', 'key']);
  const rawModelId = firstString(model, ['modelId', 'id', 'model', 'modelName', 'value', 'name'])
    || withoutProviderPrefix(providerId, explicitRegistryKey);
  const registryKey = providerQualifiedKey(providerId, rawModelId, explicitRegistryKey);
  if (!registryKey || !rawModelId) return null;
  return {
    id: registryKey,
    label: bestTitle(model, rawModelId),
    value: model,
    providerId,
    rawModelId,
    registryKey,
  };
}

function appendUnique(target: ModelOption[], model: ModelOption | null) {
  if (!model) return;
  if (target.some((item) => item.id === model.id)) return;
  target.push(model);
}

function appendUniqueString(target: string[], value: string) {
  if (!value || target.includes(value)) return;
  target.push(value);
}

/** Declared registry aliases and explicit wire identities: the only relationships a provider's models follow. */
export function providerModelSourceIds(provider: unknown): string[] {
  const providerId = bestId(provider);
  const ids: string[] = [];
  appendUniqueString(ids, declaredProviderCatalogId(providerId) ?? '');

  appendUniqueString(ids, firstString(provider, ['catalogProviderId', 'canonicalProviderId', 'subscriptionProviderId', 'baseProviderId', 'modelProviderId']));
  appendUniqueString(ids, firstString(readPath(provider, ['runtime']), ['catalogProviderId', 'canonicalProviderId', 'subscriptionProviderId', 'baseProviderId', 'modelProviderId']));
  appendUniqueString(ids, firstString(readPath(provider, ['runtime', 'models']), ['providerId', 'catalogProviderId', 'canonicalProviderId']));

  for (const route of firstArrayAtPath(provider, [
    ['routes'],
    ['runtime', 'auth', 'routes'],
  ])) {
    appendUniqueString(ids, firstString(route, ['providerId', 'catalogProviderId', 'subscriptionProviderId']));
  }
  return ids.filter((id) => id !== providerId);
}

export function modelOptionsFromProvider(provider: unknown): ModelOption[] {
  const models: ModelOption[] = [];
  const providerId = bestId(provider);
  // `models`: the catalog record's or snapshot's model list; `runtime.models`: the
  // provider's own declared ids and aliases.
  for (const path of [
    ['models'],
    ['runtime', 'models', 'models'],
    ['runtime', 'models', 'aliases'],
  ]) {
    for (const model of firstArrayAtPath(provider, [path])) {
      appendUnique(models, normalizeModel(providerId, model));
    }
  }

  const defaultModel = readPath(provider, ['runtime', 'models', 'defaultModel']);
  appendUnique(models, normalizeModel(providerId, defaultModel));

  const record = asRecord(provider);
  appendUnique(models, normalizeModel(providerId, record.defaultModel));

  return models;
}

export function modelOptionsForProvider(provider: unknown, modelCatalogProviders: unknown[] = []): ModelOption[] {
  const aliasProviderIds = providerModelSourceIds(provider);
  const aliasModels: ModelOption[] = [];

  for (const aliasProviderId of aliasProviderIds) {
    const catalogProvider = modelCatalogProviders.find((candidate) => bestId(candidate) === aliasProviderId);
    if (!catalogProvider) continue;
    for (const model of modelOptionsFromProvider(catalogProvider)) {
      appendUnique(aliasModels, model);
    }
  }

  if (aliasModels.length) return aliasModels;
  const declared = modelOptionsFromProvider(provider);
  if (declared.length) return declared;
  const catalog = modelCatalogProviders.find(candidate => bestId(candidate) === bestId(provider));
  return catalog ? modelOptionsFromProvider(catalog) : [];
}
