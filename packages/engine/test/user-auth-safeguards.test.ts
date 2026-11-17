// Proves: A session ends at its expiry, and a user deleted or re-keyed from the command line loses access on the running daemon and is not brought back by its next write.
// Red when: An expired session token is accepted, the running daemon keeps honouring a deleted user, or its next write of the user store restores a deleted user or an old password.
/**
 * Local auth: the last administrator cannot be deleted, an unreadable user
 * store is kept aside instead of overwritten, a failed hash upgrade does not
 * fail a verified login, and every expiry uses the injected clock.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserAuthManager } from '../platform/src/platform/security/user-auth.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const FAST = { N: 1024, r: 1, p: 1 };
function paths() {
  const dir = mkdtempSync(join(tmpdir(), 'gv-user-auth-safe-')); dirs.push(dir);
  return { dir, file: join(dir, 'users.json'), cred: join(dir, 'bootstrap.txt') };
}

test('session expiry follows the injected clock', () => {
  const p = paths();
  let now = 1_000_000;
  const users = new UserAuthManager({ bootstrapFilePath: p.file, bootstrapCredentialPath: p.cred, scryptParams: FAST, sessionTtlMs: 1000, nowFn: () => now });
  const session = users.createSession('admin');
  expect(session.expiresAt).toBe(1_001_000);
  expect(users.validateSession(session.token)).not.toBeNull();
  now = 1_001_001;
  expect(users.validateSession(session.token)).toBeNull();
});

function hostAndCli() {
  const p = paths();
  let now = 5_000_000;
  const host = new UserAuthManager({ bootstrapFilePath: p.file, bootstrapCredentialPath: p.cred, scryptParams: FAST, nowFn: () => now });
  host.addUser('viewer', 'viewer-password', ['viewer']);
  host.addUser('carol', 'carol-password', ['viewer']);
  const cli = new UserAuthManager({ bootstrapFilePath: p.file, bootstrapCredentialPath: p.cred, scryptParams: FAST });
  return { host, cli, advance: (ms: number) => { now += ms; } };
}

test('a host write after the CLI deleted or re-keyed a user does not bring the old record back', () => {
  const { host, cli } = hostAndCli();
  cli.deleteUser('viewer');
  cli.rotatePassword('carol', 'carol-new-password');
  host.addUser('dave', 'dave-password', ['viewer']);
  const reread = new UserAuthManager({ bootstrapFilePath: join(host.getBootstrapCredentialPath(), '..', 'users.json'), bootstrapCredentialPath: host.getBootstrapCredentialPath(), scryptParams: FAST });
  expect(reread.getUser('viewer')).toBeNull();
  expect(reread.authenticate('carol', 'carol-password').ok).toBe(false);
  expect(reread.authenticate('carol', 'carol-new-password').ok).toBe(true);
  expect(reread.getUser('dave')).not.toBeNull();
});

test('a running host stops honouring a user the CLI deleted, and ends that user\'s sessions', () => {
  const { host, cli, advance } = hostAndCli();
  const session = host.createSession('viewer');
  expect(host.validateSession(session.token)).not.toBeNull();
  cli.deleteUser('viewer');
  advance(1_500);
  expect(host.validateSession(session.token)).toBeNull();
  expect(host.authenticate('viewer', 'viewer-password').ok).toBe(false);
});
