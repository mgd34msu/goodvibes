/**
 * A captured run's recursive delete removes only what the owner lets that run
 * read: every entry inside the deleted directory passes the owner's read
 * authority, and a reserved directory anywhere inside refuses the delete.
 *
 * Real file-operation code on a real temporary tree; the owner's read rule is
 * a plain function over paths.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeCapturedFileOperations } from '../platform/src/platform/tools/exec/captured-exec-file-ops.ts';
import { CapturedBoundaryRefusal } from '../platform/src/platform/tools/exec/captured-exec-refusal.ts';

let root = '';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'captured-delete-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const denying = (denied: string) => async (path: string): Promise<string> => {
  if (path === join(root, denied)) throw new CapturedBoundaryRefusal('authority', denied, `${denied} is not readable by this run`);
  return path;
};

test('a recursive delete is refused when a file inside is one the owner denies', async () => {
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'sub', 'open.txt'), 'a');
  writeFileSync(join(root, 'sub', 'secret.txt'), 'b');
  let applied = false;
  await expect(executeCapturedFileOperations(root, [{ op: 'delete', source: 'sub', recursive: true }],
    denying(join('sub', 'secret.txt')), () => { applied = true; })).rejects.toThrow('sub/secret.txt');
  expect(applied).toBe(false);
  expect(existsSync(join(root, 'sub', 'secret.txt'))).toBe(true);
});

test('a recursive delete is refused when a reserved directory is nested inside', async () => {
  mkdirSync(join(root, 'vendor', 'x', '.git'), { recursive: true });
  writeFileSync(join(root, 'vendor', 'x', '.git', 'HEAD'), 'ref');
  await expect(executeCapturedFileOperations(root, [{ op: 'delete', source: 'vendor', recursive: true }],
    async (path) => path)).rejects.toBeInstanceOf(CapturedBoundaryRefusal);
  expect(existsSync(join(root, 'vendor', 'x', '.git', 'HEAD'))).toBe(true);
});

test('a recursive delete of admitted files goes through', async () => {
  mkdirSync(join(root, 'build', 'out'), { recursive: true });
  writeFileSync(join(root, 'build', 'out', 'a.js'), 'x');
  const result = await executeCapturedFileOperations(root, [{ op: 'delete', source: 'build', recursive: true }], async (path) => path);
  expect(result.fileOpError).toBeUndefined();
  expect(existsSync(join(root, 'build'))).toBe(false);
});
