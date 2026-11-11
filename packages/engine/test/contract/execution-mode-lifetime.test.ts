import { expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import { ConfigManager } from '../../platform/src/platform/config/manager.js';
import { PermissionManager, createPermissionConfigReader } from '../../platform/src/platform/permissions/manager.js';
import { PolicyRuntimeState } from '../../platform/src/platform/runtime/permissions/policy-runtime.js';
import { ToolRegistry } from '../../platform/src/platform/tools/registry.js';
import { ReadTool } from '../../platform/src/platform/tools/read/index.js';
import { createAgentReadInputProjector } from '../../platform/src/platform/tools/read/admission.js';
import { createFindTool } from '../../platform/src/platform/tools/find/index.js';
import { ProjectIndex } from '../../platform/src/platform/state/project-index.js';
import { executeToolCalls, type ToolExecutionDeps } from '../../platform/src/platform/core/orchestrator-tool-runtime.js';
import { currentExecutionMode, currentExecutionModeOwner, isInvocationAdmitted, withExecutionMode, withExecutionModeOwner, withInvocationExecutionMode } from '../../platform/src/platform/gate/execution-context.js';
import { ContractExecutionWork } from '../../platform/src/platform/contract/owned-execution-work.js';
import { createAgentManagerDecompositionRunner } from '../../platform/src/platform/agents/planner-decomposition-runner.js';
import { makeHarness, oneUnitPlan, startContract, waitFor, type Harness } from './runner-support.js';
import { plannerOutput } from './plan-support.js';

for (const scenario of ['explicit', 'cancelled', 'owner-only', 'owner-mode-change', 'owner-revision-change', 'owner-disposed'] as const)
test(`delayed contract planner/worker read/find respect their own lifetime: ${scenario}`, async () => {
  const cancelled = scenario === 'cancelled';
  let ownerMode: 'yolo' | 'safe-owner' = 'yolo', ownerRevision = 0, ownerDisposed = false;
  const owner = { getMode: () => ownerMode, getRevision: () => {
    if (ownerDisposed) throw new Error('session disposed');
    return ownerRevision;
  } };
  const plannerEntered = Promise.withResolvers<void>();
  const releasePlanner = Promise.withResolvers<void>();
  const releaseWorker = Promise.withResolvers<void>();
  const workerEntered = Promise.withResolvers<void>();
  const workerRead = Promise.withResolvers<void>();
  const failures: unknown[] = [];
  const observed: string[] = [];
  let toolCurrent = true;
  let deps!: ToolExecutionDeps;
  let harness!: Harness;
  harness = makeHarness({
    scripts: {}, plan: oneUnitPlan(),
    planner: { run: request => createAgentManagerDecompositionRunner({ agentManager: harness.manager, pollIntervalMs: 1 }).run(request) },
    async executeAgent(record, { manager }) {
      const planner = record.template === 'planner';
      record.status = 'running';
      if (planner) { plannerEntered.resolve(); await releasePlanner.promise; }
      else { workerEntered.resolve(); await releaseWorker.promise; }
      try {
        const signal = manager.getCancellationSignal(record.id)!;
        const results = await executeToolCalls({ ...deps, turnSignal: signal }, record.id, [
          { id: `${record.id}-read`, name: 'read', arguments: { files: [{ path: 'README.md' }] } },
          { id: `${record.id}-find`, name: 'find', arguments: { queries: [{ id: 'files', mode: 'files', patterns: ['README.md'] }] } },
        ]);
        expect(results.map(result => result.success)).toEqual([true, true]);
        expect(results[0]!.output).toContain('# demo');
        expect(results[1]!.output).toContain('README.md');
        observed.push(planner ? 'planner' : 'worker');
        if (planner) {
          record.fullOutput = plannerOutput(oneUnitPlan());
          record.status = 'completed';
          record.completedAt = Date.now();
        } else {
          workerRead.resolve();
          if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        }
      } catch (error) { failures.push(error); record.status = 'failed'; workerRead.resolve(); }
    },
  });
  const config = new ConfigManager({ surfaceRoot: 'agent', configDir: join(harness.root, '.goodvibes', 'mode-test'), workingDir: harness.root });
  config.set('permissions.mode', 'yolo');
  const manager = new PermissionManager(async () => ({ approved: false }), createPermissionConfigReader(config), new PolicyRuntimeState());
  const registry = new ToolRegistry(manager);
  const index = new ProjectIndex(harness.root);
  registry.register(new ReadTool(index), { inputProjection: createAgentReadInputProjector(index) });
  registry.register(createFindTool(harness.root));
  deps = { permissionManager: manager, toolRegistry: registry, runtimeBus: harness.bus, hookDispatcher: null,
    sessionId: 'retained-contract', emitterContext: () => ({ sessionId: 'retained-contract', traceId: 'test', source: 'test' }),
    autonomousSource: () => ({ goal: 'Inspect the fixture repository', criteria: ['Read and find README.md'] }),
  };
  let contractId: string | undefined;
  try {
    const started = scenario.startsWith('owner')
      ? await withExecutionModeOwner(owner, () => startContract(harness))
      : await withExecutionMode('yolo', () => withInvocationExecutionMode('yolo',
        () => startContract(harness), () => { if (!toolCurrent) throw new Error('initiating tool expired'); }));
    contractId = started.contract.id;
    toolCurrent = false;
    await plannerEntered.promise;
    if (cancelled) harness.runner.cancel(contractId, 'cancel delayed planner');
    if (scenario === 'owner-mode-change') ownerMode = 'safe-owner';
    if (scenario === 'owner-revision-change') ownerRevision++;
    if (scenario === 'owner-disposed') ownerDisposed = true;
    releasePlanner.resolve();
    if (cancelled) {
      await harness.runner.join(contractId);
      expect(observed).toEqual([]);
      expect(failures).toHaveLength(1);
      expect((failures[0] as Error).name).toBe('AbortError');
      return;
    }
    await waitFor(() => observed.includes('planner') || failures.length > 0, 'delayed planner tools');
    if (scenario === 'owner-mode-change' || scenario === 'owner-revision-change' || scenario === 'owner-disposed') {
      expect(observed).toEqual([]);
      expect(failures).toHaveLength(1);
      expect((failures[0] as Error).message).toBe(scenario === 'owner-disposed'
        ? 'session disposed' : 'Execution mode owner changed during retained execution');
      return;
    }
    expect(failures).toEqual([]);
    await workerEntered.promise;
    // Activation has returned by this point; the worker has its own long-lived
    // execution, and must not inherit an already-ended activation scope either.
    await new Promise(resolve => setTimeout(resolve, 0));
    releaseWorker.resolve();
    await workerRead.promise;
    expect(failures).toEqual([]);
    expect(observed).toEqual(['planner', 'worker']);
  } finally {
    releasePlanner.resolve(); releaseWorker.resolve();
    if (contractId) { harness.runner.cancel(contractId, 'test complete'); await harness.runner.join(contractId); }
    await index.dispose();
    harness.dispose();
  }
});

test('queued contract callbacks restore their originating mode owner through drainage', async () => {
  const callerAuthority = new AsyncLocalStorage<string>();
  const settled = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const owner = { getMode: () => 'safe-owner' as const, getRevision: () => 0 };
  const donor = { getMode: () => 'yolo' as const, getRevision: () => 0 };
  let work!: ContractExecutionWork;
  let invocationCurrent = true;
  await callerAuthority.run('initiating authority', () => withExecutionModeOwner(owner, () => withExecutionMode('safe-owner', async () => {
    await withInvocationExecutionMode('safe-owner', async () => { work = new ContractExecutionWork(settled.promise); },
      () => { if (!invocationCurrent) throw new Error('tool expired'); });
  }, () => { if (currentExecutionModeOwner() !== owner) throw new Error('wrong mode owner'); })));
  invocationCurrent = false;
  try {
    const running = callerAuthority.run('current callback authority', () => withExecutionModeOwner(donor, () => withExecutionMode('yolo', () => work.run(async () => {
      expect(currentExecutionModeOwner()).toBe(owner);
      expect(currentExecutionMode()).toBe('safe-owner');
      expect(callerAuthority.getStore()).toBe('current callback authority');
      expect(isInvocationAdmitted('read', {})).toBe(false);
      await cleanup.promise;
      expect(currentExecutionMode()).toBe('safe-owner');
    }))));
    expect(work.idle).toBe(false);
    // An ended/aborted owner may still have admitted cleanup to drain.
    cleanup.resolve(); await running; await work.join();
    expect(work.idle).toBe(true);
    settled.resolve(); await settled.promise;
    await expect(work.run(async () => currentExecutionMode())).rejects.toThrow('Execution mode is no longer current');
  } finally { cleanup.resolve(); settled.resolve(); }
});

for (const invalidation of ['revision', 'disposal'] as const) test(`retained contract mode still checks host ${invalidation}`, async () => {
  const settled = Promise.withResolvers<void>();
  let revision = 0, disposed = false;
  const owner = { getMode: () => 'yolo' as const, getRevision: () => {
    if (disposed) throw new Error('session disposed');
    return revision;
  } };
  let work!: ContractExecutionWork;
  await withExecutionModeOwner(owner, () => withExecutionMode('yolo', async () => {
    work = new ContractExecutionWork(settled.promise);
  }, () => {
    if (currentExecutionModeOwner() !== owner || owner.getRevision() !== 0) throw new Error('host revision changed');
  }));
  if (invalidation === 'revision') revision++; else disposed = true;
  try {
    await expect(work.run(async () => currentExecutionMode())).rejects.toThrow(invalidation === 'revision' ? 'host revision changed' : 'session disposed');
  } finally { settled.resolve(); }
});

test('contract execution capture rejects an already invalid host synchronously', () => {
  const settled = Promise.resolve();
  expect(() => withExecutionMode('yolo', () => new ContractExecutionWork(settled),
    () => { throw new Error('host already expired'); })).toThrow('host already expired');
});
