import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderCapabilityRegistry } from '../platform/src/platform/providers/capabilities.js';
import { ProviderOptimizer } from '../platform/src/platform/providers/optimizer.js';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ModelLimitsService } from '../platform/src/platform/providers/model-limits.js';
import { requestedEffortOverride } from '../platform/src/platform/providers/reasoning-effort-surface.js';
import { ConfiguredModelFollower } from '../platform/src/platform/providers/registry-configured-model.js';
import { computeConfiguredProviderIds } from '../platform/src/platform/providers/registry-configured-ids.js';
import { buildProviderNativeModelDefinition } from '../platform/src/platform/providers/live-model-discovery.js';
import { sweepLiveModelDiscovery, type ProviderRefreshableModel } from '../platform/src/platform/providers/registry-live-model-discovery.js';
import { refreshProviderCatalog } from '../platform/src/platform/providers/registry-catalog-lifecycle.js';
import { RegistryBackedCatalog, type CatalogModel } from '../platform/src/platform/providers/model-catalog.js';
import { buildSyntheticCanonicalModels } from '../platform/src/platform/providers/model-catalog-synthetic.js';
import { installCatalogModelFacts, knownCatalogMaxOutput } from '../platform/src/platform/providers/model-catalog-facts.js';
import { buildRegistryModelPricingDeps } from '../platform/src/platform/providers/model-pricing.js';
import { CATALOG_PROVIDER_NAME_ALIASES } from '../platform/src/platform/providers/provider-aliases.js';
import { findAlternativeModel } from '../platform/src/platform/providers/registry-routing.js';
import { findModelDefinitionForProvider } from '../platform/src/platform/providers/registry-models.js';
import type { LLMProvider } from '../platform/src/platform/providers/interface.js';
import type { ModelDefinition } from '../platform/src/platform/providers/registry-types.js';
import { formatProviderModel, getModelIdFromProviderModel } from '../platform/src/platform/providers/provider-model.js';
import { DEFAULT_CONFIG } from '../platform/src/platform/config/schema.js';

function nativeModel(provider: string, id: string): ModelDefinition {
  return buildProviderNativeModelDefinition(provider, id);
}

function definition(provider: string, id: string, tier?: ModelDefinition['tier']): ModelDefinition {
  return { ...nativeModel(provider, id), selectable: true, ...(tier ? { tier } : { tier: undefined }) };
}

describe('live model discovery sweep', () => {
  test('providers that register while the sweep waits keep their models, and removed ones stay removed', async () => {
    const release = Promise.withResolvers<void>();
    const slow: ProviderRefreshableModel = {
      name: 'slow',
      refreshModels: async () => {
        await release.promise;
        return { models: ['slow-live'], source: 'live', added: ['slow-live'], removed: [] };
      },
    };
    let current: ModelDefinition[] = [nativeModel('slow', 'slow-old'), nativeModel('gone', 'gone-model')];
    const registered = new Set(['slow', 'gone']);
    const sweep = sweepLiveModelDiscovery([slow], () => current, undefined, { isRegistered: (name) => registered.has(name) });

    // Registry changes while the sweep is awaiting the network.
    current = [...current.filter((model) => model.provider !== 'gone'), nativeModel('late', 'late-model')];
    registered.delete('gone');
    registered.add('late');
    release.resolve();

    const { providerNativeModels, reports } = await sweep;
    expect(providerNativeModels.map((model) => model.registryKey).sort()).toEqual(['late:late-model', 'slow:slow-live']);
    expect(reports.map((report) => report.providerId)).toEqual(['slow']);
  });

  test('a provider that is no longer registered when the sweep finishes is not re-added', async () => {
    const provider: ProviderRefreshableModel = {
      name: 'removed',
      refreshModels: async () => ({ models: ['m'], source: 'live', added: ['m'], removed: [] }),
    };
    const { providerNativeModels, reports } = await sweepLiveModelDiscovery([provider], [], undefined, { isRegistered: () => false });
    expect(providerNativeModels).toEqual([]);
    expect(reports).toHaveLength(1);
  });

  test('a provider whose refresh throws gets an error report and does not stop the others', async () => {
    const broken: ProviderRefreshableModel = { name: 'broken', refreshModels: async () => { throw new TypeError('Invalid URL'); } };
    const fine: ProviderRefreshableModel = { name: 'fine', refreshModels: async () => ({ models: ['ok'], source: 'live', added: ['ok'], removed: [] }) };
    const existing = [nativeModel('broken', 'kept')];
    const { providerNativeModels, reports } = await sweepLiveModelDiscovery([broken, fine], existing, undefined, {});
    expect(reports.map((report) => [report.providerId, report.error !== undefined])).toEqual([['broken', true], ['fine', false]]);
    expect(providerNativeModels.map((model) => model.registryKey).sort()).toEqual(['broken:kept', 'fine:ok']);
  });
});

