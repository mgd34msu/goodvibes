/** A tool may not change the daemon's verification journals. */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWritablePath } from '../platform/src/platform/utils/path-safety.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'writable-path-')); roots.push(root);
  mkdirSync(join(root, '.goodvibes', 'verification'), { recursive: true });
  return root;
}

test('the verification journal directory and everything in it is refused', () => {
  const root = workspace();
  for (const path of ['.goodvibes/verification/s.jsonl', '.goodvibes/verification', join(root, '.goodvibes', 'verification', 'new.jsonl'), '.goodvibes/./verification/s.jsonl'])
    expect(() => resolveWritablePath(path, root)).toThrow('.goodvibes/verification');
});

test('a directory that contains the journals cannot be deleted or moved either', () => {
  const root = workspace();
  for (const path of ['.goodvibes', join(root, '.goodvibes'), '.goodvibes/.', '.'])
    expect(() => resolveWritablePath(path, root)).toThrow('.goodvibes/verification');
});

test('a link that lands in the journal directory is refused', () => {
  const root = workspace();
  symlinkSync(join(root, '.goodvibes', 'verification'), join(root, 'sneaky'));
  expect(() => resolveWritablePath('sneaky/s.jsonl', root)).toThrow('.goodvibes/verification');
});

test('other paths, including neighbours under .goodvibes, stay writable', () => {
  const root = workspace();
  expect(resolveWritablePath('src/a.ts', root)).toBe(join(root, 'src', 'a.ts'));
  expect(resolveWritablePath('.goodvibes/.backups/a.ts', root)).toBe(join(root, '.goodvibes', '.backups', 'a.ts'));
  expect(resolveWritablePath('.goodvibes/verification-notes.md', root)).toBe(join(root, '.goodvibes', 'verification-notes.md'));
});
