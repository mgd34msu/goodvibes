import { describe, expect, test } from 'bun:test';
import { ChannelPluginRegistry } from '../platform/src/platform/channels/plugin-registry.js';
import { SurfaceRegistry } from '../platform/src/platform/channels/surface-registry.js';
import { createRuntimeStore } from '../platform/src/platform/runtime/store/index.js';

function registryWith(status: number | 'throw') {
  const calls: string[] = [];
  const registry = new ChannelPluginRegistry();
  registry.register({
    id: 'surface:telegram', surface: 'telegram', displayName: 'Telegram', capabilities: ['ingress'],
    webhookPath: '/webhook/telegram',
    handleInbound: async () => {
      if (status === 'throw') throw new Error('boom');
      return new Response(null, { status });
    },
  } as unknown as Parameters<ChannelPluginRegistry['register']>[0]);
  registry.setIngressAlarm({
    record: (surface: string, outcome: string) => { calls.push(`${outcome}:${surface}`); },
    recordSuccess: (surface: string) => { calls.push(`processed:${surface}`); },
    recordFailure: (surface: string) => { calls.push(`failed:${surface}`); return true; },
  } as unknown as Parameters<ChannelPluginRegistry['setIngressAlarm']>[0]);
  return { registry, calls };
}

describe('inbound health', () => {
  test('a 5xx answer is a failure, and a refusal or an unauthenticated request is neither failure nor success', async () => {
    const failing = registryWith(503);
    await failing.registry.handleInbound('/webhook/telegram', new Request('http://x/webhook/telegram'));
    expect(failing.calls).toEqual(['failed:telegram']);
    for (const status of [401, 403]) {
      const refusing = registryWith(status);
      await refusing.registry.handleInbound('/webhook/telegram', new Request('http://x/webhook/telegram'));
      expect(refusing.calls).toEqual(['refused:telegram']);
    }
    const processed = registryWith(200);
    await processed.registry.handleInbound('/webhook/telegram', new Request('http://x/webhook/telegram'));
    expect(processed.calls).toEqual(['processed:telegram']);
  });
});

describe('surface registry', () => {
  function configManager(values: Record<string, unknown>) {
    return {
      get: (key: string) => values[key],
      getCategory: () => ({ tui: { enabled: true }, telegram: {}, homeassistant: {}, googleChat: {}, signal: {}, whatsapp: {}, telephony: {}, imessage: {}, msteams: {}, bluebubbles: {}, mattermost: {}, matrix: { enabled: true } }),
    } as never;
  }

  test('a surface that drops out of the list is no longer published as healthy', () => {
    const store = createRuntimeStore();
    const plugins = new ChannelPluginRegistry();
    plugins.register({ id: 'surface:matrix', surface: 'matrix', displayName: 'Matrix', capabilities: ['ingress'] } as never);
    const registry = new SurfaceRegistry(configManager({}), store);
    registry.attachPluginRegistry(plugins);
    registry.syncConfiguredSurfaces();
    expect(store.getState().surfaces.surfaces.get('surface:matrix')?.enabled).toBe(true);
    registry.attachPluginRegistry(new ChannelPluginRegistry());
    registry.syncConfiguredSurfaces();
    expect(store.getState().surfaces.surfaces.get('surface:matrix')?.state).toBe('disabled');
  });

  test('switching a surface on in settings publishes SURFACE_ENABLED to subscribers', async () => {
    const values: Record<string, unknown> = { 'surfaces.slack.enabled': false };
    const listeners = new Map<string, () => void>();
    const config = {
      ...(configManager(values) as object),
      get: (key: string) => values[key],
      subscribe: (key: string, cb: () => void) => { listeners.set(key, cb); return () => listeners.delete(key); },
    } as never;
    const emitted: Array<{ type: string; surfaceId: string }> = [];
    const bus = { emit: (_domain: string, envelope: { payload: { type: string; surfaceId: string } }) => { emitted.push(envelope.payload); } };
    const registry = new SurfaceRegistry(config);
    const plugins = new ChannelPluginRegistry();
    plugins.register({ id: 'surface:slack', surface: 'slack', displayName: 'Slack', capabilities: ['ingress'] } as never);
    registry.attachPluginRegistry(plugins);
    registry.syncConfiguredSurfaces();
    registry.attachRuntimeBus(bus as never);
    expect(emitted).toEqual([]);
    values['surfaces.slack.enabled'] = true;
    listeners.get('surfaces.slack.enabled')?.();
    expect(emitted.map((event) => [event.type, event.surfaceId])).toEqual([['SURFACE_ENABLED', 'surface:slack']]);
  });

  test('a record leaves accountId off when the surface reports none', () => {
    const registry = new SurfaceRegistry(configManager({ 'surfaces.slack.enabled': true }));
    const plugins = new ChannelPluginRegistry();
    plugins.register({ id: 'surface:slack', surface: 'slack', displayName: 'Slack', capabilities: ['ingress'] } as never);
    registry.attachPluginRegistry(plugins);
    const slack = registry.syncConfiguredSurfaces().find((record) => record.kind === 'slack')!;
    expect('accountId' in slack).toBe(false);
  });
});
