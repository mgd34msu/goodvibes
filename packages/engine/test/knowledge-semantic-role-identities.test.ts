import { homeGraphSourceIdentityIndexes } from '../sdk/src/platform/knowledge/store-homegraph-source-selector.js';
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import { Database } from 'bun:sqlite';
/** Authored source regressions; runtime qualification is deferred. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { createSemanticNodeIdentityPlanner } from '../sdk/src/platform/knowledge/semantic/node-identity-plan.js';
import { prepareGeneratedKnowledgeNodeIdentity } from '../sdk/src/platform/knowledge/source-structural-references.js';
import { upsertRefinementTaskForGap } from '../sdk/src/platform/knowledge/semantic/self-improvement-tasks.js';
import { prepareSemanticIssueIdentity, prepareSemanticRefinementTaskIdentity } from '../sdk/src/platform/knowledge/semantic/auxiliary-identities.js';
import { semanticNodeCandidateParams, semanticNodeCandidateSql, type SemanticNodeSelector } from '../sdk/src/platform/knowledge/store-semantic-node-selector.js';
import { SemanticIdentityHeldError } from '../sdk/src/platform/knowledge/store-semantic-fact-selector.js';
import type { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.js';
const roots: string[] = [], stores: KnowledgeStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
async function open(dbPath?: string) {
  if (!dbPath) { const root = mkdtempSync(join(tmpdir(), 'semantic-role-')); roots.push(root); dbPath = join(root, 'knowledge.sqlite'); }
  const store = new KnowledgeStore({ dbPath }); stores.push(store); await store.init(); return { store, dbPath };
}
async function save(store: KnowledgeStore, selector: SemanticNodeSelector, title = 'Generated title') {
  const identity = prepareGeneratedKnowledgeNodeIdentity(store, selector);
  const kind = selector.role === 'entity' ? 'knowledge_entity' : selector.role === 'wiki' ? 'wiki_page' : 'knowledge_gap';
  const node = await store.upsertNode({ id: identity.id, kind, slug: identity.id, title: 'title' in selector ? selector.title : title, status: 'draft',
    ...('sourceId' in selector ? { sourceId: selector.sourceId } : {}), metadata: {
      knowledgeSpaceId: selector.spaceId, semanticKind: selector.role === 'wiki' ? 'wiki_page' : selector.role === 'entity' ? 'entity' : 'gap',
      ...(selector.role === 'intrinsic-gap' ? { gapKind: 'intrinsic_features', linkedObjectIds: [selector.subjectId] } : {}), ...identity.metadata,
    } }); identity.retain(node); return node;
}
const entity = { role: 'entity' as const, spaceId: 'house', sourceId: 'source', title: '温度' };
test('entity and source gap roles retain exact title, Unicode, punctuation and case while wiki title can change', async () => {
  const { store } = await open(), pass = createSemanticNodeIdentityPlanner(store);
  const selectors: SemanticNodeSelector[] = [entity, { ...entity, title: '湿度' }, { ...entity, title: 'C++' }, { ...entity, title: 'C#' },
    { ...entity, title: 'USB' }, { ...entity, title: 'usb' }, { ...entity, sourceId: 'Source' }, { ...entity, role: 'gap' },
    { role: 'wiki', spaceId: 'house', sourceId: 'source' }, { role: 'intrinsic-gap', spaceId: 'house', subjectId: 'source' }];
  const ids = selectors.map(selector => pass.prepare(selector).id); expect(new Set(ids).size).toBe(selectors.length);
  const wiki = await save(store, { role: 'wiki', spaceId: 'house', sourceId: 'source' }, 'Old page title');
  expect(createSemanticNodeIdentityPlanner(store).prepare({ role: 'wiki', spaceId: 'house', sourceId: 'source' }).id).toBe(wiki.id);
});
test('actual original exact role is reused across restart, and an old differently titled label is preserved', async () => {
  const { store, dbPath } = await open(); const saved = await save(store, entity);
  await store.upsertNode({ id: 'sem-entity-historical-lossy', kind: 'knowledge_entity', slug: 'old-role', title: 'Other title', sourceId: 'source', status: 'draft',
    metadata: { knowledgeSpaceId: 'house', semanticKind: 'entity' } });
  await store.close(); stores.splice(stores.indexOf(store), 1); const reopened = (await open(dbPath)).store;
  expect(createSemanticNodeIdentityPlanner(reopened).prepare(entity).id).toBe(saved.id);
  expect(createSemanticNodeIdentityPlanner(reopened).prepare({ ...entity, title: 'New title' }).id).not.toBe('sem-entity-historical-lossy');
  expect(reopened.getNode('sem-entity-historical-lossy')?.title).toBe('Other title');
});
test('intrinsic gap identity belongs to exact subject, survives source/title changes, and cannot cross subject case', async () => {
  const { store } = await open(); const saved = await save(store, { role: 'intrinsic-gap', spaceId: 'house', subjectId: 'TV' });
  expect(createSemanticNodeIdentityPlanner(store).prepare({ role: 'intrinsic-gap', spaceId: 'house', subjectId: 'TV' }).id).toBe(saved.id);
  expect(createSemanticNodeIdentityPlanner(store).prepare({ role: 'intrinsic-gap', spaceId: 'house', subjectId: 'tv' }).id).not.toBe(saved.id);
});
test('old ambiguous roles and future formats are held; actual indexed lookup does not scan unrelated roles', async () => {
  const { store } = await open();
  for (const id of ['a', 'b']) await store.upsertNode({ id, kind: 'knowledge_entity', slug: id, title: entity.title, sourceId: entity.sourceId, status: 'draft', metadata: { knowledgeSpaceId: 'house', semanticKind: 'entity' } });
  const before = JSON.stringify(store.listNodes()); expect(() => createSemanticNodeIdentityPlanner(store).prepare(entity)).toThrow(SemanticIdentityHeldError); expect(JSON.stringify(store.listNodes())).toBe(before);
  const sqlite = (store as unknown as { sqlite: SQLiteStore }).sqlite;
  const explain = sqlite.exec(`EXPLAIN QUERY PLAN ${semanticNodeCandidateSql}`, semanticNodeCandidateParams(entity));
  expect(JSON.stringify(explain)).toContain('idx_knowledge_nodes_semantic_role_scope');
  await store.upsertNode({ id: 'future', kind: 'knowledge_entity', slug: 'future', title: 'Future', sourceId: entity.sourceId, status: 'draft', metadata: { knowledgeSpaceId: 'house', semanticKind: 'entity', semanticIdentityVersion: 4 } });
  expect(() => createSemanticNodeIdentityPlanner(store).prepare({ ...entity, title: 'Future' })).toThrow(SemanticIdentityHeldError);
});
test('a distinct matching native publication retires the original absent plan', async () => {
  const { store } = await open(), pass = createSemanticNodeIdentityPlanner(store), original = pass.prepare(entity);
  const winner = await save(store, entity); expect(winner.id).not.toBe(original.id); expect(() => original.assertCurrent()).toThrow(SemanticIdentityHeldError);
});
test('saved issue selection is exact and a competing native publication invalidates an absent issue plan', async () => {
  const { store } = await open(); const selector = { spaceId: 'house', nodeId: 'gap', code: 'knowledge.semantic_gap', namespace: 'knowledge:house:semantic' };
  const first = prepareSemanticIssueIdentity(store, selector);
  await store.upsertIssue({ id: 'historical-issue', severity: 'info', code: selector.code, message: 'Exact gap', nodeId: selector.nodeId,
    metadata: { knowledgeSpaceId: 'house', namespace: selector.namespace } });
  expect(() => first.assertCurrent()).toThrow(SemanticIdentityHeldError);
  expect(prepareSemanticIssueIdentity(store, selector).id).toBe('historical-issue');
  expect(prepareSemanticIssueIdentity(store, { ...selector, namespace: 'different' }).id).not.toBe('historical-issue');
});
test('native refinement selection has no first100 truncation and does not remint a terminal historical task', async () => {
  const { store } = await open();
  await store.upsertRefinementTask({ id: 'historical-task', spaceId: 'house', gapId: 'gap', state: 'closed', priority: 'normal', trigger: 'manual', budget: { maxSearches: 1, maxSources: 1, maxLlmCalls: 1 } });
  for (let index = 0; index < 105; index++) await store.upsertRefinementTask({ id: `unrelated-${index}`, spaceId: 'house', gapId: `other-${index}`, state: 'detected', priority: 'normal', trigger: 'manual', budget: { maxSearches: 1, maxSources: 1, maxLlmCalls: 1 } });
  const identity = prepareSemanticRefinementTaskIdentity(store, 'house', 'gap'); expect(identity.id).toBe('historical-task'); expect(identity.original?.state).toBe('closed');
  expect(prepareSemanticRefinementTaskIdentity(store, 'House', 'gap').id).not.toBe('historical-task');
});

test('actual refinement producer keeps one saved gap task and respects its terminal lifecycle after restart', async () => {
  const { store, dbPath } = await open();
  const gap = await store.upsertNode({ id: 'gap', kind: 'knowledge_gap', slug: 'gap', title: 'What remains unknown?', status: 'draft', metadata: { knowledgeSpaceId: 'house', semanticKind: 'gap' } });
  const context = { gap, sources: [], linkedObjects: [] };
  const task = await upsertRefinementTaskForGap(store, 'house', context, 'manual', 'detected', 'Original gap');
  expect(task.id).toMatch(/^kref-[a-p-]+$/);
  await store.upsertRefinementTask({ ...task, state: 'closed' });
  await store.close(); stores.splice(stores.indexOf(store), 1); const reopened = (await open(dbPath)).store;
  const repeated = await upsertRefinementTaskForGap(reopened, 'house', { ...context, gap: reopened.getNode(gap.id)! }, 'manual', 'queued', 'Retry');
  expect(repeated.id).toBe(task.id); expect(repeated.state).toBe('closed');
  expect(reopened.getSemanticRefinementTaskCandidates('house', gap.id)).toHaveLength(1);
});

test('an actual v14 image adds role and object indexes through the current version and declares the native floor before its first publication', async () => {
  const { store, dbPath } = await open();
  const original = await save(store, entity), generation = store.getRecordSnapshot('node', original.id).generation;
  await store.close(); stores.splice(stores.indexOf(store), 1);
  const older = new Database(dbPath);
  try { for (const index of homeGraphSourceIdentityIndexes) older.run(`DROP INDEX ${index.name}`); older.run('DROP INDEX idx_knowledge_nodes_homegraph_object'); older.run('DROP INDEX idx_knowledge_nodes_homegraph_object_v1'); older.run('DROP INDEX idx_knowledge_nodes_semantic_role_scope'); older.run('PRAGMA user_version=14'); }
  finally { older.close(); }
  const originalBytes = readFileSync(dbPath); let floorSeen = false;
  const denied = new KnowledgeStore({ dbPath, nativeDataWriter: { declare(format) {
    if (format !== 'knowledge-schema-v17') return;
    floorSeen = true; const actual = new Database(dbPath, { readonly: true });
    try {
      expect(actual.query('PRAGMA user_version').get()).toEqual({ user_version: 14 });
      expect(actual.query("SELECT name FROM sqlite_schema WHERE name='idx_knowledge_nodes_semantic_role_scope'").get()).toBeNull();
    } finally { actual.close(); }
    throw new Error('Older native reader retained');
  } } }); stores.push(denied);
  await expect(denied.init()).rejects.toThrow('Older native reader retained');
  expect(floorSeen).toBe(true); expect(readFileSync(dbPath)).toEqual(originalBytes);
  await denied.close(); stores.splice(stores.indexOf(denied), 1);
  const migrated = (await open(dbPath)).store;
  expect(migrated.getNode(original.id)).toEqual(original);
  expect(migrated.getRecordSnapshot('node', original.id).generation).toBe(generation);
  const sqlite = (migrated as unknown as { sqlite: SQLiteStore }).sqlite;
  expect(sqlite.exec('PRAGMA user_version')[0]?.values[0]?.[0]).toBe(17);
  expect(sqlite.exec("SELECT name FROM sqlite_master WHERE name='idx_knowledge_nodes_semantic_role_scope'")[0]?.values).toHaveLength(1);
});

test('future saved auxiliary lifecycle states remain unchanged instead of reopening through a new identity', async () => {
  const { store, dbPath } = await open();
  const selector = { spaceId: 'house', nodeId: 'gap', code: 'knowledge.semantic_gap', namespace: 'knowledge:house:semantic' };
  await store.upsertIssue({ id: 'future-issue', code: selector.code, nodeId: selector.nodeId, severity: 'info', status: 'open', message: 'Future saved issue', metadata: { knowledgeSpaceId: 'house', namespace: selector.namespace } });
  await store.upsertRefinementTask({ id: 'future-task', gapId: 'gap', spaceId: 'house', state: 'detected', priority: 'normal', trigger: 'manual', budget: {} });
  const sqlite = (store as unknown as { sqlite: SQLiteStore }).sqlite;
  sqlite.run('UPDATE knowledge_issues SET status = ? WHERE id = ?', ['awaiting-future-owner', 'future-issue']);
  sqlite.run('UPDATE knowledge_refinement_tasks SET state = ? WHERE id = ?', ['awaiting-future-owner', 'future-task']);
  await sqlite.save(); await store.close(); stores.splice(stores.indexOf(store), 1);
  const reopened = (await open(dbPath)).store;
  expect(() => prepareSemanticIssueIdentity(reopened, selector)).toThrow(SemanticIdentityHeldError);
  expect(() => prepareSemanticRefinementTaskIdentity(reopened, 'house', 'gap')).toThrow(SemanticIdentityHeldError);
  expect(reopened.getIssue('future-issue')?.status as string).toBe('awaiting-future-owner');
  expect(reopened.getRefinementTask('future-task')?.state as string).toBe('awaiting-future-owner');
});

test('fresh role labels refuse an occupied original native row and a distinct pending role collision', async () => {
  const { store } = await open();
  const uuid = '00000000-0000-4000-8000-000000000001' as const, id = `sem-entity-${opaqueUuid(uuid)}`;
  const original = await store.upsertNode({ id, kind: 'topic', slug: 'foreign-original', title: 'Foreign original', status: 'draft' });
  const generate = spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(uuid);
  try {
    expect(() => createSemanticNodeIdentityPlanner(store).prepare(entity)).toThrow(SemanticIdentityHeldError); expect(store.getNode(id)).toBe(original);
    await store.deleteNode(id);
    const pass = createSemanticNodeIdentityPlanner(store); pass.prepare(entity);
    expect(() => pass.prepare({ ...entity, title: 'Different role' })).toThrow(SemanticIdentityHeldError); expect(store.getNode(id)).toBeNull();
  } finally { generate.mockRestore(); }
});

test('a copied role planner cannot issue native generated-node provenance or execute a supplied getter', async () => {
  const { store } = await open(); const pass = createSemanticNodeIdentityPlanner(store); let getters = 0;
  const fake = Object.create(null, { prepare: { get() { getters++; return pass.prepare; } } });
  const originalGet = WeakMap.prototype.get;
  try {
    WeakMap.prototype.get = () => ({ store, prepare: pass.prepare, assertCurrent: pass.assertCurrent });
    expect(() => prepareGeneratedKnowledgeNodeIdentity(store, entity, fake)).toThrow(SemanticIdentityHeldError);
  } finally { WeakMap.prototype.get = originalGet; }
  expect(getters).toBe(0);
});
