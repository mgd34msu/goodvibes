import { modelFamilyReadings, type ModelFamily } from '@goodvibes/engine/platform/platform/providers';
import type { ModelDefinition } from '@goodvibes/engine/platform/platform/providers';
export type PickerMode = 'model' | 'provider' | 'effort' | 'contextCap' | 'embeddingProvider' | 'choice';
/**
 * Which config keys the model picker writes to on commit.
 * 'main'       -> provider.model (default; the model key carries its provider)
 * 'helper'     -> helper.globalProvider + helper.globalModel (+ helper.enabled: true)
 * 'tool'       -> tools.llmProvider + tools.llmModel (+ tools.llmEnabled: true)
 * 'tts'        -> tts.llmProvider + tts.llmModel
 * 'embeddings' -> provider.embeddingProvider, via MemoryEmbeddingProviderRegistry.setDefaultProvider()
 *                 (not an LLM route, no model concept, see ModelPickerTargetInfo.configuredNote)
 * 'decision'   -> the judgment.* decision-model settings, through the same choice
 *                 Settings makes (settings-choice-actions.ts); its list is the target's `choices`
 */
export type ModelPickerTarget = 'main' | 'helper' | 'tool' | 'tts' | 'embeddings' | 'decision';
export type ModelPickerFocusRegion = 'targets' | 'items';
/** One entry of a target that is not a provider model (the decision model): its own short list. */
export interface ModelPickerChoice {
    readonly id: string;
    readonly label: string;
    readonly detail?: string | undefined;
    /** The entry the target is set to now. */
    readonly current: boolean;
}
export interface ModelPickerTargetInfo<Target extends ModelPickerTarget = ModelPickerTarget> {
    readonly target: Target;
    readonly label: string;
    readonly description: string;
    readonly provider: string;
    readonly model: string;
    readonly enabled: boolean;
    readonly inherited: boolean;
    /**
     * Honest override for the "Current:" summary line. Used by the 'embeddings'
     * target (which has no model concept, only a provider id + dimensions +
     * configured state) so the renderer never prints a phantom "model:" value.
     * When set, this replaces the computed provider:model route text.
     */
    readonly configuredNote?: string | undefined;
    /** Present on a target chosen from its own list instead of the model catalog (PickerMode 'choice'). */
    readonly choices?: readonly ModelPickerChoice[] | undefined;
}
/** One entry in the embedding-provider picker list (PickerMode 'embeddingProvider'). */
export interface EmbeddingProviderPickerEntry {
    readonly id: string;
    readonly label: string;
    readonly dimensions: number;
    readonly configured: boolean;
    readonly detail?: string | undefined;
}
/**
 * Pricing tier filter.
 * 'paid' matches ModelDefinition tiers 'standard' and 'premium' for forward-compat
 * with future CatalogModel tiers ('free' | 'paid' | 'subscription').
 */
export type CategoryFilter = 'all' | 'free' | 'paid' | 'subscription';
export type { ModelFamily };
export type CapabilityFilter = 'reasoning' | 'toolUse' | 'multimodal' | 'none';
export type BenchmarkSort = 'none' | 'composite' | 'swe' | 'gpqa';
export type GroupByMode = 'provider' | 'family' | 'pricingTier' | 'qualityTier';
/** Render only the canonical settled family for this exact catalog evidence. */
export function detectFamily(model: ModelDefinition): ModelFamily | undefined {
    return modelFamilyReadings.known(model);
}
export function tierToCategoryFilter(tier: string | undefined): CategoryFilter {
    if (tier === 'free')
        return 'free';
    if (tier === 'subscription')
        return 'subscription';
    return 'paid';
}
export interface PickerItem {
    id: string;
    label: string;
    detail?: string | undefined;
    isGroupHeader?: boolean | undefined;
    qualityTier?: string | undefined;
    isPinned?: boolean | undefined;
    isFree?: boolean | undefined;
    isConfigured?: boolean | undefined;
    configuredVia?: ('env' | 'secrets' | 'subscription' | 'anonymous') | undefined;
}
export { POPULAR_PROVIDERS } from './model-picker-provider-filter.js';
export interface FilteredModelsCache {
    readonly modelsRef: ModelDefinition[];
    readonly configuredProvidersKey: string;
    readonly pinnedIdsKey: string;
    readonly recentIdsKey: string;
    readonly query: string;
    readonly categoryFilter: CategoryFilter;
    readonly capabilityFilter: CapabilityFilter;
    readonly availableOnly: boolean;
    readonly benchmarkSort: BenchmarkSort;
    readonly groupBy: GroupByMode;
    readonly result: ModelDefinition[];
}
export interface FilteredProvidersCache {
    readonly providersRef: string[];
    readonly query: string;
    readonly result: string[];
}
export interface ModelItemsCache {
    readonly filteredModelsRef: ModelDefinition[];
    readonly pinnedIdsKey: string;
    readonly groupBy: GroupByMode;
    readonly result: PickerItem[];
}
export interface ProviderItemsCache {
    readonly filteredProvidersRef: string[];
    readonly configuredProvidersKey: string;
    readonly configuredViaKey: string;
    readonly result: PickerItem[];
}
