import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { syncKnowledgeMemoryNodes } from '../platform/src/platform/knowledge/memory-sync.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '../platform/src/platform/state/index.js';

const roots: string[] = [];
const stores: KnowledgeStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function registryOn(root: string): Promise<MemoryRegistry> {
  const store = new MemoryStore(join(root, 'memory.sqlite'), {
    embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager: new ConfigManager({ configDir: join(root, 'config') }) }),
    enableVectorIndex: false,
  });
  await store.init();
  return new MemoryRegistry(store);
}

const memory = (summary: string) => ({ scope: 'project' as const, cls: 'fact' as const, summary, tags: ['topic-one', 'topic-two'], review: { state: 'reviewed' as const, confidence: 95 } });

describe('mirroring memory into knowledge', () => {
  test('a process attached to another writer mirrors that writer\'s memory instead of deleting it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-memory-sync-attached-'));
    roots.push(root);
    const daemon = await registryOn(root);
    const first = await daemon.add(memory('First memory'));
    const attached = await registryOn(root);
    const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
    stores.push(store);
    await syncKnowledgeMemoryNodes(store, attached);
    expect(store.getNode(`memory-${first.id}`)).not.toBeNull();

    // The daemon adds a memory after this process loaded its image and changes the first one.
    const second = await daemon.add(memory('Second memory'));
    daemon.review(first.id, { state: 'contradicted' });
    await daemon.getStore().save();
    await syncKnowledgeMemoryNodes(store, attached);

    expect(store.getNode(`memory-${second.id}`)).not.toBeNull();
    expect(store.getNode(`memory-${first.id}`)).toBeNull();
  });

  test('a sync reads the edge list once however many memories it mirrors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-memory-sync-edges-'));
    roots.push(root);
    const registry = await registryOn(root);
    for (let index = 0; index < 5; index++) await registry.add(memory(`Memory ${index}`));
    const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
    stores.push(store);
    await store.init();
    const edges = spyOn(store, 'listEdges');
    await syncKnowledgeMemoryNodes(store, registry);
    expect(edges.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
