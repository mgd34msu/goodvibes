import { expect, test } from 'bun:test';
import { installCatalogModelFacts } from '../platform/src/platform/providers/model-catalog-facts.ts';
import { effortSpecForModel } from '../platform/src/platform/providers/reasoning-effort-surface.ts';

test('effort surfaces resolve the exact serving provider when model IDs collide', () => {
  installCatalogModelFacts(['one', 'two'].map(providerId => ({
    id: 'shared-model', name: 'Shared model', provider: providerId, providerId, providerEnvVars: [],
    pricing: null, tier: 'paid' as const,
    reasoningOptions: [{ type: 'effort' as const, values: providerId === 'one' ? ['low', 'high'] : ['medium', 'max'] }],
  })));
  try {
    expect(effortSpecForModel({ id: 'shared-model', provider: 'one' }).values).toEqual(['low', 'high']);
    expect(effortSpecForModel({ id: 'shared-model', provider: 'two' }).values).toEqual(['medium', 'max']);
  } finally { installCatalogModelFacts([]); }
});
