/**
 * What a runtime graph owns while it lives and gives back when it goes, and
 * what a follow-up on a shared session is spawned with.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bootstrap as runtimeComposition } from '@goodvibes-jev/engine/platform/platform/runtime';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { AgentConfigManager } from '../../config/host-settings.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { agentDaemonConfigClient, installAgentDaemonConfigClient } from '../../config/daemon-config-routing.ts';
import { agentDaemonCredentialsClient, installAgentDaemonCredentialsClient } from '../../config/daemon-credential-routing.ts';
import { buildContinuationSpawnInput, runHostedContinuation } from '../../runtime/continuation-spawn.ts';
import type { RuntimeServices, RuntimeServicesOptions } from '../../runtime/services.ts';
import { MemoryConsolidationScheduler } from '@goodvibes-jev/engine/platform/platform/state';
import { StoreSnapshotScheduler } from '@goodvibes-jev/engine/platform/platform/state/store-snapshots';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { createPreparedAgentRuntimeServices } from '../helpers/prepared-runtime-services.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const built: RuntimeServices[] = [];
const holders: ChildProcess[] = [];

function fixture(home: string): { configManager: AgentConfigManager; options: RuntimeServicesOptions } {
  const workingDir = join(home, 'work');
  mkdirSync(workingDir, { recursive: true });
  const configManager = new AgentConfigManager({ surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, configDir: join(home, 'config'), workingDir, homeDir: home });
  return {
    configManager,
    options: {
      modelDiscovery: 'skip',
      configManager,
      runtimeBus: new RuntimeEventBus(),
      runtimeStore: createRuntimeStore(),
      workingDir,
      homeDirectory: home,
      getConversationTitle: () => 'lifecycle',
    },
  };
}

async function boot(options: RuntimeServicesOptions): Promise<RuntimeServices> {
  const services = await createPreparedAgentRuntimeServices(options);
  built.push(services);
  return services;
}

afterEach(async () => {
  installAgentDaemonCredentialsClient(null);
  installAgentDaemonConfigClient(null);
  await Promise.allSettled(built.splice(0).map((services) => services.close()));
  for (const child of holders.splice(0)) child.kill('SIGKILL');
});

/** A process that is alive and is some other program, so a claim naming it reads as a live holder. */
async function liveForeignHolder(home: string): Promise<void> {
  const child = spawn('sleep', ['120'], { stdio: 'ignore' });
  holders.push(child);
  const pid = child.pid;
  if (typeof pid !== 'number') throw new Error('could not start a holder process');
  // /proc holds the parent's argv until exec finishes; only the real program counts.
  for (let attempt = 0; attempt < 1000 && runtimeComposition.readProcessIdentity(pid) !== 'sleep 120'; attempt++) await Bun.sleep(10);
  const path = runtimeComposition.surfaceHomeClaimPath(home, GOODVIBES_AGENT_SURFACE_ROOT);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid, identity: 'sleep 120', claimedAt: Date.now() }), { mode: 0o600 });
}

describe('a graph whose composition throws part way', () => {
  test('gives the home back, so the next boot on it is not refused', async () => {
    const home = makeProjectTempDir('agent-services-failed-compose');
    const claimPath = runtimeComposition.surfaceHomeClaimPath(home, GOODVIBES_AGENT_SURFACE_ROOT);
    // The home claim is taken by the client floor; the bus fails the first
    // subscription made after it, which is a statement the composition runs later.
    const failingBus = new RuntimeEventBus();
    const subscribe = failingBus.onDomain.bind(failingBus);
    Object.defineProperty(failingBus, 'onDomain', {
      value: (...args: Parameters<typeof subscribe>) => {
        if (existsSync(claimPath)) throw new Error('composition failed after the floor started');
        return subscribe(...args);
      },
    });
    const { options } = fixture(home);

    await expect(createPreparedAgentRuntimeServices({ ...options, runtimeBus: failingBus })).rejects.toThrow('composition failed after the floor started');

    // The teardown is requested synchronously and drains asynchronously; wait for the release itself.
    for (let attempt = 0; attempt < 600 && existsSync(claimPath); attempt++) await Bun.sleep(25);
    expect(existsSync(claimPath)).toBe(false);
    const second = await boot(fixture(home).options);
    expect(second.shellPaths.homeDirectory).toBe(home);
  });
});

