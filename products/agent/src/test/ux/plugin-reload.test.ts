/**
 * UX Anti-Regression: Plugin Reload
 *
 * Drives the real runtime store with plugin bus events (unload, load, activate)
 * and checks that the plugin registry, the active list and the reload flag stay
 * consistent while other plugins and other domains are left alone.
 */
import { describe, test, expect } from 'bun:test';
import { createRuntimeStore, createDomainDispatch } from '../../runtime/store/index.ts';
import {
  selectPlugins,
  selectOverlays,
  selectConversation,
} from '../../runtime/store/selectors/index.ts';

function storeWithActivePlugins(...names: string[]) {
  const store = createRuntimeStore();
  const dispatch = createDomainDispatch(store);
  for (const name of names) {
    dispatch.dispatchPluginEvent({ type: 'PLUGIN_DISCOVERED', pluginId: name, path: `/plugins/${name}`, version: '1.0.0' });
    dispatch.dispatchPluginEvent({ type: 'PLUGIN_LOADED', pluginId: name, version: '1.0.0', capabilities: ['a', 'b', 'c'] });
    dispatch.dispatchPluginEvent({ type: 'PLUGIN_ACTIVE', pluginId: name });
  }
  return { store, dispatch };
}

describe('ux:plugin-reload: plugin reload', () => {
  test('a reloading plugin goes unloading, loading, then active again', () => {
    const { store, dispatch } = storeWithActivePlugins('precision-engine', 'analytics');
    const status = () => selectPlugins(store.getState()).plugins.get('precision-engine')?.status;
    expect(status()).toBe('active');

    dispatch.dispatchPluginEvent({ type: 'PLUGIN_UNLOADING', pluginId: 'precision-engine', reason: 'reload' });
    expect(status()).toBe('unloading');
    dispatch.dispatchPluginEvent({ type: 'PLUGIN_LOADING', pluginId: 'precision-engine', path: '/plugins/precision-engine' });
    expect(status()).toBe('loading');
    dispatch.dispatchPluginEvent({ type: 'PLUGIN_LOADED', pluginId: 'precision-engine', version: '1.0.1', capabilities: ['a', 'b', 'c'] });
    dispatch.dispatchPluginEvent({ type: 'PLUGIN_ACTIVE', pluginId: 'precision-engine' });
    expect(status()).toBe('active');
    expect(selectPlugins(store.getState()).plugins.get('precision-engine')?.version).toBe('1.0.1');
  });

  test('reloadInProgress is set while unloading or loading and cleared once the plugin is loaded', () => {
    const { store, dispatch } = storeWithActivePlugins('my-plugin');
    const inProgress = () => selectPlugins(store.getState()).reloadInProgress;
    expect(inProgress()).toBe(false);

    dispatch.dispatchPluginEvent({ type: 'PLUGIN_UNLOADING', pluginId: 'my-plugin' });
    expect(inProgress()).toBe(true);
    dispatch.dispatchPluginEvent({ type: 'PLUGIN_LOADING', pluginId: 'my-plugin', path: '/plugins/my-plugin' });
    expect(inProgress()).toBe(true);
    dispatch.dispatchPluginEvent({ type: 'PLUGIN_LOADED', pluginId: 'my-plugin', version: '1.0.0', capabilities: [] });
    expect(inProgress()).toBe(false);
  });

  test('the reloading plugin leaves the active list and its tools stop counting until it is active again', () => {
    const { store, dispatch } = storeWithActivePlugins('plugin-a', 'plugin-b');
    expect(selectPlugins(store.getState()).totalToolsContributed).toBe(6);

    dispatch.dispatchPluginEvent({ type: 'PLUGIN_UNLOADING', pluginId: 'plugin-a' });
    let plugins = selectPlugins(store.getState());
    expect(plugins.activePluginNames).toEqual(['plugin-b']);
    expect(plugins.totalActive).toBe(1);
    expect(plugins.totalToolsContributed).toBe(3);

    dispatch.dispatchPluginEvent({ type: 'PLUGIN_LOADED', pluginId: 'plugin-a', version: '1.0.0', capabilities: ['a', 'b', 'c'] });
    dispatch.dispatchPluginEvent({ type: 'PLUGIN_ACTIVE', pluginId: 'plugin-a' });
    plugins = selectPlugins(store.getState());
    expect([...plugins.activePluginNames].sort()).toEqual(['plugin-a', 'plugin-b']);
    expect(plugins.totalToolsContributed).toBe(6);
  });

  test('other plugins stay active and the registry size is constant through a reload', () => {
    const { store, dispatch } = storeWithActivePlugins('plugin-a', 'plugin-b', 'plugin-c');
    const events: Array<Parameters<typeof dispatch.dispatchPluginEvent>[0]> = [
      { type: 'PLUGIN_UNLOADING', pluginId: 'plugin-a' },
      { type: 'PLUGIN_LOADING', pluginId: 'plugin-a', path: '/plugins/plugin-a' },
      { type: 'PLUGIN_LOADED', pluginId: 'plugin-a', version: '1.0.0', capabilities: [] },
      { type: 'PLUGIN_ACTIVE', pluginId: 'plugin-a' },
    ];
    for (const event of events) {
      dispatch.dispatchPluginEvent(event);
      const { plugins } = selectPlugins(store.getState());
      expect(plugins.size).toBe(3);
      expect(plugins.get('plugin-b')?.status).toBe('active');
      expect(plugins.get('plugin-c')?.status).toBe('active');
    }
  });

  test('a reload that fails is listed as errored with its message, not as active', () => {
    const { store, dispatch } = storeWithActivePlugins('my-plugin');
    dispatch.dispatchPluginEvent({ type: 'PLUGIN_UNLOADING', pluginId: 'my-plugin' });
    dispatch.dispatchPluginEvent({ type: 'PLUGIN_LOADING', pluginId: 'my-plugin', path: '/plugins/my-plugin' });
    dispatch.dispatchPluginEvent({ type: 'PLUGIN_ERROR', pluginId: 'my-plugin', error: 'syntax error', fatal: true });

    const plugins = selectPlugins(store.getState());
    expect(plugins.plugins.get('my-plugin')?.status).toBe('error');
    expect(plugins.plugins.get('my-plugin')?.error).toBe('syntax error');
    expect(plugins.activePluginNames).toEqual([]);
    expect(plugins.erroredPluginNames).toEqual(['my-plugin']);
    expect(plugins.reloadInProgress).toBe(false);
  });

  test('overlay and conversation slices are untouched through the reload cycle', () => {
    const { store, dispatch } = storeWithActivePlugins('my-plugin');
    const overlays = selectOverlays(store.getState());
    const conversation = selectConversation(store.getState());

    dispatch.dispatchPluginEvent({ type: 'PLUGIN_UNLOADING', pluginId: 'my-plugin' });
    dispatch.dispatchPluginEvent({ type: 'PLUGIN_LOADING', pluginId: 'my-plugin', path: '/plugins/my-plugin' });
    dispatch.dispatchPluginEvent({ type: 'PLUGIN_ACTIVE', pluginId: 'my-plugin' });

    expect(selectOverlays(store.getState())).toBe(overlays);
    expect(selectConversation(store.getState())).toBe(conversation);
  });
});
