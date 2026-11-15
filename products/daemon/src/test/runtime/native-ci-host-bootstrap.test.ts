import { expect, spyOn, test } from 'bun:test';
import * as nativeActivation from '../../runtime/native-work-execution-activation.js';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { DaemonServer } from '@goodvibes-jev/engine/platform/platform/daemon';
import { createRuntimeStore } from '@goodvibes-jev/engine/platform/platform/runtime/store';
import { createFeatureFlagManager, deriveFeatureStates, RuntimeEventBus } from '../../runtime/index.js';
import { createDaemonHost } from '../../runtime/daemon-host.js';
import { useDaemonHostFixture } from '../helpers/daemon-host-fixture.js';

const { fixture, seedPlugin, keep, gate, onRelease, track } = useDaemonHostFixture();

test('actual host clean shutdown preserves captured durable policy with enabled plugin', async () => {
  const fx = fixture(); seedPlugin(fx);
  expect((await fx.host.start()).state).toBe('ready');
  const runtime = fx.host.services!;
  expect(runtime.pluginManager.isEnabled('owned-host')).toBe(true);
  const before = runtime.configManager.captureDurableConfigurationIncarnation();
  await fx.host.close();
  expect(runtime.configManager.getDurableConfigurationIncarnation()).toBe(before);
  const successorConfig = new ConfigManager({ surfaceRoot: 'tui', configDir: join(fx.homeDirectory, '.goodvibes', 'daemon'), workingDir: fx.workingDir, homeDir: fx.homeDirectory });
  const featureFlags = createFeatureFlagManager(); featureFlags.loadFromConfig({ flags: deriveFeatureStates(successorConfig) });
  const successor = createDaemonHost({ ...fx.options, runtime: { ...fx.options.runtime, configManager: successorConfig, featureFlags, runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore() } }, fx.factories);
  track(successor);
  expect((await successor.start()).state).toBe('ready');
  expect(successor.services!.pluginManager.isEnabled('owned-host')).toBe(true);
  expect(successor.services!.configManager.getDurableConfigurationIncarnation()).toBe(before);
}, 30000);

test('composed boot controller refuses repeated start after close', async () => {
  const fx = fixture();
  expect((await fx.host.start()).state).toBe('ready');
  const boot = fx.host.services!.bootTasks!;
  await fx.host.close();
  expect(boot.snapshot().state).toBe('closed');
  await expect(boot.start()).rejects.toThrow('closed');
}, 30000);

function captureScope() {
  const build = nativeActivation.createDaemonNativeWorkExecutionActivation;
  let options: Parameters<typeof build>[0] | undefined;
  keep(spyOn(nativeActivation, 'createDaemonNativeWorkExecutionActivation').mockImplementation(value => { options = value; return build(value); }));
  return () => options!.continuationScopeOwner!;
}

test('repeated successful boot is idempotent and retirement is synchronous before held plugin teardown', async () => {
  const scope = captureScope(); const held = gate(); let init = 0; let stop = 0;
  const fx = fixture(runtime => {
    keep(spyOn(runtime.pluginManager, 'init').mockImplementation(async () => { init++; }));
    keep(spyOn(runtime.pluginManager, 'close').mockImplementation(async () => { stop++; await held.promise; }));
  });
  expect((await fx.host.start()).state).toBe('ready');
  const boot = fx.host.services!.bootTasks!;
  const first = boot.start(); expect(boot.start()).toBe(first); expect((await first).state).toBe('ready');
  expect(init).toBe(1); expect(() => scope().current()).not.toThrow();
  const closing = fx.host.close();
  expect(stop).toBe(1); expect(boot.snapshot().state).toBe('closing');
  expect(() => scope().current()).toThrow();
  await expect(boot.start()).rejects.toThrow('closed');
  held.resolve(); await closing;
});

test('settled degraded boot exposes only surviving catalog and cannot reopen after close', async () => {
  const scope = captureScope(); let init = 0;
  const fx = fixture(runtime => {
    keep(spyOn(runtime.pluginManager, 'init').mockImplementation(async () => { init++; throw new Error('synthetic plugin init failure'); }));
  });
  const result = await fx.host.start();
  expect(result.state).toBe('degraded'); expect(result.boot!.steps.find(x => x.name === 'plugins')!.state).toBe('failed');
  expect(() => scope().current()).not.toThrow();
  const boot = fx.host.services!.bootTasks!;
  expect((await boot.start()).state).toBe('degraded'); expect(init).toBe(1);
  await fx.host.close(); expect(() => scope().current()).toThrow();
  await expect(boot.start()).rejects.toThrow('closed');
});

test('boot interrupted during plugin acquisition never activates policy when admitted work settles', async () => {
  const scope = captureScope(); const entered = gate(); const held = gate(); let stop = 0;
  const fx = fixture(runtime => {
    keep(spyOn(runtime.pluginManager, 'init').mockImplementation(async () => { entered.resolve(); await held.promise; }));
    keep(spyOn(runtime.pluginManager, 'close').mockImplementation(async () => { stop++; await held.promise; }));
  });
  const starting = fx.host.start(); await entered.promise;
  expect(() => scope().current()).toThrow();
  const closing = fx.host.close(); expect(stop).toBe(1);
  expect(() => scope().current()).toThrow();
  held.resolve(); await starting; await closing;
  expect(() => scope().current()).toThrow();
  expect(fx.host.services!.bootTasks!.snapshot().state).toBe('closed');
  await expect(fx.host.services!.bootTasks!.start()).rejects.toThrow('closed');
});

test('server startup failure before product boot never completes native scope bootstrap', async () => {
  const scope = captureScope();
  const fx = fixture(undefined, { createServer(config) {
    const server = new DaemonServer(config); keep(spyOn(server, 'start').mockRejectedValue(new Error('synthetic server startup failure'))); return server;
  } });
  await expect(fx.host.start()).rejects.toThrow('server startup failed');
  await fx.host.close();
  expect(() => scope().current()).toThrow();
  expect(fx.host.services!.bootTasks!.snapshot().state).toBe('closed');
  await expect(fx.host.services!.bootTasks!.start()).rejects.toThrow('closed');
});
