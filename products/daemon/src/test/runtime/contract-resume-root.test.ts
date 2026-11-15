import { expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager, SubscriptionManager } from '@goodvibes-jev/engine/platform/platform/config';
import { createLaunchTolerantProviderRegistry, ProviderCapabilityRegistry, CacheHitTracker, FavoritesStore, BenchmarkStore } from '@goodvibes-jev/engine/platform/platform/providers';
import { RuntimeEventBus } from '@goodvibes-jev/engine/platform/platform/runtime/state';
import { createAgentExecutionGraph } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import * as composition from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { KnowledgeStore, ProjectPlanningService } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { ExecutionPlanManager } from '@goodvibes-jev/engine/platform/platform/core';
import { createRuntimeStore } from '@goodvibes-jev/engine/platform/platform/runtime/store';
import { createDaemonContractServices } from '../../runtime/contract-composition.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

function fixture() {
  const root = makeOwnedTempDir('agent-graph-base');
  const configManager = new ConfigManager({ configDir: join(root, 'config') });
  const providerRegistry = createLaunchTolerantProviderRegistry({
    configManager,
    subscriptionManager: new SubscriptionManager(join(root, 'subscriptions.json')),
    capabilityRegistry: new ProviderCapabilityRegistry(), cacheHitTracker: new CacheHitTracker(),
    favoritesStore: new FavoritesStore({ dir: root }), benchmarkStore: new BenchmarkStore({ dir: root }),
    secretsManager: { async get() { return null; }, async listDetailed() { return []; } },
    serviceRegistry: { getAll() { return {}; }, async inspect() { return null; } },
  });
  return { workingDirectory: root, configManager, providerRegistry, runtimeBus: new RuntimeEventBus() };
}

async function compose(f: ReturnType<typeof fixture>) {
  const graph = createAgentExecutionGraph(f);
  const contracts = createDaemonContractServices({ ...f, projectRoot: f.workingDirectory,
    agentManager: graph.agentManager, agentMessageBus: graph.agentMessageBus,
    acpHost: { list: () => [] }, runtimeStore: createRuntimeStore(),
    workPlanService: new ProjectPlanningService(new KnowledgeStore({ configManager: f.configManager, dbFileName: 'resume-plans.sqlite' }), { defaultProjectId: 'fixture-project' }),
    planManager: new ExecutionPlanManager(f.workingDirectory),
    readAccessFilter: async () => true,
  });
  return { contracts, dispose: () => { contracts.dispose(); graph.agentOrchestrator.dispose(); } };
}

test('a composition rebuilt on the same root after the first one was disposed resumes the contracts on disk again', async () => {
  const f = fixture();
  const first = await compose(f);
  const firstResume = spyOn(first.contracts.runner, 'resumeAll');
  await composition.resumeContracts(first.contracts.runner, f.workingDirectory);
  await composition.resumeContracts(first.contracts.runner, f.workingDirectory);
  expect(firstResume).toHaveBeenCalledTimes(1);
  first.dispose();

  const second = await compose(f);
  const secondResume = spyOn(second.contracts.runner, 'resumeAll');
  try {
    await composition.resumeContracts(second.contracts.runner, f.workingDirectory);
    expect(secondResume).toHaveBeenCalledTimes(1);
  } finally { second.dispose(); }
});

test('a failed resume is not remembered, so the next call for the root tries again', async () => {
  const f = fixture();
  const first = await compose(f);
  const failing = spyOn(first.contracts.runner, 'resumeAll').mockRejectedValue(new Error('fixture failure'));
  try {
    expect(await composition.resumeContracts(first.contracts.runner, f.workingDirectory)).toBeNull();
    failing.mockRestore();
    const retry = spyOn(first.contracts.runner, 'resumeAll');
    const report = await composition.resumeContracts(first.contracts.runner, f.workingDirectory);
    expect(report).not.toBeNull();
    expect(retry).toHaveBeenCalledTimes(1);
  } finally { first.dispose(); }
});
