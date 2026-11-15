import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { ArtifactStore } from '../platform/src/platform/artifacts/index.js';
import { createKnowledgeApi } from '../platform/src/platform/knowledge/knowledge-api.js';
import { renderKnowledgeMap } from '../platform/src/platform/knowledge/map.js';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '../platform/src/platform/state/index.js';
import { KnowledgeProjectionService } from '../platform/src/platform/knowledge/projections.js';
import { prepareKnowledgeScopeSelection } from '../platform/src/platform/knowledge/scope-selection.js';
import { KnowledgeService } from '../platform/src/platform/knowledge/service.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { trackDisposables } from './_helpers/disposables.ts';
import { useKnowledgeAnswerReadings } from './_helpers/knowledge-answer-readings.js';

useKnowledgeAnswerReadings();
const disposables = trackDisposables();
const roots: string[] = [];
const stores: KnowledgeStore[] = [];
afterEach(async () => {
  await disposables.flush();
  await Promise.all(stores.splice(0).map((store) => store.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createStores() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-knowledge-scoped-read-'));
  roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  stores.push(store);
  return { store, artifactStore: new ArtifactStore({ rootDir: join(root, 'artifacts') }) };
}

describe('knowledge map counts', () => {
  async function seeded() {
    const { store } = createStores();
    const node = await store.upsertNode({ kind: 'topic', slug: 'topic-a', title: 'Topic A', aliases: [], confidence: 90 });
    const source = await store.upsertSource({ connectorId: 'manual', sourceType: 'manual', title: 'Manual', tags: [], status: 'indexed' });
    await store.upsertIssue({ severity: 'warning', code: 'sample', message: 'Sample issue', status: 'open', sourceId: source.id });
    const state = { sources: store.listSources(20), nodes: store.listNodes(20), edges: store.listEdges(), issues: store.listIssues(20) };
    return { store, node, state };
  }

  test('the total counts only the categories the map can render', async () => {
    const { store, state } = await seeded();
    const selection = () => prepareKnowledgeScopeSelection(store);
    const withIssues = renderKnowledgeMap(state, await selection(), { includeSources: true, includeIssues: true });
    const withoutIssues = renderKnowledgeMap(state, await selection(), { includeSources: true, includeIssues: false });
    const withoutSources = renderKnowledgeMap(state, await selection(), { includeSources: false, includeIssues: false });
    expect(withIssues.totalNodeCount).toBe((withoutIssues.totalNodeCount ?? Number.NaN) + 1);
    expect(withoutIssues.totalNodeCount).toBe(withoutIssues.nodeCount);
    expect(withoutSources.totalNodeCount).toBe(withoutSources.nodeCount);
  });

  test('a record-kind filter with no valid kind is ignored instead of emptying the map', async () => {
    const { store, state } = await seeded();
    const typo = renderKnowledgeMap(state, await prepareKnowledgeScopeSelection(store), { includeSources: true, recordKinds: ['sources'] as never });
    const plain = renderKnowledgeMap(state, await prepareKnowledgeScopeSelection(store), { includeSources: true });
    expect(typo.nodeCount).toBe(plain.nodeCount);
    expect(typo.nodeCount).toBeGreaterThan(0);
  });
});

describe('knowledge overview projection', () => {
  test('job runs tagged to another space stay off this space overview', async () => {
    const { store, artifactStore } = createStores();
    await store.upsertJobRun({ jobId: 'job-for-alpha', status: 'completed', mode: 'inline', metadata: { knowledgeSpaceId: 'alpha' } });
    await store.upsertJobRun({ jobId: 'job-for-beta', status: 'completed', mode: 'inline', metadata: { knowledgeSpaceId: 'beta' } });
    await store.upsertJobRun({ jobId: 'job-shared', status: 'completed', mode: 'inline' });
    const service = new KnowledgeProjectionService(store, artifactStore);
    const page = (await service.render({ kind: 'overview', limit: 10, knowledgeSpaceId: 'alpha' })).pages.map((entry) => entry.content).join('\n');
    expect(page).toContain('job-for-alpha');
    expect(page).toContain('job-shared');
    expect(page).not.toContain('job-for-beta');
  });
});

describe('knowledge api extraction lookup', () => {
  test('get reads the one extraction by id instead of listing every extraction', async () => {
    const { store, artifactStore } = createStores();
    const root = roots[roots.length - 1]!;
    const memoryStore = new MemoryStore(join(root, 'memory.sqlite'), {
      embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager: new ConfigManager({ configDir: join(root, 'config') }) }),
      enableVectorIndex: false,
    });
    const service = disposables.add(new KnowledgeService(store, artifactStore, undefined, { memoryRegistry: new MemoryRegistry(memoryStore) }));
    const source = await store.upsertSource({ connectorId: 'manual', sourceType: 'document', title: 'Doc', tags: [], status: 'indexed' });
    const extraction = await store.upsertExtraction({ sourceId: source.id, extractorId: 'text', format: 'text', sections: [], links: [], structure: {} });
    const list = spyOn(service, 'listExtractions');
    const api = createKnowledgeApi(service);
    expect(await api.graph.extractions.get('missing-extraction')).toBeNull();
    expect(list).not.toHaveBeenCalled();
    expect((await api.graph.extractions.get(extraction.id))?.id).toBe(extraction.id);
    expect(list.mock.calls).toHaveLength(1);
    expect(list.mock.calls[0]![0]).toBe(1);
    expect(list.mock.calls[0]![1]).toBe(source.id);
  });

  test('get judges only the extraction\'s own source, not every record in the space', async () => {
    const { store, artifactStore } = createStores();
    const root = roots[roots.length - 1]!;
    const memoryStore = new MemoryStore(join(root, 'memory.sqlite'), {
      embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager: new ConfigManager({ configDir: join(root, 'config') }) }),
      enableVectorIndex: false,
    });
    const service = disposables.add(new KnowledgeService(store, artifactStore, undefined, { memoryRegistry: new MemoryRegistry(memoryStore) }));
    const source = await store.upsertSource({ connectorId: 'manual', sourceType: 'document', title: 'Doc', tags: [], status: 'indexed' });
    await store.upsertSource({ connectorId: 'manual', sourceType: 'document', title: 'Other', tags: [], status: 'indexed' });
    await store.upsertNode({ kind: 'topic', slug: 'topic-a', title: 'Topic A', aliases: [], confidence: 90 });
    const extraction = await store.upsertExtraction({ sourceId: source.id, extractorId: 'text', format: 'text', sections: [], links: [], structure: {} });
    const scan = spyOn(store, 'listExtractions');
    const api = createKnowledgeApi(service);
    expect((await api.graph.extractions.get(extraction.id))?.id).toBe(extraction.id);
    expect((await api.graph.extractions.getBySourceId(source.id))?.id).toBe(extraction.id);
    expect(scan).not.toHaveBeenCalled();
  });
});

