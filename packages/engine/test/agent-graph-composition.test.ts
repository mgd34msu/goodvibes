import { afterEach, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { contractCheckpointDir, storedCheckpointText } from '../platform/src/platform/contract/store.js';
import { makeContract, makeUnit } from './contract/fixtures.js';
import type { UnitCheck } from '../platform/src/platform/contract/types.js';
import { createNativeDataWriteOwner, assertNativeReaderCompatible, nativeReaderCapabilities, type NativeDataFormat } from '../platform/src/platform/runtime/native-reader-compatibility.js';
import { realUpdateFileIo } from '../platform/src/platform/runtime/self-update.js';
import { createAgentExecutionGraph, createContractedAgentGraph } from '../platform/src/platform/runtime/agent-graph-composition.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { SubscriptionManager } from '../platform/src/platform/config/subscriptions.ts';
import { ProviderRegistry } from '../platform/src/platform/providers/registry.ts';
import { ProviderCapabilityRegistry } from '../platform/src/platform/providers/capabilities.ts';
import { CacheHitTracker } from '../platform/src/platform/providers/cache-strategy.ts';
import { FavoritesStore } from '../platform/src/platform/providers/favorites.ts';
import { BenchmarkStore } from '../platform/src/platform/providers/model-benchmarks.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { AgentManager } from '../platform/src/platform/tools/agent/index.ts';
import * as composition from '../platform/src/platform/runtime/contract-composition.ts';
import { makeProjectTempDir } from '../test/_helpers/project-temp.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = makeProjectTempDir('agent-graph-base');
  roots.push(root);
  const configManager = new ConfigManager({ configDir: join(root, 'config') });
  const providerRegistry = new ProviderRegistry({
    configManager,
    subscriptionManager: new SubscriptionManager(join(root, 'subscriptions.json')),
    capabilityRegistry: new ProviderCapabilityRegistry(), cacheHitTracker: new CacheHitTracker(),
    favoritesStore: new FavoritesStore({ dir: root }), benchmarkStore: new BenchmarkStore({ dir: root }),
    secretsManager: { async get() { return null; }, async listDetailed() { return []; } },
    serviceRegistry: { getAll() { return {}; }, async inspect() { return null; } },
  });
  return { workingDirectory: root, configManager, providerRegistry, runtimeBus: new RuntimeEventBus() };
}

test('execution collaborators do not allocate or resume a competing contract runner', () => {
  const f = fixture(); const original = composition.composeContractRunner;
  const compose = spyOn(composition, 'composeContractRunner').mockImplementation(original);
  const install = spyOn(AgentManager.prototype, 'setContractRunner');
  let graph: ReturnType<typeof createAgentExecutionGraph> | undefined;
  try {
    graph = createAgentExecutionGraph(f);
    expect(compose).toHaveBeenCalledTimes(0); expect(install).toHaveBeenCalledTimes(0);
    expect('contractRunner' in graph).toBe(false);
    expect(graph.agentManager.list()).toEqual([]);
  } finally { graph?.agentOrchestrator.dispose(); install.mockRestore(); compose.mockRestore(); }
});

test('default graph retains exactly one canonical runner and one startup resume', async () => {
  const f = fixture(); const original = composition.composeContractRunner;
  let resumed: ReturnType<typeof spyOn> | undefined;
  const compose = spyOn(composition, 'composeContractRunner').mockImplementation((options) => {
    const composed = original(options);
    resumed = spyOn(composed.runner, 'resumeAll');
    return composed;
  });
  const install = spyOn(AgentManager.prototype, 'setContractRunner');
  let graph: ReturnType<typeof createContractedAgentGraph> | undefined;
  try {
    graph = createContractedAgentGraph(f);
    expect(compose).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledTimes(1);
    expect(install.mock.calls[0]?.[0]).toBe(graph.contractRunner);
    expect(resumed).toHaveBeenCalledTimes(1);
    await composition.resumeContracts(graph.contractRunner, f.workingDirectory);
    expect(resumed).toHaveBeenCalledTimes(1);
  } finally { graph?.dispose(); graph?.agentOrchestrator.dispose(); resumed?.mockRestore(); install.mockRestore(); compose.mockRestore(); }
});


