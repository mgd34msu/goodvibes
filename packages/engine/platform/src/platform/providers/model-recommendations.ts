/**
 * A short list of models worth trying first, for the model pickers, resting on
 * catalog facts alone: the newest model of a family (its release date), the
 * largest context window, the lowest listed price. Each model on the list
 * carries the plain words why. A provider whose models the catalog gives none
 * of these facts for contributes nothing: no recommendation is ever invented.
 *
 * Facts are compared among one provider's models (what the person picks from
 * once a provider is chosen); a list over several providers keeps the models
 * with the most reasons, newest first, up to {@link MAX_RECOMMENDED}. Only
 * models the catalog says hold a conversation are considered.
 */
import { catalogRecommendationFacts, catalogTextWork, type CatalogRecommendationFacts } from './model-catalog-facts.js';

/** The most models the recommended group lists. */
export const MAX_RECOMMENDED = 5;

/** One model a picker could recommend. */
export interface RecommendationCandidate {
  readonly registryKey: string;
  readonly provider: string;
  readonly id: string;
}

/** "1M", "200K", "32K": a context window in tokens. */
function tokensWords(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1_000)}K`;
}

/** "$0.15" or "$15": a price per 1M tokens. */
function priceWords(price: number): string {
  return `$${price >= 10 ? price.toFixed(0) : price >= 1 ? price.toFixed(2).replace(/\.00$/, '') : price.toFixed(2)}`;
}

interface Scored {
  readonly candidate: RecommendationCandidate;
  readonly facts: CatalogRecommendationFacts;
  readonly reasons: string[];
}

/** The recommendations among one provider's models. */
function providerReasons(entries: readonly Scored[]): void {
  // Newest of each family with at least two dated models.
  const families = new Map<string, Scored[]>();
  for (const entry of entries) {
    const { family, releaseDate } = entry.facts;
    if (!family || !releaseDate) continue;
    families.set(family, [...(families.get(family) ?? []), entry]);
  }
  for (const [family, members] of families) {
    if (members.length < 2) continue;
    const sorted = [...members].sort((a, b) => (b.facts.releaseDate ?? '').localeCompare(a.facts.releaseDate ?? ''));
    const newest = sorted[0]!;
    if (newest.facts.releaseDate !== sorted[1]!.facts.releaseDate) newest.reasons.push(`newest ${family}`);
  }
  // The largest context window, when it is larger than every other one.
  const windows = entries.filter((entry) => typeof entry.facts.contextWindow === 'number' && entry.facts.contextWindow > 0);
  if (windows.length >= 2) {
    const sorted = [...windows].sort((a, b) => (b.facts.contextWindow ?? 0) - (a.facts.contextWindow ?? 0));
    const largest = sorted[0]!;
    if ((largest.facts.contextWindow ?? 0) > (sorted[1]!.facts.contextWindow ?? 0)) {
      largest.reasons.push(`largest context: ${tokensWords(largest.facts.contextWindow ?? 0)} tokens`);
    }
  }
  // The lowest listed price (input and output together), when it is lower than every other one.
  const priced = entries.filter((entry) => entry.facts.pricing !== undefined);
  if (priced.length >= 2) {
    const total = (entry: Scored) => (entry.facts.pricing?.input ?? 0) + (entry.facts.pricing?.output ?? 0);
    const sorted = [...priced].sort((a, b) => total(a) - total(b));
    const cheapest = sorted[0]!;
    if (total(cheapest) < total(sorted[1]!)) {
      const price = cheapest.facts.pricing!;
      cheapest.reasons.push(`lowest price: ${priceWords(price.input)} in, ${priceWords(price.output)} out per 1M tokens`);
    }
  }
}

/**
 * The recommended models among `candidates`, by registry key, each with why
 * ("newest claude-sonnet, largest context: 1M tokens"), at most
 * {@link MAX_RECOMMENDED}, the ones with the most reasons first, then the
 * newest. Empty when the catalog gives no basis for any.
 */
export function recommendModels(candidates: readonly RecommendationCandidate[]): ReadonlyMap<string, string> {
  const byProvider = new Map<string, Scored[]>();
  for (const candidate of candidates) {
    if (catalogTextWork(candidate.provider, candidate.id) !== 'text') continue;
    const facts = catalogRecommendationFacts(candidate.provider, candidate.id);
    if (!facts) continue;
    byProvider.set(candidate.provider, [...(byProvider.get(candidate.provider) ?? []), { candidate, facts, reasons: [] }]);
  }
  const chosen: Scored[] = [];
  for (const entries of byProvider.values()) {
    providerReasons(entries);
    chosen.push(...entries.filter((entry) => entry.reasons.length > 0));
  }
  chosen.sort((a, b) => b.reasons.length - a.reasons.length
    || (b.facts.releaseDate ?? '').localeCompare(a.facts.releaseDate ?? '')
    || a.candidate.registryKey.localeCompare(b.candidate.registryKey));
  return new Map(chosen.slice(0, MAX_RECOMMENDED).map((entry) => [entry.candidate.registryKey, entry.reasons.join(', ')]));
}