describe('knowledge api reads see another process\'s saves', () => {
  test('a list the person asks for adopts a record another store saved; the service read alone does not', async () => {
    const { store: reader, artifactStore } = createStores();
    const root = roots[roots.length - 1]!;
    const memoryStore = new MemoryStore(join(root, 'memory.sqlite'), {
      embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager: new ConfigManager({ configDir: join(root, 'config') }) }),
      enableVectorIndex: false,
    });
    const service = disposables.add(new KnowledgeService(reader, artifactStore, undefined, { memoryRegistry: new MemoryRegistry(memoryStore) }));
    await service.whenReady();
    const writer = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
    stores.push(writer);
    await writer.init();
    await writer.upsertSource({ id: 'from-writer', connectorId: 'manual', sourceType: 'manual', title: 'Saved elsewhere', tags: [], status: 'indexed' });

    expect(await service.listSources(10)).toEqual([]);
    const api = createKnowledgeApi(service);
    expect((await api.sources.list(10)).map((entry) => entry.id)).toEqual(['from-writer']);
    expect((await api.status.get()).sourceCount).toBe(1);
  });

  test('packet, map, item and consolidation reads see a source another store saved', async () => {
    const { store: reader, artifactStore } = createStores();
    const root = roots[roots.length - 1]!;
    const memoryStore = new MemoryStore(join(root, 'memory.sqlite'), {
      embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager: new ConfigManager({ configDir: join(root, 'config') }) }),
      enableVectorIndex: false,
    });
    const service = disposables.add(new KnowledgeService(reader, artifactStore, undefined, { memoryRegistry: new MemoryRegistry(memoryStore) }));
    await service.whenReady();
    const writer = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
    stores.push(writer);
    await writer.init();
    await writer.upsertSource({ id: 'from-writer', connectorId: 'manual', sourceType: 'manual', title: 'Saved elsewhere', tags: [], status: 'indexed' });
    await writer.upsertSchedule({ jobId: 'job-elsewhere', label: 'elsewhere', schedule: { kind: 'every', intervalMs: 60_000 } });

    const api = createKnowledgeApi(service);
    expect(await api.graph.items.getMany(['from-writer'])).toHaveLength(1);
    expect((await api.jobs.schedules.list(10)).map((entry) => entry.jobId)).toContain('job-elsewhere');
  });
});