describe('RegistryBackedCatalog', () => {
  test('entries follow the registry when a refresh swaps models without changing their count', () => {
    let models: ModelDefinition[] = [definition('a', 'old-model')];
    let window = 1000;
    const catalog = new RegistryBackedCatalog({ listModels: () => models, getContextWindowForModel: () => window });
    expect(catalog.getModel('old-model')?.context).toBe(1000);
    models = [definition('a', 'new-model')];
    expect(catalog.getModel('old-model')).toBeNull();
    expect(catalog.getModel('new-model')).not.toBeNull();
    window = 5000;
    models = [...models];
    expect(catalog.findLargerContextModels(2000).map((entry) => entry.id)).toEqual(['new-model']);
  });
});

describe('alternative model routing', () => {
  test('a model with no tier reading is not matched to an unrelated unlabelled model', () => {
    const current = definition('a', 'one');
    const registry = [current, definition('b', 'unrelated')];
    expect(findAlternativeModel(current, registry, [])).toBeNull();
  });

  test('a labelled tier still finds a selectable model of another provider', () => {
    const current = definition('a', 'one', 'premium');
    const other = definition('b', 'two', 'premium');
    expect(findAlternativeModel(current, [current, other], [])?.registryKey).toBe('b:two');
  });
});

describe('provider-qualified model ids that contain colons', () => {
  test('an Ollama name:tag is qualified once and read back whole', () => {
    expect(formatProviderModel('ollama', 'llama3:8b')).toBe('ollama:llama3:8b');
    expect(getModelIdFromProviderModel('ollama:llama3:8b')).toBe('llama3:8b');
    expect(formatProviderModel('ollama', 'ollama:llama3:8b')).toBe('ollama:llama3:8b');
  });

  test('an empty value reads as the model half of the default', () => {
    expect(getModelIdFromProviderModel('')).toBe(getModelIdFromProviderModel(DEFAULT_CONFIG.provider.model));
    expect(getModelIdFromProviderModel('')).not.toContain(':');
  });

  test('a provider finds its own colon-bearing id before the colon is read as a qualifier', () => {
    const llama = definition('ollama', 'llama3:8b');
    expect(findModelDefinitionForProvider('llama3:8b', 'ollama', [llama], {})?.registryKey).toBe('ollama:llama3:8b');
    expect(findModelDefinitionForProvider('ollama:llama3:8b', 'ollama', [llama], {})?.registryKey).toBe('ollama:llama3:8b');
  });
});

