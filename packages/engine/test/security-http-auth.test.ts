// Proves: A remote caller that reaches the daemon through a proxy on the same machine is not given the local credential's authority.
// Red when: A request with any forwarding header, a public Host or a non-loopback peer is classed as local; the local credential carries owner authority (it can start a purchase).
// Proves: A wrong token authenticates, or a non-admin session is treated as an administrator.
// Red when: authenticateOperatorToken returns a principal for a wrong token, or isOperatorAdmin is true for an operator-role session.
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  authenticateOperatorToken,
  isOperatorAdmin,
} from '@goodvibes-jev/engine/platform/platform/security';
import { UserAuthManager } from '@goodvibes-jev/engine/platform/platform/security';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { credentialKindOf } from '../platform/src/platform/security/http-auth.js';
import { isDirectLoopbackRequest } from '../platform/src/platform/daemon/client-address.js';

describe('http auth helpers', () => {
  test('returns null for invalid credentials and keeps non-admin sessions non-admin', () => {
    const root = makeProjectTempDir('gv-http-auth');
    const userAuth = new UserAuthManager({
      bootstrapFilePath: join(root, 'users.json'),
      bootstrapCredentialPath: join(root, 'bootstrap.txt'),
      users: [{ username: 'operator', passwordHash: UserAuthManager.hashPassword('operator-password'), roles: ['operator'] }],
    });
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
});
