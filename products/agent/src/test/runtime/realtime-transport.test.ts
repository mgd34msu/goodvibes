import { createPreparedAgentRuntimeServices } from '../helpers/prepared-runtime-services.ts';
import { seedProviderMetadataCacheFixture } from '../helpers/provider-metadata-cache-fixture.ts';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { DaemonServer } from '@goodvibes-jev/engine/platform/platform/daemon';
import type { AgentEvent } from '@/runtime/index.ts';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import { createRealtimeTransport } from '@/runtime/index.ts';
import { createAuthenticatedWebSocket } from '../helpers/authenticated-websocket.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import type { RuntimeServices } from '../../runtime/services.ts';
import { UserAuthManager } from '@goodvibes-jev/engine/platform/platform/security';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const TEST_TOKEN = 'realtime-transport-token-abc123';

function createTransportFeatureFlags() {
  const featureFlags = createFeatureFlagManager();
  featureFlags.loadFromConfig({
    flags: {
      'control-plane-gateway': 'enabled',
      'unified-runtime-task': 'enabled',
    },
  });
  return featureFlags;
}

async function waitFor<T>(fn: () => Promise<T | undefined | null> | T | undefined | null, timeoutMs = 3_000, intervalMs = 10): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== null) return value;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('Timed out waiting for value');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function createUserAuth(homeDir: string): UserAuthManager {
  return new UserAuthManager({
    bootstrapFilePath: join(homeDir, 'auth-users.json'),
    bootstrapCredentialPath: join(homeDir, 'auth-bootstrap.txt'),
    users: [{
      username: 'admin',
      passwordHash: UserAuthManager.hashPassword('admin'),
      roles: ['admin'],
    }],
  });
}

async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to reserve test port')));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