describe('provider alias handling', () => {
  afterEach(() => { installCatalogModelFacts([]); });

  test('catalog facts, pricing and configured ids agree on which names are one provider', () => {
    installCatalogModelFacts([{ id: 'mercury', name: 'Mercury', provider: 'Inception', providerId: 'inception',
      providerEnvVars: [], pricing: null, tier: 'paid', maxOutputTokens: 8000 }]);
    expect(knownCatalogMaxOutput('inceptionlabs', 'mercury')).toBe(8000);
    expect(knownCatalogMaxOutput('inception', 'mercury')).toBe(8000);

    const deps = buildRegistryModelPricingDeps({
      getManualPrices: () => undefined, findModelPricing: () => null, openRouterPricing: () => null, gatewayPricing: () => null,
      getCatalog: () => null, providerAliases: CATALOG_PROVIDER_NAME_ALIASES, isKnownProviderId: () => true,
    });
    expect(deps.providerMatchesCatalogId('inceptionlabs', 'inception')).toBe(true);
    expect(deps.providerMatchesCatalogId('gemini', 'google')).toBe(true);
    expect(deps.providerMatchesCatalogId('openai', 'google')).toBe(false);
  });

  test('a key for a catalog provider does not configure a separately registered provider with an alias name', () => {
    const subscription: LLMProvider = {
      name: 'openai-subscriber', models: [], isConfigured: () => false,
      chat: async () => ({ content: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'completed' }),
    };
    const ids = computeConfiguredProviderIds([], new Map([['openai-subscriber', subscription]]), () => new Set(), () => ({ openai: 'key' }));
    expect(ids).toContain('openai');
    expect(ids).not.toContain('openai-subscriber');
  });
});

describe('synthetic model ids', () => {
  const offering = (providerId: string, id: string, canonicalModelId: string, name: string): CatalogModel => ({
    id, canonicalModelId, name, provider: providerId, providerId, providerEnvVars: [], pricing: null, tier: 'paid',
  });
  const catalog = [
    offering('p1', 'x', 'lab/x', 'Same Name'), offering('p2', 'x', 'lab/x', 'Same Name'),
    offering('p1', 'y', 'lab/y', 'Same Name'), offering('p2', 'y', 'lab/y', 'Same Name'),
    offering('p1', 'z', 'lab/z', 'Same Name'), offering('p2', 'z', 'lab/z', 'Same Name'),
  ];
  const idsByBackends = (models: readonly CatalogModel[]) => Object.fromEntries(
    buildSyntheticCanonicalModels(models).map((group) => [group.backends.map((backend) => backend.registryKey).join(','), group.id]),
  );

  test('the same model keeps its id when the catalog order changes', () => {
    expect(idsByBackends([...catalog].reverse())).toEqual(idsByBackends(catalog));
  });

  test('colliding names still get distinct ids', () => {
    const ids = Object.values(idsByBackends(catalog));
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });
});

describe('configured model follower', () => {
  function follower(initial: string, candidates: () => Array<{ id: string; provider: string; registryKey: string }> = () => []) {
    const state = { value: initial };
    const instance = new ConfiguredModelFollower({ readConfiguredModel: () => state.value, listModelCandidates: candidates });
    return { state, instance };
  }

  test('a config write after construction is adopted', () => {
    const { state, instance } = follower('a:one');
    state.value = 'b:two';
    expect(instance.adopt('a:one')).toBe('b:two');
  });

  test('an explicit selection is not undone by a config value that has not changed', () => {
    const { instance } = follower('a:one');
    instance.noteExplicitSelection();
    expect(instance.adopt('c:chosen')).toBe('c:chosen');
  });

  test('a bare id that cannot resolve yet keeps the current model and is retried', () => {
    let candidates: Array<{ id: string; provider: string; registryKey: string }> = [];
    const { state, instance } = follower('a:one', () => candidates);
    state.value = 'late-model';
    expect(instance.adopt('a:one')).toBe('a:one');
    candidates = [{ id: 'late-model', provider: 'b', registryKey: 'b:late-model' }];
    expect(instance.adopt('a:one')).toBe('b:late-model');
  });
});

