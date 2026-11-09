import { homeGraphSourceIdentityIndexes } from '../sdk/src/platform/knowledge/store-homegraph-source-selector.js';
/** Source regressions for actual persisted scope/target publication. UNRUN until
 * coding is complete; these drive native stores/services, not formatter mocks. */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../sdk/src/platform/artifacts/index.js';
import { materializeGeneratedKnowledgeProjection } from '../sdk/src/platform/knowledge/generated-projections.js';
import { listGeneratedKnowledgePages } from '../sdk/src/platform/knowledge/generated-pages.js';
import { KnowledgeProjectionService } from '../sdk/src/platform/knowledge/projections.js';
import { prepareKnowledgeScopeSelection } from '../sdk/src/platform/knowledge/scope-selection.js';
import { knowledgeSourceMatchesScope } from '../sdk/src/platform/knowledge/scope-records.js';
import { ALL_SPACES_PROJECTION_NAMESPACE, generatedProjectionIdentity, KnowledgeProjectionIdentityHeldError } from '../sdk/src/platform/knowledge/store-generated-projection-selector.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { retainStoredGeneratedProjectionReferences } from '../sdk/src/platform/knowledge/generated-projection-legacy-references.js';
import { configureKnowledgeArtifactReferences } from '../sdk/src/platform/knowledge/artifact-reference-ensemble.js';
import { useKnowledgeAnswerReadings } from './_helpers/knowledge-answer-readings.js';

useKnowledgeAnswerReadings();
const roots: string[] = [], stores: KnowledgeStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-projection-identity-')); roots.push(root);
  const dbPath = join(root, 'knowledge-wiki.sqlite');
  const open = () => { const store = new KnowledgeStore({ dbPath }); stores.push(store); return store; };
  const store = open(), artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  configureKnowledgeArtifactReferences({ artifactStore, controlPlaneDirectory: root, stores: [store] });
  return { root, dbPath, open, store, artifactStore, projections: new KnowledgeProjectionService(store, artifactStore) };
}

