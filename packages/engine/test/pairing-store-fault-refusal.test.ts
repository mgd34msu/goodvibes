/** A faulted pairing store refuses settings authority by name, not as a stale capture. */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PairingTokenManager } from '../platform/src/platform/pairing/pairing-token-store.js';
import { UserAuthManager } from '../platform/src/platform/security/user-auth.js';
import { PairingStoreFaultedError } from '../platform/src/platform/security/settings-authority.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../platform/src/platform/daemon/control-plane.js';
import { createSettingsPreconditionHandler } from '../daemon-api/src/settings-precondition.js';

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function faultedFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pairing-fault-')); roots.push(dir);
  const file = join(dir, 'pairing.json');
  const pairing = new PairingTokenManager(file);
  const paired = pairing.mint({ name: 'Synthetic device' });
  const users = new UserAuthManager({ bootstrapFilePath: join(dir, 'users.json'), bootstrapCredentialPath: join(dir, 'bootstrap.txt'),
    scryptParams: { N: 16, r: 1, p: 1 }, users: [{ username: 'operator', passwordHash: 'synthetic-unused-hash', roles: ['admin'] }] });
  const session = users.createSession('operator');
  const shared = 'synthetic-settings-shared';
  const lifetime = {};
  const helper = new DaemonControlPlaneHelper({ pairingTokens: pairing, userAuth: users, authToken: () => shared,
    settingsLifetime: () => lifetime } as unknown as DaemonControlPlaneContext);
  // The store file becomes unreadable: every settings read under the owner lock faults.
  rmSync(file); mkdirSync(file);
  const request = (token: string) => new Request('http://synthetic.invalid/config', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  return { helper, request, pairedToken: paired.token, shared, sessionToken: session.token, lifetime };
}

test('a paired or shared-token capture from a faulted store is refused as faulted', () => {
  const f = faultedFixture();
  expect(() => f.helper.captureSettingsAdminAuthority(f.request(f.pairedToken))).toThrow(PairingStoreFaultedError);
  expect(() => f.helper.captureSettingsAdminAuthority(f.request(f.shared))).toThrow(PairingStoreFaultedError);
});

test('a user session does not depend on the pairing store and still captures', () => {
  const f = faultedFixture();
  expect(f.helper.captureSettingsAdminAuthority(f.request(f.sessionToken))).not.toBeNull();
});

test('the precondition route answers PAIRING_STORE_FAULTED instead of a stale or generic refusal', async () => {
  const f = faultedFixture();
  const handler = createSettingsPreconditionHandler({
    owner: {
      prepare: () => ({}), assert: () => {}, begin: () => ({}), assertTransition: () => {},
      inspect: () => ({ key: 'display.theme', operation: 'set', value: 'nord', destinations: [] }) as never,
      finish: () => ({ status: 'unknown', completedPaths: [] }),
    },
    lifetime: () => f.lifetime,
    captureAuthority: req => f.helper.captureSettingsAdminAuthority(req),
    withAuthority: (_req, _authority, callback) => callback(() => {}),
  });
  const response = await handler.handle(f.request(f.shared),
    { settingsPrecondition: { version: 1, action: 'capture', operation: 'set', key: 'display.theme', value: 'nord' } }, f.lifetime);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'PAIRING_STORE_FAULTED' });
});
