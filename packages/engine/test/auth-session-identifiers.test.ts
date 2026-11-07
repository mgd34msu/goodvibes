import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { UserAuthManager } from '../sdk/src/platform/security/user-auth.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

test('public session IDs support scoped revocation without exposing or accepting bearer tokens', () => {
  const root = makeProjectTempDir('auth-session-identifiers');
  const auth = new UserAuthManager({ bootstrapFilePath: join(root, 'users.json'), bootstrapCredentialPath: join(root, 'bootstrap.txt'),
    users: [{ username: 'operator', passwordHash: 'synthetic-unused-hash', roles: ['admin'] }] });
  const first = auth.createSession('operator'), second = auth.createSession('operator');
  const authority = auth.captureSettingsAuthority(first.token);
  if (!authority) throw new Error('The native session did not acquire its own authority');
  const listed = auth.listSessions();
  expect(listed.map(session => session.id).sort()).toEqual([first.id, second.id].sort());
  expect(first.id).not.toBe(second.id);
  expect(JSON.stringify(listed)).not.toContain(first.token);
  expect(JSON.stringify(listed)).not.toContain(second.token);
  expect(auth.validateSession(first.id)).toBeNull();
  expect(auth.revokeSession(first.id)).toBe(true);
  expect(auth.validateSession(first.token)).toBeNull();
  expect(() => auth.assertSettingsAuthorityCurrent(authority)).toThrow();
  expect(auth.validateSession(second.token)?.id).toBe(second.id);
  expect(auth.revokeSession(second.token)).toBe(true);
  expect(auth.listSessions()).toEqual([]);
});
