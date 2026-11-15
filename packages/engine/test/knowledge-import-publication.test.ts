import { waitFor } from './_helpers/test-timeout.js';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.ts';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import * as nativeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import type { KnowledgeImportInput } from '../platform/src/platform/knowledge/store-import.js';
import type { SQLiteStore } from '../platform/src/platform/state/sqlite-store.js';

const roots: string[] = [], stores: KnowledgeStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sqliteOf = (store: KnowledgeStore) => (store as unknown as { sqlite: SQLiteStore }).sqlite;
const source = (id: string) => ({ id, connectorId: 'fixture', sourceType: 'manual' as const, status: 'indexed' as const });
async function open(dbPath: string) {
  const store = new KnowledgeStore({ dbPath }); stores.push(store); await store.init(); return store;
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-import-publication-')); roots.push(root);
  const store = await open(join(root, 'knowledge.sqlite'));
  await store.upsertSource({ ...source('unrelated'), title: 'Original unrelated source' });
  return store;
}
const input: KnowledgeImportInput = {
  sources: [{ ...source('generated'), title: 'Generated source', artifactId: 'generated-artifact' }],
  extractions: [{ id: 'generated-extraction', sourceId: 'generated', artifactId: 'generated-artifact', extractorId: 'fixture', format: 'text', excerpt: 'Generated excerpt.' }],
  nodes: [{ id: 'generated-node', kind: 'topic', slug: 'generated-node', title: 'Generated node', status: 'draft', sourceId: 'generated' }],
  edges: [{ fromKind: 'source', fromId: 'generated', toKind: 'node', toId: 'generated-node', relation: 'source_for' }],
  issues: [{ id: 'generated-issue', severity: 'info', code: 'fixture', message: 'Generated issue', nodeId: 'generated-node' }],
};
const graph = async () => ({ nodes: input.nodes, edges: input.edges, issues: input.issues });
function cacheState(store: KnowledgeStore) {
  return { sources: store.listSources(), extractions: store.listExtractions(), nodes: store.listNodes(),
    edges: store.listEdges(), issues: store.listIssues(), revisions: store.listNodeRevisions('generated-node') };
}
function localGeneratedRows(store: KnowledgeStore) {
  const sqlite = sqliteOf(store);
  return ['knowledge_sources', 'knowledge_extractions', 'knowledge_nodes', 'knowledge_edges', 'knowledge_issues', 'knowledge_node_revisions']
    .map(table => sqlite.exec(`SELECT COUNT(*) FROM ${table} WHERE ${table === 'knowledge_edges' ? 'from_id' : table === 'knowledge_node_revisions' ? 'node_id' : 'id'} LIKE 'generated%'`)[0]?.values[0]?.[0]);
}

test('unrelated external winner survives failed import with no published cache, SQL, artifact reference or callback', async () => {
  const store = await fixture(), writer = await open(store.storagePath), before = cacheState(store);
  let committed = 0, winningBytes = readFileSync(store.storagePath);
  await expect(store.applyPreparedIngest(input, async () => {
    await writer.replaceSourceRecord({ ...writer.getSource('unrelated')!, title: 'External correction' });
    winningBytes = readFileSync(store.storagePath);
    return graph();
  }, {}, () => { committed++; })).rejects.toThrow('persisted state changed');
  expect(committed).toBe(0); expect(cacheState(store)).toEqual(before);
  expect(localGeneratedRows(store)).toEqual([0, 0, 0, 0, 0, 0]);
  expect(readFileSync(store.storagePath)).toEqual(winningBytes);
  expect(store.getSourceSnapshot({ id: 'unrelated' }).source?.title).toBe('External correction');
  expect(store.getSourceSnapshot({ id: 'generated' }).source).toBeNull();
  expect(cacheState(await open(store.storagePath)).sources).toEqual(writer.listSources());
});

