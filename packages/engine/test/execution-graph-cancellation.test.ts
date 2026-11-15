import { expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { SubscriptionManager } from '../platform/src/platform/config/subscriptions.ts';
import { ProviderRegistry } from '../platform/src/platform/providers/registry.ts';
import { ProviderCapabilityRegistry } from '../platform/src/platform/providers/capabilities.ts';
import { CacheHitTracker } from '../platform/src/platform/providers/cache-strategy.ts';
import { FavoritesStore } from '../platform/src/platform/providers/favorites.ts';
import { BenchmarkStore } from '../platform/src/platform/providers/model-benchmarks.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { AgentOrchestrator } from '../platform/src/platform/agents/index.ts';
import { createAgentExecutionGraph } from '../platform/src/platform/runtime/agent-graph-composition.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

test('the execution graph bridges the manager cancellation signal into the orchestrator', () => {
  const root = makeProjectTempDir('execution-graph-cancel');
  const configManager = new ConfigManager({ configDir: join(root, 'config') });
  const providerRegistry = new ProviderRegistry({
    configManager,
    subscriptionManager: new SubscriptionManager(join(root, 'subscriptions.json')),
    capabilityRegistry: new ProviderCapabilityRegistry(), cacheHitTracker: new CacheHitTracker(),
    favoritesStore: new FavoritesStore({ dir: root }), benchmarkStore: new BenchmarkStore({ dir: root }),
    secretsManager: { async get() { return null; }, async listDetailed() { return []; } },
    serviceRegistry: { getAll() { return {}; }, async inspect() { return null; } },
  });
  const install = spyOn(AgentOrchestrator.prototype, 'setCancellationSource');
  let graph: ReturnType<typeof createAgentExecutionGraph> | undefined;
  try {
    graph = createAgentExecutionGraph({ workingDirectory: root, configManager, providerRegistry, runtimeBus: new RuntimeEventBus() });
    const source = install.mock.calls[0]?.[0];
    if (!source) throw new Error('The execution graph never installed a cancellation source');
    // A cancel reaches an in-flight run only through this signal.
    expect(source.get('agent-1')).toBe(graph.agentManager.getCancellationSignal('agent-1'));
    expect(source.get('agent-1')?.aborted).toBe(false);
  } finally { graph?.agentOrchestrator.dispose(); install.mockRestore(); }
});
