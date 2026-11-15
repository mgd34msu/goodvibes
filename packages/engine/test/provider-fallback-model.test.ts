/**
 * Unit tests for buildFallbackModelDefinition / ensureConfiguredModelIsRoutable
 *, the pre-catalog fallback registration for the configured model.
 */
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { forgetProviderReadings, readReasoningFamily } from '../platform/src/platform/routing/provider-readings.ts';
import { forgetModelLimitReadings } from '../platform/src/platform/routing/model-limit-readings.ts';
import { FALLBACK_CONTEXT_WINDOW, readFallbackContextWindow } from '../platform/src/platform/providers/context-window-fallback.ts';
import { describe, expect, test } from 'bun:test';
import {
  buildFallbackModelDefinition,
  ensureConfiguredModelIsRoutable,
} from '../platform/src/platform/providers/fallback-model.ts';
import { ProviderRegistry } from '../platform/src/platform/providers/registry.ts';
import type { ProviderRefreshableModel } from '../platform/src/platform/providers/registry-live-model-discovery.ts';
import type { ConfigManager } from '../platform/src/platform/config/manager.ts';

type RegistryOptions = ConstructorParameters<typeof ProviderRegistry>[0];

function makeRegistryOptions(config: Readonly<Record<string, unknown>> = {}): RegistryOptions {
  const configManager = {
    get: (key: string) => config[key],
    getCategory: () => ({}),
    getControlPlaneConfigDir: () => '/tmp/provider-fallback-model-test',
  } as unknown as RegistryOptions['configManager'];

  const subscriptionManager = {
    get: () => null,
    getPending: () => null,
    saveSubscription: async () => {},
    resolveAccessToken: async () => null,
  } as unknown as RegistryOptions['subscriptionManager'];

  const capabilityRegistry = {
    getCapability: () => ({}),
    getRouteExplanation: () => ({ accepted: true }),
    invalidate: () => {},
    setModelFactsSource: () => {},
    canHandle: () => true,
  } as unknown as RegistryOptions['capabilityRegistry'];

  const cacheHitTracker = { record: () => {} } as unknown as RegistryOptions['cacheHitTracker'];
  const favoritesStore = { load: async () => ({ pinned: [], history: [] }) } as unknown as RegistryOptions['favoritesStore'];
  const benchmarkStore = {
    getBenchmarks: () => undefined,
    getTopBenchmarkModelIds: () => [],
  } as unknown as RegistryOptions['benchmarkStore'];
  const secretsManager = {} as unknown as RegistryOptions['secretsManager'];
  const serviceRegistry = {} as unknown as RegistryOptions['serviceRegistry'];

  return {
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
  };
}

describe('buildFallbackModelDefinition', () => {
  test('marks the definition as a fallback with a provider-qualified registryKey', () => {
    const definition = buildFallbackModelDefinition('anthropic', 'claude-fallback-test');
    expect(definition.registryKey).toBe('anthropic:claude-fallback-test');
    expect(definition.contextWindowProvenance).toBe('fallback');
    expect(definition.selectable).toBe(true);
  });

  test('a model whose id reads into a documented reasoning family gets that spec and is marked reasoning', async () => {
    forgetProviderReadings();
    const previous = installJudgmentPort(fakePort((_name, question) => choiceAnswer(question, 'claude-5', 0.95)).port);
    try {
      await readReasoningFamily('claude-x', 'test');
      const definition = buildFallbackModelDefinition('anthropic', 'claude-x');
      expect(definition.capabilities.reasoning).toBe(true);
      expect(definition.reasoningEffort?.source).toBe('family');
      // Image input is never claimed from a provider's name.
      expect(definition.capabilities.multimodal).toBe(false);
      expect(definition.tier).toBeUndefined();
    } finally {
      installJudgmentPort(previous);
      forgetProviderReadings();
    }
  });

  test('a model whose family has not been read claims no reasoning, levels or image input', () => {
    const definition = buildFallbackModelDefinition('anthropic', 'unread-model');
    expect(definition.capabilities.reasoning).toBe(false);
    expect(definition.capabilities.multimodal).toBe(false);
    expect(definition.reasoningEffort).toBeUndefined();
  });

  test('keeps an unsized model at the fallback estimate without family inference', async () => {
    forgetModelLimitReadings();
    const { port, requests } = fakePort((_name, question, state) => choiceAnswer(question, (state as { model_id?: unknown }).model_id === 'gemini-x' ? 'gemini' : 'claude', 0.95));
    const previous = installJudgmentPort(port);
    try {
      expect(buildFallbackModelDefinition('anthropic', 'claude-x').contextWindow).toBe(FALLBACK_CONTEXT_WINDOW);
      expect(requests).toHaveLength(0);
      await readFallbackContextWindow('anthropic', 'claude-x', 'test');
      await readFallbackContextWindow('google', 'gemini-x', 'test');
      expect(buildFallbackModelDefinition('anthropic', 'claude-x').contextWindow).toBe(FALLBACK_CONTEXT_WINDOW);
      expect(buildFallbackModelDefinition('google', 'gemini-x').contextWindow).toBe(FALLBACK_CONTEXT_WINDOW);
      expect(requests).toHaveLength(0);
    } finally {
      installJudgmentPort(previous);
      forgetModelLimitReadings();
    }
  });

  test('every fallback definition declares tool calling and code editing support', () => {
    const definition = buildFallbackModelDefinition('groq', 'llama-x');
    expect(definition.capabilities.toolCalling).toBe(true);
    expect(definition.capabilities.codeEditing).toBe(true);
  });
});

