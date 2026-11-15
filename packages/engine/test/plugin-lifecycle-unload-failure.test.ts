/**
 * An unload that throws must still end in a resting state, record the error,
 * and a refused transition must not be announced.
 */
import { describe, expect, test } from 'bun:test';
import { PluginLifecycleManager } from '../platform/src/platform/runtime/plugins/manager.ts';
import type { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { createInitialPluginsState } from '../platform/src/platform/runtime/store/domains/plugins.ts';
import { updatePluginState } from '../platform/src/platform/runtime/store/helpers/reducers/sync.ts';
import type { PluginEvent } from '../platform/src/platform/runtime/store/helpers/events.ts';
import type { PluginManifestV2 } from '../platform/src/platform/runtime/plugins/types.ts';
import type { LoadedPlugin } from '../platform/src/platform/plugins/loader.ts';

const manifest = { name: 'p', version: '1.0.0', description: 'p', entry: 'index.js' } as unknown as PluginManifestV2;

function setup() {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const bus = {
    emit(_d: string, e: { type?: string; payload?: Record<string, unknown> }) {
      events.push({ type: String(e.type), payload: e.payload ?? {} });
    },
  } as unknown as RuntimeEventBus;
  const mgr = new PluginLifecycleManager({ runtimeBus: bus });
  mgr.registerDiscovered(manifest, '/tmp/p');
  return { mgr, events };
}

const throwingPlugin = {
  manifest,
  get active(): boolean { throw new Error('boom during unload'); },
  cleanup: [],
} as unknown as LoadedPlugin;

describe('PluginLifecycleManager.unloadPlugin failure', () => {
  test('a throwing unload still reaches disabled, records the error and announces it', async () => {
    const { mgr, events } = setup();
    (mgr.getRecord('p') as { state: string }).state = 'active';
    await mgr.unloadPlugin('p', 'test', { getLoadedPlugin: () => throwingPlugin });

    const record = mgr.getRecord('p')!;
    expect(record.state).toBe('disabled');
    expect(record.lastError).toContain('boom during unload');
    expect(typeof record.errorAt).toBe('number');
    const types = events.map((e) => e.type);
    expect(types).toContain('PLUGIN_ERROR');
    expect(types).toContain('PLUGIN_DISABLED');
  });

  test('a failed load still announces exactly one PLUGIN_ERROR (applied transition)', async () => {
    const { mgr, events } = setup();
    (mgr.getRecord('p') as { state: string }).state = 'disabled';
    const ok = await mgr.loadPlugin(manifest, '/nonexistent-dir', {} as never);
    expect(ok).toBe(false);
    expect(events.filter((e) => e.type === 'PLUGIN_ERROR').length).toBe(1);
    expect(mgr.getRecord('p')!.state).toBe('error');
  });
});

describe('PluginLifecycleManager.recordReloaded', () => {
  function storeAfter(events: Array<{ payload: Record<string, unknown> }>) {
    let state = createInitialPluginsState();
    for (const e of events) state = updatePluginState(state, e.payload as unknown as PluginEvent);
    return state.plugins.get('p')!;
  }

  test('a successful reload after a failed one returns the runtime store from error to active', () => {
    const { mgr, events } = setup();
    (mgr.getRecord('p') as { state: string }).state = 'error';
    events.push({ type: 'PLUGIN_ERROR', payload: { type: 'PLUGIN_ERROR', pluginId: 'p', error: 'reload failed', fatal: true } });
    expect(storeAfter(events).status).toBe('error');

    mgr.recordReloaded('p');

    expect(mgr.getRecord('p')!.state).toBe('active');
    const plugin = storeAfter(events);
    expect(plugin.status).toBe('active');
    expect(plugin.active).toBe(true);
    expect(plugin.error).toBeUndefined();
  });

  test('a reload that recovers a degraded plugin returns the runtime store to active', () => {
    const { mgr, events } = setup();
    (mgr.getRecord('p') as { state: string }).state = 'active';
    mgr.degradePlugin('p', 'slow health check');
    expect(storeAfter(events).status).toBe('degraded');

    mgr.recordReloaded('p');

    expect(mgr.getRecord('p')!.state).toBe('active');
    expect(storeAfter(events).status).toBe('active');
    expect(storeAfter(events).active).toBe(true);
  });
});
