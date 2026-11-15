/**
 * A token refresh that finishes after the stored token changed (a logout or a
 * new login while it was in flight) leaves the store as the user left it.
 */
import { expect, test } from 'bun:test';
import { AutoRefreshCoordinator } from '../platform/src/client-auth/auto-refresh.ts';
import { createMemoryTokenStore } from '../platform/src/auth.ts';
import { GoodVibesError } from '../errors/src/index.js';

function parkedRefresh(outcome: () => { token: string } | never) {
  let release!: () => void;
  const parked = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  return { release, started, refresh: async () => { entered(); await parked; return outcome(); } };
}

test('a logout during a refresh is not undone by the refresh answer', async () => {
  const tokenStore = createMemoryTokenStore('expiring-token', Date.now() + 1_000);
  const parked = parkedRefresh(() => ({ token: 'refreshed-token' }));
  const coordinator = new AutoRefreshCoordinator({ tokenStore, autoRefresh: true, refreshLeewayMs: 60_000, refresh: parked.refresh });
  const refreshing = coordinator.ensureFreshToken();
  await parked.started;
  await tokenStore.clearToken();
  parked.release();
  await refreshing;
  expect(await tokenStore.getToken()).toBeNull();
});

test('a refusal that arrives after a new login does not clear the new login', async () => {
  const tokenStore = createMemoryTokenStore('expiring-token', Date.now() + 1_000);
  const parked = parkedRefresh(() => {
    throw new GoodVibesError('refresh refused', { category: 'authentication', source: 'transport', status: 401, recoverable: false });
  });
  const coordinator = new AutoRefreshCoordinator({ tokenStore, autoRefresh: true, refreshLeewayMs: 60_000, refresh: parked.refresh });
  const refreshing = coordinator.ensureFreshToken();
  await parked.started;
  await tokenStore.setToken('new-login-token');
  parked.release();
  await refreshing;
  expect(await tokenStore.getToken()).toBe('new-login-token');
});