describe('native generated projection scope and saved identity', () => {
  test('the same overview has distinct default, named-space and all-space sources and reuses each actual saved identity after restart', async () => {
    const item = fixture();
    const scopes = [{}, { knowledgeSpaceId: 'project:other' }, { includeAllSpaces: true }] as const;
    const materialized: Awaited<ReturnType<KnowledgeProjectionService['materialize']>>[] = [];
    for (const scope of scopes) materialized.push(await item.projections.materialize({ kind: 'overview', ...scope }));
    expect(new Set(materialized.map(result => result.source?.id)).size).toBe(3);
    expect(new Set(materialized.map(result => result.source?.canonicalUri)).size).toBe(3);
    for (const result of materialized) {
      expect(result.source?.id).toMatch(/^kg-gen-[a-p-]+$/);
      expect(result.source?.metadata.knowledgeSpaceId).toBe(result.artifact.metadata?.knowledgeSpaceId);
    }
    expect(materialized[2]?.source?.metadata.knowledgeSpaceId).toBe(ALL_SPACES_PROJECTION_NAMESPACE);
    const all = materialized[2]?.source; if (!all) throw new Error('Missing aggregate source');
    expect(knowledgeSourceMatchesScope(all)).toBe(false);
    expect(knowledgeSourceMatchesScope(all, { knowledgeSpaceId: ALL_SPACES_PROJECTION_NAMESPACE })).toBe(false);
    expect(knowledgeSourceMatchesScope(all, { includeAllSpaces: true })).toBe(true);
    await item.store.close();
    const reopened = item.open(), projections = new KnowledgeProjectionService(reopened, item.artifactStore);
    for (const [index, scope] of scopes.entries()) {
      const repeated = await projections.materialize({ kind: 'overview', ...scope });
      expect(repeated.source?.id).toBe(materialized[index]?.source?.id);
      expect(repeated.source?.canonicalUri).toBe(materialized[index]?.source?.canonicalUri);
    }
    expect(reopened.listSources().filter(source => source.connectorId === 'knowledge-projection')).toHaveLength(3);
  });

  test('an old unscoped page is preserved/reported and its actual old card-shaped reference is readable after reopen in all spaces', async () => {
    const item = fixture();
    const original = await item.store.upsertSource({ id: 'kg-gen-ed5991843b25af5630805d1e',
      connectorId: 'knowledge-projection', sourceType: 'document', title: 'Saved Project Manual', status: 'indexed',
      canonicalUri: 'knowledge://generated/knowledge-source/1e228da5206988773063',
      sourceUri: 'knowledge://generated/knowledge-source/1e228da5206988773063',
      metadata: { generatedKnowledgePage: true, generatedProjection: true, projectionKind: 'knowledge-source',
        targetKind: 'source', targetId: 'source:owned-projection-target-1283' } });
    const originalRow = item.store.getSourceSnapshot({ id: original.id });
    expect(() => retainStoredGeneratedProjectionReferences(item.store, { ...original }, originalRow)).toThrow();
    const next = await item.projections.materialize({ kind: 'overview' });
    expect(next.preservedUnscopedSourceIds).toEqual([original.id]);
    expect(next.note).toContain('preserved');
    expect(item.store.getSourceSnapshot({ id: original.id })).toEqual(originalRow);
    expect(knowledgeSourceMatchesScope(original)).toBe(false);
    const generatedPages = await listGeneratedKnowledgePages({ artifactStore: item.artifactStore, spaceId: 'default', sources: item.store.listSources(),
      nodes: item.store.listNodes(), edges: item.store.listEdges(), limit: 100, includeMarkdown: false });
    expect(generatedPages.pages.some(page => page.source.id === original.id)).toBe(false);
    await item.store.close();
    const reopened = item.open();
    const all = await prepareKnowledgeScopeSelection(reopened, { includeAllSpaces: true });
    expect(all.sources.some(source => source.id === original.id)).toBe(true);
    const specific = await prepareKnowledgeScopeSelection(reopened);
    expect(specific.sources.some(source => source.id === original.id)).toBe(false);
  });

  test('an all-space derived node view never relocates the original node out of default scope', async () => {
    const item = fixture();
    const node = await item.store.upsertNode({ kind: 'topic', slug: 'canonical', title: 'Canonical topic' });
    const page = await item.projections.materialize({ kind: 'node', id: node.id, includeAllSpaces: true });
    expect(item.store.listEdges().some(edge => edge.fromId === page.source?.id && edge.toId === node.id && edge.relation === 'source_for')).toBe(true);
    const selected = await prepareKnowledgeScopeSelection(item.store);
    expect(selected.nodes.some(record => record.id === node.id)).toBe(true);
    expect(selected.sources.some(record => record.id === page.source?.id)).toBe(false);
  });

  test('a matching future identity is held before artifact creation and its exact original row survives', async () => {
    const item = fixture();
    const first = await item.projections.materialize({ kind: 'overview' });
    if (!first.source) throw new Error('Missing projection source');
    await item.store.replaceSourceRecord({ ...first.source, metadata: { ...first.source.metadata, projectionIdentityVersion: 2 } });
    const saved = item.store.getSourceSnapshot({ id: first.source.id });
    const create = spyOn(item.artifactStore, 'createForPublication');
    try {
      await expect(item.projections.materialize({ kind: 'overview' })).rejects.toBeInstanceOf(KnowledgeProjectionIdentityHeldError);
      expect(create).not.toHaveBeenCalled();
      expect(item.store.getSourceSnapshot({ id: first.source.id })).toEqual(saved);
    } finally { create.mockRestore(); }
  });

  test('two original stores cannot publish duplicate scope tuples; loser preserves winner and a newly opened store adopts it', async () => {
    const item = fixture(), second = item.open();
    // Initialize both original images before either candidate publishes.
    await Promise.all([item.store.init(), second.init()]);
    const other = new KnowledgeProjectionService(second, item.artifactStore);
    const createOriginal = item.artifactStore.createForPublication.bind(item.artifactStore);
    let winner: Awaited<ReturnType<KnowledgeProjectionService['materialize']>> | undefined, entered = false;
    const create = spyOn(item.artifactStore, 'createForPublication').mockImplementation(async (...args) => {
      const artifact = await createOriginal(...args);
      if (!entered) { entered = true; winner = await other.materialize({ kind: 'overview' }); }
      return artifact;
    });
    try { await expect(item.projections.materialize({ kind: 'overview' })).rejects.toBeInstanceOf(KnowledgeProjectionIdentityHeldError); }
    finally { create.mockRestore(); }
    if (!winner?.source) throw new Error('Concurrent writer did not publish');
    expect(second.getGeneratedProjectionSourceSnapshot(generatedProjectionIdentity({}, 'overview', 'overview')).source?.id).toBe(winner.source.id);
    expect(item.artifactStore.get(winner.artifact.id)).not.toBeNull();
    await expect(item.projections.materialize({ kind: 'overview' })).rejects.toThrow('Reload the project or knowledge store');
    const refreshed = item.open();
    expect((await new KnowledgeProjectionService(refreshed, item.artifactStore).materialize({ kind: 'overview' })).source?.id).toBe(winner.source.id);
    expect(refreshed.listSources().filter(source => source.connectorId === 'knowledge-projection')).toHaveLength(1);
  });

  test('an actual schema13 store installs the new index through the current schema without rewriting existing rows', async () => {
    const item = fixture();
    const source = await item.store.upsertSource({ id: 'existing-source', connectorId: 'manual', sourceType: 'document', title: 'Existing source', status: 'indexed' });
    const generation = item.store.getSourceGeneration(source.id);
    await item.store.close();
    const database = new Database(item.dbPath);
    database.run('DROP INDEX idx_knowledge_sources_generated_projection_identity');
    database.run('DROP INDEX idx_knowledge_sources_artifact_reference');
    database.run('DROP INDEX idx_knowledge_extractions_artifact_reference');
    database.run('DROP INDEX idx_knowledge_edges_artifact_target_reference');
    database.run('DROP INDEX idx_knowledge_nodes_semantic_fact_identity');
    database.run('DROP INDEX idx_knowledge_nodes_semantic_role_scope');
    database.run('DROP INDEX idx_knowledge_nodes_homegraph_object');
    database.run('DROP INDEX idx_knowledge_nodes_homegraph_object_v1');
    for (const index of homeGraphSourceIdentityIndexes) database.run(`DROP INDEX ${index.name}`);
    database.run('PRAGMA user_version=13'); database.close();
    const migrated = item.open(); await migrated.init();
    expect(migrated.getSourceGeneration(source.id)).toBe(generation);
    expect(migrated.getSource(source.id)).toEqual(source);
    const page = await new KnowledgeProjectionService(migrated, item.artifactStore).materialize({ kind: 'overview' });
    expect(page.source?.metadata.projectionIdentityVersion).toBe(1);
    await migrated.close();
    const check = new Database(item.dbPath, { readonly: true });
    try {
      expect(check.query('PRAGMA user_version').get()).toEqual({ user_version: 17 });
      expect(check.query("SELECT name FROM sqlite_schema WHERE name='idx_knowledge_sources_generated_projection_identity'").get()).not.toBeNull();
    } finally { check.close(); }
  });
});

for (const returned of ['promise', 'value'] as const) {
  test(`a ${returned} owner result is held synchronously before any generated artifact exists`, async () => {
    const item = fixture(), create = spyOn(item.artifactStore, 'createForPublication');
    const assertCurrent = (() => returned === 'promise' ? Promise.reject(new Error('Owner failed')) : true) as unknown as () => void;
    try {
      await expect(materializeGeneratedKnowledgeProjection({ store: item.store, artifactStore: item.artifactStore,
        sourceId: 'held-page', connectorId: 'generated', title: 'Held', filename: 'held.md', markdown: '# Held',
        canonicalUri: 'knowledge://generated/held', projectionKind: 'test', assertCurrent })).rejects.toThrow();
      expect(create).not.toHaveBeenCalled(); expect(item.store.getSource('held-page')).toBeNull();
    } finally { create.mockRestore(); }
  });
}
