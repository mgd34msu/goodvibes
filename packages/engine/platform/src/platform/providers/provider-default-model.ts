/**
 * Programmatic per-provider default model resolution backed by `models.dev`.
 *
 * Provider default models are never hardcoded: whenever the `models.dev`
 * catalog or a provider's live model listing refreshes, each provider's default
 * resolves to the highest benchmark-ranked text/chat model it serves.
 *
 * Ranking order (deterministic, zero hardcoded model IDs):
 *   1. Highest `models.dev` normalized `benchmarkScore` (benchmarked models
 *      always outrank unbenchmarked ones).
 *   2. Optional secondary benchmark score (e.g. ZeroEval leaderboard) when
 *      neither model carries a `models.dev` benchmark score.
 *   3. Tool-calling capability (`toolCalling === true` preferred).
 *   4. Newest `models.dev` `releaseDate` (`YYYY-MM-DD` descending).
 *   5. Original order for live/declared lists, otherwise lexicographical id.
 */
import type { CatalogModel } from './model-catalog.js';
import {
  catalogModelBenchmarkScore,
  catalogModelsForProvider,
  catalogModelsForReference,
  catalogTextWork,
} from './model-catalog-facts.js';
import { sameProviderCatalog } from './provider-aliases.js';

export interface ProviderDefaultModelOptions {
  /**
   * Live-discovered or custom-declared model ids for this provider. When
   * non-empty, selection is restricted to this list so a provider never
   * defaults to a model its endpoint does not offer.
   */
  readonly availableModels?: readonly string[] | undefined;
  /**
   * Explicit catalog snapshot to rank against; when omitted, reads the
   * installed `models.dev` catalog facts updated on every catalog refresh.
   */
  readonly catalogModels?: readonly CatalogModel[] | undefined;
  /**
   * Optional secondary numeric benchmark score (higher is better) consulted
   * only when `models.dev` carries no benchmark score for a candidate.
   */
  readonly getExternalBenchmarkScore?: ((modelId: string) => number | null | undefined) | undefined;
  /** Optional predicate restricting eligible candidate model ids. */
  readonly filterModelId?: ((modelId: string) => boolean) | undefined;
  /** Optional model-id mapper applied to the winning catalog model id. */
  readonly normalizeCatalogModelId?: ((modelId: string) => string) | undefined;
}

interface RankedCandidate {
  readonly id: string;
  readonly benchmarkScore: number | undefined;
  readonly externalScore: number | undefined;
  readonly toolCalling: boolean | undefined;
  readonly releaseDate: string | undefined;
  readonly originalIndex: number;
}

const NON_CONVERSATION_TYPES: ReadonlySet<string> = new Set([
  'embedding',
  'reranking',
  'image',
  'video',
  'speech',
  'transcription',
  'decision',
  'realtime',
]);

function isCatalogTextModel(model: CatalogModel): boolean {
  if (model.modelType !== undefined && NON_CONVERSATION_TYPES.has(model.modelType)) return false;
  if (model.outputModalities !== undefined && !model.outputModalities.includes('text')) return false;
  if (model.inputModalities !== undefined && !model.inputModalities.includes('text')) return false;
  return true;
}

