/**
 * A ProviderRegistry built from test doubles, plus custom-provider fixture
 * files, so registry lifecycle tests run without real providers or network.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProviderRegistry } from '../../platform/src/platform/providers/registry.ts';
import type { LLMProvider } from '../../platform/src/platform/providers/interface.ts';

export function makeProvider(name: string, models: readonly string[] = []): LLMProvider {
  return {
    name,
    models: [...models],
    // Every provider, whether its models array starts empty or already
    // populated, needs a declared modelSource to pass the registration-time
    // contract check (model-source-contract.ts): a non-empty array is no
    // longer accepted by itself now that the bare-array escape hatch is
    // closed, so this test double always declares 'live-discovery', the same
    // as any real provider whose list starts empty (e.g. Anthropic).
    modelSource: { kind: 'live-discovery' },
    // Registration-time credential contract: doubles declare 'anonymous'.
    credentialAuthority: 'anonymous',
    chat: async () => { throw new Error('not implemented'); },
    stream: async function* () { /* empty */ },
  } as unknown as LLMProvider;
}

/** Build a ProviderRegistry with the minimum required options provided by test doubles. */
export function makeRegistry(
  root = '/tmp/test-registry',
  config: Readonly<Record<string, unknown>> = {},
): ProviderRegistry {
  const configManager = {
    get: (key: string) => config[key],
    getCategory: () => ({}),
    getControlPlaneConfigDir: () => root,
  } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['configManager'];

  const subscriptionManager = {
    get: () => null,
    getPending: () => null,
    saveSubscription: async () => {},
    resolveAccessToken: async () => null,
  } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['subscriptionManager'];

  // No bare `as unknown as` on this double any more. The cast was hiding that
  // it does not implement setModelFactsSource, which the registry CALLS on
  // every catalog update, the omission surfaced only as a runtime TypeError
  // once a test reached that path. The `satisfies` clause makes the next
  // missing method a compile error instead.
  const capabilityRegistry = {
    getCapability: () => ({}),
    getRouteExplanation: () => ({ accepted: true }),
    invalidate: () => {},
    setModelFactsSource: () => {},
    canHandle: () => true,
  } satisfies Record<keyof ConstructorParameters<typeof ProviderRegistry>[0]['capabilityRegistry'], unknown> as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['capabilityRegistry'];

  const cacheHitTracker = {
    record: () => {},
  } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['cacheHitTracker'];

  const favoritesStore = {
    load: async () => ({ pinned: [], history: [] }),
  } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['favoritesStore'];

  const benchmarkStore = {
    getBenchmarks: () => undefined,
    getTopBenchmarkModelIds: () => [],
  } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['benchmarkStore'];

  const secretsManager = {} as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['secretsManager'];
  const serviceRegistry = {} as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['serviceRegistry'];

  return new ProviderRegistry({
    configManager,
    subscriptionManager,
    capabilityRegistry,
    cacheHitTracker,
    favoritesStore,
    benchmarkStore,
    secretsManager,
    serviceRegistry,
    featureFlags: null,
    runtimeBus: null,
  });
}

export function writeCustomProvider(root: string, name: string, modelId: string): void {
  const providersDir = join(root, 'providers');
  mkdirSync(providersDir, { recursive: true });
  writeFileSync(join(providersDir, `${name}.json`), JSON.stringify({
    name,
    displayName: name,
    type: 'openai-compat',
    baseURL: `https://${name}.example.test/v1`,
    models: [{
      id: modelId,
      displayName: modelId,
      contextWindow: 8192,
      capabilities: {
        toolCalling: true,
        codeEditing: false,
        reasoning: false,
        multimodal: false,
      },
    }],
  }));
}
