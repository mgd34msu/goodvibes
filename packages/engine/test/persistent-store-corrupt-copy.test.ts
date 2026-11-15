import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { PersistentStore } from '../platform/src/platform/state/persistent-store.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const dir = (): string => { const root = mkdtempSync(join(tmpdir(), 'gv-pstore-')); roots.push(root); return root; };

test('an unreadable state file is copied aside before the next write replaces it', async () => {
  const root = dir();
  const path = join(root, 'state.json');
  writeFileSync(path, '{"gifts": [torn');
  const store = new PersistentStore<{ gifts: string[] }>(path);

  const read = await store.loadOrDiscard();
  expect(read.data).toBeNull();
  expect(read.corruption).not.toBeNull();
  await store.persist({ gifts: [] });

  const copies = readdirSync(root).filter((name) => name.startsWith('state.json.corrupt-'));
  expect(copies).toHaveLength(1);
  expect(readFileSync(join(root, copies[0]!), 'utf8')).toBe('{"gifts": [torn');
  expect(read.corruption?.quarantinedTo).toBe(join(root, copies[0]!));
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ gifts: [] });
});

test('reading the same unreadable file again does not make another copy, and the copies are bounded', async () => {
  const root = dir();
  const path = join(root, 'state.json');
  const store = new PersistentStore<Record<string, unknown>>(path);
  writeFileSync(path, 'torn 1');
  await store.loadOrDiscard();
  await store.loadOrDiscard();
  expect(readdirSync(root).filter((name) => name.includes('.corrupt-'))).toHaveLength(1);
  for (let i = 2; i <= 9; i += 1) {
    writeFileSync(path, `torn ${i} ${'x'.repeat(i)}`);
    await store.loadOrDiscard();
  }
  expect(readdirSync(root).filter((name) => name.includes('.corrupt-')).length).toBeLessThanOrEqual(5);
});
