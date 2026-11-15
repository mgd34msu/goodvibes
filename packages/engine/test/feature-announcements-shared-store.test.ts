/**
 * feature-announcements-shared-store.test.ts
 *
 * The announce-once file is shared by the daemon and the terminal products.
 * Pins that its read-modify-write runs under the cross-process file lock, and
 * that a network-mode web surface is announced at an address a browser can open.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FeatureAnnouncementStore,
  collectStartupAnnouncements,
  resolveWebSurfaceUrl,
} from '../platform/src/platform/runtime/feature-announcements.js';
import { syncFileLockPath } from '../platform/src/platform/config/sync-file-lock.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function storePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-announce-shared-'));
  roots.push(root);
  return join(root, 'control-plane', 'feature-announcements.json');
}

/** Replace the store's file read with one that notes whether the lock is held at that moment. */
function observeLockAtRead(store: FeatureAnnouncementStore, path: string): boolean[] {
  const seen: boolean[] = [];
  const internals = store as unknown as { read: () => unknown };
  const original = internals.read.bind(store);
  internals.read = () => {
    seen.push(existsSync(syncFileLockPath(path)));
    return original();
  };
  return seen;
}

describe('FeatureAnnouncementStore across processes', () => {
  test('record reads and writes the file with the lock held, and releases it afterwards', () => {
    const path = storePath();
    const store = new FeatureAnnouncementStore(path);
    const seen = observeLockAtRead(store, path);
    expect(store.record('a', 'line')).toBe(true);
    expect(seen).toEqual([true]);
    expect(existsSync(syncFileLockPath(path))).toBe(false);
  });

  test('drainPending reads the queue with the lock held', () => {
    const path = storePath();
    const store = new FeatureAnnouncementStore(path);
    store.record('a', 'line');
    const seen = observeLockAtRead(store, path);
    expect(store.drainPending()).toHaveLength(1);
    expect(seen).toEqual([true]);
  });
});

function config(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] as never };
}

describe('web surface announcement in network mode', () => {
  const network = {
    'web.enabled': true,
    'web.hostMode': 'network',
    'web.host': '',
    'web.port': 3423,
    'web.publicBaseUrl': '',
  };

  test('announces localhost with a note, never the 0.0.0.0 bind address', () => {
    expect(resolveWebSurfaceUrl(config(network))).toBe('http://localhost:3423');
    const lines = collectStartupAnnouncements({
      configManager: config(network),
      store: new FeatureAnnouncementStore(storePath()),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).not.toContain('0.0.0.0');
    expect(lines[0]!.text).toContain('web.publicBaseUrl');
  });

  test('a configured public URL is announced as is, without the interface note', () => {
    const lines = collectStartupAnnouncements({
      configManager: config({ ...network, 'web.publicBaseUrl': 'https://ops.example' }),
      store: new FeatureAnnouncementStore(storePath()),
    });
    expect(lines[0]!.text).toBe('Web surface ready: https://ops.example');
  });
});
