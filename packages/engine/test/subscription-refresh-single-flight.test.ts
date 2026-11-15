/**
 * A provider subscription refresh is one request per provider at a time, in
 * one process and across processes sharing the store, and
 * its answer is merged into the store as it is after the request: a logout or
 * another provider's login made meanwhile survives it. An abandoned re-login
 * stops masking a working subscription.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubscriptionManager, type OAuthProviderConfig, type ProviderSubscription } from '../platform/src/platform/config/subscriptions.js';

const realFetch = globalThis.fetch;
const dirs: string[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const config: OAuthProviderConfig = { authUrl: 'https://auth.invalid/authorize', tokenUrl: 'https://auth.invalid/token', clientId: 'synthetic', redirectUri: 'http://127.0.0.1/cb' };

function manager(): SubscriptionManager {
  const dir = mkdtempSync(join(tmpdir(), 'gv-subscription-refresh-')); dirs.push(dir);
  return new SubscriptionManager(join(dir, 'subscriptions.json'));
}
function expired(provider: string): ProviderSubscription {
  return { provider, accessToken: 'old-access', refreshToken: 'old-refresh', tokenType: 'Bearer', expiresAt: Date.now() - 1_000,
    authMode: 'oauth', overrideAmbientApiKeys: true, createdAt: 1, updatedAt: 1 };
}
/** A token endpoint that answers when released, counting requests and signalling when one has arrived. */
function heldTokenEndpoint() {
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let markEntered!: () => void;
  const entered = new Promise<void>(resolve => { markEntered = resolve; });
  const calls = { count: 0 };
  globalThis.fetch = (async () => {
    calls.count++;
    markEntered();
    await released;
    return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'Bearer', expires_in: 3600 });
  }) as unknown as typeof fetch;
  return { calls, release, entered };
}

test('two concurrent token resolutions make one refresh request', async () => {
  const subscriptions = manager();
  subscriptions.saveSubscription(expired('synthetic-provider'));
  const endpoint = heldTokenEndpoint();
  const first = subscriptions.resolveAccessToken('synthetic-provider', config);
  const second = subscriptions.resolveAccessToken('synthetic-provider', config);
  endpoint.release();
  expect(await Promise.all([first, second])).toEqual(['new-access', 'new-access']);
  expect(endpoint.calls.count).toBe(1);
  expect(subscriptions.get('synthetic-provider')?.refreshToken).toBe('new-refresh');
});

test('two processes that need a fresh token send the rotating refresh token once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gv-subscription-refresh-')); dirs.push(dir);
  const path = join(dir, 'subscriptions.json');
  // Separate managers share no in-process request, as two processes do not.
  const first = new SubscriptionManager(path);
  const second = new SubscriptionManager(path);
  first.saveSubscription(expired('synthetic-provider'));
  const endpoint = heldTokenEndpoint();
  const fromFirst = first.resolveAccessToken('synthetic-provider', config);
  await endpoint.entered;
  const fromSecond = second.resolveAccessToken('synthetic-provider', config);
  endpoint.release();
  expect(await Promise.all([fromFirst, fromSecond])).toEqual(['new-access', 'new-access']);
  expect(endpoint.calls.count).toBe(1);
  expect(second.get('synthetic-provider')?.refreshingUntil).toBeUndefined();
});

test('a logout during a refresh stays logged out, and another provider\'s login is kept', async () => {
  const subscriptions = manager();
  subscriptions.saveSubscription(expired('synthetic-provider'));
  const endpoint = heldTokenEndpoint();
  const resolving = subscriptions.resolveAccessToken('synthetic-provider', config);
  await endpoint.entered;
  subscriptions.logout('synthetic-provider');
  subscriptions.saveSubscription({ ...expired('other-provider'), accessToken: 'other-access', expiresAt: Date.now() + 3_600_000 });
  endpoint.release();
  expect(await resolving).toBeNull();
  expect(subscriptions.get('synthetic-provider')).toBeNull();
  expect(subscriptions.get('other-provider')?.accessToken).toBe('other-access');
});

test('an abandoned re-login no longer masks a working subscription', () => {
  const subscriptions = manager();
  subscriptions.saveSubscription({ ...expired('synthetic-provider'), expiresAt: Date.now() + 3_600_000 });
  subscriptions.savePending({ provider: 'synthetic-provider', state: 's', verifier: 'v', redirectUri: config.redirectUri, createdAt: Date.now() - 31 * 60_000 });
  expect(subscriptions.getPending('synthetic-provider')).toBeNull();
  expect(subscriptions.listPending()).toEqual([]);
  subscriptions.savePending({ provider: 'synthetic-provider', state: 's', verifier: 'v', redirectUri: config.redirectUri, createdAt: Date.now() });
  expect(subscriptions.getPending('synthetic-provider')?.state).toBe('s');
});