test('successful import publishes complete exact records and callback only after real persistence, including a batch prefix', async () => {
  const store = await fixture(); let committed = 0;
  await store.batch(async () => {
    await store.upsertSource(source('batch-prefix'));
    const receipt = await store.applyPreparedIngest(input, graph, {}, () => {
      committed++;
      const rows = sqliteOf(store).readPersistedRow('knowledge_sources', 'id', 'generated')[0];
      expect(rows?.values[0]?.[rows.columns.indexOf('artifact_id')]).toBe('generated-artifact');
      expect(sqliteOf(store).readPersistedRow('knowledge_sources', 'id', 'batch-prefix')[0]?.values).toHaveLength(1);
    });
    const [writtenSource] = receipt.sources, [writtenNode] = receipt.nodes, [writtenEdge] = receipt.edges;
    if (!writtenSource || !writtenNode || !writtenEdge) throw new Error('Complete import receipt must contain the generated source, node and edge.');
    expect(store.getSource('generated')).toBe(writtenSource);
    expect(store.getNode('generated-node')).toBe(writtenNode);
    expect(store.listEdges()[0]).toBe(writtenEdge);
    expect(localGeneratedRows(store)).toEqual([1, 1, 1, 1, 1, 1]);
    await store.upsertSource(source('batch-suffix'));
  });
  expect(committed).toBe(1);
  expect(cacheState(await open(store.storagePath))).toEqual(cacheState(store));
});

test('Classic import publishes native records once and keeps synthesized active claims as unassessed drafts', async () => {
  const store = await fixture(); let asks = 0, metadata = 0, prepared = 0, committed = 0;
  const previous = installJudgmentPort({ get model(): never { metadata++; throw new Error('Classic borrowed model metadata'); },
    get recorder(): never { metadata++; throw new Error('Classic borrowed recorder'); }, async ask() { asks++; throw new Error('Classic must not ask'); } });
  const data: KnowledgeImportInput = { ...input, nodes: [{ ...input.nodes[0]!, status: 'active',
    metadata: { reviewProvenance: { state: 'reviewed' }, nodeActivation: { outcome: 'accepted', probability: 1, decisionId: 'forged-producer-decision' } } }] };
  try {
    await withDecisionModelPolicy(() => 'Classic - Off', async () => {
      const receipt = await store.applyPreparedIngest(data, async () => { prepared++; return { nodes: data.nodes, edges: data.edges, issues: data.issues }; }, {}, () => { committed++; });
      expect(prepared).toBe(1); expect(committed).toBe(1); expect(receipt.nodes).toHaveLength(1);
      const node = store.getNode('generated-node');
      expect(node).toMatchObject({ status: 'draft', metadata: { reviewProvenance: { state: 'pending-review' }, nodeActivation: { operationProvenance: 'classic', semanticAssessment: 'not-evaluated' } } });
      const activation = node?.metadata.nodeActivation as Record<string, unknown>;
      for (const field of ['battery', 'model', 'decisionId', 'probability']) expect(activation[field]).toBeUndefined();
      expect(store.getSource('generated')).not.toBeNull(); expect(store.getExtractionBySourceId('generated')).not.toBeNull();
      expect(localGeneratedRows(store)).toEqual([1, 1, 1, 1, 1, 1]);
      expect((await open(store.storagePath)).getNode('generated-node')).toEqual(node); expect(asks).toBe(0); expect(metadata).toBe(0);
    });
  } finally { installJudgmentPort(previous); }
});

test('Classic import rejects a retired native guard before publishing any staged source or node', async () => {
  const store = await fixture(), before = cacheState(store), bytes = readFileSync(store.storagePath); let retired = false, committed = 0;
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    await expect(store.applyPreparedIngest(input, async () => { retired = true; return graph(); }, { assertCurrent() { if (retired) throw new Error('Native import owner retired'); } }, () => { committed++; })).rejects.toThrow();
    expect(cacheState(store)).toEqual(before); expect(readFileSync(store.storagePath)).toEqual(bytes); expect(committed).toBe(0);
  });
});

