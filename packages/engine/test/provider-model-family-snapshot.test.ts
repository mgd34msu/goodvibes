import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { enrichModelEntries } from '@goodvibes-jev/engine/platform/platform/runtime/ui';
import { createInitialModelState } from '../platform/src/platform/runtime/store/domains/model.ts';
import { createInitialProviderHealthState } from '../platform/src/platform/runtime/store/domains/provider-health.ts';
import { getProviderRuntimeSnapshot, listProviderRuntimeSnapshots, type ModelDefinition } from '@goodvibes-jev/engine/platform/platform/providers';
import { installCatalogModelFacts } from '../platform/src/platform/providers/model-catalog-facts.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); installCatalogModelFacts([]); });
afterEach(() => { installJudgmentPort(previous); installCatalogModelFacts([]); });
function model(): ModelDefinition {
  return { id: 'alias', registryKey: 'local:alias', displayName: 'Opaque alias', provider: 'local',
    description: '', selectable: true, contextWindow: 8192,
    capabilities: { reasoning: false, toolCalling: true, codeEditing: true, multimodal: false } };
}
function publish(family: string): void {
  installCatalogModelFacts([{ id: 'alias', name: 'Published model', family, provider: 'Local', providerId: 'local',
    providerEnvVars: [], pricing: null, tier: 'paid' }]);
}
function registry(): Parameters<typeof getProviderRuntimeSnapshot>[0] {
  return { getRegistered: () => ({ name: 'local', models: ['alias'], chat: async () => { throw new Error('unused'); } }),
    getCurrentModel: model, listModels: () => [model()], describeRuntime: async () => null, resolveModelPricing: () => ({ status: 'unknown' }) };
}

test('runtime snapshots publish repository families immediately and preserve the enrichment switch', async () => {
  publish('llama');
  let calls = 0;
  installJudgmentPort({ model: 'synthetic', async ask() { calls++; throw new Error('Unexpected judgment'); } });
  const source = registry();
  const snapshots = await listProviderRuntimeSnapshots({ ...source, listProviders: () => [source.getRegistered('local')] });
  expect(snapshots[0]?.models[0]).toMatchObject({ family: 'Llama', contextWindow: 8192, registryKey: 'local:alias' });
  expect((await getProviderRuntimeSnapshot(source, 'local', { modelFamilyEnrichment: 'none' }))?.models[0]).not.toHaveProperty('family');
  expect(calls).toBe(0);
});

test('repository refresh replaces family metadata while earlier snapshots remain stable', async () => {
  publish('gpt');
  const source = registry();
  const old = await getProviderRuntimeSnapshot(source, 'local');
  publish('llama');
  expect((await getProviderRuntimeSnapshot(source, 'local'))?.models[0]?.family).toBe('Llama');
  expect(old?.models[0]?.family).toBe('GPT');
  installCatalogModelFacts([]);
  const missing = await getProviderRuntimeSnapshot(source, 'local');
  expect(missing?.models).toHaveLength(1);
  expect(missing?.models[0]).not.toHaveProperty('family');
});

test('picker entries report prompt caching for providers whose adapter sends cache hints, and not for others', () => {
  const entryFor = (provider: string) => enrichModelEntries([{ ...model(), provider }], createInitialProviderHealthState(), createInitialModelState(), new Set(), { getBenchmarks: () => undefined }, {
    getSyntheticModelInfoFromCatalog: () => null,
    getContextWindowForModel: candidate => candidate.contextWindow,
    getKnownContextWindowForModel: candidate => candidate.contextWindow,
  })[0];
  expect(entryFor('anthropic')?.capabilities.caching).toBe(true);
  expect(entryFor('local')?.capabilities.caching).toBe(false);
});

test('picker entries take their family from the local metadata and follow a registry refresh', () => {
  const enrich = () => enrichModelEntries([model()], createInitialProviderHealthState(), createInitialModelState(), new Set(), { getBenchmarks: () => undefined }, {
    getSyntheticModelInfoFromCatalog: () => null,
    getContextWindowForModel: candidate => candidate.contextWindow,
    getKnownContextWindowForModel: candidate => candidate.contextWindow,
  });
  publish('gpt');
  expect(enrich()[0]?.family).toBe('GPT');
  publish('claude-haiku');
  expect(enrich()[0]?.family).toBe('Claude');
});
