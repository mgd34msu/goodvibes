import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { type DecisionModelPolicy } from '@goodvibes-jev/engine/errors';
import { ArtifactStore } from '../platform/src/platform/artifacts/index.js';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { KnowledgeService, type KnowledgeServiceConfig } from '../platform/src/platform/knowledge/service.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { KnowledgeSemanticService } from '../platform/src/platform/knowledge/semantic/service.js';
import { waitForRepairSourceText } from '../platform/src/platform/knowledge/semantic/self-improvement-promotion.js';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '../platform/src/platform/state/index.js';
import { trackDisposables } from './_helpers/disposables.ts';

const disposables = trackDisposables();
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const classic = <T>(operation: () => T): T => withDecisionModelPolicy((): DecisionModelPolicy => 'Classic - Off', operation);
const tempRoot = () => { const root = mkdtempSync(join(tmpdir(), 'goodvibes-knowledge-service-guards-')); roots.push(root); return root; };

async function memoryRegistryAt(root: string): Promise<MemoryRegistry> {
  const configManager = new ConfigManager({ configDir: join(root, 'config') });
  const memoryStore = new MemoryStore(join(root, 'memory.sqlite'), {
    embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }), enableVectorIndex: false,
  });
  await memoryStore.init();
  return new MemoryRegistry(memoryStore);
}

