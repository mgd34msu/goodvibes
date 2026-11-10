import { expect, spyOn, test } from 'bun:test';
import { createDisposalScope, registerDaemonRuntimeBasePollers, registerDaemonRuntimePollers, type DaemonRuntimePollerOwners } from '../../runtime/disposal-wiring.ts';

function owners(calls: string[], close: () => Promise<void>): DaemonRuntimePollerOwners {
  const stop = (name: string) => () => { calls.push(name); };
  return {
    watcherRegistry: { dispose: stop('watchers') }, storeSnapshotScheduler: { stop: stop('snapshots') },
    appendOnlyRetentionScheduler: { stop: stop('retention') }, memoryConsolidationScheduler: { stop: stop('consolidation') },
    codeIndexReindexScheduler: { dispose: stop('reindex') }, sessionOrchestration: { dispose: stop('sessions') },
    knowledgeService: { dispose: stop('knowledge') }, agentKnowledgeService: { dispose: stop('agent-knowledge') },
    homeGraphService: { dispose: stop('home-graph') }, contractRunner: { dispose: stop('contract') },
    processRegistry: { dispose: stop('processes') }, memoryGovernor: { stop: stop('memory') },
    agentOrchestrator: { dispose: stop('orchestrator') }, cancelHostedAgentRuns: () => { calls.push('agents'); return 0; },
    triggerManager: { shutdown: stop('triggers') }, stopDurabilityHousekeeping: stop('durability'),
    stopWakeHousekeeping: stop('wake'), devicePosture: { stopHousekeeping: stop('devices') }, daemonHandlers: { close },
  };
}
const expected = ['handlers', 'wake', 'devices', 'durability', 'agents', 'processes', 'triggers', 'orchestrator', 'memory', 'contract', 'home-graph', 'agent-knowledge', 'knowledge', 'sessions', 'reindex', 'consolidation', 'retention', 'snapshots', 'watchers', 'config'];

test('all declared owners are registered and handler drain precedes the rest of the graph', async () => {
  const calls: string[] = []; const scope = createDisposalScope('fixture');
  let release!: () => void; const hold = new Promise<void>((resolve) => { release = resolve; });
  registerDaemonRuntimePollers(scope.registry, owners(calls, async () => { calls.push('handlers'); await hold; }), { stopConfigWatch: () => { calls.push('config'); } });
  const closed = scope.close();
  try { expect(calls).toEqual(['handlers']); await Promise.resolve(); expect(calls).toHaveLength(1); }
  finally { release(); await closed; }
  expect(calls).toEqual(expected); await scope.close(); expect(calls).toEqual(expected);
});

test('legacy dispose starts cleanup and callers can await its same ownership drain', async () => {
  const calls: string[] = []; const scope = createDisposalScope('fixture');
  registerDaemonRuntimePollers(scope.registry, owners(calls, async () => { calls.push('handlers'); }), { stopConfigWatch: () => { calls.push('config'); } });
  scope.dispose(); await scope.close(); expect(calls).toEqual(expected);
});

test('a handler failure is visible after the remaining owners have still been stopped', async () => {
  const calls: string[] = []; const scope = createDisposalScope('fixture');
  registerDaemonRuntimePollers(scope.registry, owners(calls, async () => { calls.push('handlers'); throw new Error('fixture cleanup'); }), { stopConfigWatch: () => { calls.push('config'); } });
  await expect(scope.close()).rejects.toMatchObject({ code: 'DISPOSAL_FAILED' }); expect(calls).toEqual(expected);
});

test('the constructed base graph can be released when no handler surface was acquired', async () => {
  const calls: string[] = []; const scope = createDisposalScope('fixture');
  const { daemonHandlers: _unacquired, ...base } = owners(calls, async () => { throw new Error('Unacquired handler must not be closed'); });
  registerDaemonRuntimeBasePollers(scope.registry, base, { stopConfigWatch: () => { calls.push('config'); } });
  await scope.close();
  expect(calls).toEqual(expected.slice(1));
});

test('the fleet reader stops before the trigger owner drains and older dependencies remain available', async () => {
  const calls: string[] = [], scope = createDisposalScope('fixture');
  let entered!: () => void, release!: () => void;
  const joined = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  registerDaemonRuntimePollers(scope.registry, {
    ...owners(calls, async () => { calls.push('handlers'); }),
    triggerManager: { shutdown() { calls.push('triggers'); }, async join() {
      calls.push('trigger-join'); entered(); await pending; calls.push('trigger-drained');
    } },
  }, { stopConfigWatch: () => { calls.push('config'); } });
  const closed = scope.close();
  await joined;
  try { expect(calls).toEqual([...expected.slice(0, 7), 'trigger-join']); }
  finally { release(); await closed; }
  expect(calls).toEqual([...expected.slice(0, 7), 'trigger-join', 'trigger-drained', ...expected.slice(7)]);
});


test('the actual daemon graph retains its owned browser shutdown promise', async () => {
  const { BrowserSessionManager } = await import('@goodvibes-jev/engine/platform/platform/browser');
  const { startGatewayFixture } = await import('../helpers/gateway-route-fixture.js');
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  const original = BrowserSessionManager.prototype.shutdown;
  const shutdown = spyOn(BrowserSessionManager.prototype, 'shutdown').mockImplementation(async function(this: InstanceType<typeof BrowserSessionManager>) {
    entered(); await hold; await original.call(this);
  });
  let daemon: Awaited<ReturnType<typeof startGatewayFixture>> | undefined;
  let stop: Promise<void> | undefined;
  try {
    daemon = await startGatewayFixture();
    // Listing builds the real lazy owner without launching a browser/driver.
    await daemon.invoke('browser.sessions.list', {});
    let settled = false;
    stop = daemon.stop().then(() => { settled = true; });
    await Promise.race([arrived, stop.then(() => { throw new Error('Daemon stopped before its original browser shutdown entered'); })]);
    await Promise.resolve(); expect(settled).toBe(false); expect(shutdown).toHaveBeenCalledTimes(1);
    release(); await stop; expect(settled).toBe(true);
  } finally { release(); try { await (stop ?? daemon?.stop()); } finally { shutdown.mockRestore(); } }
});
