/**
 * One held Google connection: token requests per call, counted.
 */
import { describe, expect, test } from 'bun:test';
import { GoogleConnectionOwner } from '../platform/src/platform/google/connection-owner.ts';
import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS } from '../platform/src/platform/google/setup-plan.ts';
import type { GoogleConnectionSources } from '../platform/src/platform/google/connection.ts';

function sources(secrets: Record<string, string>): GoogleConnectionSources {
  return {
    files: { exists: () => false, readText: () => null },
    homeDirectory: '/nonexistent',
    configGet: (key) => (key === GOOGLE_CONFIG_KEYS.oauthClientId ? 'client.apps.googleusercontent.com' : undefined),
    secretGet: async (key) => secrets[key] ?? null,
  };
}

function tokenEndpoint(answer: () => { status: number; body: Record<string, unknown> }) {
  let posts = 0;
  return {
    posts: () => posts,
    port: {
      fetch: async (_url: string, _init: RequestInit): Promise<Response> => {
        posts += 1;
        const { status, body } = answer();
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      },
    },
  };
}

describe('a held Google connection', () => {
  test('five calls make one token request', async () => {
    const endpoint = tokenEndpoint(() => ({ status: 200, body: { access_token: 'token', expires_in: 3600, scope: 'https://www.googleapis.com/auth/calendar.events' } }));
    const secrets = { [GOOGLE_SECRET_KEYS.oauthClientSecret]: 'secret', [GOOGLE_SECRET_KEYS.oauthRefreshToken]: 'refresh-1' };
    const owner = new GoogleConnectionOwner({ sources: sources(secrets), fetch: endpoint.port });
    for (let call = 0; call < 5; call += 1) {
      const connection = await owner.connection();
      expect((await connection!.tokens.accessToken()).ok).toBe(true);
    }
    expect(endpoint.posts()).toBe(1);
  });

  test('a dead grant is asked about once, and a new refresh token is asked about again', async () => {
    const endpoint = tokenEndpoint(() => ({ status: 400, body: { error: 'invalid_grant' } }));
    const secrets: Record<string, string> = { [GOOGLE_SECRET_KEYS.oauthClientSecret]: 'secret', [GOOGLE_SECRET_KEYS.oauthRefreshToken]: 'refresh-dead' };
    const owner = new GoogleConnectionOwner({ sources: sources(secrets), fetch: endpoint.port });
    for (let call = 0; call < 5; call += 1) {
      const outcome = await (await owner.connection())!.tokens.accessToken();
      expect(outcome.ok).toBe(false);
    }
    expect(endpoint.posts()).toBe(1);

    secrets[GOOGLE_SECRET_KEYS.oauthRefreshToken] = 'refresh-new';
    await (await owner.connection())!.tokens.accessToken();
    expect(endpoint.posts()).toBe(2);
  });
});
