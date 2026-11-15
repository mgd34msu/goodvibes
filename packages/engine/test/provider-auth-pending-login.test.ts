import { describe, expect, test } from 'bun:test';
import { buildStandardProviderAuthRoutes, summarizeProviderAuth } from '../platform/src/platform/providers/runtime-metadata.ts';
import type { ProviderRuntimeMetadataDeps } from '../platform/src/platform/providers/interface.ts';

function deps(session: Record<string, unknown> | null, pending: Record<string, unknown> | null): ProviderRuntimeMetadataDeps {
  return {
    subscriptionManager: { get: () => session, getPending: () => pending },
    serviceRegistry: { getAll: () => ({}), inspect: async () => null },
    secretsManager: { get: async () => null, listDetailed: async () => [] },
  } as never;
}

const subscriptionRoute = async (session: Record<string, unknown> | null, pending: Record<string, unknown> | null) =>
  (await buildStandardProviderAuthRoutes({ providerId: 'acme-sub', subscriptionProviderId: 'acme-sub' }, deps(session, pending)))
    .find((route) => route.route === 'subscription-oauth')!;

describe('a subscription login that has not finished', () => {
  test('is not usable, and does not make the provider look configured', async () => {
    const route = await subscriptionRoute(null, { startedAt: 1 });
    expect(route.freshness).toBe('pending');
    expect(route.usable).toBe(false);
    const base = { configured: false, detail: 'ACME_API_KEY not set' };
    expect(summarizeProviderAuth(base, [route])).toEqual(base);
  });

  test('does not hide the state of a session that is already stored', async () => {
    const healthy = await subscriptionRoute({ expiresAt: Date.now() + 10 * 24 * 60 * 60 * 1000 }, { startedAt: 1 });
    expect(healthy.freshness).toBe('healthy');
    expect(healthy.usable).toBe(true);
    const revoked = await subscriptionRoute({ revokedAt: 5 }, { startedAt: 1 });
    expect(revoked.freshness).toBe('expired');
    expect(revoked.usable).toBe(false);
  });
});