describe('RealtimeTransport', () => {
  let daemon: DaemonServer;
  let runtimeServices: RuntimeServices | undefined;
  let tempRoot: string;
  let workingDir: string;
  let homeDir: string;
  let port: number;

  beforeEach(async () => {
    tempRoot = makeProjectTempDir('gv-realtime-transport');
    workingDir = join(tempRoot, 'workspace');
    homeDir = join(tempRoot, 'home');
    port = await reservePort();
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir: join(homeDir, '.goodvibes', 'tui'), workingDir, homeDir });
    seedProviderMetadataCacheFixture({ configManager, homeDirectory: homeDir, workingDirectory: workingDir });
    runtimeServices = (await createPreparedAgentRuntimeServices({
      // Opt out: this process does not outlive the unawaited sweep.
      modelDiscovery: 'skip',
      runtimeStore: createRuntimeStore(),
      runtimeBus: new RuntimeEventBus(),
      configManager,
      workingDir,
      homeDirectory: homeDir,
      featureFlags: createTransportFeatureFlags(),
      getConversationTitle: () => 'realtime-transport-test',
    }));
    daemon = new DaemonServer({
      port,
      host: '127.0.0.1',
      // The daemon-grade view: this test stands up a REAL DaemonServer to be
      // the host the client half talks to, and a server wants the register.
      runtimeServices: runtimeServices.asDaemonGradeView(),
      userAuth: createUserAuth(homeDir),
    });
  });

  afterEach(async () => {
    const failures: unknown[] = [];
    try { await daemon?.stop(); } catch (error) { failures.push(error); }
    try { await runtimeServices?.close(); } catch (error) { failures.push(error); }
    try { await runtimeServices?.workspaceCheckpointManager.drain(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Transport fixture teardown failed');
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('streams operator events over WebSocket while keeping HTTP query semantics', async () => {
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();

    const transport = createRealtimeTransport({
      baseUrl: `http://127.0.0.1:${port}`,
      authToken: TEST_TOKEN,
      webSocketImpl: createAuthenticatedWebSocket(TEST_TOKEN),
    });

    const session = await transport.operator.sessions.ensureSession({
      sessionId: 'realtime-transport-session',
      title: 'Realtime Transport Session',
      participant: {
        surfaceKind: 'web',
        surfaceId: 'realtime-shell',
      },
    });
    expect((await transport.peer.getNodeHostContract()).basePath).toBe('/api/remote');

    const pair = await transport.peer.pairing.request({
      peerKind: 'device',
      label: 'realtime transport peer',
      requestedId: 'realtime-transport-peer',
      capabilities: ['invoke'],
      commands: ['sync'],
    });
    await transport.peer.pairing.approve(pair.request.id, 'tester', 'paired for realtime transport test');
    const verified = await transport.peer.pairing.verify(pair.request.id, pair.challenge, '10.0.0.72');
    expect(verified?.peer).toEqual(expect.objectContaining({
      label: 'realtime transport peer',
      requestedId: 'realtime-transport-peer',
      status: 'connected',
    }));
    expect(verified?.peer.id).toMatch(/^device-/);

    const seen: Array<{ type: string; agentId: string }> = [];
    const unsubscribe = transport.operator.events.agents.on('AGENT_SPAWNING', (event: Extract<AgentEvent, { type: 'AGENT_SPAWNING' }>) => {
      seen.push({ type: event.type, agentId: event.agentId });
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!runtimeServices) throw new Error('The original transport runtime was not composed');
    const services = runtimeServices;
    const releaseStartup = Promise.withResolvers<void>();
    const startupEntered = Promise.withResolvers<AbortSignal>();
    const startForOwner = services.contractRunner.startForOwner.bind(services.contractRunner);
    // Task admission publishes a pending contract owner, hence a queued task.
    // Hold the genuine start boundary so this transport test can cancel that
    // exact admitted owner without depending on a configured model planner.
    const startup = spyOn(services.contractRunner, 'startForOwner').mockImplementation(async (record, options = {}) => {
      if (!options.signal) throw new Error('The real Agent start must retain its cancellation signal');
      startupEntered.resolve(options.signal);
      await releaseStartup.promise;
      return startForOwner(record, options);
    });
    let agentId: string | undefined;
    try {
      const task = await transport.operator.tasks.submit({ task: 'cancel me over realtime transport' });
      agentId = task.agentId;
      if (!agentId) throw new Error('The admitted task must name its actual agent');
      expect(agentId).toEqual(expect.any(String));
      expect(agentId?.length).toBeGreaterThan(0);
      const signal = await startupEntered.promise;
      const taskRecord = await waitFor(async () => {
        const tasks = await transport.operator.tasks.list();
        return tasks.find(entry => entry.id === agentId) ?? null;
      });
      expect(taskRecord).toEqual(expect.objectContaining({
        title: 'cancel me over realtime transport', id: agentId, owner: agentId, status: 'queued',
      }));
      expect(signal.aborted).toBe(false);
      await waitFor(() => seen[0]);
      await transport.operator.tasks.cancel(taskRecord.id);
      expect(signal.aborted).toBe(true);
      releaseStartup.resolve();
      await services.agentManager.join(agentId);
      const cancelled = await transport.operator.tasks.list();
      expect(cancelled.find(entry => entry.id === agentId)?.status).toBe('cancelled');
    } finally {
      releaseStartup.resolve();
      try {
        if (agentId) {
          services.agentManager.cancel(agentId);
          await services.agentManager.join(agentId);
        }
      } finally { startup.mockRestore(); unsubscribe(); }
    }

    expect(seen[0]).toEqual({
      type: 'AGENT_SPAWNING',
      agentId,
    });
    const snapshot = await transport.snapshot();
    expect(snapshot.kind).toBe('realtime');
    expect(snapshot.peer.peers).toContainEqual(
      expect.objectContaining({ id: verified!.peer.id }),
    );
    expect(snapshot.operator.sessions).toContainEqual(
      expect.objectContaining({ id: session.id }),
    );
  });
});
