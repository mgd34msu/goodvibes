/**
 * A repository cannot choose where the operator's private SQLite stores are
 * written: a link at `.goodvibes`, `.goodvibes/tui` or `operator` is refused,
 * nothing is created through it and its target keeps its mode.
 *
 * Real path code on real temporary directories.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capturePrivateSqliteDirectory } from '../platform/src/platform/state/private-sqlite-path.ts';

let base = '';
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'private-sqlite-')); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

for (const linked of ['.goodvibes', join('.goodvibes', 'tui'), join('.goodvibes', 'tui', 'operator')]) {
  test(`a link at ${linked} is refused and its target is left as it was`, () => {
    const workspace = join(base, 'repo');
    const target = join(base, 'elsewhere');
    mkdirSync(target, { recursive: true });
    chmodSync(target, 0o755);
    mkdirSync(join(workspace, linked, '..'), { recursive: true });
    symlinkSync(target, join(workspace, linked));
    expect(() => capturePrivateSqliteDirectory(workspace, { create: true, assertCurrent() {} })).toThrow('symbolic link');
    expect(statSync(target).mode & 0o777).toBe(0o755);
    expect(existsSync(join(target, 'tui'))).toBe(false);
    expect(existsSync(join(target, 'operator'))).toBe(false);
  });
}

test('a plain workspace gets an owner-only store directory', () => {
  const { directory } = capturePrivateSqliteDirectory(join(base, 'repo'), { create: true, assertCurrent() {} });
  expect(statSync(directory).mode & 0o777).toBe(0o700);
});
