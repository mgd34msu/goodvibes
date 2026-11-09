/**
 * Every required member of RuntimePollerOwners must be satisfiable by a consumer.
 *
 * The contract is all-required by design, and goodvibes-tui and goodvibes-agent
 * each compose their own runtime graph and hand it to registerRuntimePollers.
 * So a required member is a demand on those forks, and the platform has to publish
 * whatever is needed to meet it.
 *
 * `cancelHostedAgentRuns` shipped as required in 1.17.1 while the shared
 * implementation it names, `cancelAllAgentRuns`, was reachable from no published
 * subpath at all, the contract asked for something the package did not hand
 * out, and the only way to satisfy it was to re-write the cancel loop in every
 * fork. The subpath surface gate does not catch this class: it records what IS
 * exported, not whether a required member can be met.
 */
import { describe, expect, test } from 'bun:test';
import { cancelAllAgentRuns, type CancellableAgentRuns } from '../platform/src/platform/tools/index.js';
import { registerRuntimePollers } from '../platform/src/platform/runtime/disposal.js';
import { createAsyncDisposalScope } from '../platform/src/platform/runtime/async-disposal.js';

describe('RuntimePollerOwners is satisfiable from the published surface', () => {
  test('fleet polling stops before trigger shutdown and its asynchronous native drain', async () => {
    const scope = createAsyncDisposalScope('poller shutdown fixture');
    const calls: string[] = [];
    let release!: () => void;
    const pendingChild = new Promise<void>((resolve) => { release = resolve; });
    let fleetStopped = false;
    const stub = { dispose() {}, stop() {} };
    registerRuntimePollers(scope.registry, {
      stopConfigWatch() {}, watcherRegistry: stub, storeSnapshotScheduler: stub,
      appendOnlyRetentionScheduler: stub, memoryConsolidationScheduler: stub,
      codeIndexReindexScheduler: stub, sessionOrchestration: stub, knowledgeService: stub,
      agentKnowledgeService: stub, homeGraphService: stub, contractRunner: stub,
      processRegistry: { dispose() { fleetStopped = true; calls.push('fleet stopped'); } },
      memoryGovernor: stub, agentOrchestrator: stub,
      cancelHostedAgentRuns() { calls.push('agents cancelled'); return 0; },
      triggerManager: {
        shutdown() { expect(fleetStopped).toBe(true); calls.push('triggers stopped'); },
        async join() { calls.push('child draining'); await pendingChild; calls.push('child drained'); },
      },
    });
    const closing = scope.close();
    try {
      // Async disposal advances one owner at a time; wait until the child is
      // actually held so the assertion covers the entire shutdown interval.
      for (let turn = 0; turn < 50 && !calls.includes('child draining'); turn++) await Promise.resolve();
      expect(calls).toEqual(['agents cancelled', 'fleet stopped', 'triggers stopped', 'child draining']);
    } finally { release(); await closing; }
    expect(calls.at(-1)).toBe('child drained');
  });

  test('the tools barrel publishes the agent-run canceller the contract names', () => {
    expect(typeof cancelAllAgentRuns).toBe('function');
  });

  test('cancelAllAgentRuns cancels the live runs, and leaves settled ones alone', () => {
    const cancelled: string[] = [];
    const manager: CancellableAgentRuns = {
      list: () => ([
        { id: 'pending-one', status: 'pending' },
        { id: 'running-one', status: 'running' },
        // Already finished: cancelling it would invent a state change.
        { id: 'done-one', status: 'completed' },
      ] as unknown as ReturnType<CancellableAgentRuns['list']>),
      cancel: (id) => { cancelled.push(id); return true; },
    };
    expect(cancelAllAgentRuns(manager)).toBe(2);
    expect(cancelled).toEqual(['pending-one', 'running-one']);
  });

  test('a consumer-shaped owner object registers without a type assertion', () => {
    // Written the way a fork writes it: an object literal, so a required member
    // this package cannot supply would fail to compile here first.
    const stopped: string[] = [];
    const stub = { dispose: () => { stopped.push('d'); }, stop: () => { stopped.push('s'); } };
    const registry = { add: (label: string, stop: () => void) => { void label; stop(); } };
    registerRuntimePollers(registry, {
      stopConfigWatch: () => { stopped.push('config'); },
      watcherRegistry: stub,
      storeSnapshotScheduler: stub,
      appendOnlyRetentionScheduler: stub,
      memoryConsolidationScheduler: stub,
      codeIndexReindexScheduler: stub,
      sessionOrchestration: stub,
      knowledgeService: stub,
      agentKnowledgeService: stub,
      homeGraphService: stub,
      contractRunner: stub,
      processRegistry: stub,
      memoryGovernor: stub,
      agentOrchestrator: stub,
      cancelHostedAgentRuns: () => cancelAllAgentRuns({ list: () => [], cancel: () => false }),
    });
    expect(stopped).toContain('config');
  });
});
