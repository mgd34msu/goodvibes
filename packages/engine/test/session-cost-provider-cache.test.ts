import { afterEach, describe, expect, test } from 'bun:test';
import { computeUsageCostUsd, setProviderCacheRatios, type ResolvedModelPricing } from '../platform/src/platform/providers/model-pricing.ts';
import { resolveSessionCost, setModelPricingResolver, setPricingSource } from '../platform/src/platform/providers/session-cost.ts';
import type { CatalogModel } from '../platform/src/platform/providers/model-catalog.ts';

afterEach(() => {
  setModelPricingResolver(null);
  setPricingSource(null);
  setProviderCacheRatios(null);
});

const priced: ResolvedModelPricing = { status: 'priced', source: 'catalog', rates: { inputPerMTok: 10, outputPerMTok: 20 } };
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 };

describe('the session total prices cache traffic like each request does', () => {
  test('a provider that publishes a cache-read ratio is billed at it', () => {
    setProviderCacheRatios((provider) => (provider === 'cachey' ? { read: 0.1, write: 1.25 } : undefined));
    setModelPricingResolver(() => priced);
    const perRequest = computeUsageCostUsd(priced, usage, 'cachey');
    expect(perRequest).toBeCloseTo(1, 6);
    expect(resolveSessionCost(0, 0, 1_000_000, 0, 'cachey:big-model').cost).toBeCloseTo(perRequest!, 6);
    // An explicit provider wins over the one the id names.
    expect(resolveSessionCost(0, 0, 1_000_000, 0, 'big-model', 'cachey').cost).toBeCloseTo(perRequest!, 6);
  });

  test('a price from the catalog goes through the same ratio', () => {
    setProviderCacheRatios((provider) => (provider === 'cachey' ? { read: 0.1 } : undefined));
    setModelPricingResolver(() => ({ status: 'unknown' }));
    const model = { id: 'cachey:catalog-model', name: 'm', provider: 'cachey', providerId: 'cachey', providerEnvVars: [], pricing: { input: 10, output: 20 }, tier: 'paid', contextWindow: 1, maxOutputTokens: 1 } as CatalogModel;
    setPricingSource(() => [model]);
    const result = resolveSessionCost(0, 0, 1_000_000, 0, 'cachey:catalog-model');
    expect(result.source).toBe('catalog');
    expect(result.cost).toBeCloseTo(1, 6);
  });

  test('a provider that publishes nothing keeps cache at the input rate', () => {
    setModelPricingResolver(() => priced);
    expect(resolveSessionCost(0, 0, 1_000_000, 0, 'plain:model').cost).toBeCloseTo(10, 6);
  });
});
