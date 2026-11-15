/** Two stores on one home (TUI, daemon, agent) keep each other's writes. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContextWindowOverrideStore,
  getContextWindowOverridesPath,
} from '../platform/src/platform/providers/context-window-overrides.js';
import { FavoritesStore } from '../platform/src/platform/providers/favorites.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'shared-home-stores-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('ContextWindowOverrideStore across processes', () => {
  test('a stale store does not overwrite what another store learned, and a third store sees both', () => {
    const path = getContextWindowOverridesPath(dir);
    const daemon = new ContextWindowOverrideStore(path);
    const tui = new ContextWindowOverrideStore(path);
    expect(tui.get('p:b')).toBeNull();
    daemon.recordRejection('p:a', 250_000);
    expect(tui.set('p:b', 100_000)).toBe(true);
    const third = new ContextWindowOverrideStore(path);
    expect(third.getObserved('p:a')).toBe(250_000);
    expect(third.get('p:b')).toBe(100_000);
  });

  test('a store sees knowledge another store wrote after it loaded', () => {
    const path = getContextWindowOverridesPath(dir);
    const tui = new ContextWindowOverrideStore(path);
    expect(tui.getObserved('p:a')).toBeNull();
    new ContextWindowOverrideStore(path).recordRejection('p:a', 123_456);
    expect(tui.getObserved('p:a')).toBe(123_456);
  });

  test('a clear survives and does not resurrect another store\'s entry', () => {
    const path = getContextWindowOverridesPath(dir);
    const a = new ContextWindowOverrideStore(path);
    const b = new ContextWindowOverrideStore(path);
    a.set('p:x', 50_000);
    b.set('p:y', 60_000);
    expect(a.clear('p:x')).toBe(true);
    const third = new ContextWindowOverrideStore(path);
    expect(third.get('p:x')).toBeNull();
    expect(third.get('p:y')).toBe(60_000);
  });
});

describe('FavoritesStore across processes', () => {
  test('recording usage in a stale store keeps a pin another store made', async () => {
    const first = new FavoritesStore({ dir });
    const second = new FavoritesStore({ dir });
    await first.load();
    await second.pinModel('p:pinned');
    await first.recordUsage('p:used');
    const onDisk = await new FavoritesStore({ dir }).load();
    expect(onDisk.pinned.map((entry) => entry.registryKey)).toEqual(['p:pinned']);
    expect(onDisk.history.map((entry) => entry.registryKey)).toEqual(['p:used']);
  });

  test('a save whose rename fails leaves no temporary file behind', async () => {
    const store = new FavoritesStore({ dir });
    await store.pinModel('p:one');
    rmSync(store.getPath());
    mkdirSync(join(store.getPath(), 'blocker'), { recursive: true });
    await expect(store.pinModel('p:two')).rejects.toThrow();
    expect(readdirSync(dir).filter((name) => name.includes('.tmp.'))).toEqual([]);
  });
});
