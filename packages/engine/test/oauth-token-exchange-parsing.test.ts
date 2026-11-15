import { afterEach, expect, test } from 'bun:test';
import { decodeJwtPayload, refreshOAuthAccessToken } from '../platform/src/platform/runtime/auth/oauth-core.ts';
import type { OAuthProviderConfig } from '../platform/src/platform/config/subscriptions.ts';

const config: OAuthProviderConfig = {
  clientId: 'client',
  authUrl: 'https://auth.example.com/authorize',
  tokenUrl: 'https://auth.example.com/token',
  redirectUri: 'http://localhost:4000/callback',
  scopes: ['openid'],
};

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function answerWith(body: Record<string, unknown>): void {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
}

test('a numeric string expires_in still gives the session an expiry', async () => {
  answerWith({ access_token: 'a', expires_in: '3600' });
  const before = Date.now();
  const token = await refreshOAuthAccessToken(config, 'refresh');
  expect(token.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
  expect(token.expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
});

test('an expires_in that is not a number leaves the expiry unset', async () => {
  answerWith({ access_token: 'a', expires_in: 'soon' });
  expect((await refreshOAuthAccessToken(config, 'refresh')).expiresAt).toBeUndefined();
});

test('non-ASCII claims survive decoding', () => {
  const claims = { name: 'Zoë Ålesund 日本' };
  const payload = Buffer.from(JSON.stringify(claims), 'utf-8').toString('base64url');
  expect(decodeJwtPayload(`header.${payload}.sig`)).toEqual(claims);
});