test('actual canonical composition publishes optional-check reader floor before every serialized check location', () => {
  const f = fixture(), graph = createAgentExecutionGraph(f), execPath = join(f.workingDirectory, 'goodvibes');
  writeFileSync(execPath, 'Original native reader fixture', { mode: 0o755 });
  const owner = createNativeDataWriteOwner({ execPath, version: '3.1.2', assertCurrent() {} });
  const declared: NativeDataFormat[] = []; let target = '', refuse = false;
  const nativeDataWriter = { declare(format: NativeDataFormat) {
    declared.push(format);
    if (format === 'contract-optional-check-digests-v1') {
      expect(existsSync(target)).toBe(false);
      if (refuse) throw new Error('Original optional-check reader unavailable');
    }
    owner.declare(format);
  } };
  const composed = composition.composeContractRunner({ ...f, projectRoot: f.workingDirectory, nativeDataWriter,
    agentManager: graph.agentManager, agentMessageBus: graph.agentMessageBus,
    fleetCapacity: composition.nativeAgentFleetCapacity(f.configManager, graph.agentManager) });
  const pass: UnitCheck = { id: 'current-pass', at: 10, trigger: 'completion', result: 'pass', quality: {},
    goal: { probabilityUnmet: .01, verdict: 'met', outcome: 'act' }, decisionIds: ['actual-passed-decision'] };
  try {
    const old = makeContract({ projectRoot: f.workingDirectory, checks: [{ ...pass, evidenceDigest: 'actual-old-saved-check' }] });
    target = contractCheckpointDir(f.workingDirectory, old.id); composed.store.hold(old);
    expect(composed.store.write(old.id)).toBe(true);
    expect(declared).not.toContain('contract-optional-check-digests-v1');
    expect(storedCheckpointText(f.workingDirectory, old.id)).toContain('actual-old-saved-check');
    for (const location of ['contract', 'group', 'unit', 'attempt'] as const) {
      const current = makeContract({ projectRoot: f.workingDirectory });
      if (location === 'contract') current.checks = [pass];
      if (location === 'group') current.groups[0]!.checks = [pass];
      if (location === 'unit') current.units[0]!.checks = [pass];
      if (location === 'attempt') current.units[0]!.attemptUnits = [makeUnit({ id: 'attempt', attemptOf: current.units[0]!.id, attemptIndex: 0, checks: [pass] })];
      target = contractCheckpointDir(f.workingDirectory, current.id); composed.store.hold(current);
      refuse = true; expect(composed.store.write(current.id)).toBe(false); expect(existsSync(target)).toBe(false);
      refuse = false; declared.length = 0;
      expect(composed.store.write(current.id)).toBe(true); expect(declared).toContain('contract-optional-check-digests-v1');
    }
    const capabilities = nativeReaderCapabilities('3.1.2');
    expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo, capabilities)).not.toThrow();
    expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo, { ...capabilities,
      formats: capabilities.formats.filter(format => format !== 'contract-optional-check-digests-v1') })).toThrow('does not confirm');
  } finally { composed.dispose(); graph.agentOrchestrator.dispose(); rmSync(f.workingDirectory, { recursive: true, force: true }); }
});

