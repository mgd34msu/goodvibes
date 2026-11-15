import { describe, expect, test } from 'bun:test';
import type { CommandContext } from '../../input/command-registry.ts';
import { readProviderHealthSignal } from '../../tools/agent-harness-model-provider-health.ts';
import { loadPinnedModelIds } from '../../tools/agent-harness-model-catalog.ts';

function contextWith(readModels: Record<string, unknown>): CommandContext {
  return { platform: { readModels }, clients: {} } as unknown as CommandContext;
}

const record = { providerId: 'acme', modelRouteId: 'acme:fast', status: 'healthy', avgLatencyMs: 120, lastCheckedAt: '2026-06-01T00:00:00Z' };

describe('provider health read-model sources', () => {
  test('the first snapshot method that answers decides, so a later throwing method cannot fail the source', () => {
    const calls: string[] = [];
    const source = {
      getSnapshot: () => { calls.push('getSnapshot'); return { providers: [record] }; },
      list: () => { calls.push('list'); throw new Error('list is broken'); },
    };
    const signal = readProviderHealthSignal(contextWith({ providerHealth: source }), 'acme', 'acme:fast');
    expect(signal.status).toBe('record-found');
    expect(calls).toEqual(['getSnapshot']);
  });

  test('an empty first source does not hide a record published by a later one', () => {
    const signal = readProviderHealthSignal(contextWith({
      providerHealth: { getSnapshot: () => ({ providers: [] }) },
      routeHealth: { getSnapshot: () => ({ providers: [record] }) },
    }), 'acme', 'acme:fast');
    expect(signal.status).toBe('record-found');
    expect(signal.agentConsumption.readModelPath).toBe('context.platform.readModels.routeHealth');
  });

  test('when no source holds the record the empty answer names every source searched', () => {
    const signal = readProviderHealthSignal(contextWith({
      providerHealth: { getSnapshot: () => ({ providers: [] }) },
      routeHealth: { getSnapshot: () => ({ providers: [] }) },
    }), 'acme');
    expect(signal.status).toBe('read-model-empty');
    expect(signal.agentConsumption.evidence).toContain('providerHealth');
    expect(signal.agentConsumption.evidence).toContain('routeHealth');
  });

  test('a source that answers asynchronously is reported as unreadable, never as having no record', async () => {
    let rejected = false;
    const source = { getSnapshot: () => Promise.reject(new Error('late')).catch((error: unknown) => { rejected = true; throw error; }) };
    const signal = readProviderHealthSignal(contextWith({ providerHealth: source }), 'acme');
    expect(signal.status).toBe('read-model-error');
    expect(signal.daemonPublication.evidence).toContain('asynchronously');
    await Promise.resolve(); await Promise.resolve();
    expect(rejected).toBe(true);
  });

  test('a record matched by provider id only says it is not specific to the model route', () => {
    const signal = readProviderHealthSignal(contextWith({ providerHealth: { getSnapshot: () => ({ providers: [{ ...record, modelRouteId: 'acme:other' }] }) } }), 'acme', 'acme:fast');
    expect(signal.status).toBe('record-found');
    expect(signal.agentConsumption.evidence).toContain('provider id only');
  });
});

describe('pinned model favorites', () => {
  const contextWithApi = (getFavorites: () => Promise<unknown>) => ({
    clients: { providerApi: { getFavorites, getCurrentModel: async () => null, listModels: async () => [], listProviderIds: () => [] } },
  }) as unknown as CommandContext;

  test('a favorites read that fails is unknown, not an empty pin list', async () => {
    expect(await loadPinnedModelIds(contextWithApi(async () => { throw new Error('offline'); }))).toBeNull();
  });

  test('favorites that read fine give the pinned ids', async () => {
    const pinned = await loadPinnedModelIds(contextWithApi(async () => ({ pinned: [{ registryKey: 'acme:fast', modelId: 'fast' }] })));
    expect(pinned?.has('acme:fast')).toBe(true);
  });
});
