/**
 * Device-code polling outlasts a dropped connection or a server error while
 * the user is still approving; only a run of them, or a real refusal, ends it.
 */
import { expect, test } from 'bun:test';
import { pollDeviceCodeFlow } from '../platform/src/platform/calendar/oauth-flow.ts';
import type { HttpFetch, HttpResponse, ResolvedClientConfig } from '../platform/src/platform/calendar/oauth-types.ts';

const config = { provider: 'google', clientId: 'synthetic', scopes: [], authorizationEndpoint: 'https://auth.invalid/a',
  tokenEndpoint: 'https://auth.invalid/token', deviceAuthorizationEndpoint: 'https://auth.invalid/device', apiBaseUrl: 'https://api.invalid' } as unknown as ResolvedClientConfig;
const start = { deviceCode: 'device', userCode: 'USER', verificationUri: 'https://auth.invalid/verify', expiresAt: Number.MAX_SAFE_INTEGER, intervalMs: 0 };
const respond = (status: number, body: unknown): HttpResponse => ({ status, ok: status < 300, header: () => null, json: async () => body, text: async () => JSON.stringify(body) });

function scripted(steps: readonly (() => HttpResponse)[]): HttpFetch {
  let index = 0;
  return async () => steps[Math.min(index++, steps.length - 1)]!();
}

test('a dropped poll and a server error do not end a login the user then approves', async () => {
  const fetchImpl = scripted([
    () => respond(400, { error: 'authorization_pending' }),
    () => { throw new Error('ECONNRESET'); },
    () => respond(503, {}),
    () => respond(200, { access_token: 'access', token_type: 'Bearer', expires_in: 3600 }),
  ]);
  const tokens = await pollDeviceCodeFlow(config, fetchImpl, start, () => 0, async () => {});
  expect(tokens.accessToken).toBe('access');
});

test('a run of failures ends the login with the last cause', async () => {
  const fetchImpl = scripted([() => { throw new Error('ENETUNREACH'); }]);
  await expect(pollDeviceCodeFlow(config, fetchImpl, start, () => 0, async () => {})).rejects.toThrow('5 times in a row');
});

test('a refusal still ends the login at once', async () => {
  const fetchImpl = scripted([() => respond(400, { error: 'access_denied' })]);
  await expect(pollDeviceCodeFlow(config, fetchImpl, start, () => 0, async () => {})).rejects.toThrow('access_denied');
});