function finiteNumber(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function compareCandidates(a: RankedCandidate, b: RankedCandidate, preserveOrderOnTie: boolean): number {
  if (a.benchmarkScore !== undefined && b.benchmarkScore !== undefined && a.benchmarkScore !== b.benchmarkScore) {
    return b.benchmarkScore - a.benchmarkScore;
  }
  if (a.benchmarkScore !== undefined && b.benchmarkScore === undefined) return -1;
  if (a.benchmarkScore === undefined && b.benchmarkScore !== undefined) return 1;

  if (a.externalScore !== undefined && b.externalScore !== undefined && a.externalScore !== b.externalScore) {
    return b.externalScore - a.externalScore;
  }
  if (a.externalScore !== undefined && b.externalScore === undefined) return -1;
  if (a.externalScore === undefined && b.externalScore !== undefined) return 1;

  const toolA = a.toolCalling === true ? 1 : a.toolCalling === false ? -1 : 0;
  const toolB = b.toolCalling === true ? 1 : b.toolCalling === false ? -1 : 0;
  if (toolA !== toolB) return toolB - toolA;

  const dateA = a.releaseDate ?? '';
  const dateB = b.releaseDate ?? '';
  if (dateA !== dateB) return dateB.localeCompare(dateA);

  return preserveOrderOnTie ? a.originalIndex - b.originalIndex : a.id.localeCompare(b.id);
}

function lookupCatalogFacts(
  providerId: string,
  modelId: string,
  explicitCatalog: readonly CatalogModel[] | undefined,
): { readonly benchmarkScore?: number | undefined; readonly toolCalling?: boolean | undefined; readonly releaseDate?: string | undefined; readonly isNonText: boolean } {
  if (explicitCatalog) {
    const providerMatches = explicitCatalog.filter((entry) => sameProviderCatalog(entry.providerId, providerId) && entry.id === modelId);
    const matches = providerMatches.length > 0
      ? providerMatches
      : explicitCatalog.filter((entry) => entry.id === modelId || entry.canonicalModelId === modelId);
    let benchmarkScore: number | undefined;
    let toolCalling: boolean | undefined;
    let releaseDate: string | undefined;
    let sawText = false;
    let sawOther = false;
    for (const entry of matches) {
      if (isCatalogTextModel(entry)) sawText = true;
      else sawOther = true;
      const score = finiteNumber(entry.benchmarkScore);
      if (score !== undefined && (benchmarkScore === undefined || score > benchmarkScore)) benchmarkScore = score;
      if (entry.toolCalling === true) toolCalling = true;
      else if (entry.toolCalling === false && toolCalling === undefined) toolCalling = false;
      if (entry.releaseDate && (!releaseDate || entry.releaseDate > releaseDate)) releaseDate = entry.releaseDate;
    }
    return { benchmarkScore, toolCalling, releaseDate, isNonText: sawOther && !sawText };
  }

  const textWork = catalogTextWork(providerId, modelId);
  const providerMatches = catalogModelsForReference(modelId, providerId);
  let toolCalling: boolean | undefined;
  let releaseDate: string | undefined;
  for (const entry of providerMatches) {
    if (entry.toolCalling === true) toolCalling = true;
    else if (entry.toolCalling === false && toolCalling === undefined) toolCalling = false;
    if (entry.releaseDate && (!releaseDate || entry.releaseDate > releaseDate)) releaseDate = entry.releaseDate;
  }
  return {
    benchmarkScore: catalogModelBenchmarkScore(providerId, modelId),
    toolCalling,
    releaseDate,
    isNonText: textWork === 'other',
  };
}

/**
 * Rank a provider's candidate models from best to worst using `models.dev`
 * benchmark scores, falling back to tool-calling support and release date.
 */
export function rankProviderModels(
  providerId: string,
  options: ProviderDefaultModelOptions = {},
): readonly string[] {
  const filter = options.filterModelId;
  const available = (options.availableModels ?? []).filter((id) => id.trim().length > 0 && (!filter || filter(id)));
  if (available.length > 0) {
    const unique = [...new Set(available)];
    const described = unique.map((id, originalIndex) => {
      const facts = lookupCatalogFacts(providerId, id, options.catalogModels);
      return {
        isNonText: facts.isNonText,
        candidate: {
          id,
          benchmarkScore: facts.benchmarkScore,
          externalScore: finiteNumber(options.getExternalBenchmarkScore?.(id)),
          toolCalling: facts.toolCalling,
          releaseDate: facts.releaseDate,
          originalIndex,
        } satisfies RankedCandidate,
      };
    });
    const textOnly = described.filter((entry) => !entry.isNonText);
    const pool = (textOnly.length > 0 ? textOnly : described).map((entry) => entry.candidate);
    pool.sort((a, b) => compareCandidates(a, b, true));
    return pool.map((entry) => entry.id);
  }

  const catalogEntries = (options.catalogModels
    ? options.catalogModels.filter((entry) => sameProviderCatalog(entry.providerId, providerId))
    : catalogModelsForProvider(providerId))
    .filter((entry) => isCatalogTextModel(entry) && (!filter || filter(entry.id)));

  if (catalogEntries.length === 0) return [];

  const deduped = new Map<string, RankedCandidate>();
  catalogEntries.forEach((entry, originalIndex) => {
    const id = options.normalizeCatalogModelId ? options.normalizeCatalogModelId(entry.id) : entry.id;
    if (!id) return;
    const candidate: RankedCandidate = {
      id,
      benchmarkScore: finiteNumber(entry.benchmarkScore),
      externalScore: finiteNumber(options.getExternalBenchmarkScore?.(id)),
      toolCalling: entry.toolCalling,
      releaseDate: entry.releaseDate,
      originalIndex,
    };
    const existing = deduped.get(id);
    if (!existing || compareCandidates(candidate, existing, false) < 0) {
      deduped.set(id, candidate);
    }
  });

  return [...deduped.values()]
    .sort((a, b) => compareCandidates(a, b, false))
    .map((entry) => entry.id);
}

/**
 * Resolve the programmatic default model id for `providerId`: the highest
 * benchmark-ranked chat/text model from `models.dev` (restricted to live
 * `availableModels` when present), or `undefined` when no models are known yet.
 */
export function resolveProviderDefaultModel(
  providerId: string,
  options: ProviderDefaultModelOptions = {},
): string | undefined {
  return rankProviderModels(providerId, options)[0];
}
