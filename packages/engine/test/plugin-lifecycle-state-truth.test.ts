/**
 * The plugin lifecycle record tells the truth: a failed hot reload shows an error instead of an
 * active plugin that is gone, capability grants follow trust and quarantine, and an unload that
 * did not happen says so.
 */
import { describe, expect, test } from 'bun:test';
import type { PluginLoaderDeps } from '../platform/src/platform/plugins/loader.ts';
import { PluginInFlightTracker } from '../platform/src/platform/plugins/in-flight.ts';
import { runHotReload } from '../platform/src/platform/runtime/plugins/hot-reload.ts';
import { PluginLifecycleManager } from '../platform/src/platform/runtime/plugins/manager.ts';
import { PluginQuarantineEngine } from '../platform/src/platform/runtime/plugins/quarantine.ts';
import type { PluginManifestV2 } from '../platform/src/platform/runtime/plugins/types.ts';

const manifest = {
  name: 'p',
  version: '1.0.0',
  description: 'p',
  entry: 'index.js',
  capabilities: ['shell.exec', 'filesystem.read'],
} as unknown as PluginManifestV2;

function setState(lcm: PluginLifecycleManager, state: string): void {
  (lcm.getRecord('p') as { state: string }).state = state;
}

function reloadOptions() {
  return {
    getLoadedPlugin: () => undefined,
    removeLoadedPlugin: () => {},
    storeLoadedPlugin: () => {},
  };
}

const deps = (): PluginLoaderDeps => ({ inFlight: new PluginInFlightTracker() }) as unknown as PluginLoaderDeps;

describe('hot reload and the lifecycle record', () => {
  test('a reload that fails after the old instance was removed leaves the record in error', async () => {
    const lcm = new PluginLifecycleManager();
    lcm.registerDiscovered(manifest, '/nonexistent-plugin-dir');
    setState(lcm, 'active');

    const result = await runHotReload('p', manifest, '/nonexistent-plugin-dir', deps(), lcm, reloadOptions());

    expect(result.success).toBe(false);
    expect(result.failedPhase).toBe('reload');
    const record = lcm.getRecord('p')!;
    expect(record.state).toBe('error');
    expect(record.lastError).toContain('Hot-reload failed in the reload phase');
    expect(record.reloading).toBe(false);
  });

  test('a plugin that is not in a reloadable state is refused before anything is touched', async () => {
    const lcm = new PluginLifecycleManager();
    lcm.registerDiscovered(manifest, '/nonexistent-plugin-dir');
    setState(lcm, 'disabled');
    let removed = false;

    const result = await runHotReload('p', manifest, '/nonexistent-plugin-dir', deps(), lcm, {
      ...reloadOptions(),
      removeLoadedPlugin: () => { removed = true; },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("state 'disabled'");
    expect(removed).toBe(false);
    expect(lcm.getRecord('p')!.state).toBe('disabled');
  });
});

describe('capability grants follow trust and quarantine', () => {
  test('downgrading the trust tier takes high-risk grants away at once', () => {
    const lcm = new PluginLifecycleManager();
    lcm.setTrustTier('p', 'trusted');
    lcm.registerDiscovered(manifest, '/tmp/p');
    expect(lcm.getRecord('p')!.capabilities.granted).toContain('shell.exec');

    lcm.setTrustTier('p', 'untrusted');

    const { granted, denied } = lcm.getRecord('p')!.capabilities;
    expect(granted).not.toContain('shell.exec');
    expect(denied).toContain('shell.exec');
  });

  test('a restored quarantine keeps high-risk grants off a freshly registered plugin', () => {
    const quarantine = new PluginQuarantineEngine();
    quarantine.importRecords({
      p: { pluginName: 'p', quarantinedAt: 1, reason: 'bad update', revokedCapabilities: ['shell.exec'], lifted: false },
    });
    const lcm = new PluginLifecycleManager({ quarantine, trustTierResolver: () => 'trusted' });

    lcm.registerDiscovered(manifest, '/tmp/p');

    const record = lcm.getRecord('p')!;
    expect(record.quarantined).toBe(true);
    expect(record.capabilities.granted).not.toContain('shell.exec');
    expect(record.capabilities.granted).toContain('filesystem.read');
  });
});

describe('unloadPlugin reports what happened', () => {
  test('a plugin that cannot be unloaded from its state says so and keeps that state', async () => {
    const lcm = new PluginLifecycleManager();
    lcm.registerDiscovered(manifest, '/tmp/p');
    setState(lcm, 'loading');

    const result = await lcm.unloadPlugin('p');

    expect(result.unloaded).toBe(false);
    if (!result.unloaded) expect(result.reason).toContain("'loading'");
    expect(lcm.getRecord('p')!.state).toBe('loading');
  });

  test('an unload that completes reports it', async () => {
    const lcm = new PluginLifecycleManager();
    lcm.registerDiscovered(manifest, '/tmp/p');
    setState(lcm, 'active');
    expect((await lcm.unloadPlugin('p')).unloaded).toBe(true);
    expect(lcm.getRecord('p')!.state).toBe('disabled');
  });
});
