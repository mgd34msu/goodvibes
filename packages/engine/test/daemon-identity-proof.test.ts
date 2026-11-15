import { describe, expect, test } from 'bun:test';
import { DaemonHttpRouter } from '../platform/src/platform/daemon/http/router.ts';
import {
  answerDaemonChallenge,
  DAEMON_PROOF_HEADER,
  DAEMON_CHALLENGE_HEADER,
  isValidDaemonIdentityProof,
} from '../platform/src/platform/daemon/identity-proof.ts';

const challenged = (challenge: string): Request => new Request('http://127.0.0.1/status', { headers: { [DAEMON_CHALLENGE_HEADER]: challenge } });

describe('daemon identity proof', () => {
  test('a daemon holding the token answers a challenge with a proof the host accepts', () => {
    const proof = answerDaemonChallenge(challenged('nonce-1'), 'shared-token');
    expect(isValidDaemonIdentityProof('shared-token', 'nonce-1', proof)).toBe(true);
  });

  test('a proof does not verify for another challenge or another token', () => {
    const proof = answerDaemonChallenge(challenged('nonce-1'), 'shared-token');
    expect(isValidDaemonIdentityProof('shared-token', 'nonce-2', proof)).toBe(false);
    expect(isValidDaemonIdentityProof('other-token', 'nonce-1', proof)).toBe(false);
    expect(isValidDaemonIdentityProof('shared-token', 'nonce-1', null)).toBe(false);
  });

  test('no proof is made without a challenge, without a token, or for an oversized challenge', () => {
    expect(answerDaemonChallenge(new Request('http://127.0.0.1/status'), 'shared-token')).toBeNull();
    expect(answerDaemonChallenge(challenged('nonce-1'), null)).toBeNull();
    expect(answerDaemonChallenge(challenged('x'.repeat(129)), 'shared-token')).toBeNull();
  });
});

describe('the daemon router answers a challenge on its refusal', () => {
  const router = (token: string | null) => new DaemonHttpRouter({
    configManager: { get: () => undefined },
    gatewayMethods: { findByHttpBinding: () => null, get: () => null, list: () => [], listEvents: () => [], getAllScopes: () => [] as string[] },
    controlPlaneGateway: {},
    userAuth: null,
    runtimeStore: null,
    runtimeDispatch: null,
    authToken: () => token,
    checkAuth: () => false,
    extractAuthToken: () => '',
  } as unknown as ConstructorParameters<typeof DaemonHttpRouter>[0]);

  test('an unauthenticated /status carries a proof the host accepts', async () => {
    const response = await router('shared-token').handleRequest(challenged('nonce-1'));
    expect(response.status).toBe(401);
    expect(isValidDaemonIdentityProof('shared-token', 'nonce-1', response.headers.get(DAEMON_PROOF_HEADER))).toBe(true);
  });

  test('a refusal without a challenge carries no proof', async () => {
    const response = await router('shared-token').handleRequest(new Request('http://127.0.0.1/status'));
    expect(response.status).toBe(401);
    expect(response.headers.get(DAEMON_PROOF_HEADER)).toBeNull();
  });
});
