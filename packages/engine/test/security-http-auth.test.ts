import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { join } from 'node:path';
import {
  authenticateOperatorRequest,
  authenticateOperatorToken,
  extractOperatorAuthToken,
  isOperatorAdmin,
  OPERATOR_SESSION_COOKIE_NAME,
} from '@goodvibes-jev/engine/platform/platform/security';
import { UserAuthManager } from '@goodvibes-jev/engine/platform/platform/security';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { credentialKindOf, matchesSharedToken } from '../platform/src/platform/security/http-auth.js';
import { isDirectLoopbackRequest, isLocalOrigin, resolveClientAddress } from '../platform/src/platform/daemon/client-address.js';

test.each([
  ['same-token', 'same-token', true],
  ['same-toker', 'same-token', false],
  ['short', 'same-token', false],
  ['é', 'ab', false],
  ['é', 'é', true],
] as const)('shared token comparison handles exact UTF-8 bytes (%s)', (supplied, expected, matches) => {
  expect(matchesSharedToken(supplied, expected)).toBe(matches);
});

describe('http auth helpers', () => {
  let userAuth: UserAuthManager;

  beforeEach(() => {
    const root = makeProjectTempDir('gv-http-auth');
    userAuth = new UserAuthManager({
      bootstrapFilePath: join(root, 'users.json'),
      bootstrapCredentialPath: join(root, 'bootstrap.txt'),
      users: [
        {
          username: 'admin',
          passwordHash: UserAuthManager.hashPassword('admin-password'),
          roles: ['admin'],
        },
        {
          username: 'operator',
          passwordHash: UserAuthManager.hashPassword('operator-password'),
          roles: ['operator'],
        },
      ],
    });
  });

  test('prefers bearer auth over the session cookie when both are present', () => {
    const request = new Request('http://localhost/api', {
      headers: {
        Authorization: 'Bearer shared-secret',
        Cookie: `${OPERATOR_SESSION_COOKIE_NAME}=session-token`,
      },
    });
    expect(extractOperatorAuthToken(request)).toBe('shared-secret');
  });

  test('unknown usernames still perform password hashing before refusal', () => {
    const hash = spyOn(crypto, 'scryptSync');
    try {
      expect(userAuth.authenticate('missing-user', 'wrong').ok).toBe(false);
      expect(hash).toHaveBeenCalledTimes(1);
      expect(userAuth.authenticate('admin', 'wrong').ok).toBe(false);
      expect(hash).toHaveBeenCalledTimes(2);
    } finally { hash.mockRestore(); }
  });

  test('authenticates shared tokens and treats them as admin', () => {
    const request = new Request('http://localhost/api', {
      headers: {
        Authorization: 'Bearer shared-secret',
      },
    });
    const authenticated = authenticateOperatorRequest(request, {
      sharedToken: 'shared-secret',
      userAuth,
    });
    expect(authenticated).toEqual({
      kind: 'shared-token',
      token: 'shared-secret',
    });
    expect(isOperatorAdmin(authenticated)).toBe(true);
  });

  test('authenticates local sessions from cookies', () => {
    const session = userAuth.createSession('admin');
    const request = new Request('http://localhost/api', {
      headers: {
        Cookie: `${OPERATOR_SESSION_COOKIE_NAME}=${encodeURIComponent(session.token)}`,
      },
    });
    const authenticated = authenticateOperatorRequest(request, {
      userAuth,
    });
    expect(authenticated).toEqual({
      kind: 'session',
      token: session.token,
      username: 'admin',
      roles: ['admin'],
      expiresAt: session.expiresAt,
    });
    expect(isOperatorAdmin(authenticated)).toBe(true);
  });

  test('returns null for invalid credentials and keeps non-admin sessions non-admin', () => {
    const operatorSession = userAuth.createSession('operator');
    expect(authenticateOperatorToken('wrong-token', { userAuth })).toBeNull();

    const authenticated = authenticateOperatorToken(operatorSession.token, { userAuth });
    expect(authenticated).toEqual({
      kind: 'session',
      token: operatorSession.token,
      username: 'operator',
      roles: ['operator'],
      expiresAt: operatorSession.expiresAt,
    });
    expect(isOperatorAdmin(authenticated)).toBe(false);
  });
});

describe('the operator token is the local credential only on a direct connection from this machine', () => {
  const shared = { kind: 'shared-token', token: 'shared-secret' } as const;
  const request = (host: string, headers: Record<string, string> = {}) =>
    new Request(`http://${host}/api/control-plane/status`, { headers: { host, authorization: 'Bearer shared-secret', ...headers } });

  test('a direct loopback request is local', () => {
    for (const [host, peer] of [['127.0.0.1:3421', '127.0.0.1'], ['localhost:3421', '::1'], ['[::1]:3421', '::ffff:127.0.0.1']] as const) {
      const local = isDirectLoopbackRequest(request(host), peer);
      expect(`${host} from ${peer}: ${local}`).toBe(`${host} from ${peer}: true`);
      expect(credentialKindOf(shared, local)).toBe('local');
    }
  });

  test('a remote caller behind a same-machine proxy is not local, whichever forwarding header the proxy adds', () => {
    const forwarded: Record<string, string> = {
      forwarded: 'for=203.0.113.9', 'x-forwarded-for': '203.0.113.9', 'x-forwarded-host': 'daemon.example.com', 'x-real-ip': '203.0.113.9',
      'cf-connecting-ip': '203.0.113.9', 'true-client-ip': '203.0.113.9', via: '1.1 caddy',
    };
    for (const [name, value] of Object.entries(forwarded)) {
      const local = isDirectLoopbackRequest(request('127.0.0.1:3421', { [name]: value }), '127.0.0.1');
      expect(`${name}: ${local}`).toBe(`${name}: false`);
      expect(credentialKindOf(shared, local)).toBe('shared-token');
    }
    // A proxy that adds no header but passes the public name through.
    expect(isDirectLoopbackRequest(request('daemon.example.com'), '127.0.0.1')).toBe(false);
    // A caller on another machine, even naming a loopback host.
    expect(isDirectLoopbackRequest(request('127.0.0.1:3421'), '192.168.1.20')).toBe(false);
    expect(isDirectLoopbackRequest(request('127.0.0.1:3421'), undefined)).toBe(false);
  });

  test('a request no listener bound is never local, and a trusted proxy names the remote client, not loopback', () => {
    expect(isLocalOrigin(request('127.0.0.1:3421'))).toBe(false);
    const behindProxy = request('127.0.0.1:3421', { 'x-forwarded-for': '203.0.113.9' });
    expect(resolveClientAddress(behindProxy, '127.0.0.1', { trustProxy: true })).toBe('203.0.113.9');
    // Without proxy trust the header names nothing; the socket peer does.
    expect(resolveClientAddress(behindProxy, '127.0.0.1', { trustProxy: false })).toBe('127.0.0.1');
  });
});
