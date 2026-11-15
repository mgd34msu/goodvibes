import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertBinaryFresh, newestSourceMtimeMs } from './harness.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function file(path: string, mtimeSeconds: number): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'x');
  utimesSync(path, mtimeSeconds, mtimeSeconds);
  return path;
}

test('a binary older than the newest source is refused, and a newer one is accepted', () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-binary-fresh-')); dirs.push(root);
  const binary = file(join(root, 'dist', 'goodvibes'), 1_000);
  file(join(root, 'src', 'a.ts'), 900);
  file(join(root, 'src', 'nested', 'b.ts'), 2_000);
  const newest = newestSourceMtimeMs([join(root, 'src')]);
  expect(newest).toBe(2_000_000);
  expect(() => assertBinaryFresh(binary, newest)).toThrow('built');
  utimesSync(binary, 3_000, 3_000);
  expect(() => assertBinaryFresh(binary, newest)).not.toThrow();
});

test('test directories and missing roots do not count as source', () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-binary-fresh-')); dirs.push(root);
  file(join(root, 'src', 'a.ts'), 900);
  file(join(root, 'src', 'test', 'newer.test.ts'), 5_000);
  expect(newestSourceMtimeMs([join(root, 'src'), join(root, 'missing')], new Set(['test']))).toBe(900_000);
});
