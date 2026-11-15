import { describe, expect, test } from 'bun:test';
import { DaemonHttpRouter } from '../platform/src/platform/daemon/http/router.ts';
import {
  answerDaemonChallenge,
  DAEMON_PROOF_HEADER,
  DAEMON_CHALLENGE_HEADER,
  isValidDaemonIdentityProof,
} from '../platform/src/platform/daemon/identity-proof.ts';

const challenged = (challenge: string): Request => new Request('http://127.0.0.1:3421/status', { headers: { [DAEMON_CHALLENGE_HEADER]: challenge } });

describe('daemon identity proof', () => {
  test('a daemon holding the token answers a challenge with a proof the host accepts for the port it dialled', () => {
    const proof = answerDaemonChallenge(challenged('nonce-1'), 'shared-token', 3421);
    expect(isValidDaemonIdentityProof('shared-token', 'nonce-1', proof, 3421)).toBe(true);
  });

  test('a proof does not verify for another challenge, another token or another port', () => {
    const proof = answerDaemonChallenge(challenged('nonce-1'), 'shared-token', 3421);
    expect(isValidDaemonIdentityProof('shared-token', 'nonce-2', proof, 3421)).toBe(false);
    expect(isValidDaemonIdentityProof('other-token', 'nonce-1', proof, 3421)).toBe(false);
    expect(isValidDaemonIdentityProof('shared-token', 'nonce-1', null, 3421)).toBe(false);
    // A process on another port that relays the challenge to the real daemon gets a proof that does not verify where the host dialled.
    expect(isValidDaemonIdentityProof('shared-token', 'nonce-1', proof, 4000)).toBe(false);
  });

  test('no proof is made without a challenge, without a token, or for an oversized challenge', () => {
    expect(answerDaemonChallenge(new Request('http://127.0.0.1/status'), 'shared-token', 3421)).toBeNull();
    expect(answerDaemonChallenge(challenged('nonce-1'), null, 3421)).toBeNull();
    expect(answerDaemonChallenge(challenged('x'.repeat(129)), 'shared-token', 3421)).toBeNull();
  });
});

describe('the daemon router answers a challenge', () => {
  const router = (token: string | null) => new DaemonHttpRouter({
    configManager: { get: () => undefined },
    gatewayMethods: { findByHttpBinding: () => null, get: () => null, list: () => [], listEvents: () => [], getAllScopes: () => [] as string[] },
    controlPlaneGateway: {},
    userAuth: null,
    runtimeStore: null,
    runtimeDispatch: null,
    authToken: () => token,
    listenerBinding: () => ({ host: '127.0.0.1', port: 3421, scheme: 'http' }),
    authenticateRequest: () => null,
    extractAuthToken: () => '',
  } as unknown as ConstructorParameters<typeof DaemonHttpRouter>[0]);

  test('an unauthenticated /status carries a proof bound to the port the daemon listens on', async () => {
    const response = await router('shared-token').handleRequest(challenged('nonce-1'));
    expect(response.status).toBe(401);
    expect(isValidDaemonIdentityProof('shared-token', 'nonce-1', response.headers.get(DAEMON_PROOF_HEADER), 3421)).toBe(true);
  });

  test('a refusal without a challenge carries no proof', async () => {
    const response = await router('shared-token').handleRequest(new Request('http://127.0.0.1:3421/status'));
    expect(response.status).toBe(401);
    expect(response.headers.get(DAEMON_PROOF_HEADER)).toBeNull();
  });
});
