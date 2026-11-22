import type { CatalogModel } from './model-catalog.js';
import { CATALOG_PROVIDER_NAME_ALIASES, sameProviderCatalog } from './provider-aliases.js';

/** Facts are indexed under the canonical catalog name, so a registered alias and the catalog's own spelling meet. */
const canonicalProviderId = (providerId: string): string => CATALOG_PROVIDER_NAME_ALIASES[providerId] ?? providerId;

/** Public repository facts shared by provider discovery and benchmark matching. */
let catalog: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map();
let byProvider: ReadonlyMap<string, ReadonlyMap<string, CatalogModel>> = new Map();
let byReference: ReadonlyMap<string, readonly CatalogModel[]> = new Map();
let identities: ReadonlyMap<string, ReadonlySet<string>> = new Map();

export function installCatalogModelFacts(models: readonly CatalogModel[]): void {
  const next = new Map<string, Map<string, string>>();
  const aliases = new Map<string, Set<string>>();
  const providers = new Map<string, Map<string, CatalogModel>>();
  const references = new Map<string, CatalogModel[]>();
  for (const model of models) {
    const providerKey = canonicalProviderId(model.providerId);
    let records = providers.get(providerKey);
    if (!records) { records = new Map(); providers.set(providerKey, records); }
    records.set(model.id, model);
    for (const reference of new Set([model.id, `${model.providerId}:${model.id}`, ...(model.canonicalModelId ? [model.canonicalModelId] : [])])) {
      const matches = references.get(reference) ?? [];
      matches.push(model); references.set(reference, matches);
    }
    if (model.modelType) {
      let provider = next.get(providerKey);
      if (!provider) { provider = new Map(); next.set(providerKey, provider); }
      provider.set(model.id, model.modelType);
    }
    if (!model.canonicalModelId) continue;
    for (const reference of [model.id, model.name, `${model.providerId}:${model.id}`, model.canonicalModelId]) {
      const key = reference.toLowerCase();
      let matches = aliases.get(key);
      if (!matches) { matches = new Set(); aliases.set(key, matches); }
      matches.add(model.canonicalModelId);
    }
  }
  catalog = next;
  byProvider = providers;
  byReference = references;
  identities = aliases;
}

/** Only unambiguous, explicitly published names and IDs establish identity. */
export function knownCatalogModelIdentity(reference: string): string | undefined {
  const matches = identities.get(reference.toLowerCase());
  return matches?.size === 1 ? matches.values().next().value : undefined;
}

export function knownCatalogChatCapability(provider: string, modelId: string): boolean | undefined {
  const type = catalog.get(canonicalProviderId(provider))?.get(modelId);
  if (type === undefined) return undefined;
  if (type === 'chat') return true;
  return NON_CONVERSATION_TYPES.has(type) ? false : undefined;
}

/** Catalog types of models that do not hold a conversation. */
const NON_CONVERSATION_TYPES: ReadonlySet<string> = new Set(['embedding', 'reranking', 'image', 'video', 'speech', 'transcription', 'decision', 'realtime']);

/** Exact endpoint facts. A canonical ID can join only this provider's offerings. */
export function catalogModelsForReference(modelId: string, provider?: string): readonly CatalogModel[] {
  if (provider === undefined) return byReference.get(modelId) ?? [];
  const records = byProvider.get(canonicalProviderId(provider));
  const direct = records?.get(modelId);
  if (direct) return [direct];
  return (byReference.get(modelId) ?? []).filter(model => sameProviderCatalog(model.providerId, provider));
}

/**
 * What the catalog says about one model's ability to read and write text, the
 * work every conversation route (main chat, helper, tool work, spoken replies)
 * gives it. `text` when it publishes text in and text out (or the chat type,
 * which the repository gives a model it states no type for); `other` when it
 * publishes a non-conversation type or modalities without text (an image,
 * video or speech model); `unknown` when the catalog has no entry for it or
 * its entries disagree.
 */
export type CatalogTextWork = 'text' | 'other' | 'unknown';

function textWorkOf(model: CatalogModel): CatalogTextWork {
  if (model.modelType !== undefined && NON_CONVERSATION_TYPES.has(model.modelType)) return 'other';
  if (model.outputModalities !== undefined && !model.outputModalities.includes('text')) return 'other';
  if (model.inputModalities !== undefined && !model.inputModalities.includes('text')) return 'other';
  if (model.outputModalities !== undefined || model.inputModalities !== undefined || model.modelType === 'chat') return 'text';
  return 'unknown';
}

/** {@link CatalogTextWork} for one provider's model, from this provider's catalog entries only. */
export function catalogTextWork(provider: string, modelId: string): CatalogTextWork {
  const answers = new Set(catalogModelsForReference(modelId, provider).map(textWorkOf));
  answers.delete('unknown');
  return answers.size === 1 ? answers.values().next().value! : 'unknown';
}

/** Unknown or conflicting endpoint limits remain unknown. */
export function knownCatalogMaxOutput(provider: string, modelId: string): number | undefined {
  const models = catalogModelsForReference(modelId, provider);
  const limits = new Set(models.map(model => model.maxOutputTokens));
  const limit = limits.values().next().value;
  return limits.size === 1 && typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? limit : undefined;
}