describe('schedulers started before a later composition step throws', () => {
  test('are stopped with the rest of the graph, so no timer runs against closed stores', async () => {
    const home = makeProjectTempDir('agent-services-failed-compose-timers');
    const stopped: string[] = [];
    let consolidationStarted = false;
    const realStart = MemoryConsolidationScheduler.prototype.start;
    const realStop = { snapshot: StoreSnapshotScheduler.prototype.stop, consolidation: MemoryConsolidationScheduler.prototype.stop };
    MemoryConsolidationScheduler.prototype.start = function start(this: MemoryConsolidationScheduler) { consolidationStarted = true; return realStart.call(this); };
    StoreSnapshotScheduler.prototype.stop = function stop(this: StoreSnapshotScheduler) { stopped.push('snapshot'); return realStop.snapshot.call(this); };
    MemoryConsolidationScheduler.prototype.stop = function stop(this: MemoryConsolidationScheduler) { stopped.push('consolidation'); return realStop.consolidation.call(this); };
    // Every scheduler is running once the consolidation scheduler has started; the next bus subscription fails.
    const realBus = new RuntimeEventBus();
    const failingBus = new Proxy(realBus, {
      get(target, property) {
        if (consolidationStarted) throw new Error('composition failed after the schedulers started');
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
      const { options } = fixture(home);
      await expect(createPreparedAgentRuntimeServices({ ...options, runtimeBus: failingBus })).rejects.toThrow('composition failed after the schedulers started');
      for (let attempt = 0; attempt < 600 && !(stopped.includes('snapshot') && stopped.includes('consolidation')); attempt++) await Bun.sleep(25);
      expect(stopped).toContain('snapshot');
      expect(stopped).toContain('consolidation');
    } finally {
      MemoryConsolidationScheduler.prototype.start = realStart;
      StoreSnapshotScheduler.prototype.stop = realStop.snapshot;
      MemoryConsolidationScheduler.prototype.stop = realStop.consolidation;
    }
  });
});

describe('homeSingleWriter', () => {
  test('a graph that opts out coexists with a live holder', async () => {
    const home = makeProjectTempDir('agent-services-claim-off');
    await liveForeignHolder(home);
    const reader = await boot({ ...fixture(home).options, homeSingleWriter: 'off' });
    expect(reader.shellPaths.homeDirectory).toBe(home);
  });

  test('the default still refuses a live holder', async () => {
    const home = makeProjectTempDir('agent-services-claim-default');
    await liveForeignHolder(home);
    await expect(boot(fixture(home).options)).rejects.toBeInstanceOf(runtimeComposition.SurfaceHomeInUseError);
  });
});

describe('a second graph in a live process', () => {
  test('closing it leaves the live graph\'s routing clients alone', async () => {
    const home = makeProjectTempDir('agent-services-second-graph');
    const live = await boot(fixture(home).options);
    installAgentDaemonCredentialsClient(live.daemonCredentialsClient);
    installAgentDaemonConfigClient(live.daemonConfigClient);

    const other = await createPreparedAgentRuntimeServices({ ...fixture(home).options, homeSingleWriter: 'off' });
    await other.close();

    expect(agentDaemonCredentialsClient()).toBe(live.daemonCredentialsClient);
    expect(agentDaemonConfigClient()).toBe(live.daemonConfigClient);
  });

  test('closing the graph that installed the clients clears them', async () => {
    const home = makeProjectTempDir('agent-services-own-clients');
    const live = await boot(fixture(home).options);
    installAgentDaemonCredentialsClient(live.daemonCredentialsClient);
    installAgentDaemonConfigClient(live.daemonConfigClient);

    await live.close();

    expect(agentDaemonCredentialsClient()).toBeNull();
    expect(agentDaemonConfigClient()).toBeNull();
  });
});

describe('composition wiring', () => {
  test('the in-process local voice provider exists, so setup has an engine to provision', async () => {
    const services = await boot(fixture(makeProjectTempDir('agent-services-voice')).options);
    expect(services.voiceProviders.get('local')).toBeDefined();
  });

  test('the webhook notifier follows the metadata-only setting live', async () => {
    const { configManager, options } = fixture(makeProjectTempDir('agent-services-webhook-privacy'));
    const services = await boot(options);
    const reader = (services.webhookNotifier as unknown as { readonly metadataOnly?: () => boolean }).metadataOnly;
    expect(reader).toBeDefined();
    expect(reader!()).toBe(true);
    configManager.getHostBooleanSetting('behavior.notificationsMetadataOnly').set(false);
    expect(reader!()).toBe(false);
  });
});

describe('what a shared-session follow-up is spawned with', () => {
  // The shipped defaults: channel surfaces are gated, a local surface is not.
  const gate = () => ({
    get: (key: string): never => (key.startsWith('profile.') || key.startsWith('occasions.') ? '' : undefined) as never,
    getCategory: () => undefined as never,
  });
  const request = (surfaceKind: string, metadata?: Record<string, unknown>) => ({
    task: 'reply',
    input: { sessionId: 's1', surfaceKind, ...(metadata ? { metadata } : {}) } as never,
  });

  test('a channel follow-up is a conversation with a real tool list, not an empty registry', () => {
    const spawn = buildContinuationSpawnInput(request('slack'), { configReader: gate() as never, modelCandidates: [] });
    expect(spawn.restrictTools).toBe(true);
    expect(spawn.tools?.length).toBeGreaterThan(0);
    expect(spawn.tools).toContain('read');
  });

  test('a pre-authorized follow-up keeps the full tool set', () => {
    const spawn = buildContinuationSpawnInput(request('slack', { 'goodvibes.workAuthorized': true }), { configReader: gate() as never, modelCandidates: [] });
    expect(spawn.restrictTools).toBeUndefined();
    expect(spawn.tools).toBeUndefined();
  });

  describe('the hand-off in front of the local spawn', () => {
    const run = (outcome: Awaited<ReturnType<Parameters<typeof runHostedContinuation>[1]['hostedHandoff']['promote']>>) => {
      const spawned: unknown[] = [];
      const warnings: string[] = [];
      const result = runHostedContinuation(request('slack') as never, {
        hostedHandoff: { promote: async () => outcome },
        spawn: (input) => { spawned.push(input); return { id: 'agent-1' }; },
        spawnDeps: { configReader: gate() as never, modelCandidates: [] },
        log: { warn: (message) => { warnings.push(message); } },
      });
      return { result, spawned, warnings };
    };

    test('an unconfirmed hand-off holds the message and never spawns a local agent', async () => {
      const { result, spawned } = run({ promoted: false, reason: 'lost reply', disabled: false, unconfirmed: true });
      expect(await result).toEqual({ disposition: 'held', reason: 'lost reply' });
      expect(spawned).toHaveLength(0);
    });

    test('a promoted hand-off is transferred and spawns nothing', async () => {
      const { result, spawned } = run({ promoted: true, hostedSessionId: 'h1', action: 'created' });
      expect(await result).toEqual({ disposition: 'transferred', requestId: 'h1' });
      expect(spawned).toHaveLength(0);
    });

    test('a definite refusal answers locally, and the disabled setting does so silently', async () => {
      const refused = run({ promoted: false, reason: 'at capacity', disabled: false });
      expect(await refused.result).toEqual({ agentId: 'agent-1' });
      expect(refused.spawned).toHaveLength(1);
      expect(refused.warnings).toHaveLength(1);
      const off = run({ promoted: false, reason: 'off', disabled: true });
      expect(await off.result).toEqual({ agentId: 'agent-1' });
      expect(off.warnings).toHaveLength(0);
    });
  });
});
