/**
 * config-persistence-hardening.test.ts
 *
 * How configuration reaches disk and how a change on disk reaches the process:
 * the daemon-owned migration keeps owner-only permissions and never overwrites
 * a concurrent edit, load-time migration passes only claim a rewrite that
 * happened and keep the reader floor, a failed category patch leaves nothing
 * half written, and the file watcher survives a throwing subscriber.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateDaemonOwnedConfig, describeDaemonConfigMigration } from '../platform/src/platform/config/daemon-config-migration.js';
import { daemonConfigMovedPath } from '../platform/src/platform/config/daemon-config-migration-io.js';
import {
  applyFleetMaxSizeMigrationPass,
  runDaemonTierMigrationPasses,
  OWNS_FILE,
} from '../platform/src/platform/config/manager-migration-passes.js';
import { persistCategoryPatch } from '../platform/src/platform/config/manager-category-io.js';
import { reloadAndNotifyChanges, watchConfigFiles } from '../platform/src/platform/config/config-file-watcher.js';
import { ensureSharedConfig } from '../platform/src/platform/config/manager-bootstrap.js';
import { FeatureAnnouncementStore } from '../platform/src/platform/runtime/feature-announcements.js';
import { UnknownSettingFormsQueue, ingestManagerSettings } from '../platform/src/platform/config/manager-ingestion.js';

const roots: string[] = [];
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-config-hardening-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});
function writeSurface(h: string, surface: string, value: unknown, mode = 0o600): string {
  const dir = join(h, '.goodvibes', surface);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'settings.json');
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
  chmodSync(path, mode);
  return path;
}
const daemonStore = (h: string): string => join(h, '.goodvibes', 'daemon', 'settings.json');
const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
const modeOf = (path: string): number => statSync(path).mode & 0o777;

describe('daemon-owned config migration files', () => {
  test('the store, the stripped surface file and the marker are owner-only whatever the umask', () => {
    const h = home();
    const surface = writeSurface(h, 'tui', { surfaces: { telegram: { botUsername: 'bot' } }, display: { theme: 'nord' } });
    const previous = process.umask(0o022);
    try {
      migrateDaemonOwnedConfig({ homeDir: h });
    } finally {
      process.umask(previous);
    }
    expect(modeOf(daemonStore(h))).toBe(0o600);
    expect(modeOf(surface)).toBe(0o600);
    expect(modeOf(daemonConfigMovedPath(daemonStore(h)))).toBe(0o600);
  });

  test('a leftover fixed-name temp file from another process does not break or get published', () => {
    const h = home();
    writeSurface(h, 'tui', { surfaces: { telegram: { botUsername: 'bot' } } });
    mkdirSync(join(h, '.goodvibes', 'daemon'), { recursive: true });
    writeFileSync(`${daemonStore(h)}.tmp`, '{"half":');
    const result = migrateDaemonOwnedConfig({ homeDir: h });
    expect(result.migrated).toBe(true);
    expect((readJson(daemonStore(h))['surfaces'] as Record<string, unknown>)['telegram']).toEqual({ botUsername: 'bot' });
    expect(readFileSync(`${daemonStore(h)}.tmp`, 'utf-8')).toBe('{"half":');
  });

  test('a setting another process saves between the read and the write is not overwritten', () => {
    const h = home();
    const surface = writeSurface(h, 'tui', { surfaces: { telegram: { botUsername: 'bot' } }, display: { theme: 'nord' } });
    const saved = { surfaces: { telegram: { botUsername: 'bot' } }, display: { theme: 'vaporwave' } };
    let injected = false;
    expect(() => migrateDaemonOwnedConfig({
      homeDir: h,
      // Called after every file was read and before any was written.
      now: () => {
        if (!injected) { injected = true; writeFileSync(surface, `${JSON.stringify(saved)}\n`); }
        return new Date(0);
      },
    })).toThrow('changed while the daemon-owned config migration was running');
    expect(readJson(surface)).toEqual(saved);
    // The marker was left in-progress, so the next start migrates from what is there.
    const retried = migrateDaemonOwnedConfig({ homeDir: h });
    expect(retried.migrated).toBe(true);
    expect(readJson(surface)['display']).toEqual({ theme: 'vaporwave' });
  });

  test('one corrupt surface file is skipped and disclosed while the others migrate', () => {
    const h = home();
    writeSurface(h, 'tui', { surfaces: { telegram: { botUsername: 'bot' } } });
    const corrupt = writeSurface(h, 'other', []);
    const result = migrateDaemonOwnedConfig({ homeDir: h });
    expect(result.migrated).toBe(true);
    expect(readJson(daemonStore(h))['surfaces']).toEqual({ telegram: { botUsername: 'bot' } });
    expect(result.marker.skipped?.map((entry) => entry.path)).toEqual([corrupt]);
    expect(describeDaemonConfigMigration(result.marker)).toContain(corrupt);
    // Skipped values are still stranded, so the next start tries again.
    expect(result.marker.coveredKeys).toEqual([]);
    expect(readJson(corrupt)).toEqual([] as unknown as Record<string, unknown>);
  });

  test('a backup copy of a surface directory is not treated as a surface', () => {
    const h = home();
    writeSurface(h, 'tui', { surfaces: { telegram: { botUsername: 'real' } } });
    const backup = writeSurface(h, 'tui.bak', { surfaces: { telegram: { botUsername: 'old' } } });
    migrateDaemonOwnedConfig({ homeDir: h });
    expect(readJson(backup)).toEqual({ surfaces: { telegram: { botUsername: 'old' } } });
    expect((readJson(daemonStore(h))['surfaces'] as Record<string, unknown>)['telegram']).toEqual({ botUsername: 'real' });
  });
});

describe('load-time migration passes', () => {
  test('a rewrite that failed files no receipt', () => {
    const h = home();
    // The settings path sits under a regular file, so the write cannot succeed.
    const blocker = join(h, 'file');
    writeFileSync(blocker, 'x');
    const receipts: string[] = [];
    const result = applyFleetMaxSizeMigrationPass(
      { orchestration: { maxActiveAgents: 4 } },
      join(blocker, 'settings.json'),
      (id) => { receipts.push(id); },
      OWNS_FILE,
    );
    expect(result['fleet']).toEqual({ maxSize: 4 });
    expect(receipts).toEqual([]);
  });

  test('a later pass keeps the reader floor an earlier one wrote', () => {
    const h = home();
    const path = join(h, 'daemon-settings.json');
    // The loader strips the marker before any pass runs, so the passes get the object without it.
    writeFileSync(path, JSON.stringify({
      $goodvibes: { minReaderVersion: '1.20.0', setBy: 'credential-sweep', at: '2026-01-01T00:00:00.000Z' },
      occasions: { finalStretchDays: 3 },
    }));
    runDaemonTierMigrationPasses({ occasions: { finalStretchDays: 3 } }, path, () => {}, OWNS_FILE);
    const after = readJson(path);
    expect((after['$goodvibes'] as { minReaderVersion: string }).minReaderVersion).toBe('1.20.0');
    expect(after['occasions']).toBeUndefined();
  });

  test('the payments floor survives the pass that runs after it', () => {
    const h = home();
    const path = join(h, 'daemon-settings.json');
    writeFileSync(path, JSON.stringify({ payments: { budget: { perPurchaseCeilingCents: 10000 } }, occasions: { finalStretchDays: 3 } }));
    runDaemonTierMigrationPasses(
      { payments: { budget: { perPurchaseCeilingCents: 10000 } }, occasions: { finalStretchDays: 3 } },
      path,
      () => {},
      OWNS_FILE,
    );
    const after = readJson(path);
    expect((after['$goodvibes'] as { minReaderVersion: string }).minReaderVersion).toBe('2.0.5');
    expect(after['occasions']).toBeUndefined();
  });
});

describe('category patch across the daemon store and the surface file', () => {
  test('a failed surface write puts the daemon keys back', () => {
    const h = home();
    const configPath = join(h, 'settings.json');
    const daemonPath = join(h, 'daemon-settings.json');
    writeFileSync(daemonPath, JSON.stringify({ surfaces: { telegram: { botUsername: 'before' } } }));
    const marked: string[] = [];
    const live: Record<string, unknown> = {};
    expect(() => persistCategoryPatch('surfaces', { telegram: { botUsername: 'after' } }, live, {
      configPath,
      daemonTierPath: daemonPath,
      writeRawGlobal: () => { throw new Error('disk full'); },
      markDaemonKey: (key) => { marked.push(key); },
    })).toThrow('disk full');
    expect(readJson(daemonPath)).toEqual({ surfaces: { telegram: { botUsername: 'before' } } });
  });

  test('a daemon key that did not exist before is removed again', () => {
    const h = home();
    const daemonPath = join(h, 'daemon-settings.json');
    writeFileSync(daemonPath, '{}');
    expect(() => persistCategoryPatch('surfaces', { telegram: { botUsername: 'after' } }, {}, {
      configPath: join(h, 'settings.json'),
      daemonTierPath: daemonPath,
      writeRawGlobal: () => { throw new Error('disk full'); },
      markDaemonKey: () => {},
    })).toThrow('disk full');
    expect(JSON.stringify(readJson(daemonPath))).not.toContain('botUsername');
  });
});

describe('config file watcher', () => {
  test('a throwing change handler does not escape the poll, and the next change is still seen', () => {
    const h = home();
    const path = join(h, 'settings.json');
    writeFileSync(path, '{}');
    let calls = 0;
    const watch = watchConfigFiles([path], () => { calls += 1; throw new Error('subscriber failed'); }, 60_000);
    try {
      writeFileSync(path, '{"a":1}');
      expect(() => watch.poll()).not.toThrow();
      writeFileSync(path, '{"a":1,"bb":22}');
      expect(() => watch.poll()).not.toThrow();
      expect(calls).toBe(2);
    } finally {
      watch.stop();
    }
  });

  test('a write this process acknowledges is not reported back, an outside write is', () => {
    const h = home();
    const path = join(h, 'settings.json');
    writeFileSync(path, '{}');
    let calls = 0;
    const watch = watchConfigFiles([path], () => { calls += 1; }, 60_000);
    try {
      writeFileSync(path, '{"mine":true}');
      watch.acknowledge(path);
      watch.poll();
      expect(calls).toBe(0);
      writeFileSync(path, '{"mine":true,"theirs":true}');
      watch.poll();
      expect(calls).toBe(1);
    } finally {
      watch.stop();
    }
  });

  test('one listener throwing does not stop the others from being told', () => {
    let value = 1;
    const told: string[] = [];
    reloadAndNotifyChanges({
      listenerKeys: ['a', 'b'],
      get: () => value,
      load: () => { value = 2; },
      notify: (key) => {
        told.push(key);
        if (key === 'a') throw new Error('listener failed');
      },
    });
    expect(told).toEqual(['a', 'b']);
  });
});

describe('shared config bootstrap', () => {
  test('a shared file another product filled first is not reset to empty', () => {
    const h = home();
    const path = join(h, 'shared', 'settings.json');
    ensureSharedConfig(path);
    expect(modeOf(path)).toBe(0o600);
    writeFileSync(path, '{"tts":{"voice":"nova"}}');
    ensureSharedConfig(path);
    expect(readFileSync(path, 'utf-8')).toBe('{"tts":{"voice":"nova"}}');
    expect(existsSync(path)).toBe(true);
  });
});

describe('settings ingestion notices', () => {
  test('the same bad key in two files is announced for each', () => {
    const ids: string[] = [];
    const sink = { record() {}, receipt(id: string) { ids.push(id); }, unknown() {} };
    for (const file of ['/global/settings.json', '/project/settings.json']) {
      ingestManagerSettings({ display: { stream: 'nope' } }, file, sink);
    }
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  test('a key that is fixed and then broken again is announced again, while one left bad is not', () => {
    const store = new FeatureAnnouncementStore(join(home(), 'feature-announcements.json'));
    const announced: string[] = [];
    const sink = {
      record() {}, unknown() {},
      receipt(id: string, text: string) { if (store.record(id, text)) announced.push(id); },
      forgetReceipts(selects: (id: string) => boolean) { store.forgetMatching(selects); },
    };
    const file = '/global/settings.json';
    const bad = () => ingestManagerSettings({ display: { stream: 'nope' } }, file, sink);
    bad();
    bad();
    expect(announced).toHaveLength(1);
    ingestManagerSettings({ display: { stream: true } }, file, sink);
    bad();
    expect(announced).toHaveLength(2);
    // The undelivered line for the first break was withdrawn with it; one line for the current break is waiting.
    expect(store.peekPending()).toHaveLength(1);
  });

  test('unknown keys kept before a composition starts are bounded and deduplicated by file', () => {
    const queue = new UnknownSettingFormsQueue();
    const sink = { record() {}, receipt() {}, unknown() {} };
    for (let i = 0; i < 1000; i++) queue.keep('/same/settings.json', [], sink);
    for (let i = 0; i < UnknownSettingFormsQueue.MAX_PENDING * 3; i++) queue.keep(`/file-${i}/settings.json`, [], sink);
    const pending = (queue as unknown as { pending: unknown[] }).pending;
    expect(pending.length).toBe(UnknownSettingFormsQueue.MAX_PENDING);
  });
});
