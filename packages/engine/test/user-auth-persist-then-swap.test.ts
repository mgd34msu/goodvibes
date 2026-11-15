/**
 * Local user changes are written first and made live only after the write
 * succeeds: a failed write leaves the account exactly as it was, in memory
 * and on disk, and the next successful write lifts the settings hold.
 */
import { afterEach, expect, test as baseTest } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserAuthManager } from '../platform/src/platform/security/user-auth.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); } });

const FAST = { N: 1024, r: 1, p: 1 };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gv-user-auth-swap-')); dirs.push(dir);
  const file = join(dir, 'users.json');
  const users = new UserAuthManager({ bootstrapFilePath: file, bootstrapCredentialPath: join(dir, 'bootstrap.txt'), scryptParams: FAST });
  users.addUser('operator', 'operator-password', ['admin']);
  users.addUser('spare', 'spare-password-1', ['admin']);
  // A read-only directory refuses the atomic writer's staging file, so the next write fails.
  const blockWrites = () => chmodSync(dir, 0o500);
  const allowWrites = () => chmodSync(dir, 0o700);
  return { file, users, blockWrites, allowWrites, reopen: () => new UserAuthManager({ bootstrapFilePath: file, bootstrapCredentialPath: join(dir, 'bootstrap.txt'), scryptParams: FAST }) };
}

// Root ignores directory permissions, so a write cannot be made to fail there.
const test = process.getuid?.() === 0 ? baseTest.skip : baseTest;

test('a failed delete keeps the account in memory and on disk, and its sessions', () => {
  const f = fixture();
  const session = f.users.createSession('spare');
  f.blockWrites();
  expect(() => f.users.deleteUser('spare')).toThrow();
  expect(f.users.getUser('spare')).not.toBeNull();
  expect(f.users.validateSession(session.token)).not.toBeNull();
  expect(f.reopen().getUser('spare')).not.toBeNull();
});

test('a failed password rotation keeps the old password working', () => {
  const f = fixture();
  f.blockWrites();
  expect(() => f.users.rotatePassword('spare', 'next-password-2')).toThrow();
  expect(f.users.authenticate('spare', 'spare-password-1').ok).toBe(true);
  expect(f.users.authenticate('spare', 'next-password-2').ok).toBe(false);
});

test('the next successful write lifts the settings hold a failed write placed', () => {
  const f = fixture();
  const session = f.users.createSession('operator');
  f.blockWrites();
  expect(() => f.users.deleteUser('spare')).toThrow();
  expect(f.users.captureSettingsAuthority(session.token)).toBeNull();
  f.allowWrites();
  expect(f.users.deleteUser('spare')).toBe(true);
  expect(f.users.captureSettingsAuthority(session.token)).not.toBeNull();
});
