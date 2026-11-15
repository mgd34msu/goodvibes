import { afterEach, beforeEach, expect, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { registerInboxSurface } from '@goodvibes-jev/engine/platform/platform/intake';
import { BenchmarkStore, ProviderRegistry } from '@goodvibes-jev/engine/platform/platform/providers';
import { createRuntimeStore } from '@goodvibes-jev/engine/platform/platform/runtime/store';
import { UserAuthManager } from '@goodvibes-jev/engine/platform/platform/security';
import { createFeatureFlagManager, deriveFeatureStates, RuntimeEventBus } from '../../runtime/index.js';
import { createDaemonHost, type DaemonHost, type DaemonHostFactories, type DaemonHostOptions } from '../../runtime/daemon-host.js';
import { createDaemonBootOperations } from '../../runtime/boot-composition.js';
import { createRuntimeServices, type RuntimeServices } from '../../runtime/services.js';
import { makeOwnedTempDir } from './owned-temp.js';

/**
 * The shared host fixture of the daemon-host tests: registers the per-test
 * setup and teardown, and returns the builders that feed them. Every host a
 * test creates is closed afterwards. A close that rejects fails the test,
 * unless the test named that host with `expectCloseFailure` because the
 * failure is the behaviour under test.
 */
export function useDaemonHostFixture() {
  let hosts: DaemonHost[];
  let restores: Array<() => void>;
  let releases: Array<() => void>;
  let expectedCloseFailures: Set<DaemonHost>;

  beforeEach(() => {
    hosts = []; restores = []; releases = []; expectedCloseFailures = new Set();
    keep(spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]));
    keep(spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue());
  });
  afterEach(async () => {
    for (const release of releases) release();
    const unexpected: unknown[] = [];
    for (const host of hosts) {
      try { await host.close(); } catch (error) { if (!expectedCloseFailures.has(host)) unexpected.push(error); }
    }
    for (const restore of restores.reverse()) restore();
    if (unexpected.length > 0) throw new AggregateError(unexpected, 'A host this test did not expect to fail rejected its close');
  });

  function keep<T extends { mockRestore(): void }>(spy: T): T { restores.push(() => spy.mockRestore()); return spy; }
  /** Runs `fn` during teardown, before the hosts are closed. */
  function onRelease(fn: () => void) { releases.push(fn); }
  /** Closes `host` during teardown. */
  function track(host: DaemonHost): DaemonHost { hosts.push(host); return host; }
  /** Marks a tracked host whose close is expected to reject. */
  function expectCloseFailure(host: DaemonHost) { expectedCloseFailures.add(host); }
  function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>((yes) => { resolve = yes; });
    releases.push(resolve);
    return { promise, resolve };
  }

  function fixture(configure?: (runtime: RuntimeServices) => void, extra: DaemonHostFactories = {},
    native: Pick<DaemonHostOptions, 'updateArtifact' | 'hasOverriddenHome' | 'httpListener'> = {}) {
    const root = makeOwnedTempDir('owned-daemon-host');
    const homeDirectory = join(root, 'home'); const workingDir = join(root, 'workspace');
    const configDir = join(homeDirectory, '.goodvibes', 'daemon');
    mkdirSync(configDir, { recursive: true }); mkdirSync(workingDir, { recursive: true });
    const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir, workingDir, homeDir: homeDirectory });
    configManager.set('cluster.enabled', false);
    configManager.set('relay.enabled', false);
    const featureFlags = createFeatureFlagManager();
    featureFlags.loadFromConfig({ flags: deriveFeatureStates(configManager) });
    let port = 0;
    const serveFactory = ((options) => {
      const server = Bun.serve(options); port = server.port!; return server;
    }) as typeof Bun.serve;
    const options: DaemonHostOptions = {
      runtime: { configManager, runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(), featureFlags,
        homeDirectory, workingDir, daemonHomeDirectory: configDir,
        inboxFactory: (context, _routing, inboxOptions) => registerInboxSurface(context, { ...inboxOptions, adapters: new Map() }),
        localUserAuthManager: new UserAuthManager({ bootstrapFilePath: join(homeDirectory, 'users.json'), bootstrapCredentialPath: join(homeDirectory, 'bootstrap.txt'),
          users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('fixture'), roles: ['admin'] }] }),
      },
      daemon: { host: '127.0.0.1', port: 0, token: 'synthetic-host-token', serveFactory },
      ...native,
    };
    const factories: DaemonHostFactories = {
      providerDiscovery: { scan: async () => ({ servers: [], scannedHosts: 0, scannedPorts: 0, durationMs: 0 }) },
      async createRuntime(runtimeOptions) {
        expect(runtimeOptions.createBootOperations).toBe(createDaemonBootOperations);
        const runtime = await createRuntimeServices(runtimeOptions);
        keep(spyOn(runtime.serviceRegistry, 'resolveSecret').mockResolvedValue(''));
        configure?.(runtime); return runtime;
      }, ...extra,
    };
    const host = track(createDaemonHost(options, factories));
    return { root, homeDirectory, workingDir, options, factories, host, get baseUrl() { return `http://127.0.0.1:${port}`; } };
  }

  function seedPlugin(fx: { workingDir: string; homeDirectory: string }) {
    const directory = join(fx.workingDir, '.goodvibes', 'plugins', 'owned-host');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ name: 'owned-host', version: '1.0.0', description: 'owned fixture' }));
    writeFileSync(join(directory, 'index.js'), `
    let release; const held = new Promise(resolve => { release = resolve; });
    export function finish() { release('finished'); }
    export function init(api) {
      api.registerGatewayMethod({ id: 'held', title: 'Held fixture', description: 'fixture', category: 'plugins', access: 'authenticated', transport: ['internal'], scopes: [], invokable: true }, () => held);
      api.registerChannelPlugin({ id: 'owned-host', surface: 'webhook', displayName: 'Fixture', capabilities: [], webhookPath: '/webhook/owned-host',
        async handleInbound() { return new Response('owned configured host', { status: 202 }); } });
    }
  `);
    const preferences = join(fx.homeDirectory, '.goodvibes', 'tui', 'plugins.json');
    mkdirSync(join(preferences, '..'), { recursive: true });
    writeFileSync(preferences, JSON.stringify({ enabled: { 'owned-host': true }, enabledDirs: { 'owned-host': directory }, config: {}, trust: {}, quarantine: {} }));
    return { directory, preferences };
  }

  return { fixture, seedPlugin, keep, gate, onRelease, track, expectCloseFailure };
}
