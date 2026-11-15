import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RemoteSubstrate } from '../platform/src/platform/runtime/remote/index.js';
import { ReconnectEngine, type ConnectOutcome, type TransportAdapter } from '../platform/src/platform/runtime/remote/reconnect.js';
import type { SyncStoreCallbacks } from '../platform/src/platform/runtime/remote/sync.js';
import { deriveRemoteHeartbeat } from '../platform/src/platform/runtime/remote/heartbeat.js';
import { RemoteRunnerRegistry } from '../platform/src/platform/runtime/remote/runner-registry.js';
import { AppendOnlyRetentionScheduler } from '../platform/src/platform/runtime/retention/append-only-registry.js';
import type { AcpConnection } from '../platform/src/platform/runtime/store/domains/acp.js';
import type { RemoteTask } from '../platform/src/platform/runtime/remote/types.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';

const FAST = { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, jitter: 0 };
const IDENTITY = { sessionId: 's1', taskId: 't1', agentId: 'agent-1', createdAt: 1, generation: 1 };
const connected = (replayFromOffset = 0) => ({
  success: true, token: 'tok', epoch: 1, replayFromOffset, negotiatedProtocol: undefined,
}) as unknown as ConnectOutcome;

function adapterWith(overrides: Partial<TransportAdapter>): TransportAdapter {
  return { connect: async () => connected(), disconnect: async () => {}, requestReplay: async () => {}, ...overrides };
}

describe('the reconnect engine', () => {
  test('a rejecting adapter is a retryable failed attempt, not a stuck authenticating state', async () => {
    const disconnects: Array<boolean | undefined> = [];
    const engine = new ReconnectEngine(
      adapterWith({ connect: async () => { throw new Error('ECONNREFUSED'); } }),
      IDENTITY as never,
      undefined,
      { onConnected: () => {}, onTerminalFailure: () => {}, onDisconnected: (_reason, willRetry) => { disconnects.push(willRetry); } },
      FAST,
    );
    expect(await engine.connectOutcome('token')).toBe('retry');
    expect(await engine.connect('token')).toBe(false);
    expect(disconnects).toEqual([true, true]);
  });

  test('two callers asking to reconnect share one loop and one connect per attempt', async () => {
    let calls = 0;
    const engine = new ReconnectEngine(
      adapterWith({ connect: async () => { calls++; return calls < 2 ? ({ success: false, category: 'network', error: 'down', retryable: true } as ConnectOutcome) : connected(); } }),
      IDENTITY as never,
      undefined,
      { onConnected: () => {}, onTerminalFailure: () => {} },
      FAST,
    );
    const first = engine.reconnect(async () => 'token');
    const second = engine.reconnect(async () => 'token');
    expect(second).toBe(first);
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(calls).toBe(2);
  });

  test('replay ends in a settled callback, flagged when the replay failed', async () => {
    for (const failing of [false, true]) {
      const synced: Array<{ ok: boolean; error?: string | undefined }> = [];
      const engine = new ReconnectEngine(
        adapterWith({
          connect: async () => connected(5),
          requestReplay: async () => { if (failing) throw new Error('replay refused'); },
        }),
        IDENTITY as never,
        undefined,
        { onConnected: () => {}, onTerminalFailure: () => {}, onSynced: (ok, error) => { synced.push({ ok, error }); } },
        FAST,
      );
      expect(await engine.connect('token')).toBe(true);
      expect(synced).toHaveLength(1);
      expect(synced[0]?.ok).toBe(!failing);
      if (failing) expect(synced[0]?.error).toContain('replay refused');
    }
  });
});

function substrateWith(adapter: TransportAdapter) {
  const patches: Array<Partial<AcpConnection>> = [];
  const callbacks: SyncStoreCallbacks = {
    updateAcpConnection: (_agentId, patch) => { patches.push(patch); },
    upsertRemoteTask: () => {},
    finalizeRemoteTask: () => {},
  };
  const substrate = new RemoteSubstrate({ endpoint: 'wss://example.invalid', identity: IDENTITY as never, reconnectPolicy: FAST } as never, adapter);
  substrate.attach(adapter, callbacks);
  return { substrate, patches };
}

