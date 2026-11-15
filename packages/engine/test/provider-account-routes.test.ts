/**
 * The provider account snapshot names the route the credential chain really uses:
 * a stored subscription outranks an ambient API key only when it overrides ambient keys.
 */

import { describe, expect, test } from 'bun:test';
import { buildProviderAccountSnapshot } from '../platform/src/platform/runtime/provider-accounts/registry.ts';
import type { ProviderAccountSnapshotDeps } from '../platform/src/platform/runtime/provider-accounts/registry.ts';

function snapshotFor(overrideAmbientApiKeys: boolean) {
  const subscription = {
    provider: 'anthropic',
    accessToken: 'token',
    overrideAmbientApiKeys,
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  };
  const deps = {
    providerRegistry: {
      listModels: () => [],
      getCurrentModel: () => undefined,
      getRegistered: () => [],
      describeRuntime: async () => null,
    },
    serviceRegistry: { getAll: () => ({}), inspect: async () => null },
    subscriptionManager: {
      list: () => [subscription],
      listPending: () => [],
      get: (provider: string) => (provider === 'anthropic' ? subscription : null),
      getPending: () => null,
    },
    secretsManager: { get: async (key: string) => (key === 'ANTHROPIC_API_KEY' ? 'sk-test' : null) },
  } as unknown as ProviderAccountSnapshotDeps;
  return buildProviderAccountSnapshot(deps).then((snapshot) => snapshot.providers.find((entry) => entry.providerId === 'anthropic')!);
}

describe('provider account active route', () => {
  test('a subscription that does not override ambient keys leaves the API key active', async () => {
    const record = await snapshotFor(false);
    expect(record.availableRoutes).toEqual(expect.arrayContaining(['api-key', 'subscription']));
    expect(record.activeRoute).toBe('api-key');
    expect(record.activeRouteReason).toContain('does not override');
  });

  test('a subscription set to override ambient keys is the active route', async () => {
    const record = await snapshotFor(true);
    expect(record.activeRoute).toBe('subscription');
  });
});

describe('provider account snapshot with an unusable services file', () => {
  const build = (reason: string | null) => buildProviderAccountSnapshot({
    providerRegistry: { listModels: () => [], getCurrentModel: () => undefined, getRegistered: () => [], describeRuntime: async () => null },
    serviceRegistry: { getAll: () => ({}), inspect: async () => null, unreadableReason: () => reason },
    subscriptionManager: { list: () => [], listPending: () => [], get: () => null, getPending: () => null },
    secretsManager: { get: async () => null },
  } as unknown as ProviderAccountSnapshotDeps);

  test('names the reason and counts it as an issue instead of reading as no services', async () => {
    const snapshot = await build('/w/services.json is not valid JSON');
    expect(snapshot.servicesUnreadable).toBe('/w/services.json is not valid JSON');
    expect(snapshot.issueCount).toBeGreaterThanOrEqual(1);
  });

  test('a usable file adds nothing', async () => {
    const snapshot = await build(null);
    expect(snapshot.servicesUnreadable).toBeUndefined();
  });
});
