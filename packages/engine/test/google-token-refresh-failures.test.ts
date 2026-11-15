/** A refresh that cannot finish must still answer, never reject. */
import { describe, expect, test } from 'bun:test';
import type { GoogleOAuthCredentials } from '../platform/src/platform/google/credential-adoption.ts';
import { checkGoogleCredentialsAtBoot, GoogleTokenManager, type GoogleRefreshOutcome } from '../platform/src/platform/google/token-manager.ts';

function credentials(): GoogleOAuthCredentials {
  return {
    clientId: 'client-id',
    clientSecret: 'secret',
    refreshToken: 'refresh',
    accessToken: null,
    expiresAtMs: null,
    scopes: [],
    tokenUri: 'https://oauth2.googleapis.com/token',
    origin: 'secret-store',
    location: 'goodvibes.google.oauth.refreshToken',
  };
}

const fresh = async (): Promise<GoogleRefreshOutcome> => ({ ok: true, result: { accessToken: 'fresh', expiresInSeconds: 3600, scopes: null } });

describe('token refresh failures', () => {
  test('a refresh function that rejects is a transient failure, not a thrown error or a dead grant', async () => {
    let calls = 0;
    const manager = new GoogleTokenManager(credentials(), {
      refresh: async () => { calls += 1; if (calls === 1) throw new Error('socket hang up'); return fresh(); },
    });
    const first = await checkGoogleCredentialsAtBoot(manager);
    expect(first.usable).toBe(false);
    expect(first.needsReauthorization).toBe(false);
    expect((await manager.accessToken()).ok).toBe(true);
  });
});
