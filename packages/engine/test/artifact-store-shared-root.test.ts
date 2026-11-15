/**
 * Two processes can share one artifact root: a record whose files another
 * process removed is forgotten, and a crash's content spool is reclaimed only
 * once it is clearly abandoned.
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ArtifactStore } from '../platform/src/platform/artifacts/store.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function root(): string {
  const home = mkdtempSync(join(tmpdir(), 'artifact-shared-root-'));
  dirs.push(home);
  return join(home, 'artifacts');
}

test('a record whose files another process removed is dropped instead of listed forever', async () => {
  const dir = root();
  const mine = new ArtifactStore({ rootDir: dir });
  const created = await mine.create({ kind: 'document', mimeType: 'text/plain', filename: 'a.txt', text: 'hello' });
  const other = new ArtifactStore({ rootDir: dir });
  expect(other.delete(created.id)).toBe(true);

  expect(mine.list().map((a) => a.id)).not.toContain(created.id);
  expect(mine.get(created.id)).toBeNull();
});

test('a content spool with no metadata is reclaimed once idle for a day, and left alone while fresh', () => {
  const dir = root();
  new ArtifactStore({ rootDir: dir });
  const stale = join(dir, 'artifact-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.data');
  const fresh = join(dir, 'artifact-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.data');
  writeFileSync(stale, 'partial', { mode: 0o600 });
  writeFileSync(fresh, 'partial', { mode: 0o600 });
  const old = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(stale, old, old);

  new ArtifactStore({ rootDir: dir });
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
  unlinkSync(fresh);
});
