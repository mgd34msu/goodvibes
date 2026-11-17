/**
 * The two pricing seams the composition root injects wherever usage is
 * priced (fleet registry, orchestration engine/phase-runner), built over the
 * ONE model pricing resolver (manual -> registration -> provider-served ->
 * catalog -> honest unknown):
 *
 * - `priceUsage`, honest-unpriced dollars: unknown/subscription yields null
 *   (costState 'unpriced'), never $0. SHARED by fleet + orchestration so
 *   totals never double-count. It prices fresh input, output and cache tokens
 *   through `computeUsageCostUsd`, the formula cost attribution uses too, so
 *   a run shows one dollar figure whichever surface reports it; pass the
 *   provider so cache tokens get that provider's published ratio.
 * - `priceProvenance`, provenance for the SAME resolution priceUsage prices
 *   with, stamped at pricing time so every priced value can say where its
 *   rates came from (costSource) and how fresh dated sources are (as-of).
 */
import { computeUsageCostUsd, type ResolvedModelPricing, type UsageTokenCounts } from '../../providers/model-pricing.js';

export interface PricingSeams {
  readonly priceUsage: (model: string | undefined, usage: UsageTokenCounts, provider?: string | undefined) => number | null;
  readonly priceProvenance: (model: string | undefined, provider?: string | undefined) => { source: 'user' | 'provider' | 'catalog'; asOf?: string | undefined } | null;
}

export function buildPricingSeams(
  registry: { resolveModelPricing(model: string, provider?: string): ResolvedModelPricing },
): PricingSeams {
  return {
    priceUsage: (model, usage, provider) => (model ? computeUsageCostUsd(registry.resolveModelPricing(model, provider), usage, provider) : null),
    priceProvenance: (model, provider) => {
      if (!model) return null;
      const resolved = registry.resolveModelPricing(model, provider);
      return resolved.status === 'priced' ? { source: resolved.source, asOf: resolved.asOf } : null;
    },
  };
}
