import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { KnowledgeService, KnowledgeStore, prepareConfiguredProjectContext } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { createAsyncDisposalScope } from '@goodvibes-jev/engine/platform/platform/runtime/disposal';
import { createKnowledgeServices } from '../../runtime/knowledge-services.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { disposeTestRuntimeServicesAfterAll, getTestRuntimeServices } from '../helpers/runtime-services.ts';

disposeTestRuntimeServicesAfterAll();

test('partial TUI knowledge construction owns every allocated store before returning any handles', async () => {
  const borrowed = await getTestRuntimeServices();
  await borrowed.knowledgeService.whenReady();
  const root = makeProjectTempDir('TUI-partial-knowledge-owner'), home = join(root, 'home'), work = join(root, 'work');
  mkdirSync(home, { recursive: true }); mkdirSync(work, { recursive: true });
  const configManager = new ConfigManager({ homeDir: home, workingDir: work, configDir: join(home, 'config'), surfaceRoot: 'tui' });
  await prepareConfiguredProjectContext(configManager, work, 'knowledge-wiki.sqlite', { activate: true });
  const scope = createAsyncDisposalScope('partial TUI knowledge owner');
  const enteredInit = Promise.withResolvers<void>(), releaseInit = Promise.withResolvers<void>();
  const enteredHomeGraph = Promise.withResolvers<void>(), releaseHomeGraph = Promise.withResolvers<void>();
  const enteredRewind = Promise.withResolvers<void>(), releaseRewind = Promise.withResolvers<void>();
  const originalInit = KnowledgeStore.prototype.init, originalClose = KnowledgeStore.prototype.close;
  const closes: string[] = [];
  const isOwned = (store: KnowledgeStore) => {
    const path = relative(root, store.storagePath);
    return !path.startsWith('..') && !path.startsWith('/');
  };
  const init = spyOn(KnowledgeStore.prototype, 'init').mockImplementation(async function(this: KnowledgeStore) {
    if (isOwned(this)) { enteredInit.resolve(); await releaseInit.promise; }
    await originalInit.call(this);
  });
  const close = spyOn(KnowledgeStore.prototype, 'close').mockImplementation(async function(this: KnowledgeStore) {
    if (isOwned(this)) closes.push(basename(this.storagePath));
    await originalClose.call(this);
  });
  const failure = new Error('Later knowledge constructor step failed');
  const attach = spyOn(KnowledgeService.prototype, 'attachRuntimeBus').mockImplementation(() => { throw failure; });
  let closing: Promise<void> | undefined;
  try {
    expect(() => createKnowledgeServices({ ownership: scope.registry,
      rewindDrain: () => { enteredRewind.resolve(); return releaseRewind.promise; },
      homeGraphDrain: () => { enteredHomeGraph.resolve(); return releaseHomeGraph.promise; },
      configManager, providerRegistry: borrowed.providerRegistry, artifactStore: borrowed.artifactStore,
      memoryRegistry: borrowed.memoryRegistry, runtimeBus: borrowed.runtimeBus,
      workingDirectory: work, homeDirectory: home, isBackgroundPaused: () => false, admitExpensiveWork: () => ({ allowed: true }),
    })).toThrow(failure);
    closing = scope.close();
    await enteredInit.promise;
    expect(closes).toEqual([]);
    releaseInit.resolve(); await enteredHomeGraph.promise;
    expect(closes).toEqual([]);
    releaseHomeGraph.resolve(); await enteredRewind.promise;
    expect(closes).toEqual([]);
    releaseRewind.resolve(); await closing;
    expect(closes).toEqual(['knowledge-home-graph.sqlite', 'knowledge-agent.sqlite', 'knowledge-wiki.sqlite']);
    expect(() => borrowed.processRegistry.query()).not.toThrow();
  } finally {
    releaseInit.resolve(); releaseHomeGraph.resolve(); releaseRewind.resolve();
    await (closing ?? scope.close());
    init.mockRestore(); close.mockRestore(); attach.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
