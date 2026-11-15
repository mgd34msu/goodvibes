import { upsertObservedKnowledgeNode } from './store-node-observation.js';
import type { MemoryRecord, MemoryRegistry } from '../state/index.js';
import { DEFAULT_KNOWLEDGE_SPACE_ID, knowledgeSpaceMetadata } from './spaces.js';
import type { KnowledgeStore } from './store.js';
import { slugify } from './shared.js';
import type { KnowledgeEdgeRecord, KnowledgeNodeRecord } from './types.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

export async function syncKnowledgeMemoryNodes(
  store: KnowledgeStore,
  registry: Pick<MemoryRegistry, 'getAll' | 'getStore'> & Partial<Pick<MemoryRegistry, 'reloadIfChanged'>>,
): Promise<void> {
  await registry.getStore().init();
  await store.init();
  // Another process (the daemon this surface is attached to) may have saved
  // memory since this image loaded. Mirroring a stale image would delete its
  // new records from the shared graph and revert its edits, so a failed
  // reload skips the mirror instead of trusting the old image.
  try { await registry.reloadIfChanged?.(); }
  catch (error) {
    logger.warn('Knowledge memory mirror skipped: the memory store could not be reloaded', { error: summarizeError(error) });
    return;
  }
  const edgesByFrom = new Map<string, KnowledgeEdgeRecord[]>();
  for (const edge of store.listEdges()) {
    if (edge.fromKind !== 'node') continue;
    const bucket = edgesByFrom.get(edge.fromId);
    if (bucket) bucket.push(edge); else edgesByFrom.set(edge.fromId, [edge]);
  }
  // The mirror is a projection of the memory store: it compares first and writes
  // only what differs, and the whole pass is one save (none when nothing changed).
  await store.batch(async () => {
    for (const node of [...store.iterateNodes()]) {
      const memoryId = node.metadata.memoryId;
      if (node.kind !== 'memory' || typeof memoryId !== 'string' || node.id !== `memory-${memoryId}`) continue;
      const current = registry.getStore().get(memoryId);
      if (!current || current.reviewState === 'contradicted') await store.deleteNode(node.id);
    }
    const memoryRecords = registry.getAll().filter((record) => record.reviewState !== 'contradicted');
    for (const record of memoryRecords) {
      await upsertKnowledgeMemoryNode(store, record, () => registry.getStore().get(record.id) ?? undefined, edgesByFrom);
    }
  });
}

function memoryNodeInput(record: MemoryRecord) {
  return {
    id: `memory-${record.id}`,
    kind: 'memory' as const,
    slug: slugify(record.id),
    title: record.summary,
    summary: record.detail ?? record.summary,
    aliases: record.tags,
    status: record.reviewState === 'stale' ? 'stale' as const : 'active' as const,
    confidence: record.confidence,
    metadata: {
      ...knowledgeSpaceMetadata(DEFAULT_KNOWLEDGE_SPACE_ID),
      memoryId: record.id,
      scope: record.scope,
      cls: record.cls,
      reviewState: record.reviewState,
    },
  };
}

/** The mirrored node already says what the memory record says. */
function mirrorCurrent(node: KnowledgeNodeRecord | null, input: ReturnType<typeof memoryNodeInput>): node is KnowledgeNodeRecord {
  if (!node || node.kind !== input.kind || node.slug !== input.slug || node.title !== input.title
    || (node.summary ?? '') !== input.summary || node.status !== input.status || node.confidence !== input.confidence
    || node.aliases.length !== input.aliases.length || node.aliases.some((alias, index) => alias !== input.aliases[index])) return false;
  return Object.entries(input.metadata).every(([key, value]) => JSON.stringify(node.metadata[key]) === JSON.stringify(value));
}

async function upsertKnowledgeMemoryNode(store: KnowledgeStore, record: MemoryRecord, readCurrent: () => MemoryRecord | undefined,
  edgesByFrom: ReadonlyMap<string, readonly KnowledgeEdgeRecord[]>): Promise<void> {
  const input = memoryNodeInput(record);
  const existing = store.getNode(input.id);
  const node = mirrorCurrent(existing, input) ? existing : await upsertObservedKnowledgeNode(store, input, 'memory-mirror', record, readCurrent);

  const wantedTags = new Set(record.tags.map(slugify));
  const wantedSessions = new Set(record.provenance.filter(item => item.kind === 'session').map(item => item.ref));
  for (const edge of edgesByFrom.get(node.id) ?? []) {
    if ((edge.relation === 'memory_tagged_with' && edge.toKind === 'node' && !wantedTags.has(store.getNode(edge.toId)?.slug ?? ''))
      || (edge.relation === 'derived_from_session' && edge.toKind === 'session' && !wantedSessions.has(edge.toId))) {
      await store.deleteEdge(edge.id);
    }
  }

  for (const tag of record.tags) {
    const existingTopic = store.getNodeByKindAndSlug('topic', slugify(tag));
    const topicNode = existingTopic && existingTopic.title === tag ? existingTopic : await upsertObservedKnowledgeNode(store, {
      kind: 'topic',
      slug: slugify(tag),
      title: tag,
      summary: `Topic tag ${tag}.`,
      aliases: [tag],
      metadata: knowledgeSpaceMetadata(DEFAULT_KNOWLEDGE_SPACE_ID, { tag }),
    }, 'catalog-structure', record, readCurrent);
    await store.upsertEdge({
      fromKind: 'node',
      fromId: node.id,
      toKind: 'node',
      toId: topicNode.id,
      relation: 'memory_tagged_with',
    });
  }

  for (const provenance of record.provenance) {
    if (provenance.kind !== 'session') continue;
    await store.upsertEdge({
      fromKind: 'node',
      fromId: node.id,
      toKind: 'session',
      toId: provenance.ref,
      relation: 'derived_from_session',
    });
  }
}