/** Completion observers cannot revoke an acknowledged native import. */
import { logger } from '../platform/src/platform/utils/logger.js';

test('throwing postcommit notification retains the real receipt and native rows across reopen', async () => {
  const store = await fixture(), warnings: unknown[] = [], secret = 'SYNTHETIC_PRIVATE_OBSERVER_ERROR';
  const warn = spyOn(logger, 'warn').mockImplementation((...args) => { warnings.push(args); });
  try {
    const receipt = await store.applyPreparedIngest(input, graph, {}, () => { throw new Error(secret); });
    if (!receipt.sources[0]) throw new Error('Acknowledged import receipt omitted its source');
    expect(store.getSource('generated')).toBe(receipt.sources[0]);
    if (!receipt.nodes[0]) throw new Error('Acknowledged import receipt omitted its node');
    expect(store.getNode('generated-node')).toBe(receipt.nodes[0]);
    expect(localGeneratedRows(store)).toEqual([1, 1, 1, 1, 1, 1]);
    const reopened = await open(store.storagePath);
    expect(reopened.getSource('generated')?.artifactId).toBe('generated-artifact');
    expect(reopened.getNode('generated-node')).toEqual(receipt.nodes[0]);
    expect(JSON.stringify(warnings)).toContain('completion notification failed');
    expect(JSON.stringify(warnings)).not.toContain(secret);
  } finally { warn.mockRestore(); }
});

test('returned async observer is drained without delaying or rejecting the committed receipt', async () => {
  const store = await fixture(), release = Promise.withResolvers<void>(), seen: unknown[] = [], warnings: unknown[] = [];
  const unhandled = (reason: unknown) => { seen.push(reason); };
  process.on('unhandledRejection', unhandled);
  const warn = spyOn(logger, 'warn').mockImplementation((...args) => { warnings.push(args); });
  let called = 0, settled = false;
  try {
    const receipt = await store.applyPreparedIngest(input, graph, {}, async () => {
      called++; await release.promise; settled = true; throw new Error('SYNTHETIC_PRIVATE_LATE_NOTIFICATION');
    });
    expect(called).toBe(1); expect(settled).toBe(false);
    if (!receipt.sources[0]) throw new Error('Acknowledged import receipt omitted its source');
    expect(store.getSource('generated')).toBe(receipt.sources[0]);
    expect((await open(store.storagePath)).getSource('generated')?.artifactId).toBe('generated-artifact');
    release.resolve();
    await waitFor(() => warnings.length > 0);
    expect(settled).toBe(true); expect(seen).toEqual([]);
    expect(JSON.stringify(warnings)).toContain('asynchronous completion notification');
    expect(JSON.stringify(warnings)).not.toContain('SYNTHETIC_PRIVATE_LATE_NOTIFICATION');
  } finally { release.resolve(); warn.mockRestore(); process.off('unhandledRejection', unhandled); }
});

test('ordinary primitive notification returns do not produce a spurious warning', async () => {
  const store = await fixture(), notifications: string[] = [], warnings: unknown[] = [];
  const warn = spyOn(logger, 'warn').mockImplementation((...args) => { warnings.push(args); });
  try {
    const receipt = await store.applyPreparedIngest(input, graph, {}, () => notifications.push('committed'));
    expect(notifications).toEqual(['committed']); if (!receipt.sources[0]) throw new Error('Acknowledged import receipt omitted its source');
    expect(store.getSource('generated')).toBe(receipt.sources[0]);
    expect(JSON.stringify(warnings)).not.toContain('notification');
  } finally { warn.mockRestore(); }
});

test('a write that was admitted before the store closed reports the store as closed, not as uninitialized', async () => {
  const store = await fixture(), init = store.init.bind(store);
  store.init = async () => { await init(); await store.close(); };
  await expect(store.upsertSource(source('late-write'))).rejects.toThrow('KnowledgeStore is closed');
});
