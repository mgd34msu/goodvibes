import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { PersistentStore } from '../platform/src/platform/state/persistent-store.js';
import { MemoryUsageStatsStore } from '../platform/src/platform/state/memory-usage-stats.js';

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

test('usage counters from two processes sharing one file are both kept', () => {
  const root = dir();
  const path = join(root, 'usage.json');
  const daemon = new MemoryUsageStatsStore(path);
  const terminal = new MemoryUsageStatsStore(path);
  daemon.recordInjected(['a'], 1);
  terminal.recordInjected(['b'], 2);
  daemon.recordInjected(['a'], 3);
  expect(new MemoryUsageStatsStore(path).get('a')?.injectedCount).toBe(2);
  expect(new MemoryUsageStatsStore(path).get('b')?.injectedCount).toBe(1);
});

test('a usage file that cannot be written does not throw into the caller', () => {
  const root = dir();
  const blocked = join(root, 'blocked');
  writeFileSync(blocked, 'a file where the directory should be');
  const store = new MemoryUsageStatsStore(join(blocked, 'usage.json'));
  expect(() => store.recordInjected(['a'], 1)).not.toThrow();
});
