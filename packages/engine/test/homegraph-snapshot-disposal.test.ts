import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../platform/src/platform/artifacts/index.js';
import { HomeGraphService } from '../platform/src/platform/knowledge/home-graph/service.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { createAsyncDisposalScope } from '../platform/src/platform/runtime/async-disposal.js';

test('runtime close drains a foreground snapshot before closing its store and prevents late publication', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-homegraph-snapshot-close-'));
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const service = new HomeGraphService(store, new ArtifactStore({ rootDir: join(root, 'artifacts') }));
  const scope = createAsyncDisposalScope('foreground snapshot owner');
  let storeClosed = false;
  scope.registry.add('knowledge store', async () => { await store.close(); storeClosed = true; });
  scope.registry.add('home graph service', () => service.dispose());
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const initialize = store.init.bind(store);
  const admission = spyOn(store, 'init').mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    await initialize();
  });
  const sync = service.syncSnapshot({ installationId: 'closing-house', pageAutomation: { enabled: false },
    devices: [{ id: 'late-device', name: 'Late device' }] });
  const outcome = sync.then(() => 'completed', (error: unknown) => error);
  try {
    await entered.promise;
    const closing = scope.close();
    let disposed = false;
    void closing.then(() => { disposed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(disposed).toBe(false);
    expect(storeClosed).toBe(false);
    release.resolve();
    const failure = await outcome;
    expect(failure).toBeInstanceOf(DOMException);
    if (!(failure instanceof DOMException)) throw new Error('Snapshot cancellation was not delivered to its caller');
    expect(failure.name).toBe('AbortError');
    await closing;
    expect(storeClosed).toBe(true);
    const reopened = new KnowledgeStore({ dbPath: store.storagePath });
    try {
      await reopened.init();
      expect(reopened.listSources()).toEqual([]);
      expect(reopened.listNodes()).toEqual([]);
      expect(reopened.listEdges()).toEqual([]);
    } finally { await reopened.close(); }
    await expect(service.syncSnapshot({ installationId: 'closed-house' })).rejects.toThrow('aborted');
  } finally {
    release.resolve();
    await outcome;
    await scope.close();
    admission.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