test('ordinary review receipts declare optional state bindings before publication and retain older bound receipts', () => {
  const f = fixture(), graph = createAgentExecutionGraph(f), declared: NativeDataFormat[] = [];
  let target = '', refuse = false;
  const nativeDataWriter = { declare(format: NativeDataFormat) {
    declared.push(format);
    if (format === 'optional-review-binding-v1') {
      expect(existsSync(target)).toBe(false);
      if (refuse) throw new Error('Original review-binding reader unavailable');
    }
  } };
  const composed = composition.composeContractRunner({ ...f, projectRoot: f.workingDirectory, nativeDataWriter,
    agentManager: graph.agentManager, agentMessageBus: graph.agentMessageBus,
    fleetCapacity: composition.nativeAgentFleetCapacity(f.configManager, graph.agentManager) });
  try {
    for (const scope of ['final-answer-review', 'goal-obligations', 'original-obligations']) {
      const current = makeContract({ projectRoot: f.workingDirectory });
      current.decisions.push({ id: 'review', at: 10, action: 'checked', targetId: `${current.id}.${scope}`,
        reason: JSON.stringify({ schemaVersion: 2, passed: true, decisionIds: ['actual-review'] }), decisionIds: ['actual-review'] });
      target = contractCheckpointDir(f.workingDirectory, current.id); composed.store.hold(current);
      refuse = true; expect(composed.store.write(current.id)).toBe(false); expect(existsSync(target)).toBe(false);
      refuse = false; declared.length = 0;
      expect(composed.store.write(current.id)).toBe(true); expect(declared).toContain('optional-review-binding-v1');
    }
    const older = makeContract({ projectRoot: f.workingDirectory });
    older.decisions.push({ id: 'old-review', at: 10, action: 'checked', targetId: `${older.id}.final-answer-review`,
      reason: JSON.stringify({ stateHash: '1'.repeat(64), evidenceDigest: '2'.repeat(64) }), decisionIds: ['old-recorded-review'] });
    declared.length = 0; target = contractCheckpointDir(f.workingDirectory, older.id); composed.store.hold(older);
    expect(composed.store.write(older.id)).toBe(true); expect(declared).not.toContain('optional-review-binding-v1');
    expect(nativeReaderCapabilities('3.1.2').formats).toContain('optional-review-binding-v1');
  } finally { composed.dispose(); graph.agentOrchestrator.dispose(); rmSync(f.workingDirectory, { recursive: true, force: true }); }
});

// A borrowed thenable or promise must never have its `then` read or run by the publication boundary.
for (const boundary of ['identity', 'checkpoint'] as const) for (const mode of ['throw-promise', 'return-promise', 'throw-error', 'return-thenable'] as const) {
  test(`contract ${boundary} publication ${mode} preserves refusal and observes owned rejected work`, async () => {
    const f = fixture(), graph = createAgentExecutionGraph(f), contract = makeContract({ projectRoot: f.workingDirectory });
    const work = Promise.withResolvers<void>(), originalError = new Error('Original native reader refused');
    let reads = 0, declarations = 0;
    Object.defineProperty(work.promise, 'then', { get() { reads++; throw new Error('Borrowed Promise then must not run'); } });
    const thenable = { get then() { reads++; throw new Error('Borrowed thenable must not run'); } };
    const nativeDataWriter = { declare(_format: NativeDataFormat) {
      expect(this).toBe(nativeDataWriter); declarations++;
      if (mode === 'throw-promise') throw work.promise;
      if (mode === 'throw-error') throw originalError;
      return mode === 'return-promise' ? work.promise : thenable;
    } };
    const composed = composition.composeContractRunner({ ...f, projectRoot: f.workingDirectory, nativeDataWriter,
      agentManager: graph.agentManager, agentMessageBus: graph.agentMessageBus,
      fleetCapacity: composition.nativeAgentFleetCapacity(f.configManager, graph.agentManager) });
    try {
      let refusal: unknown;
      try {
        if (boundary === 'identity') composed.store.reserveCreation(contract.id);
        else composed.store.prepareCheckpointWrite(contract);
      } catch (error) { refusal = error; }
      if (mode === 'throw-promise') expect(refusal).toBe(work.promise);
      else if (mode === 'throw-error') expect(refusal).toBe(originalError);
      else expect(refusal).toMatchObject({ message: boundary === 'identity'
        ? 'Contract identity publication requires a synchronous native owner'
        : 'Contract data format publication requires a synchronous native owner' });
      expect(declarations).toBe(1);
      expect(reads).toBe(0);
      expect(storedCheckpointText(f.workingDirectory, contract.id)).toBeNull();
      if (mode === 'throw-promise' || mode === 'return-promise') {
        work.reject(new Error('Late native declaration rejection'));
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        expect(reads).toBe(0);
      }
    } finally { composed.dispose(); graph.agentOrchestrator.dispose(); rmSync(f.workingDirectory, { recursive: true, force: true }); }
  });
}
