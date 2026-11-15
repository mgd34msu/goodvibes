/** A removed watcher leaves the runtime store and the watchers read model, so add/remove cycles do not grow it. */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WatcherRegistry } from '../platform/src/platform/watchers/registry.js';
import { createRuntimeStore } from '../platform/src/platform/runtime/store/index.js';
import type { AutomationSourceRecord } from '../platform/src/platform/automation/sources.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const source = {
  id: 'source-1', kind: 'watcher', label: 'Source 1', enabled: true, createdAt: 1, updatedAt: 1, metadata: {},
} as AutomationSourceRecord;

test('removing a watcher drops it from the watchers domain and its totals, and keeps the others', () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-watcher-mirror-'));
  roots.push(root);
  const runtimeStore = createRuntimeStore();
  const registry = new WatcherRegistry({
    storePath: join(root, 'watchers.json'),
    featureFlags: { isEnabled: (id: string): boolean => id === 'watcher-framework' },
  });
  registry.attachRuntime({ runtimeStore });
  try {
    registry.registerWatcher({ id: 'keep', label: 'Keep', source, kind: 'manual', run: async () => {} });
    registry.registerWatcher({ id: 'drop', label: 'Drop', source, kind: 'manual', run: async () => {} });
    registry.startWatcher('keep');
    registry.startWatcher('drop');
    expect(runtimeStore.getState().watchers.watcherIds.sort()).toEqual(['drop', 'keep']);

    expect(registry.removeWatcher('drop')).toBe(true);

    const watchers = runtimeStore.getState().watchers;
    expect(watchers.watchers.has('drop')).toBe(false);
    expect(watchers.watcherIds).toEqual(['keep']);
    expect(watchers.activeWatcherIds).toEqual(['keep']);
    expect(watchers.totalStopped).toBe(0);
    expect(watchers.totalStarted).toBe(1);
  } finally { registry.dispose(); }
});
