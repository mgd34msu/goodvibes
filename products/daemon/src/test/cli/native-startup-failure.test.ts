/** Exact first loader failures are kept as fixed codes, not later repro guesses. */
import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeDaemonNativeSqlite } from '../../cli/native-sqlite-runtime.js';
import { nativeStartupFailureCode, nativeStartupFailureLine } from '../../cli/native-startup-failure.js';
import { darwinInstallationFixture } from '../helpers/darwin-installation.js';

test('the original real SQLite guard failure remains attributable after a later clean startup succeeds', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'native-first-failure-'));
  try {
    const f = darwinInstallationFixture(root), library = f.installed[2]!;
    const options = { platform: 'darwin', arch: f.arch, execPath: f.execPath, version: f.version,
      bundled: true, capturedOwner: f.owner, setCustomSQLite: () => true };
    chmodSync(library, 0o600); let original: unknown;
    try { initializeDaemonNativeSqlite(options); } catch (error) { original = error; }
    expect(original).toBeInstanceOf(Error);
    const firstFailure = nativeStartupFailureLine('sqlite', original);
    expect(firstFailure).toBe('[goodvibes-daemon:native-startup-failure] sqlite SQLITE_FILE_MODE');
    chmodSync(library, 0o644);
    expect(initializeDaemonNativeSqlite(options)).toBeDefined();
    expect(firstFailure).toBe('[goodvibes-daemon:native-startup-failure] sqlite SQLITE_FILE_MODE');
    expect(firstFailure).not.toContain(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('first failure diagnostics never render unknown messages, paths, causes or borrowed getters', () => {
  const secret = 'native-startup-private-value-8a1f';
  const error = Object.assign(new Error(secret), { code: 'ENOENT', path: secret, cause: { message: secret } });
  expect(nativeStartupFailureLine('darwin-original', error)).toBe('[goodvibes-daemon:native-startup-failure] darwin-original ENOENT');
  expect(nativeStartupFailureCode(new Error(secret))).toBe('UNKNOWN');
  expect(nativeStartupFailureCode(new SyntaxError(secret))).toBe('METADATA_JSON');
  let getterCalls = 0;
  const borrowed = Object.defineProperties({}, { message: { get() { getterCalls++; return secret; } }, code: { get() { getterCalls++; return secret; } } });
  expect(nativeStartupFailureCode(borrowed)).toBe('UNKNOWN'); expect(getterCalls).toBe(0);
  expect(nativeStartupFailureLine('sqlite', error)).not.toContain(secret);
});
