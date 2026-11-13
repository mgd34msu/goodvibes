/**
 * A watcher run that is in flight when the watcher is stopped or removed must
 * not write its outcome back over that decision.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as registryModule from '../platform/src/platform/watchers/registry.js';
import { WatcherRegistry } from '../platform/src/platform/watchers/registry.js';
import type { AutomationSourceRecord } from '../platform/src/platform/automation/sources.js';

const roots: string[] = [];
const registries: WatcherRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const source = {
  id: 'source-1', kind: 'watcher', label: 'Source 1', enabled: true, createdAt: 1, updatedAt: 1, metadata: {},
} as AutomationSourceRecord;

function make(): WatcherRegistry {
  const root = mkdtempSync(join(tmpdir(), 'gv-watcher-stop-'));
  roots.push(root);
  const registry = new WatcherRegistry({
    storePath: join(root, 'watchers.json'),
    featureFlags: { isEnabled: (id: string): boolean => id === 'watcher-framework' },
  });
  registries.push(registry);
  return registry;
}

function gate(): { promise: Promise<void>; open: () => void; reject: (e: Error) => void } {
  let open!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => { open = res; reject = rej; });
  return { promise, open, reject };
}

describe('watcher run racing stop/remove', () => {
  test('stop during a run leaves the watcher stopped when the run succeeds', async () => {
    const registry = make();
    const g = gate();
    registry.registerWatcher({ id: 'w1', label: 'W1', source, kind: 'manual', run: () => g.promise });
    registry.startWatcher('w1');
    const running = registry.runWatcherNow('w1');
    registry.stopWatcher('w1');
    g.open();
    await running;
    expect(registry.getWatcher('w1')?.state).toBe('stopped');
  });

  test('stop during a run leaves the watcher stopped when the run fails', async () => {
    const registry = make();
    const g = gate();
    registry.registerWatcher({ id: 'w1', label: 'W1', source, kind: 'manual', run: () => g.promise });
    registry.startWatcher('w1');
    const running = registry.runWatcherNow('w1');
    registry.stopWatcher('w1');
    g.reject(new Error('boom'));
    await running;
    expect(registry.getWatcher('w1')?.state).toBe('stopped');
  });

  test('remove during a run does not re-insert the watcher', async () => {
    const registry = make();
    const g = gate();
    registry.registerWatcher({ id: 'w1', label: 'W1', source, kind: 'manual', run: () => g.promise });
    registry.startWatcher('w1');
    const running = registry.runWatcherNow('w1');
    registry.removeWatcher('w1');
    g.open();
    await running;
    expect(registry.getWatcher('w1')).toBeNull();
    expect(registry.list().some((w) => w.id === 'w1')).toBe(false);
  });

  test('the declared table names the legal moves', () => {
    const watcherLifecycle = (registryModule as unknown as { watcherLifecycle: { can(a: string, b: string): boolean; check(a: string, b: string): { ok: boolean } } }).watcherLifecycle;
    expect(watcherLifecycle.can('stopped', 'running')).toBe(true);
    expect(watcherLifecycle.check('failed', 'starting').ok).toBe(false);
  });
});
