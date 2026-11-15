import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { verifySourceArchive } from '../scripts/source-archive-pin.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function archive(content: string): { path: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gv-pin-'));
  dirs.push(dir);
  const path = join(dir, 'src.tar.gz');
  writeFileSync(path, content);
  return { path, sha: createHash('sha256').update(content).digest('hex') };
}

test('an archive matching its pin passes', () => {
  const { path, sha } = archive('payload');
  expect(() => verifySourceArchive(path, 'x', sha)).not.toThrow();
});

test('a different archive is refused and both digests are named', () => {
  const { path, sha } = archive('payload');
  expect(() => verifySourceArchive(path, 'x', 'a'.repeat(64))).toThrow(sha);
});

test('an unpinned archive is refused with the digest to verify', () => {
  const { path, sha } = archive('payload');
  expect(() => verifySourceArchive(path, 'x', undefined)).toThrow(sha);
  expect(() => verifySourceArchive(path, 'x', '')).toThrow('no sha256 pin');
});
