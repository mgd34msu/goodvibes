/**
 * model-picker-filter, pure filtering, sorting, and cache-key helpers for ModelPickerModal.
 *
 * All functions are stateless: they receive inputs and return results without
 * side-effects. The class in model-picker.ts uses these as delegates.
 */
import type { CatalogTextWork, ModelDefinition } from '@goodvibes/engine/platform/platform/providers';
import { compositeScore, A_TIER_THRESHOLD } from '@goodvibes/engine/platform/platform/providers';
import type { BenchmarkStore } from '@goodvibes/engine/platform/platform/providers';
import type { ProviderRegistry } from '@goodvibes/engine/platform/platform/providers';
import { tierToCategoryFilter } from './model-picker-types.js';
import type { BenchmarkSort, CapabilityFilter, CategoryFilter, FilteredModelsCache, FilteredProvidersCache, GroupByMode, } from './model-picker-types.js';
import { filterProviders } from './model-picker-provider-filter.js';
export { filterProviders };
// ---------------------------------------------------------------------------
// Cache key helpers
// ---------------------------------------------------------------------------
export function setKey(values: ReadonlySet<string>): string {
    if (values.size === 0)
        return '';
    return [...values].sort().join('');
}
export function orderedListKey(values: readonly string[]): string {
    return values.length === 0 ? '' : values.join('');
}
export function mapKey(values: ReadonlyMap<string, string | undefined>): string {
    if (values.size === 0)
        return '';
    return [...values.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}${value ?? ''}`)
        .join('');
}
// ---------------------------------------------------------------------------
// Synthetic sub-group classification
// ---------------------------------------------------------------------------
export function getSyntheticSubgroup(model: ModelDefinition, providerRegistry: Pick<ProviderRegistry, 'getSyntheticModelInfoFromCatalog'>): 'top' | 'all' {
    const info = providerRegistry.getSyntheticModelInfoFromCatalog(model.id);
    const score = info?.bestCompositeScore ?? null;
    return score !== null && score >= A_TIER_THRESHOLD ? 'top' : 'all';
}
// ---------------------------------------------------------------------------
// buildFilteredModels
// ---------------------------------------------------------------------------
export interface FilterModelParams {
    readonly models: ModelDefinition[];
    readonly configuredProviders: ReadonlySet<string>;
    readonly pinnedIds: ReadonlySet<string>;
    readonly recentIds: readonly string[];
    readonly query: string;
    readonly categoryFilter: CategoryFilter;
    readonly capabilityFilter: CapabilityFilter;
    readonly availableOnly: boolean;
    readonly benchmarkSort: BenchmarkSort;
    readonly groupBy: GroupByMode;
    readonly benchmarkStore: Pick<BenchmarkStore, 'getBenchmarks'>;
    readonly providerRegistry: Pick<ProviderRegistry, 'getSyntheticModelInfoFromCatalog'>;
    /**
     * Whether the catalog says a model reads and writes text, the work every
     * model target gives it: 'other' (an image, video or speech model) is not
     * listed; 'unknown' is listed after the described models.
     */
    readonly textWork?: ((model: ModelDefinition) => CatalogTextWork) | undefined;
    /** Registry keys of the recommended short list (recommendModels), listed after pinned and recent models. */
    readonly recommended?: ReadonlySet<string> | undefined;
}
export function buildFilteredModels(params: FilterModelParams, cache: FilteredModelsCache | null): {
    result: ModelDefinition[];
    cache: FilteredModelsCache;
} {
    const { models, configuredProviders, pinnedIds, recentIds, query, categoryFilter, capabilityFilter, availableOnly, benchmarkSort, groupBy, benchmarkStore, providerRegistry, textWork, recommended, } = params;
    const configuredProvidersKey = setKey(configuredProviders);
    const pinnedIdsKey = setKey(pinnedIds);
    const recentIdsKey = orderedListKey(recentIds);
    if (cache !== null
        && cache.modelsRef === models
        && cache.configuredProvidersKey === configuredProvidersKey
        && cache.pinnedIdsKey === pinnedIdsKey
        && cache.recentIdsKey === recentIdsKey
        && cache.query === query
        && cache.categoryFilter === categoryFilter
        && cache.capabilityFilter === capabilityFilter
        && cache.availableOnly === availableOnly
        && cache.benchmarkSort === benchmarkSort
        && cache.groupBy === groupBy) {
        return { result: cache.result, cache };
    }
    let result = models;
    // Only models that can do the target's work: the catalog's own modality and type facts.
    if (textWork) {
        result = result.filter(m => textWork(m) !== 'other');
    }
    // Available-only filter
    if (availableOnly && configuredProviders.size > 0) {
        result = result.filter(m => configuredProviders.has(m.provider));
    }
    // Pricing tier / category filter
    if (categoryFilter === 'free') {
        result = result.filter(m => m.tier === 'free');
    }
    else if (categoryFilter === 'paid') {
        // Only a model the catalog prices: one whose tier is not published yet is not known to be paid.
        // A model a server on this computer or your own network serves is never paid (modelPriceTier).
        result = result.filter(m => (m.tier === 'standard' || m.tier === 'premium') && m.local !== true);
    }
    else if (categoryFilter === 'subscription') {
        result = result.filter(m => tierToCategoryFilter(m.tier) === 'subscription');
    }
    // Capability filter
    if (capabilityFilter === 'reasoning') {
        result = result.filter(m => m.capabilities?.reasoning === true);
    }
    else if (capabilityFilter === 'toolUse') {
        result = result.filter(m => m.capabilities?.toolCalling === true);
    }
    else if (capabilityFilter === 'multimodal') {
        result = result.filter(m => m.capabilities?.multimodal === true);
    }
    // Query filter, fuzzy: every space-separated word must appear somewhere
    if (query.trim().length > 0) {
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        result = result.filter(m => {
            const haystack = `${m.id} ${m.displayName} ${m.provider}`.toLowerCase();
            return words.every(w => haystack.includes(w));
        });
    }
    // Benchmark sort
    if (benchmarkSort !== 'none') {
        result = [...result].sort((a, b) => {
            let scoreA: number | null = null;
            let scoreB: number | null = null;
            if (benchmarkSort === 'composite') {
                if (a.provider === 'synthetic') {
                    scoreA = providerRegistry.getSyntheticModelInfoFromCatalog(a.id)?.bestCompositeScore ?? null;
                }
                else {
                    const bA = benchmarkStore.getBenchmarks(a.id) ?? benchmarkStore.getBenchmarks(a.displayName);
                    scoreA = bA ? compositeScore(bA.benchmarks) : null;
                }
                if (b.provider === 'synthetic') {
                    scoreB = providerRegistry.getSyntheticModelInfoFromCatalog(b.id)?.bestCompositeScore ?? null;
                }
                else {
                    const bB = benchmarkStore.getBenchmarks(b.id) ?? benchmarkStore.getBenchmarks(b.displayName);
                    scoreB = bB ? compositeScore(bB.benchmarks) : null;
                }
            }
            else {
                // swe/gpqa sort, individual scores not available for synthetic models
                const bA = a.provider === 'synthetic' ? null : (benchmarkStore.getBenchmarks(a.id) ?? benchmarkStore.getBenchmarks(a.displayName));
                const bB = b.provider === 'synthetic' ? null : (benchmarkStore.getBenchmarks(b.id) ?? benchmarkStore.getBenchmarks(b.displayName));
                if (benchmarkSort === 'swe') {
                    scoreA = bA?.benchmarks.swe ?? null;
                    scoreB = bB?.benchmarks.swe ?? null;
                }
                else if (benchmarkSort === 'gpqa') {
                    scoreA = bA?.benchmarks.gpqa ?? null;
                    scoreB = bB?.benchmarks.gpqa ?? null;
                }
            }
            // Models with no score sink to the end
            if (scoreA == null && scoreB == null)
                return 0;
            if (scoreA == null)
                return 1;
            if (scoreB == null)
                return -1;
            return scoreB - scoreA; // descending
        });
    }
    // Synthetic sub-grouping: when groupBy is 'provider', order synthetic models so that
    // "Top Models" (score >= 0.65) appear before "All Synthetic"
    if (groupBy === 'provider' && benchmarkSort === 'none') {
        const nonSynthetic = result.filter(m => m.provider !== 'synthetic');
        const synthetic = result.filter(m => m.provider === 'synthetic');
        if (synthetic.length > 0) {
            const topModels = synthetic.filter(m => getSyntheticSubgroup(m, providerRegistry) === 'top');
            const allModels = synthetic.filter(m => getSyntheticSubgroup(m, providerRegistry) === 'all');
            // Sort top models by composite score descending
            topModels.sort((a, b) => {
                const sA = providerRegistry.getSyntheticModelInfoFromCatalog(a.id)?.bestCompositeScore ?? null;
                const sB = providerRegistry.getSyntheticModelInfoFromCatalog(b.id)?.bestCompositeScore ?? null;
                if (sA == null && sB == null)
                    return 0;
                if (sA == null)
                    return 1;
                if (sB == null)
                    return -1;
                return sB - sA;
            });
            // Sort remaining alphabetically by id
            allModels.sort((a, b) => a.id.localeCompare(b.id));
            result = [...nonSynthetic, ...topModels, ...allModels];
        }
    }
    // Models the catalog does not describe follow the described ones, in their own order.
    if (textWork) {
        const described = result.filter(m => textWork(m) === 'text');
        if (described.length > 0 && described.length < result.length) {
            result = [...described, ...result.filter(m => textWork(m) !== 'text')];
        }
    }
    // The recommended short list leads the rest (pinned and recent go above it
    // next); a benchmark sort the person chose keeps its own order.
    if (recommended && recommended.size > 0 && benchmarkSort === 'none') {
        result = [...result.filter(m => recommended.has(m.registryKey)), ...result.filter(m => !recommended.has(m.registryKey))];
    }
    // Boost recent (non-pinned) models to the front
    if (recentIds.length > 0) {
        // Models can share an id across providers, so the ones moved to the
        // front are tracked by identity and the others keep their place.
        const recent: ModelDefinition[] = [];
        const moved = new Set<ModelDefinition>();
        // Recent entries are registry keys (favorites history).
        for (const key of recentIds) {
            const model = result.find(m => m.registryKey === key);
            if (model && !pinnedIds.has(model.registryKey) && !pinnedIds.has(model.id) && !moved.has(model)) {
                recent.push(model);
                moved.add(model);
            }
        }
        const rest = result.filter(m => !moved.has(m));
        result = [...recent, ...rest];
    }
    // Pinned models lead (before recent), so the picker's Pinned group sits at
    // the top and up/down walks the list in the order it is drawn. Pins may be
    // recorded by model id or by registry key.
    if (pinnedIds.size > 0) {
        const isPinned = (m: ModelDefinition): boolean => pinnedIds.has(m.id) || pinnedIds.has(m.registryKey);
        result = [...result.filter(isPinned), ...result.filter((m) => !isPinned(m))];
    }
    const newCache: FilteredModelsCache = {
        modelsRef: models,
        configuredProvidersKey,
        pinnedIdsKey,
        recentIdsKey,
        query,
        categoryFilter,
        capabilityFilter,
        availableOnly,
        benchmarkSort,
        groupBy,
        result,
    };
    return { result, cache: newCache };
}
// ---------------------------------------------------------------------------
// buildFilteredProviders (cache-aware)
// ---------------------------------------------------------------------------
export function buildFilteredProviders(providers: string[], query: string, cache: FilteredProvidersCache | null): {
    result: string[];
    cache: FilteredProvidersCache;
} {
    if (cache !== null
        && cache.providersRef === providers
        && cache.query === query) {
        return { result: cache.result, cache };
    }
    const result = filterProviders(providers, query);
    const newCache: FilteredProvidersCache = { providersRef: providers, query, result };
    return { result, cache: newCache };
}
