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

/**
 * What one model costs to use, as a fact a picker shows beside it: `free`
 * (the catalog lists it at no charge), `paid` (charged per token),
 * `subscription` (served through a plan the person signed in with), or
 * `unknown` (nothing says).
 */
export type ModelPriceTier = 'free' | 'paid' | 'subscription' | 'unknown';

/** The price tier in the words a picker shows: "free" | "paid" | "subscription" | "price not known". */
export const MODEL_PRICE_TIER_WORDS: Readonly<Record<ModelPriceTier, string>> = {
  free: 'free', paid: 'paid', subscription: 'subscription', unknown: 'price not known',
};

/**
 * {@link ModelPriceTier} for one provider's model: a subscription route first
 * (the registry marks it), then this provider's catalog entries when they agree,
 * then the registry's own tier (`standard` and `premium` are metered models).
 * One owner for the fact both pickers show (the terminal's and the web UI's, through models.list).
 */
export function modelPriceTier(model: { readonly provider: string; readonly id: string; readonly tier?: string | undefined }): ModelPriceTier {
  if (model.tier === 'subscription') return 'subscription';
  const listed = new Set(catalogModelsForReference(model.id, model.provider).map((entry) => entry.tier));
  if (listed.size === 1) return listed.values().next().value!;
  if (model.tier === 'free') return 'free';
  if (model.tier === 'standard' || model.tier === 'premium') return 'paid';
  return 'unknown';
}

/** A model the catalog listed as free before a check and no longer does after it. */
export interface NoLongerFreeModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly name: string;
  readonly tier: 'paid' | 'subscription';
  readonly pricing?: { readonly input: number; readonly output: number } | undefined;
}

/** The models whose catalog tier moved from free to anything else between two readings of the catalog. */
export function modelsNoLongerFree(before: readonly CatalogModel[], after: readonly CatalogModel[]): NoLongerFreeModel[] {
  const wasFree = new Set(before.filter((model) => model.tier === 'free').map((model) => `${model.providerId}\u0000${model.id}`));
  return after
    .filter((model) => model.tier !== 'free' && wasFree.has(`${model.providerId}\u0000${model.id}`))
    .map((model) => ({
      providerId: model.providerId, modelId: model.id, name: model.name || model.id, tier: model.tier as 'paid' | 'subscription',
      ...(model.pricing ? { pricing: { input: model.pricing.input, output: model.pricing.output } } : {}),
    }));
}

/** The notice for a model the person uses that stopped being free: what changed, what it costs now, what to do. */
export function noLongerFreeNotice(model: NoLongerFreeModel, inUse: boolean): string {
  const price = model.pricing ? ` at $${model.pricing.input} in and $${model.pricing.output} out per 1M tokens` : '';
  const charged = model.tier === 'subscription' ? 'now needs a subscription' : `is no longer free: the model catalog now lists it as paid${price}`;
  return `${model.name} (${model.providerId}) ${charged}. ${inUse ? 'It is the model in use, so the next messages are charged.' : 'It is one of your pinned or recent models.'} Pick a free model with /model if you do not want to pay.`;
}

/** What the catalog publishes about one provider's model that a recommendation may rest on. */
export interface CatalogRecommendationFacts {
  readonly family?: string | undefined;
  readonly releaseDate?: string | undefined;
  readonly contextWindow?: number | undefined;
  /** USD per 1M tokens, input and output; absent when the catalog prices it at nothing it states. */
  readonly pricing?: { readonly input: number; readonly output: number } | undefined;
}

/** One value all of a model's entries agree on, else undefined. */
function agreed<T>(values: readonly (T | undefined)[], key: (value: T) => string = String): T | undefined {
  const present = values.filter((value): value is T => value !== undefined);
  if (present.length === 0 || present.length !== values.length) return undefined;
  return new Set(present.map(key)).size === 1 ? present[0] : undefined;
}

/**
 * The catalog facts of one provider's model, from this provider's entries only;
 * a fact its entries disagree on is left out. Undefined when the catalog has no
 * entry for it.
 */
export function catalogRecommendationFacts(provider: string, modelId: string): CatalogRecommendationFacts | undefined {
  const models = catalogModelsForReference(modelId, provider);
  if (models.length === 0) return undefined;
  const pricing = agreed(models.map((model) => model.pricing ?? undefined), (price) => `${price.input}/${price.output}`);
  return {
    family: agreed(models.map((model) => model.family)),
    releaseDate: agreed(models.map((model) => model.releaseDate)),
    contextWindow: agreed(models.map((model) => model.contextWindow)),
    ...(pricing ? { pricing: { input: pricing.input, output: pricing.output } } : {}),
  };
}

/** Unknown or conflicting endpoint limits remain unknown. */
export function knownCatalogMaxOutput(provider: string, modelId: string): number | undefined {
  const models = catalogModelsForReference(modelId, provider);
  const limits = new Set(models.map(model => model.maxOutputTokens));
  const limit = limits.values().next().value;
  return limits.size === 1 && typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? limit : undefined;
}
