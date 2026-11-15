/**
 * Local auth: the last administrator cannot be deleted, an unreadable user
 * store is kept aside instead of overwritten, a failed hash upgrade does not
 * fail a verified login, and every expiry uses the injected clock.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

test('deleting the only administrator is refused while other users remain', () => {
  const p = paths();
  const users = new UserAuthManager({ bootstrapFilePath: p.file, bootstrapCredentialPath: p.cred, scryptParams: FAST });
  users.addUser('viewer', 'viewer-password', ['viewer']);
  expect(() => users.deleteUser('admin')).toThrow(/admin role/);
  expect(users.getUser('admin')).not.toBeNull();
  users.addUser('second', 'second-password', ['admin']);
  expect(users.deleteUser('admin')).toBe(true);
});

test('an unreadable user store is kept aside before a new admin is generated', () => {
  const p = paths();
  writeFileSync(p.file, '{');
  const users = new UserAuthManager({ bootstrapFilePath: p.file, bootstrapCredentialPath: p.cred, scryptParams: FAST });
  expect(users.getUser('admin')).not.toBeNull();
  const kept = readdirSync(p.dir).filter(name => name.startsWith('users.json.corrupt-'));
  expect(kept).toHaveLength(1);
  expect(readFileSync(join(p.dir, kept[0]!), 'utf-8')).toBe('{');
});

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

test('restoring a snapshot puts back the accounts, passwords and sessions as they were', () => {
  const p = paths();
  const users = new UserAuthManager({ bootstrapFilePath: p.file, bootstrapCredentialPath: p.cred, scryptParams: FAST });
  users.addUser('alice', 'alice-password', ['admin']);
  const kept = users.createSession('alice');
  const state = users.snapshotState();
  users.rotatePassword('alice', 'alice-changed-password');
  users.addUser('bob', 'bob-password', ['viewer']);
  const added = users.createSession('bob');
  users.restoreState(state);
  expect(users.getUser('bob')).toBeNull();
  expect(users.validateSession(kept.token)).not.toBeNull();
  expect(users.validateSession(added.token)).toBeNull();
  expect(users.authenticate('alice', 'alice-password').ok).toBe(true);
  expect(users.authenticate('alice', 'alice-changed-password').ok).toBe(false);
});

test('restoring a snapshot taken before a failed user-store write clears the write fault', () => {
  const p = paths();
  const users = new UserAuthManager({ bootstrapFilePath: p.file, bootstrapCredentialPath: p.cred, scryptParams: FAST });
  users.addUser('alice', 'alice-password', ['admin']);
  const session = users.createSession('alice');
  expect(users.captureSettingsAuthority(session.token)).not.toBeNull();
  const state = users.snapshotState();
  const stored = readFileSync(p.file, 'utf-8');
  // A directory where the store file belongs makes the next write fail.
  rmSync(p.file);
  mkdirSync(p.file);
  expect(() => users.addUser('bob', 'bob-password', ['viewer'])).toThrow();
  expect(users.captureSettingsAuthority(session.token)).toBeNull();
  rmSync(p.file, { recursive: true });
  writeFileSync(p.file, stored);
  users.restoreState(state);
  expect(users.getUser('bob')).toBeNull();
  expect(users.captureSettingsAuthority(session.token)).not.toBeNull();
});

test('a hash upgrade after login never overwrites a password the CLI rotated while the login was being checked', () => {
  const p = paths();
  const weak = { N: 512, r: 1, p: 1 };
  const cli = new UserAuthManager({ bootstrapFilePath: p.file, bootstrapCredentialPath: p.cred, scryptParams: weak });
  cli.addUser('carol', 'carol-password', ['viewer']);
  let rotateNow = false;
  // The host reads its target cost after it refreshed from disk and before it verifies: a rotation landing there is the window.
  const target = { get N() { if (rotateNow) { rotateNow = false; cli.rotatePassword('carol', 'carol-new-password'); } return 1024; }, r: 1, p: 1 };
  const host = new UserAuthManager({ bootstrapFilePath: p.file, bootstrapCredentialPath: p.cred, scryptParams: target });
  rotateNow = true;
  expect(host.authenticate('carol', 'carol-password').ok).toBe(true);
  const reread = new UserAuthManager({ bootstrapFilePath: p.file, bootstrapCredentialPath: p.cred, scryptParams: weak });
  expect(reread.authenticate('carol', 'carol-password').ok).toBe(false);
  expect(reread.authenticate('carol', 'carol-new-password').ok).toBe(true);
});