describe('provider optimizer pinned mode', () => {
  const optimizer = () => new ProviderOptimizer(
    { getCurrentModel: () => undefined as never, getSelectableModels: () => [], explainRoute: () => undefined as never },
    new ProviderCapabilityRegistry(),
    true,
  );

  test('pinned mode needs a target and leaves the mode alone when refused', () => {
    const subject = optimizer();
    expect(() => subject.setMode('pinned')).toThrow('pin(providerId, modelId)');
    expect(subject.mode).toBe('manual');
    subject.pin('a', 'one');
    expect(() => subject.setMode('pinned')).not.toThrow();
    expect(subject.mode).toBe('pinned');
  });
});

describe('catalog refresh', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  function context(root: string, applied: { count: number }) {
    return {
      getCatalogCachePaths: () => ({ cachePath: join(root, 'models.json'), tmpPath: join(root, 'models.tmp') }),
      getCatalogModels: () => [],
      updateCatalogState() { applied.count += 1; },
      favoritesStore: { async load() { return { pinned: [], history: [] }; } },
      benchmarkStore: { getTopBenchmarkModelIds: () => [] },
      async refreshCatalog() {},
      afterCatalogApplied() {},
    };
  }

  test('overlapping refreshes share one download', async () => {
    const root = mkdtempSync(join(tmpdir(), 'catalog-single-flight-'));
    const release = Promise.withResolvers<void>();
    let fetches = 0;
    globalThis.fetch = (async () => { fetches += 1; await release.promise; return new Response('unavailable', { status: 503 }); }) as unknown as typeof fetch;
    try {
      const applied = { count: 0 };
      const first = refreshProviderCatalog(context(root, applied));
      const second = refreshProviderCatalog(context(root, applied));
      release.resolve();
      await expect(first).rejects.toThrow('HTTP 503');
      await expect(second).rejects.toThrow('HTTP 503');
      expect(fetches).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a feed with no models is reported as a failed refresh and changes nothing', async () => {
    const { c } = await import('tar');
    const root = mkdtempSync(join(tmpdir(), 'catalog-empty-feed-'));
    const previousPort = installJudgmentPort(fakePort(() => noulAnswer(0.05)).port);
    try {
      mkdirSync(join(root, 'snapshot/providers/test'), { recursive: true });
      writeFileSync(join(root, 'snapshot/providers/test/provider.toml'), 'name="Test"\nenv=[]');
      const parts: Buffer[] = [];
      for await (const part of c({ gzip: true, cwd: root }, ['snapshot'])) parts.push(Buffer.from(part));
      const archive = Buffer.concat(parts);
      globalThis.fetch = (async () => new Response(archive)) as unknown as typeof fetch;
      const applied = { count: 0 };
      await expect(refreshProviderCatalog(context(root, applied))).rejects.toThrow('returned no models');
      expect(applied.count).toBe(0);
    } finally { installJudgmentPort(previousPort); rmSync(root, { recursive: true, force: true }); }
  });
});

describe('tool result limit units', () => {
  test('the character limit is the configured token limit converted, and zero stays unlimited', () => {
    const service = new ModelLimitsService({ cachePath: join(tmpdir(), 'unused-model-limits.json') });
    expect(service.getToolResultMaxCharsForModel(null)).toBe(0);
    const limited = { ...definition('a', 'one'), tokenLimits: { maxToolResultTokens: 1000 } };
    expect(service.getToolResultMaxCharsForModel(limited)).toBe(4000);
  });
});

describe('requested effort override', () => {
  const reader = (origin: string, value: unknown, fail = false) => ({
    get: () => value,
    describeConfigKeySource: () => { if (fail) throw new Error('config store unreadable'); return { effectiveOrigin: origin }; },
  });

  test('a stored explicit level is reported and restored defaults are not', () => {
    expect(requestedEffortOverride(reader('user', 'high'))).toBe('high');
    expect(requestedEffortOverride(reader('default', 'high'))).toBeNull();
  });

  test('a failed config read is an error, not "defaults restored"', () => {
    expect(() => requestedEffortOverride(reader('user', 'high', true))).toThrow('config store unreadable');
  });
});
