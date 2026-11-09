/** Actual Home Graph source tuple migration/producer/ownership source regressions. UNRUN. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ArtifactStore } from '../sdk/src/platform/artifacts/store.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.js';
import { KNOWLEDGE_SCHEMA_VERSION } from '../sdk/src/platform/knowledge/store-schema-version.js';
import { configureKnowledgeArtifactReferences } from '../sdk/src/platform/knowledge/artifact-reference-ensemble.js';
import { HomeGraphService } from '../sdk/src/platform/knowledge/home-graph/service.js';
import { runHomeGraphSnapshotSync } from '../sdk/src/platform/knowledge/home-graph/sync.js';
import { refreshHomeGraphDevicePassport, generateHomeGraphPacket } from '../sdk/src/platform/knowledge/home-graph/generated-pages.js';
import { createHomeGraphSourceIdentityPlanner } from '../sdk/src/platform/knowledge/home-graph/source-identity-plan.js';
import { homeGraphSourceIdentityIndexes, homeGraphSourceCandidateQuery, type HomeGraphSourceSelector } from '../sdk/src/platform/knowledge/store-homegraph-source-selector.js';
import { HomeGraphIdentityHeldError } from '../sdk/src/platform/knowledge/store-homegraph-node-selector.js';
import { withDecisionModelPolicy } from '../sdk/src/platform/runtime/decision-policy.js';
const roots: string[] = [], stores: KnowledgeStore[] = [], services: HomeGraphService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.dispose())); for (const store of stores.splice(0)) await store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(path?: string) {
  const root = path ? dirname(path) : mkdtempSync(join(tmpdir(), 'homegraph-source-')); if (!path) roots.push(root);
  const dbPath = path ?? join(root, 'knowledge-home-graph.sqlite'), store = new KnowledgeStore({ dbPath }); stores.push(store); await store.init();
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') }); configureKnowledgeArtifactReferences({ artifactStore, controlPlaneDirectory: root, stores: [store] });
  const service = new HomeGraphService(store, artifactStore); services.push(service);
  const sync = (capturedAt?: number) => withDecisionModelPolicy(() => 'Classic - Off', () => runHomeGraphSnapshotSync({ store, artifactStore, snapshot: { installationId: 'house', pageAutomation: { enabled: false }, ...(capturedAt === undefined ? {} : { capturedAt }) } }));
  return { store, dbPath, root, artifactStore, service, sync };
}
const spaceId = 'homeassistant:house', url = 'https://example.invalid/manual';
const selector: HomeGraphSourceSelector = { spaceId, role: 'url', locator: 'uri', value: url };
async function savedUrl(store: KnowledgeStore, id: string, extra: Record<string, unknown> = {}) {
  return store.upsertSource({ id, connectorId: 'homeassistant', sourceType: 'url', sourceUri: url, canonicalUri: `homegraph://saved/${id}`, title: 'Saved manual', status: 'indexed', metadata: { knowledgeSpaceId: spaceId, homeGraph: true, homeGraphSourceKind: 'url', ...extra } });
}

test('old exact source ID and canonical URI survive restart without label regeneration', async () => {
  const f = await fixture(), original = await savedUrl(f.store, 'hg-src-1470179648492cbe3c32885b');
  const pass = createHomeGraphSourceIdentityPlanner(f.store), identity = pass.prepare(selector);
  expect(identity.id).toBe(original.id); expect(identity.canonicalUri).toBe(original.canonicalUri);
  await f.store.close(); const next = await fixture(f.dbPath), before = readFileSync(f.dbPath), ids = spyOn(crypto, 'randomUUID');
  try { expect(createHomeGraphSourceIdentityPlanner(next.store).lookup(selector)?.id).toBe(original.id); expect(ids).not.toHaveBeenCalled(); expect(readFileSync(f.dbPath)).toEqual(before); }
  finally { ids.mockRestore(); }
});

test('two default captures at the same clock create separate events; supplied-time replay keeps its saved ID/URI', async () => {
  const f = await fixture(), now = spyOn(Date, 'now').mockReturnValue(1_791_110_401_109);
  try {
    const first = await f.sync(), second = await f.sync(); expect(first.source.id).not.toBe(second.source.id); expect(first.source.canonicalUri).not.toBe(second.source.canonicalUri);
    const explicit = await f.sync(1_791_110_401_109), replay = await f.sync(1_791_110_401_109);
    expect(replay.source.id).toBe(explicit.source.id); expect(replay.source.canonicalUri).toBe(explicit.source.canonicalUri); expect(explicit.source.id).not.toBe(first.source.id);
  } finally { now.mockRestore(); }
});

test('fresh URI roles and punctuation-rich scope/locator facts remain distinct and allocate once', async () => {
  const f = await fixture(), pass = createHomeGraphSourceIdentityPlanner(f.store);
  const a = pass.prepare(selector), b = pass.prepare({ ...selector, role: 'artifact' }), c = pass.prepare({ ...selector, spaceId: 'Project' }), d = pass.prepare({ ...selector, spaceId: 'project' });
  expect(new Set([a.id,b.id,c.id,d.id]).size).toBe(4); expect(pass.prepare(selector)).toBe(a);
  for (const identity of [a,b,c,d]) { expect(identity.id).toMatch(/^hg-src-[a-p-]+$/); expect(identity.canonicalUri).toBe(`homegraph://source/${identity.id.slice('hg-src-'.length)}`); expect(identity.canonicalUri).not.toContain(url); }
  expect(pass.lookup({ ...selector, value: url + '/unknown' })).toBeUndefined();
});

test('actual integration documentation sources are shared by exact URL while node links remain distinct', async () => {
  const f = await fixture();
  await withDecisionModelPolicy(() => 'Classic - Off', () => runHomeGraphSnapshotSync({ store: f.store, artifactStore: f.artifactStore, snapshot: { installationId: 'house', capturedAt: 1000, integrations: [{ id: 'mqtt' }], pageAutomation: { enabled: false } } }));
  const first = f.store.listSources().find(source => source.metadata.homeGraphSourceKind === 'documentation-candidate')!;
  await withDecisionModelPolicy(() => 'Classic - Off', () => runHomeGraphSnapshotSync({ store: f.store, artifactStore: f.artifactStore, snapshot: { installationId: 'house', capturedAt: 2000, integrations: [{ id: 'mqtt', title: 'Updated integration' }], pageAutomation: { enabled: false } } }));
  expect(f.store.listSources().filter(source => source.metadata.homeGraphSourceKind === 'documentation-candidate')).toHaveLength(1); expect(f.store.getSource(first.id)?.canonicalUri).toBe(first.canonicalUri);
});

test('actual packet regeneration retains one source/URI while title and markdown change', async () => {
  const f = await fixture(), generate = (title: string) => withDecisionModelPolicy(() => 'Default - On', () => generateHomeGraphPacket({ store: f.store, artifactStore: f.artifactStore, spaceId, installationId: 'house', input: { title, packetKind: 'network:maintenance', sharingProfile: 'network-admin' } }));
  const first = await generate('First packet'), next = await generate('Updated packet');
  expect(next.source?.id).toBe(first.source?.id); expect(next.source?.canonicalUri).toBe(first.source?.canonicalUri); expect(next.source?.title).toBe('Updated packet');
});

test('actual known physical/native page aliases preserve an earlier saved source key, and ambiguous aliases hold', async () => {
  const f = await fixture();
  await f.store.upsertSource({ id: 'older-passport-source', connectorId: 'homeassistant', sourceType: 'document', canonicalUri: 'homegraph://saved/passport', status: 'indexed', metadata: { knowledgeSpaceId: spaceId, homeGraphSourceKind: 'generated-page', projectionKind: 'device-passport', deviceId: 'native-device-row' } });
  const input: HomeGraphSourceSelector = { spaceId, role: 'generated-page', projectionKind: 'device-passport', keys: ['physical-device','native-device-row'] }, identity = createHomeGraphSourceIdentityPlanner(f.store).prepare(input);
  expect(identity.id).toBe('older-passport-source'); expect(identity.metadata.deviceId).toBe('native-device-row');
  await f.store.upsertSource({ id: 'other-passport-source', connectorId: 'homeassistant', sourceType: 'document', canonicalUri: 'homegraph://saved/other-passport', status: 'indexed', metadata: { knowledgeSpaceId: spaceId, homeGraphSourceKind: 'generated-page', projectionKind: 'device-passport', deviceId: 'physical-device' } });
  expect(() => identity.assertCurrent()).toThrow(HomeGraphIdentityHeldError); expect(() => createHomeGraphSourceIdentityPlanner(f.store).lookup(input)).toThrow(HomeGraphIdentityHeldError);
});

test('ambiguous known URI holds before artifact creation or any new source write', async () => {
  const f = await fixture(); await savedUrl(f.store, 'old-a'); await savedUrl(f.store, 'old-b'); const before = readFileSync(f.dbPath), create = spyOn(f.artifactStore, 'createForPublication');
  try { await expect(withDecisionModelPolicy(() => 'Classic - Off', () => f.service.ingestUrl({ installationId: 'house', url }))).rejects.toBeInstanceOf(HomeGraphIdentityHeldError); expect(create).not.toHaveBeenCalled(); expect(readFileSync(f.dbPath)).toEqual(before); }
  finally { create.mockRestore(); }
});

test('failed source publication preserves an unpublished family then cleans only its own original after a genuine clean write', async () => {
  const f = await fixture(), createNative = f.artifactStore.createForPublication.bind(f.artifactStore); let created = '';
  const create = spyOn(f.artifactStore, 'createForPublication').mockImplementation(async () => { const publication = await createNative({ kind: 'document', mimeType: 'text/plain', filename: 'manual.txt', text: 'A reference manual.' }); created = publication.artifact.id; return publication; });
  const write = spyOn(f.store, 'applyPreparedIngest').mockRejectedValue(new Error('Original publication failure'));
  try { await expect(withDecisionModelPolicy(() => 'Classic - Off', () => f.service.ingestUrl({ installationId: 'house', url }))).rejects.toThrow('Original publication failure'); expect(created).not.toBe(''); expect(f.artifactStore.get(created)).not.toBeNull(); expect(f.store.listSources()).toHaveLength(0);
    const original = f.artifactStore.captureOriginal(created);
    expect(await f.store.cleanupUnreferencedArtifact(original)).toBe('held'); expect(f.artifactStore.get(created)).not.toBeNull();
    await f.store.upsertSource({ id: 'unrelated-clean-publication', connectorId: 'manual', sourceType: 'manual', status: 'indexed' });
    // The acknowledged publication makes the reference image available. Either
    // the owned clean-write retry or this maintenance call deletes that original.
    const deadline = Date.now() + 5_000;
    while (f.artifactStore.get(created) && Date.now() < deadline) {
      await f.store.cleanupUnreferencedArtifact(original);
      if (f.artifactStore.get(created)) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(f.artifactStore.get(created)).toBeNull(); expect(f.store.getSource('unrelated-clean-publication')).not.toBeNull(); }
  finally { create.mockRestore(); write.mockRestore(); }
});

test('failure with an existing caller artifact preserves it and its unrelated saved references', async () => {
  const f = await fixture(), artifact = await f.artifactStore.create({ kind: 'document', mimeType: 'text/plain', filename: 'owned.txt', text: 'Keep this original.' });
  const write = spyOn(f.store, 'applyPreparedIngest').mockRejectedValue(new Error('Source held'));
  try { await expect(withDecisionModelPolicy(() => 'Classic - Off', () => f.service.ingestArtifact({ installationId: 'house', artifactId: artifact.id }))).rejects.toThrow('Source held'); expect(f.artifactStore.get(artifact.id)).toEqual(artifact); }
  finally { write.mockRestore(); }
});

test('acknowledged URI refresh cleans its superseded Home Graph artifact without changing saved identity', async () => {
  const f = await fixture(), createNative = f.artifactStore.createForPublication.bind(f.artifactStore);
  const create = spyOn(f.artifactStore, 'createForPublication').mockImplementation(async input => createNative({ kind: 'document', mimeType: 'text/plain', filename: 'manual.txt', text: 'An updated reference manual.', metadata: input.metadata }));
  try {
    const ingest = () => withDecisionModelPolicy(() => 'Classic - Off', () => f.service.ingestUrl({ installationId: 'house', url }));
    const first = await ingest(), next = await ingest(); expect(next.source.id).toBe(first.source.id); expect(next.source.canonicalUri).toBe(first.source.canonicalUri);
    expect(next.artifactId).not.toBe(first.artifactId); expect(f.artifactStore.get(first.artifactId!)).toBeNull(); expect(f.artifactStore.get(next.artifactId!)).toBeDefined();
  } finally { create.mockRestore(); }
});

test('refresh preserves superseded external library artifacts even when only the old source referenced them', async () => {
  const f = await fixture(), external = await f.artifactStore.create({ kind: 'document', mimeType: 'text/plain', filename: 'user-library.txt', text: 'User-owned library artifact.' });
  await f.store.upsertSource({ id: 'saved-user-artifact-source', connectorId: 'homeassistant', sourceType: 'url', sourceUri: url, canonicalUri: 'homegraph://saved/external', artifactId: external.id, status: 'indexed', metadata: { knowledgeSpaceId: spaceId, homeGraphSourceKind: 'url' } });
  const createNative = f.artifactStore.createForPublication.bind(f.artifactStore), create = spyOn(f.artifactStore, 'createForPublication').mockImplementation(async input => createNative({ kind: 'document', mimeType: 'text/plain', filename: 'new.txt', text: 'Updated source.', metadata: input.metadata }));
  try { await withDecisionModelPolicy(() => 'Classic - Off', () => f.service.ingestUrl({ installationId: 'house', url })); expect(f.artifactStore.get(external.id)).toEqual(external); }
  finally { create.mockRestore(); }
});

test('native final source writer rejects v1 competing ID and changed URI binding without adopting either', async () => {
  const f = await fixture(), identity = createHomeGraphSourceIdentityPlanner(f.store).prepare(selector);
  const source = await f.store.upsertSource({ id: identity.id, connectorId: 'homeassistant', sourceType: 'url', sourceUri: url, canonicalUri: identity.canonicalUri, status: 'indexed', metadata: { knowledgeSpaceId: spaceId, homeGraphSourceKind: 'url', ...identity.metadata } });
  await expect(f.store.upsertSource({ ...source, id: 'competing-id', canonicalUri: 'homegraph://competing' })).rejects.toBeInstanceOf(HomeGraphIdentityHeldError);
  await expect(f.store.upsertSource({ ...source, sourceUri: url + '/other' })).rejects.toBeInstanceOf(HomeGraphIdentityHeldError); expect(f.store.getSource(source.id)).toBe(source);
});

test('unknown saved node/source lifecycle states remain untouched by snapshot retirement and targeted refresh holds before effects', async () => {
  const f = await fixture();
  await withDecisionModelPolicy(() => 'Classic - Off', () => runHomeGraphSnapshotSync({ store: f.store, artifactStore: f.artifactStore, snapshot: { installationId: 'house', capturedAt: 1000, devices: [{ id: 'future-device' }], pageAutomation: { enabled: false } } }));
  const node = f.store.listNodes().find(node => node.kind === 'ha_device')!, sourceId = node.sourceId!; await f.store.close();
  const edit = new Database(f.dbPath); try { edit.run("UPDATE knowledge_nodes SET status='future-node-state' WHERE id=?", [node.id]); edit.run("UPDATE knowledge_sources SET status='future-source-state' WHERE id=?", [sourceId]); } finally { edit.close(); }
  const next = await fixture(f.dbPath);
  await withDecisionModelPolicy(() => 'Classic - Off', () => runHomeGraphSnapshotSync({ store: next.store, artifactStore: next.artifactStore, snapshot: { installationId: 'house', capturedAt: 2000, devices: [], pageAutomation: { enabled: false } } }));
  expect(next.store.getNode(node.id)?.status as string).toBe('future-node-state'); expect(next.store.getSource(sourceId)?.status as string).toBe('future-source-state');
  const before = readFileSync(f.dbPath);
  await expect(withDecisionModelPolicy(() => 'Classic - Off', () => runHomeGraphSnapshotSync({ store: next.store, artifactStore: next.artifactStore, snapshot: { installationId: 'house', capturedAt: 3000, devices: [{ id: 'future-device' }], pageAutomation: { enabled: false } } }))).rejects.toBeInstanceOf(HomeGraphIdentityHeldError); expect(readFileSync(f.dbPath)).toEqual(before);
});

test('actual16 image adds only source indexes without changing saved identities, URI or native row generation', async () => {
  const f = await fixture(), original = await savedUrl(f.store, 'saved-before17'), generation = f.store.getSourceGeneration(original.id); await f.store.close();
  const old = new Database(f.dbPath); try { for (const index of homeGraphSourceIdentityIndexes) old.run(`DROP INDEX ${index.name}`); old.run('PRAGMA user_version=16'); } finally { old.close(); }
  const before = readFileSync(f.dbPath); let declared = false; const blocked = new KnowledgeStore({ dbPath: f.dbPath, nativeDataWriter: { declare(format) { if (format === 'knowledge-schema-v17') { declared = true; throw Error('Reader cohort held'); } } } }); stores.push(blocked);
  await expect(blocked.init()).rejects.toThrow('Reader cohort held'); expect(declared).toBe(true); expect(readFileSync(f.dbPath)).toEqual(before); await blocked.close();
  const next = await fixture(f.dbPath); expect(next.store.getSource(original.id)).toEqual(original); expect(next.store.getSourceGeneration(original.id)).toBe(generation);
  const sqlite = (next.store as unknown as { sqlite: SQLiteStore }).sqlite, query = homeGraphSourceCandidateQuery(selector);
  expect(sqlite.exec('EXPLAIN QUERY PLAN ' + query.sql, query.params)[0]?.values.map(row => String(row[3])).join(' ')).toContain('idx_knowledge_sources_homegraph_uri'); expect(sqlite.exec('PRAGMA user_version')[0]?.values[0]?.[0]).toBe(KNOWLEDGE_SCHEMA_VERSION);
});

test('all closed selector shapes use actual indexes and the v1 unique index prevents direct duplicate native rows', async () => {
  const f = await fixture(), sqlite = (f.store as unknown as { sqlite: SQLiteStore }).sqlite;
  for (const [input, index] of [
    [selector, 'idx_knowledge_sources_homegraph_uri'],
    [{ spaceId, role: 'artifact', locator: 'artifact', value: 'artifact-native' }, 'idx_knowledge_sources_artifact_reference'],
    [{ spaceId, role: 'snapshot', capturedAt: 1000 }, 'idx_knowledge_sources_homegraph_capture'],
    [{ spaceId, role: 'generated-page', projectionKind: 'device-passport', keys: ['device'] }, 'idx_knowledge_sources_homegraph_page'],
  ] as const) {
    const query = homeGraphSourceCandidateQuery(input); expect(sqlite.exec('EXPLAIN QUERY PLAN ' + query.sql, query.params)[0]?.values.map(row => String(row[3])).join(' ')).toContain(index);
  }
  const identity = createHomeGraphSourceIdentityPlanner(f.store).prepare(selector), metadata = JSON.stringify({ knowledgeSpaceId: spaceId, homeGraphSourceKind: 'url', ...identity.metadata });
  const sql = 'INSERT INTO knowledge_sources(id,connector_id,source_type,source_uri,status,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)';
  sqlite.run(sql, ['native-direct-one','homeassistant','url',url,'indexed',metadata,1,1]); expect(() => sqlite.run(sql, ['native-direct-two','homeassistant','url',url,'indexed',metadata,1,1])).toThrow();
});

test('copied stores or substituted source selectors cannot provide invented source identity facts', async () => {
  const f = await fixture(); expect(() => createHomeGraphSourceIdentityPlanner(Object.create(f.store)).lookup(selector)).toThrow(HomeGraphIdentityHeldError);
  const sqlite = (f.store as unknown as { sqlite: SQLiteStore }).sqlite; sqlite.readHomeGraphSourceCandidates = () => [];
  try { expect(() => createHomeGraphSourceIdentityPlanner(f.store).lookup(selector)).toThrow(HomeGraphIdentityHeldError); }
  finally { delete (sqlite as unknown as { readHomeGraphSourceCandidates?: unknown }).readHomeGraphSourceCandidates; }
});

test('unknown saved source identity and future schema are retained, not rewritten or reallocated', async () => {
  const f = await fixture(); await savedUrl(f.store, 'future-source'); await f.store.close();
  const edit = new Database(f.dbPath); try { edit.run("UPDATE knowledge_sources SET metadata=json_set(metadata,'$.homeGraphSourceIdentityVersion',2) WHERE id='future-source'"); } finally { edit.close(); }
  const next = await fixture(f.dbPath), before = readFileSync(f.dbPath); expect(() => createHomeGraphSourceIdentityPlanner(next.store).lookup(selector)).toThrow(HomeGraphIdentityHeldError); expect(readFileSync(f.dbPath)).toEqual(before); await next.store.close();
  const future = new Database(f.dbPath); try { future.run(`PRAGMA user_version=${KNOWLEDGE_SCHEMA_VERSION + 1}`); } finally { future.close(); }
  const bytes = readFileSync(f.dbPath), unsupported = new KnowledgeStore({ dbPath: f.dbPath }); stores.push(unsupported); await expect(unsupported.init()).rejects.toThrow(); expect(readFileSync(f.dbPath)).toEqual(bytes);
});

for (const returned of ['promise','value'] as const) test(`actual passport ${returned} owner cannot enter page or artifact work`, async () => {
  const f = await fixture(), create = spyOn(f.artifactStore, 'createForPublication');
  const assertCurrent = (() => returned === 'promise' ? Promise.reject(Error('private owner failure')) : true) as unknown as () => void;
  try { await expect(withDecisionModelPolicy(() => 'Default - On', () => refreshHomeGraphDevicePassport({ store: f.store, artifactStore: f.artifactStore, spaceId, installationId: 'house', input: { deviceId: 'not-yet-imported' }, assertCurrent }))).rejects.toThrow(); expect(create).not.toHaveBeenCalled(); expect(f.store.listSources()).toHaveLength(0); }
  finally { create.mockRestore(); }
});
