import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { setExplicitAuthToken, tokenStore } from './goodvibes';

const realFetch = globalThis.fetch;
const asFetch = (impl: () => Promise<Response>): typeof fetch =>
  Object.assign(impl, { preconnect: realFetch.preconnect }) as unknown as typeof fetch;

beforeEach(async () => {
  await tokenStore.clearToken();
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  await tokenStore.clearToken();
});

describe('setExplicitAuthToken when the daemon cannot be asked', () => {
  test('keeps the credential the browser already had, expiry included', async () => {
    const expiresAt = Date.now() + 3_600_000;
    await tokenStore.setTokenEntry('previous-token', expiresAt);
    globalThis.fetch = asFetch(async () => { throw new TypeError('Failed to fetch'); });

    await expect(setExplicitAuthToken('minted-device-token')).rejects.toBeDefined();

    expect(await tokenStore.getTokenEntry()).toEqual({ token: 'previous-token', expiresAt });
  });

  test('a token the daemon rejects is still removed, so a bad paste cannot linger', async () => {
    await tokenStore.setToken('previous-token');
    globalThis.fetch = asFetch(async () => new Response(JSON.stringify({ authenticated: false, authMode: 'invalid' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(setExplicitAuthToken('wrong-token')).rejects.toBeDefined();

    expect(await tokenStore.getToken()).toBeFalsy();
  });

  test('a transient failure on the first look does not discard a good token', async () => {
    let calls = 0;
    globalThis.fetch = asFetch(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify({ authenticated: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    await setExplicitAuthToken('minted-device-token');

    expect(await tokenStore.getToken()).toBe('minted-device-token');
  });
});