async function serviceAt(root: string, options: Partial<Omit<KnowledgeServiceConfig, 'memoryRegistry'>> & { readonly memoryRegistry?: MemoryRegistry } = {}) {
  const memoryRegistry = options.memoryRegistry ?? await memoryRegistryAt(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const service = disposables.add(new KnowledgeService(store, new ArtifactStore({ rootDir: join(root, 'artifacts') }), undefined, { ...options, memoryRegistry }));
  await store.init();
  return { service, store, memoryRegistry };
}

describe('reindex', () => {
  test('recompiles every source it can and lists the ones it could not', async () => {
    const { service, store } = await serviceAt(tempRoot());
    for (const id of ['source-one', 'source-bad', 'source-three']) {
      await store.upsertSource({ id, connectorId: 'fixture', sourceType: 'document', title: id, status: 'indexed', metadata: {} });
      await store.upsertExtraction({ sourceId: id, extractorId: 'fixture', format: 'text', excerpt: `${id} text`, metadata: {} });
    }
    const real = store.getExtractionBySourceId.bind(store);
    const reads: string[] = [];
    let failed = false;
    store.getExtractionBySourceId = (id) => {
      reads.push(id);
      if (id === 'source-bad' && !failed) { failed = true; throw new Error('extraction store unavailable for this source'); }
      return real(id);
    };

    const result = await classic(() => service.reindex());

    expect(result.recompileFailures).toEqual([{ sourceId: 'source-bad', error: expect.stringContaining('extraction store unavailable') }]);
    expect(reads).toContain('source-three');
    expect(result.status.sourceCount).toBe(3);
  });
});

describe('the memory governor gate', () => {
  test('refuses every ingest entry point and a direct reindex at the critical tier', async () => {
    const { service } = await serviceAt(tempRoot(), { admitExpensiveWork: (label) => ({ allowed: false, reason: `refused ${label}` }) });
    const refused = async (call: () => Promise<unknown>, label: string) => {
      await expect(call()).rejects.toThrow(`refused ${label}`);
    };
    await refused(() => service.importBookmarksFromFile({ path: '/nonexistent' }), 'knowledge bookmark import');
    await refused(() => service.importUrlsFromFile({ path: '/nonexistent' }), 'knowledge url import');
    await refused(() => service.ingestBookmarkSeeds([]), 'knowledge bookmark ingestion');
    await refused(() => service.ingestWithConnector('bookmark', {}), 'knowledge connector ingestion');
    await refused(() => service.ingestConnectorInput({ connectorId: 'bookmark' }), 'knowledge connector ingestion');
    await refused(() => service.syncBrowserHistory(), 'knowledge browser history sync');
    await refused(() => classic(() => service.reindex()), 'knowledge reindex');
  });

  test('a reindex job is admitted once, when it is requested, and is not refused again inside', async () => {
    let asked = 0;
    const { service } = await serviceAt(tempRoot(), { admitExpensiveWork: () => ({ allowed: ++asked === 1, reason: 'refused again inside the job' }) });
    const run = await classic(() => service.runJob('knowledge-reindex', { mode: 'inline' }));
    expect(run.status).toBe('completed');
    expect(asked).toBe(1);
  });
});

describe('a refinement run limit', () => {
  test('of zero is refused instead of becoming an unbounded run', async () => {
    const { service } = await serviceAt(tempRoot());
    await expect(service.runRefinement({ limit: 0 })).rejects.toThrow('positive integer');
    await expect(service.runRefinement({ limit: 2.5 })).rejects.toThrow('positive integer');
  });
});

describe('the knowledge copy of memory', () => {
  test('follows a memory when it is added and leaves search when it is deleted, with no ingest in between', async () => {
    const root = tempRoot();
    const { service, store, memoryRegistry } = await serviceAt(root);
    const memory = await memoryRegistry.add({ scope: 'project', cls: 'fact', summary: 'Use sqlite-vec for recall', tags: ['recall'], review: { state: 'reviewed', confidence: 95 } });
    await service['memoryMirror'];
    expect(store.getNode(`memory-${memory.id}`)).not.toBeNull();

    memoryRegistry.delete(memory.id);
    await service['memoryMirror'];
    expect(store.getNode(`memory-${memory.id}`)).toBeNull();
  });

  test('a retracted memory is removed as well', async () => {
    const { service, store, memoryRegistry } = await serviceAt(tempRoot());
    const memory = await memoryRegistry.add({ scope: 'project', cls: 'fact', summary: 'Wrong claim', tags: [], review: { state: 'reviewed', confidence: 95 } });
    await service['memoryMirror'];
    expect(store.getNode(`memory-${memory.id}`)).not.toBeNull();
    memoryRegistry.review(memory.id, { state: 'contradicted' });
    await service['memoryMirror'];
    expect(store.getNode(`memory-${memory.id}`)).toBeNull();
  });
});

describe('waiting on repairs that are already running', () => {
  const semantic = () => new KnowledgeSemanticService(new KnowledgeStore({ dbPath: join(tempRoot(), 'knowledge.sqlite') }));

  test('ends when the repair settles, however long the allowed wait', async () => {
    const service = semantic();
    service['activeGapRepairs'].add('space:gap');
    const wait = service['waitForActiveAnswerGapRepairs']('space', ['gap'], Infinity);
    service['activeGapRepairs'].delete('space:gap');
    service['notifyGapRepairSettled']();
    await expect(wait).resolves.toBe(true);
  });

  test('ends with the caller\'s cancellation', async () => {
    const service = semantic();
    service['activeGapRepairs'].add('space:gap');
    const controller = new AbortController();
    const wait = service['waitForActiveAnswerGapRepairs']('space', ['gap'], Infinity, controller.signal);
    controller.abort();
    await expect(wait).rejects.toMatchObject({ reason: 'aborted' });
  });

  test('a source text wait returns at once for a cancelled or paused run', async () => {
    const store = new KnowledgeStore({ dbPath: join(tempRoot(), 'knowledge.sqlite') });
    await store.init();
    const source = await store.upsertSource({ connectorId: 'fixture', sourceType: 'url', title: 'Pending', status: 'indexed', metadata: {} });
    const farDeadline = Date.now() + 60_000;
    const cancelled = new AbortController(); cancelled.abort();
    await waitForRepairSourceText(store, source.id, farDeadline, { signal: cancelled.signal });
    await waitForRepairSourceText(store, source.id, farDeadline, { shouldStop: () => true });
  });
});