describe('the remote substrate session', () => {
  test('leaves syncing once the replay finishes', async () => {
    const { substrate } = substrateWith(adapterWith({ connect: async () => connected(3) }));
    expect(await substrate.connect()).toBe(true);
    expect(substrate.session.transportState).toBe('connected');
    substrate.dispose();
  });

  test('shows a failed replay as degraded with the reason', async () => {
    const { substrate } = substrateWith(adapterWith({
      connect: async () => connected(3),
      requestReplay: async () => { throw new Error('replay refused'); },
    }));
    await substrate.connect();
    expect(substrate.session.transportState).toBe('degraded');
    expect(substrate.session.lastError).toContain('replay refused');
    substrate.dispose();
  });

  test('a late healthy report cannot revive a terminal failure', async () => {
    const { substrate, patches } = substrateWith(adapterWith({
      connect: async () => ({ success: false, category: 'authentication', error: 'bad token', retryable: false }) as ConnectOutcome,
    }));
    expect(await substrate.connectOutcome()).toBe('terminal');
    expect(substrate.session.transportState).toBe('terminal_failure');
    const before = patches.length;
    substrate.receiveHealthUpdate({ status: 'healthy', updatedAt: 1 });
    expect(substrate.session.transportState).toBe('terminal_failure');
    expect(patches.slice(before)).toEqual([]);
    substrate.dispose();
  });

  test('an unreachable report on a live connection reads degraded, not reconnecting', async () => {
    const { substrate, patches } = substrateWith(adapterWith({}));
    await substrate.connect();
    substrate.receiveHealthUpdate({ status: 'unreachable', updatedAt: 1, degradedReason: 'no route' });
    expect(patches.at(-1)).toMatchObject({ transportState: 'degraded', lastError: 'no route' });
    substrate.dispose();
  });

  test('a replayed older update cannot reopen a finished task', async () => {
    const { substrate } = substrateWith(adapterWith({}));
    const task = (status: RemoteTask['status'], updatedAt: number): RemoteTask => ({ taskId: 'task-1', agentId: 'agent-1', title: 'T', status, updatedAt });
    substrate.receiveTaskUpdate(task('completed', 20));
    substrate.receiveTaskUpdate(task('running', 10));
    expect(substrate.session.remoteTasks.get('task-1')?.status).toBe('completed');
    substrate.receiveTaskUpdate(task('running', 30));
    expect(substrate.session.remoteTasks.get('task-1')?.status).toBe('completed');
    substrate.dispose();
  });

  test('an older update for an unfinished task is dropped, a newer one applies', async () => {
    const { substrate } = substrateWith(adapterWith({}));
    const task = (status: RemoteTask['status'], updatedAt: number): RemoteTask => ({ taskId: 'task-1', agentId: 'agent-1', title: 'T', status, updatedAt });
    substrate.receiveTaskUpdate(task('running', 20));
    substrate.receiveTaskUpdate(task('queued', 10));
    expect(substrate.session.remoteTasks.get('task-1')?.status).toBe('running');
    substrate.receiveTaskUpdate(task('blocked', 25));
    expect(substrate.session.remoteTasks.get('task-1')?.status).toBe('blocked');
    substrate.dispose();
  });

  test('received and sent messages are counted on the session', async () => {
    const { substrate } = substrateWith(adapterWith({}));
    await substrate.connect();
    const before = substrate.session.messagesReceived;
    substrate.receiveTaskUpdate({ taskId: 'task-1', agentId: 'agent-1', title: 'T', status: 'running', updatedAt: 5 });
    substrate.receiveHealthUpdate({ status: 'healthy', updatedAt: 1 });
    expect(substrate.session.messagesReceived).toBe(before + 2);
    // A dropped stale update is not a counted message.
    substrate.receiveTaskUpdate({ taskId: 'task-1', agentId: 'agent-1', title: 'T', status: 'queued', updatedAt: 1 });
    expect(substrate.session.messagesReceived).toBe(before + 2);
    expect(substrate.session.messagesSent).toBe(0);
    substrate.recordMessageSent();
    substrate.recordMessageSent();
    expect(substrate.session.messagesSent).toBe(2);
    substrate.dispose();
  });

  test('connect does not dereference an engine that was disposed while the token was fetched', async () => {
    const adapter = adapterWith({});
    const substrate = new RemoteSubstrate({
      endpoint: 'wss://example.invalid',
      identity: IDENTITY as never,
      authProvider: { getToken: async () => { substrate.dispose(); return 'token'; } },
    } as never, adapter);
    substrate.attach(adapter);
    expect(await substrate.connectOutcome()).toBe('terminal');
  });
});

