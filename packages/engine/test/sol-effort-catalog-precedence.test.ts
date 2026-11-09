import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { loadCatalogCache } from '../platform/src/platform/providers/model-catalog-cache.js';
import { installCatalogModelFacts } from '../platform/src/platform/providers/model-catalog-facts.js';
import { getCatalogModelDefinitionsFrom, modelCapabilityFactsFromCatalog, type CatalogModel } from '../platform/src/platform/providers/model-catalog.js';
import { getSyntheticModelDefinitions } from '../platform/src/platform/providers/model-catalog-synthetic.js';
import { resolveEffortForRequest, resolveReasoningEffortSpec } from '../platform/src/platform/providers/reasoning-effort-families.js';
import { effortLevelsForModel, resolveRequestedEffortForServingModel } from '../platform/src/platform/providers/reasoning-effort-surface.js';
import { parseReasoningOptions, reasoningEffortSpecFromLevels } from '../platform/src/platform/providers/reasoning-effort.js';
import { getDiscoveredTraits } from '../platform/src/platform/providers/discovered-traits.js';

const aliases = ['gpt-6.1-sol', 'openai:gpt-6.1-sol', 'openai/gpt-6.1-sol', 'openai-subscriber:gpt-6.1-sol'];
const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
const highOnly = [{ type: 'effort' as const, values: ['low', 'medium', 'high'] }];
const roots: string[] = [];
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'sol-effort-precedence-'));
  roots.push(path);
  return path;
}
afterEach(() => {
  installCatalogModelFacts([]);
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

test.each(aliases)('known Sol controls survive an attached stale catalog spec: %s', modelId => {
  const spec = parseReasoningOptions(highOnly)!;
  expect(effortLevelsForModel({ id: modelId, reasoningEffort: spec })).toEqual(levels);
  for (const requested of ['xhigh', 'max']) {
    // This is the resolver the native adapters use before writing their wire field.
    expect(resolveEffortForRequest(requested, { modelId, spec }).value).toBe(requested);
  }
});

test.each([5, 6, 7])('actual version-%i disk catalog preserves Sol picker and request controls offline', version => {
  const model: CatalogModel = {
    id: 'gpt-6.1-sol', name: 'Sol', provider: 'OpenAI', providerId: 'openai',
    providerEnvVars: [], pricing: null, tier: 'paid', contextWindow: 100000,
    reasoning: true, reasoningOptions: highOnly,
  };
  const cachePath = join(root(), 'catalog.json');
  writeFileSync(cachePath, JSON.stringify({ version, fetchedAt: Date.now(), ttlMs: 3600000, models: [model] }));
  const cache = loadCatalogCache(cachePath)!;
  expect(cache).not.toBeNull();
  installCatalogModelFacts(cache.models);
  const definition = getCatalogModelDefinitionsFrom(cache.models)[0]!;
  expect(effortLevelsForModel(definition)).toEqual(levels);
  for (const modelId of aliases) {
    expect(resolveEffortForRequest('xhigh', { provider: 'openai', modelId }).value).toBe('xhigh');
    expect(resolveEffortForRequest('max', { provider: 'openai', modelId }).value).toBe('max');
  }
});

test.each(aliases)('stale false/empty catalog capability does not bypass Sol effort resolution: %s', modelId => {
  for (const reasoningOptions of [undefined, []]) {
    const model: CatalogModel = {
      id: modelId, name: 'Sol', provider: 'OpenAI', providerId: 'openai',
      providerEnvVars: [], pricing: null, tier: 'paid', contextWindow: 100000,
      reasoning: false, reasoningOptions,
    };
    const ordinary: CatalogModel = { ...model, id: 'actual-fixed-depth-model' };
    const cachePath = join(root(), 'catalog.json');
    writeFileSync(cachePath, JSON.stringify({ version: 7, fetchedAt: Date.now(), ttlMs: 3600000, models: [model, ordinary] }));
    const cached = loadCatalogCache(cachePath)!.models;
    installCatalogModelFacts(cached);
    const definitions = getCatalogModelDefinitionsFrom(cached);
    const sol = definitions[0]!;
    // The real orchestrator checks this flag before calling the effort resolver.
    expect(sol.capabilities.reasoning).toBe(true);
    expect(effortLevelsForModel(sol)).toEqual(levels);
    expect(resolveRequestedEffortForServingModel({ get: () => 'max' }, sol).effective).toBe('max');
    const facts = modelCapabilityFactsFromCatalog(cached);
    expect(facts('openai', modelId)?.reasoningControls).toBe(true);
    expect(facts('openai', ordinary.id)?.reasoningControls).toBe(false);
    expect(definitions[1]!.capabilities.reasoning).toBe(false);
    const synthetic = getSyntheticModelDefinitions(cached, [{
      id: 'sol-failover', tier: 'paid', backendCount: 1, keyedBackendCount: 1,
      backends: [{ providerName: 'openai', modelId, contextWindow: 100000 }],
    }])[0]!;
    expect(synthetic.capabilities.reasoning).toBe(true);
    expect(effortLevelsForModel(synthetic)).toEqual(levels);
    expect(resolveRequestedEffortForServingModel({ get: () => 'xhigh' }, synthetic).effective).toBe('xhigh');
  }
});

test.each(aliases)('explicit endpoint restrictions still govern Sol: %s', modelId => {
  const restricted = reasoningEffortSpecFromLevels(['low', 'high'])!;
  expect(resolveReasoningEffortSpec({ modelId, spec: restricted })).toBe(restricted);
  expect(effortLevelsForModel({ id: modelId, reasoningEffort: restricted })).toEqual(['low', 'high']);
  expect(resolveEffortForRequest('max', { modelId, spec: restricted }).value).toBe('high');
  const fixed = reasoningEffortSpecFromLevels([])!;
  expect(resolveReasoningEffortSpec({ modelId, spec: fixed })).toBe(fixed);
  expect(resolveEffortForRequest('xhigh', { modelId, spec: fixed }).value).toBeUndefined();
});

test('temporary actual endpoint caps do not rewrite the saved Sol preference', () => {
  const configDir = root();
  const config = new ConfigManager({ configDir });
  config.set('provider.model', 'openai:gpt-6.1-sol');
  config.set('provider.reasoningEffort', 'max');
  config.save();
  const restricted = { id: 'gpt-6.1-sol', reasoningEffort: reasoningEffortSpecFromLevels(['low', 'high'])! };
  expect(resolveRequestedEffortForServingModel(config, restricted)).toMatchObject({ requested: 'max', effective: 'high', capped: true });
  const reopened = new ConfigManager({ configDir });
  expect(reopened.get('provider.reasoningEffort')).toBe('max');
  expect(resolveRequestedEffortForServingModel(reopened, {
    id: 'openai:gpt-6.1-sol', reasoningEffort: parseReasoningOptions(highOnly)!,
  })).toMatchObject({ requested: 'max', effective: 'max', capped: false });
  expect(reopened.getIngestionQuarantine().some(notice => notice.key === 'provider.reasoningEffort')).toBe(false);
});

test('actual local adapter declarations still restrict a model named Sol', () => {
  for (const server of ['ollama', 'lm-studio', 'llamacpp'] as const) {
    const spec = getDiscoveredTraits(server).reasoningEffort!;
    expect(spec.source).toBe('declared');
    expect(resolveReasoningEffortSpec({ modelId: 'gpt-6.1-sol', spec })).toBe(spec);
    expect(resolveEffortForRequest('max', { modelId: 'gpt-6.1-sol', spec }).value).toBe('high');
  }
});

test('other exact models retain their existing catalog controls', () => {
  const spec = parseReasoningOptions(highOnly)!;
  expect(resolveReasoningEffortSpec({ modelId: 'another-model', spec })).toBe(spec);
  expect(resolveEffortForRequest('max', { modelId: 'another-model', spec }).value).toBe('high');
});
