/**
 * Context window UI and diagnostics tests.
 *
 * Proves that ModelPickerEntry includes contextWindow and contextWindowSource,
 * and that getContextIngestionDiagnostics surfaces cache state.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LocalContextIngestionService,
} from '@goodvibes-jev/engine/platform/platform/providers';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { SecretsManager } from '../../config/secrets.ts';
import { ServiceRegistry } from '@goodvibes-jev/engine/platform/platform/config';
import { SubscriptionManager } from '@goodvibes-jev/engine/platform/platform/config';
import { enrichModelEntries } from '@/runtime/index.ts';
import type { ModelDefinition } from '@goodvibes-jev/engine/platform/platform/providers';
import { ProviderRegistry } from '@goodvibes-jev/engine/platform/platform/providers';
import { createLaunchTolerantProviderRegistry } from '@goodvibes-jev/engine/platform/platform/providers';
import { createInitialProviderHealthState } from '@/runtime/index.ts';
import { createInitialModelState } from '@/runtime/index.ts';
import { CacheHitTracker } from '@goodvibes-jev/engine/platform/platform/providers';
import { ProviderCapabilityRegistry } from '@goodvibes-jev/engine/platform/platform/providers';
import { FavoritesStore } from '@goodvibes-jev/engine/platform/platform/providers';
import { BenchmarkStore } from '@goodvibes-jev/engine/platform/platform/providers';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    id: 'test-model',
    provider: 'test-provider',
    registryKey: 'test-provider:test-model',
    displayName: 'Test Model',
    description: '',
    contextWindow: 32_768,
    selectable: true,
    capabilities: {
      toolCalling: true,
      codeEditing: true,
      reasoning: false,
      multimodal: false,
    },
    ...overrides,
  };
}

function makeHealthState() {
  return createInitialProviderHealthState();
}

function makeModelState(activeModelId = 'test-model') {
  const state = createInitialModelState();
  return { ...state, activeModelId };
}

interface EnrichmentHarness {
  readonly favoritesStore: FavoritesStore;
  readonly benchmarkStore: BenchmarkStore;
  readonly providerRegistry: ProviderRegistry;
  readonly contextIngestionService: LocalContextIngestionService;
  cleanup(): void;
}

function createEnrichmentHarness(): EnrichmentHarness {
  const rootDir = makeProjectTempDir('gv-context-window-ui');
  const configDir = join(rootDir, 'config');
  const dataDir = join(rootDir, 'provider-data');
  const subscriptionsPath = join(rootDir, 'subscriptions.json');
  const servicesPath = join(rootDir, 'services.json');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const secretsManager = new SecretsManager({ projectRoot: rootDir, globalHome: rootDir });
  const subscriptionManager = new SubscriptionManager(subscriptionsPath);
  const serviceRegistry = new ServiceRegistry(servicesPath, {
    secretsManager,
    subscriptionManager,
  });
  const favoritesStore = new FavoritesStore({ dir: dataDir });
  const benchmarkStore = new BenchmarkStore({ dir: dataDir });
  const contextIngestionService = new LocalContextIngestionService();
  writeFileSync(favoritesStore.getPath(), JSON.stringify({ pinned: [], history: [] }, null, 2));
  writeFileSync(
    benchmarkStore.getCachePath(),
    JSON.stringify({ version: 1 as const, fetchedAt: Date.now(), ttlMs: 86_400_000, entries: [] }, null, 2),
  );
  benchmarkStore.initBenchmarks();

  const providerRegistry = createLaunchTolerantProviderRegistry({
    configManager: new ConfigManager({ surfaceRoot: 'agent',  configDir }),
    subscriptionManager,
    secretsManager,
    serviceRegistry,
    capabilityRegistry: new ProviderCapabilityRegistry(),
    cacheHitTracker: new CacheHitTracker(),
    favoritesStore,
    benchmarkStore,
  });

  return {
    favoritesStore,
    benchmarkStore,
    providerRegistry,
    contextIngestionService,
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}

let harness: EnrichmentHarness;

beforeEach(() => {
  harness = createEnrichmentHarness();
});

afterEach(() => {
  harness?.cleanup();
});

// ---------------------------------------------------------------------------
// enrichModelEntries, contextWindow and contextWindowSource fields
// ---------------------------------------------------------------------------

describe('enrichModelEntries: contextWindow fields', () => {
  test('entry includes contextWindow equal to model.contextWindow when no OpenRouter cache', () => {
    const model = makeModel({ contextWindow: 32_768 });
    const entries = enrichModelEntries(
      [model],
      makeHealthState(),
      makeModelState(),
      new Set(),
      harness.benchmarkStore,
      harness.providerRegistry,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.contextWindow).toBe(32_768);
  });

  test('entry contextWindowSource is "registry" when no provenance and no OpenRouter data', () => {
    const model = makeModel({ contextWindow: 32_768 });
    const entries = enrichModelEntries(
      [model],
      makeHealthState(),
      makeModelState(),
      new Set(),
      harness.benchmarkStore,
      harness.providerRegistry,
    );
    expect(entries[0]!.contextWindowSource).toBe('registry');
  });

  test('entry contextWindowSource is "provider_api" when model has provider_api provenance', () => {
    const model = makeModel({
      contextWindow: 131_072,
      contextWindowProvenance: 'provider_api',
    });
    const entries = enrichModelEntries(
      [model],
      makeHealthState(),
      makeModelState(),
      new Set(),
      harness.benchmarkStore,
      harness.providerRegistry,
    );
    expect(entries[0]!.contextWindowSource).toBe('provider_api');
    expect(entries[0]!.contextWindow).toBe(131_072);
  });

  test('entry contextWindowSource is "configured_cap" when model has configured_cap provenance', () => {
    const model = makeModel({
      contextWindow: 65_536,
      contextWindowProvenance: 'configured_cap',
    });
    const entries = enrichModelEntries(
      [model],
      makeHealthState(),
      makeModelState(),
      new Set(),
      harness.benchmarkStore,
      harness.providerRegistry,
    );
    expect(entries[0]!.contextWindowSource).toBe('configured_cap');
  });

  test('entry contextWindowSource is "fallback" when model has fallback provenance', () => {
    const model = makeModel({
      contextWindow: 8_192,
      contextWindowProvenance: 'fallback',
    });
    const entries = enrichModelEntries(
      [model],
      makeHealthState(),
      makeModelState(),
      new Set(),
      harness.benchmarkStore,
      harness.providerRegistry,
    );
    expect(entries[0]!.contextWindowSource).toBe('fallback');
  });

  test('multiple models each have correct contextWindow', () => {
    const models = [
      makeModel({ id: 'small', contextWindow: 8_192 }),
      makeModel({ id: 'large', contextWindow: 128_000, contextWindowProvenance: 'provider_api' }),
      makeModel({ id: 'medium', contextWindow: 32_768, contextWindowProvenance: 'configured_cap' }),
    ];
    const entries = enrichModelEntries(
      models,
      makeHealthState(),
      makeModelState('small'),
      new Set(),
      harness.benchmarkStore,
      harness.providerRegistry,
    );
    const byId = new Map(entries.map((e) => [e.modelId, e]));
    expect(byId.get('small')!.contextWindow).toBe(8_192);
    expect(byId.get('small')!.contextWindowSource).toBe('registry');
    expect(byId.get('large')!.contextWindow).toBe(128_000);
    expect(byId.get('large')!.contextWindowSource).toBe('provider_api');
    expect(byId.get('medium')!.contextWindow).toBe(32_768);
    expect(byId.get('medium')!.contextWindowSource).toBe('configured_cap');
  });
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

describe('getContextIngestionDiagnostics', () => {
  const originalFetch = globalThis.fetch;
  let clock = 1_700_000_000_000;

  beforeEach(() => {
    clock = 1_700_000_000_000;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'http://local-a.test/v1/models') {
        return new Response(
          JSON.stringify({ data: [{ id: 'big', max_context_length: 131072 }, { id: 'small', max_context_length: 4096 }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns empty array when no ingestion has occurred', () => {
    expect(new LocalContextIngestionService(() => clock).getDiagnostics()).toEqual([]);
  });

  test('reports one row per ingested provider with its model count and failure flag', async () => {
    const service = new LocalContextIngestionService(() => clock);
    await service.ingestProviderContextWindows('local-a', 'http://local-a.test/v1');
    clock += 5;
    await service.ingestProviderContextWindows('local-offline', 'http://local-offline.test/v1');

    const diag = service.getDiagnostics();
    expect(diag).toHaveLength(2);
    expect(diag).toEqual([
      { providerName: 'local-a', fetchedAt: 1_700_000_000_000, modelCount: 2, failed: false },
      { providerName: 'local-offline', fetchedAt: 1_700_000_000_005, modelCount: 0, failed: true },
    ]);
  });

  test('clearAllCaches empties the diagnostics', async () => {
    const service = new LocalContextIngestionService(() => clock);
    await service.ingestProviderContextWindows('local-a', 'http://local-a.test/v1');
    expect(service.getDiagnostics()).toHaveLength(1);
    service.clearAllCaches();
    expect(service.getDiagnostics()).toEqual([]);
  });
});