describe('the heartbeat read from a connection', () => {
  const connection = (over: Partial<AcpConnection>): AcpConnection => ({
    agentId: 'a', label: 'a', transportState: 'connected', connectedAt: Date.now() - 10 * 60_000,
    completing: false, messageCount: 0, errorCount: 0, ...over,
  });

  test('a healthy connection that connected long ago is fresh', () => {
    expect(deriveRemoteHeartbeat(connection({})).status).toBe('fresh');
  });

  test('a degraded or reconnecting transport is stale', () => {
    expect(deriveRemoteHeartbeat(connection({ transportState: 'degraded' })).status).toBe('stale');
    expect(deriveRemoteHeartbeat(connection({ transportState: 'reconnecting' })).status).toBe('stale');
  });

  test('a failed or disconnected transport is offline', () => {
    expect(deriveRemoteHeartbeat(connection({ transportState: 'terminal_failure' })).status).toBe('offline');
    expect(deriveRemoteHeartbeat(connection({ connectedAt: undefined })).status).toBe('offline');
  });
});

describe('the remote runner registry', () => {
  const agent = (id: string) => ({
    id, template: 'general', task: 'do it', status: 'completed', tools: ['read'], startedAt: 1, completedAt: 2,
    fullOutput: 'out', toolCallCount: 1, executionProtocol: 'gather-plan-apply', reviewMode: 'contract', communicationLane: 'parent-only',
  });
  const registryFor = (workspaceRoot?: string) => new RemoteRunnerRegistry({
    getStatus: (id: string) => (id.startsWith('agent') ? agent(id) : null),
    list: () => [],
  } as never, workspaceRoot);

  test('two captures in the same millisecond keep distinct ids', () => {
    const registry = registryFor();
    const realNow = Date.now;
    Date.now = () => 1_000;
    try {
      const first = registry.captureArtifactForAgent('agent-1');
      const second = registry.captureArtifactForAgent('agent-1');
      expect(first?.id).not.toBe(second?.id);
      expect(registry.listArtifacts()).toHaveLength(2);
    } finally { Date.now = realNow; }
  });

  test('the registry keeps only the newest artifacts', () => {
    const registry = registryFor();
    const realNow = Date.now;
    let clock = 0;
    Date.now = () => ++clock;
    try {
      for (let index = 0; index < 130; index++) registry.captureArtifactForAgent('agent-1');
    } finally { Date.now = realNow; }
    expect(registry.listArtifacts()).toHaveLength(100);
  });

  test('importing an artifact older than the held ones keeps it, and drops the oldest stored instead', async () => {
    const workspace = makeProjectTempDir('remote-runner-old-import');
    const source = registryFor(workspace);
    const realNow = Date.now;
    let clock = 1_000_000;
    Date.now = () => ++clock;
    let older: string;
    try {
      const artifact = source.captureArtifactForAgent('agent-1')!;
      older = (await source.exportArtifact(artifact.id))!.path;
    } finally { Date.now = realNow; }
    const registry = registryFor(workspace);
    Date.now = () => ++clock;
    const held: string[] = [];
    try {
      for (let index = 0; index < 100; index++) held.push(registry.captureArtifactForAgent('agent-1')!.id);
    } finally { Date.now = realNow; }
    const imported = await registry.importArtifact(older);
    expect(registry.getArtifact(imported.id)).not.toBeNull();
    expect(registry.getArtifact(held[0]!)).toBeNull();
    expect(registry.listArtifacts()).toHaveLength(100);
  });

  test('a session bundle with more artifacts than the registry keeps is refused whole', async () => {
    const workspace = makeProjectTempDir('remote-runner-big-bundle');
    const registry = registryFor(workspace);
    const artifact = registry.captureArtifactForAgent('agent-1')!;
    const bundle = registry.buildSessionBundle();
    const oversized = join(workspace, 'bundle.json');
    writeFileSync(oversized, JSON.stringify({
      ...bundle,
      artifacts: Array.from({ length: 101 }, (_, index) => ({ ...artifact, id: `artifact-${index}` })),
    }));
    const fresh = new RemoteRunnerRegistry({ getStatus: () => null, list: () => [] } as never);
    await expect(fresh.importSessionBundle(oversized)).rejects.toThrow('Nothing was imported');
    expect(fresh.listArtifacts()).toEqual([]);
    expect(fresh.listContracts()).toEqual([]);
  });

  test('an imported contract does not replace the live contract of a runner the agent manager still tracks', async () => {
    const workspace = makeProjectTempDir('remote-runner-live-contract');
    const registry = registryFor(workspace);
    const artifact = registry.captureArtifactForAgent('agent-1')!;
    const live = registry.getContract('agent-1');
    const forged = join(workspace, 'forged.json');
    writeFileSync(forged, JSON.stringify({ ...artifact, runnerContract: { ...artifact.runnerContract, label: 'forged label' } }));
    await registry.importArtifact(forged);
    expect(registry.getContract('agent-1')?.label).toBe(live?.label);
    const detached = new RemoteRunnerRegistry({ getStatus: () => null, list: () => [] } as never);
    await detached.importArtifact(forged);
    expect(detached.getContract('agent-1')?.label).toBe('forged label');
  });

  test('exports go under the workspace root, readable by the owner only', async () => {
    const workspace = makeProjectTempDir('remote-runner-export');
    const registry = registryFor(workspace);
    const artifact = registry.captureArtifactForAgent('agent-1')!;
    const exported = await registry.exportArtifact(artifact.id);
    expect(exported?.path.startsWith(workspace)).toBe(true);
    expect(existsSync(exported!.path)).toBe(true);
    expect(statSync(exported!.path).mode & 0o777).toBe(0o600);
  });

  test('an imported artifact missing a field the rerun command reads is refused by name', async () => {
    const workspace = makeProjectTempDir('remote-runner-import');
    const registry = registryFor(workspace);
    const artifact = registry.captureArtifactForAgent('agent-1')!;
    const exported = await registry.exportArtifact(artifact.id);
    const good = JSON.parse(readFileSync(exported!.path, 'utf8')) as { runnerContract: { capabilityCeiling: Record<string, unknown> } };
    delete good.runnerContract.capabilityCeiling.writeScope;
    const broken = join(workspace, 'broken.json');
    writeFileSync(broken, JSON.stringify(good));
    const fresh = new RemoteRunnerRegistry({ getStatus: () => null, list: () => [] } as never);
    await expect(fresh.importArtifact(broken)).rejects.toThrow('writeScope');
    expect(fresh.listArtifacts()).toEqual([]);
  });

  test('an artifact exported by this registry imports cleanly', async () => {
    const workspace = makeProjectTempDir('remote-runner-roundtrip');
    const registry = registryFor(workspace);
    const artifact = registry.captureArtifactForAgent('agent-1')!;
    const exported = await registry.exportArtifact(artifact.id);
    const fresh = new RemoteRunnerRegistry({ getStatus: () => null, list: () => [] } as never);
    expect((await fresh.importArtifact(exported!.path)).id).toBe(artifact.id);
  });
});

describe('the append-only retention scheduler', () => {
  test('a manual tick replaces the armed timer instead of leaving two chains running', () => {
    const armed = new Set<number>();
    let nextId = 0;
    const scheduler = new AppendOnlyRetentionScheduler({
      roots: { workingDirectory: makeProjectTempDir('retention-tick'), surfaceRoot: 'tui' },
      intervalMs: 1_000,
      setTimer: () => { const id = ++nextId; armed.add(id); return id as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: (timer) => { armed.delete(timer as unknown as number); },
    });
    scheduler.start();
    scheduler.tick();
    scheduler.tick();
    expect(armed.size).toBe(1);
    scheduler.stop();
    expect(armed.size).toBe(0);
  });
});