describe('ensureConfiguredModelIsRoutable', () => {
  test('is a no-op when the configured model is not provider-qualified', () => {
    const registry = createLaunchTolerantAwareRegistry();
    ensureConfiguredModelIsRoutable(registry, makeConfigManager('not-qualified'));
    expect(registry.listModels().some((m) => m.registryKey === 'not-qualified')).toBe(false);
  });

  test('is a no-op when the configured model is already in the live catalog', () => {
    const registry = createLaunchTolerantAwareRegistry();
    const [existing] = registry.listModels();
    if (!existing) throw new Error('test setup expects at least one built-in model to exist');
    const before = registry.listModels().length;
    ensureConfiguredModelIsRoutable(registry, makeConfigManager(existing.registryKey));
    expect(registry.listModels().length).toBe(before);
  });

  test('is a no-op when the configured provider is not registered', () => {
    const registry = createLaunchTolerantAwareRegistry();
    expect(() => ensureConfiguredModelIsRoutable(registry, makeConfigManager('no-such-provider:some-model'))).not.toThrow();
    expect(registry.listModels().some((m) => m.registryKey === 'no-such-provider:some-model')).toBe(false);
  });

  test('registers a runtime fallback model when the provider is registered but the model is unknown to the catalog', () => {
    const registry = createLaunchTolerantAwareRegistry();
    const providerId = registry.listModels()[0]?.provider;
    if (!providerId) throw new Error('test setup expects at least one built-in provider to exist');
    const configuredModel = `${providerId}:a-model-not-in-the-catalog-yet`;

    ensureConfiguredModelIsRoutable(registry, makeConfigManager(configuredModel));

    expect(registry.listModels().some((m) => m.registryKey === configuredModel)).toBe(true);
  });

  test('adds the configured model beside the runtime models the provider already has', () => {
    const registry = createLaunchTolerantAwareRegistry();
    const template = registry.listModels()[0];
    const provider = template ? registry.tryGet(template.provider) : undefined;
    if (!template || !provider) throw new Error('test setup expects at least one built-in provider to exist');
    const runtimeModel = (id: string) => ({ ...buildFallbackModelDefinition(template.provider, id), registryKey: `${template.provider}:${id}` });
    registry.registerRuntimeProvider({ provider, replace: true, models: [runtimeModel('plugin-model-a'), runtimeModel('plugin-model-b')] });

    ensureConfiguredModelIsRoutable(registry, makeConfigManager(`${template.provider}:configured-model`));

    const keys = registry.listModels().map((m) => m.registryKey);
    expect(keys).toContain(`${template.provider}:plugin-model-a`);
    expect(keys).toContain(`${template.provider}:plugin-model-b`);
    expect(keys).toContain(`${template.provider}:configured-model`);
  });
});

describe('refreshLiveModelDiscovery', () => {
  test('overlapping refreshes finish in the order they were asked, so the newest answer stays', async () => {
    const registry = createLaunchTolerantAwareRegistry();
    const template = registry.listModels()[0];
    const provider = template ? registry.tryGet(template.provider) : undefined;
    if (!template || !provider) throw new Error('test setup expects at least one built-in provider to exist');
    const firstAnswer = Promise.withResolvers<void>();
    let calls = 0;
    // The registry's discovery sweep calls this optional method on the registered provider object.
    const refreshable: ProviderRefreshableModel = provider;
    refreshable.refreshModels = async () => {
      calls += 1;
      if (calls === 1) {
        await firstAnswer.promise;
        return { models: ['answer-old'], source: 'live' as const, added: ['answer-old'], removed: [] };
      }
      return { models: ['answer-new'], source: 'live' as const, added: ['answer-new'], removed: [] };
    };

    const first = registry.refreshLiveModelDiscovery(template.provider, { force: true });
    const second = registry.refreshLiveModelDiscovery(template.provider, { force: true });
    firstAnswer.resolve();
    await Promise.all([first, second]);

    const keys = registry.listModels().map((m) => m.registryKey);
    expect(keys).toContain(`${template.provider}:answer-new`);
    expect(keys).not.toContain(`${template.provider}:answer-old`);
  });
});

function makeConfigManager(providerModel: string): ConfigManager {
  return {
    get: (key: string) => (key === 'provider.model' ? providerModel : undefined),
    getCategory: () => ({}),
    getControlPlaneConfigDir: () => '/tmp/provider-fallback-model-test',
  } as unknown as ConfigManager;
}

function createLaunchTolerantAwareRegistry(): ProviderRegistry {
  return new ProviderRegistry(makeRegistryOptions());
}
