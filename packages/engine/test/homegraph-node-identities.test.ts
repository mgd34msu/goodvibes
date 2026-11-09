import { homeGraphSourceIdentityIndexes } from '../platform/src/platform/knowledge/store-homegraph-source-selector.js';
/** Source regressions for the complete node16 producer/read/migration family. UNRUN. */
import { KNOWLEDGE_SCHEMA_VERSION } from '../platform/src/platform/knowledge/store-schema-version.js';
import { Database } from 'bun:sqlite';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import { ArtifactStore } from '../platform/src/platform/artifacts/store.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { SQLiteStore } from '../platform/src/platform/state/sqlite-store.js';
import { runHomeGraphSnapshotSync } from '../platform/src/platform/knowledge/home-graph/sync.js';
import { linkHomeGraphKnowledge, unlinkHomeGraphKnowledge } from '../platform/src/platform/knowledge/home-graph/link.js';
import { createHomeGraphNodeIdentityPlanner, prepareHomeGraphNodeIdentity } from '../platform/src/platform/knowledge/home-graph/node-identity-plan.js';
import { buildHomeGraphMetadata } from '../platform/src/platform/knowledge/home-graph/helpers.js';
import { homeGraphIdentitySpace, homeGraphNodeCandidateQuery, homeGraphNodeIdentityIndexes, HomeGraphIdentityHeldError } from '../platform/src/platform/knowledge/store-homegraph-node-selector.js';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import type { HomeGraphSnapshotInput } from '../platform/src/platform/knowledge/home-graph/types.js';
import { seedHomeAssistantObservation } from './_helpers/homegraph-observation-fixtures.js';
const roots: string[] = [], stores: KnowledgeStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(path?: string) {
  const root = path ? undefined : mkdtempSync(join(tmpdir(), 'homegraph-node-identity-')); if (root) roots.push(root);
  const dbPath = path ?? join(root!, 'knowledge-home-graph.sqlite'), store = new KnowledgeStore({ dbPath }); stores.push(store); await store.init();
  const artifacts = new ArtifactStore({ rootDir: join(root ?? dirname(dbPath), 'artifacts') });
  const sync = (snapshot: HomeGraphSnapshotInput) => withDecisionModelPolicy(() => 'Classic - Off', () => runHomeGraphSnapshotSync({ store, artifactStore: artifacts, snapshot: { installationId: 'house', pageAutomation: { enabled: false }, ...snapshot } }));
  return { store, dbPath, artifacts, sync };
}
const selector = { spaceId: 'homeassistant:house', kind: 'ha_device' as const, objectId: 'device' };
const metadata = (spaceId: string, objectId: string, current = false) => buildHomeGraphMetadata(spaceId, 'house', {
  homeAssistant: { objectId, objectKind: 'device' }, ...(current ? { homeGraphIdentityVersion: 1, homeGraphIdentitySpace: homeGraphIdentitySpace(spaceId) } : {}),
});

test('old native IDs, slugs, edges and object references survive changed display text and restart', async () => {
  const f = await fixture();
  // Actual earlier producer-format label: no old derivation in live code.
  const oldId = 'hg-node-853f4e5415f8242d3b034aa6';
  const original = await seedHomeAssistantObservation(f.store, { id: oldId, kind: 'ha_device', slug: 'original-readable-url', title: 'Before', status: 'active', metadata: metadata(selector.spaceId, 'device') });
  await f.sync({ devices: [{ id: 'device', title: 'After' }], areas: [{ id: 'room' }], entities: [{ id: 'sensor.value', deviceId: 'device', areaId: 'room' }] });
  const updated = f.store.getNode(original.id)!; expect(updated.title).toBe('After'); expect(updated.slug).toBe(original.slug);
  const entity = f.store.listNodes().find(node => (node.metadata.homeAssistant as { objectId?: string })?.objectId === 'sensor.value')!;
  expect(f.store.edgesFor('node', entity.id)).toContainEqual(expect.objectContaining({ relation: 'belongs_to_device', toId: original.id }));
  const path = f.dbPath; await f.store.close(); const next = await fixture(path);
  await next.sync({ devices: [{ id: 'device', title: 'After restart' }] });
  expect(next.store.getNode(original.id)?.title).toBe('After restart'); expect(next.store.getNode(original.id)?.slug).toBe(original.slug);
  expect(createHomeGraphNodeIdentityPlanner(next.store).lookup(selector)?.id).toBe(original.id);
});

test('once-per-mutation opaque IDs avoid old delimiter and normalized-slug collisions', async () => {
  const f = await fixture();
  const first = await f.sync({ knowledgeSpaceId: 'tenant:ha_device', devices: [{ id: 'value' }, { id: 'a-b' }, { id: 'a b' }] });
  await f.sync({ knowledgeSpaceId: 'tenant', devices: [{ id: 'ha_device:value' }] });
  const nodes = f.store.listNodes().filter(node => node.kind === 'ha_device'); expect(nodes).toHaveLength(4);
  expect(new Set(nodes.map(node => node.id)).size).toBe(4); expect(new Set(nodes.map(node => node.slug)).size).toBe(4);
  for (const node of nodes) expect(node.id).toMatch(/^hg-node-[a-p-]+$/);
  await f.sync({ knowledgeSpaceId: 'tenant:ha_device', devices: [{ id: 'value', title: 'Updated' }, { id: 'a-b' }, { id: 'a b' }] });
  expect(f.store.listNodes().filter(node => node.kind === 'ha_device')).toHaveLength(4); expect(first.counts.devices).toBe(3);
});

test('read-only lookup never creates a label or changes bytes; only actual HA alias spaces coalesce', async () => {
  const f = await fixture();
  await f.store.upsertNode({ id: 'saved-custom', kind: 'ha_device', slug: 'saved-custom', title: 'Saved', status: 'draft', metadata: metadata('Project', 'device') });
  await f.store.upsertNode({ id: 'saved-ha', kind: 'ha_device', slug: 'saved-ha', title: 'Saved HA', status: 'draft', metadata: metadata('HOMEASSISTANT:My House', 'ha-device') });
  const before = readFileSync(f.dbPath), ids = spyOn(crypto, 'randomUUID'), pass = createHomeGraphNodeIdentityPlanner(f.store);
  try {
    expect(pass.lookup({ ...selector, spaceId: 'project' })).toBeUndefined(); expect(pass.lookup({ ...selector, spaceId: 'Project' })?.id).toBe('saved-custom');
    expect(pass.lookup({ ...selector, spaceId: 'homeassistant:my-house', objectId: 'ha-device' })?.id).toBe('saved-ha');
    expect(pass.lookup({ ...selector, objectId: 'not-yet-imported' })).toBeUndefined(); expect(ids).not.toHaveBeenCalled();
    expect(readFileSync(f.dbPath)).toEqual(before);
  } finally { ids.mockRestore(); }
});

test('multiple earlier saved tuple matches hold the entire snapshot preflight without any prefix write', async () => {
  const f = await fixture();
  for (const id of ['older-a', 'older-b']) await seedHomeAssistantObservation(f.store, { id, kind: 'ha_device', slug: id, title: id, status: 'active', metadata: metadata(selector.spaceId, 'device') });
  const before = readFileSync(f.dbPath), sourceCount = f.store.listSources().length;
  await expect(f.sync({ areas: [{ id: 'otherwise-first' }], devices: [{ id: 'device' }] })).rejects.toBeInstanceOf(HomeGraphIdentityHeldError);
  expect(readFileSync(f.dbPath)).toEqual(before); expect(f.store.listSources()).toHaveLength(sourceCount); expect(f.store.listNodes()).toHaveLength(2); expect(f.artifacts.list()).toHaveLength(0);
});

test('actual alias references select one passport row and hold independently saved aliases', async () => {
  const f = await fixture(), pass = createHomeGraphNodeIdentityPlanner(f.store);
  await f.store.upsertNode({ id: 'earlier-passport', kind: 'ha_device_passport', slug: 'saved-passport-url', title: 'Passport', status: 'draft', metadata: buildHomeGraphMetadata(selector.spaceId, 'house', { homeAssistant: { objectId: 'native-device-row' } }) });
  const input = { spaceId: selector.spaceId, kind: 'ha_device_passport' as const, objectId: 'physical-device', aliases: ['native-device-row'] };
  const identity = prepareHomeGraphNodeIdentity(pass, f.store, input); expect(identity.id).toBe('earlier-passport'); expect(identity.objectId).toBe('native-device-row'); expect(identity.slug).toBe('saved-passport-url');
  await f.store.upsertNode({ id: 'second-passport', kind: 'ha_device_passport', slug: 'second-passport', title: 'Second', status: 'draft', metadata: buildHomeGraphMetadata(selector.spaceId, 'house', { homeAssistant: { objectId: 'physical-device' } }) });
  expect(() => identity.assertCurrent()).toThrow(HomeGraphIdentityHeldError); expect(() => createHomeGraphNodeIdentityPlanner(f.store).prepare(input)).toThrow(HomeGraphIdentityHeldError);
});

test('same-pass links resolve new area/device IDs and never materialize missing references', async () => {
  const f = await fixture(); await f.sync({ areas: [{ id: 'room' }], devices: [{ id: 'device', areaId: 'room' }], entities: [{ id: 'sensor.one', deviceId: 'device' }], helpers: [{ id: 'input_boolean.helper', areaId: 'missing-area' }] });
  const pass = createHomeGraphNodeIdentityPlanner(f.store), device = pass.lookup(selector)!, area = pass.lookup({ ...selector, kind: 'ha_area', objectId: 'room' })!, entity = pass.lookup({ ...selector, kind: 'ha_entity', objectId: 'sensor.one' })!;
  expect(f.store.edgesFor('node', device.id)).toContainEqual(expect.objectContaining({ relation: 'located_in', toId: area.id }));
  expect(f.store.edgesFor('node', entity.id)).toContainEqual(expect.objectContaining({ relation: 'belongs_to_device', toId: device.id })); expect(pass.lookup({ ...selector, kind: 'ha_area', objectId: 'missing-area' })).toBeUndefined();
});

test('link-created object IDs are stable through lookup/unlink and do not adopt caller-chosen labels', async () => {
  const f = await fixture(), source = await f.store.upsertSource({ connectorId: 'fixture', sourceType: 'document', title: 'Manual', status: 'indexed', metadata: { knowledgeSpaceId: selector.spaceId } });
  const input = { spaceId: selector.spaceId, installationId: 'house', sourceId: source.id, target: { kind: 'device' as const, id: 'hg-node-caller-label', title: 'Declared' } };
  const first = await withDecisionModelPolicy(() => 'Classic - Off', () => linkHomeGraphKnowledge(f.store, input));
  expect(first.target?.id).not.toBe(input.target.id); const second = await withDecisionModelPolicy(() => 'Classic - Off', () => linkHomeGraphKnowledge(f.store, input)); expect(second.target?.id).toBe(first.target?.id);
  await unlinkHomeGraphKnowledge(f.store, input); expect(f.store.getNode(first.target!.id)).toBeNull();
});

test('fresh tuple duplicates and changed tuple binding are refused at the real native row writer', async () => {
  const f = await fixture();
  const first = await f.store.upsertNode({ id: 'current-one', kind: 'ha_device', slug: 'current-one', title: 'One', status: 'draft', metadata: metadata(selector.spaceId, 'device', true) });
  await expect(f.store.upsertNode({ id: 'current-two', kind: 'ha_device', slug: 'current-two', title: 'Two', status: 'draft', metadata: metadata(selector.spaceId, 'device', true) })).rejects.toBeInstanceOf(HomeGraphIdentityHeldError);
  await expect(f.store.upsertNode({ ...first, metadata: metadata(selector.spaceId, 'other-device', true) })).rejects.toBeInstanceOf(HomeGraphIdentityHeldError);
  expect(f.store.getNode(first.id)).toBe(first);
});

test('opaque collision, retired original and copied planner cannot silently rebind native identity', async () => {
  const f = await fixture(), uuid = '00000000-0000-4000-8000-000000000001' as const, id = `hg-node-${opaqueUuid(uuid)}`;
  await f.store.upsertNode({ id, kind: 'topic', slug: 'foreign', title: 'Foreign', status: 'draft' }); const generator = spyOn(crypto, 'randomUUID').mockReturnValue(uuid);
  try { expect(() => createHomeGraphNodeIdentityPlanner(f.store).prepare(selector)).toThrow(HomeGraphIdentityHeldError); } finally { generator.mockRestore(); }
  await f.store.deleteNode(id); const repeated = spyOn(crypto, 'randomUUID').mockReturnValue(uuid);
  try { const pending = createHomeGraphNodeIdentityPlanner(f.store); pending.prepare(selector); expect(() => pending.prepare({ ...selector, objectId: 'other-pending' })).toThrow(HomeGraphIdentityHeldError); } finally { repeated.mockRestore(); }
  const saved = await f.store.upsertNode({ id: 'native-saved', kind: 'ha_device', slug: 'native-saved', title: 'Native', status: 'draft', metadata: metadata(selector.spaceId, 'device') });
  const pass = createHomeGraphNodeIdentityPlanner(f.store), identity = pass.prepare(selector); await f.store.deleteNode(saved.id); expect(() => identity.assertCurrent()).toThrow(HomeGraphIdentityHeldError);
  let getters = 0; const copied = Object.create(null, { prepare: { get() { getters++; return pass.prepare; } } });
  expect(() => prepareHomeGraphNodeIdentity(copied, f.store, selector)).toThrow(HomeGraphIdentityHeldError); expect(getters).toBe(0);
});

test('a copied store or replaced closed native selector cannot supply invented tuple facts', async () => {
  const f = await fixture(), copied = Object.create(f.store);
  expect(() => createHomeGraphNodeIdentityPlanner(copied).lookup(selector)).toThrow(HomeGraphIdentityHeldError);
  const sqlite = (f.store as unknown as { sqlite: SQLiteStore }).sqlite, original = sqlite.readHomeGraphNodeCandidates;
  sqlite.readHomeGraphNodeCandidates = () => [];
  try { expect(() => createHomeGraphNodeIdentityPlanner(f.store).lookup(selector)).toThrow(HomeGraphIdentityHeldError); } finally { delete (sqlite as unknown as { readHomeGraphNodeCandidates?: unknown }).readHomeGraphNodeCandidates; }
  expect(sqlite.readHomeGraphNodeCandidates).toBe(original);
});

test('native tuple index drives EXPLAIN, rejects duplicate v1 rows and is added to an original v15 without rewriting data', async () => {
  const f = await fixture(), original = await f.store.upsertNode({ id: 'saved-before16', kind: 'ha_device', slug: 'saved-readable-slug', title: 'Saved', status: 'draft', metadata: metadata(selector.spaceId, 'device') });
  const snapshot = f.store.getRecordSnapshot('node', original.id); await f.store.close();
  const before15 = new Database(f.dbPath); try { for (const index of [...homeGraphNodeIdentityIndexes, ...homeGraphSourceIdentityIndexes]) before15.run(`DROP INDEX ${index.name}`); before15.run('PRAGMA user_version=15'); } finally { before15.close(); }
  const before = readFileSync(f.dbPath); let declared = false;
  const denied = new KnowledgeStore({ dbPath: f.dbPath, nativeDataWriter: { declare(format) { if (format === 'knowledge-schema-v17') { declared = true; throw Error('Reader floor held'); } } } }); stores.push(denied);
  await expect(denied.init()).rejects.toThrow('Reader floor held'); expect(declared).toBe(true); expect(readFileSync(f.dbPath)).toEqual(before); await denied.close();
  const next = await fixture(f.dbPath); expect(next.store.getNode(original.id)).toEqual(original); expect(next.store.getRecordSnapshot('node', original.id).generation).toBe(snapshot.generation);
  const sqlite = (next.store as unknown as { sqlite: SQLiteStore }).sqlite, query = homeGraphNodeCandidateQuery(selector);
  expect(sqlite.exec('EXPLAIN QUERY PLAN ' + query.sql, query.params)[0]?.values.map(row => String(row[3])).join(' ')).toContain('idx_knowledge_nodes_homegraph_object');
  expect(sqlite.exec('PRAGMA user_version')[0]?.values[0]?.[0]).toBe(KNOWLEDGE_SCHEMA_VERSION);
  const encoded = JSON.stringify(metadata(selector.spaceId, 'same-current', true));
  sqlite.run("INSERT INTO knowledge_nodes (id,kind,slug,title,status,confidence,aliases,metadata,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", ['sql-one','ha_device','sql-one','One','draft',0,'[]',encoded,1,1]);
  expect(() => sqlite.run("INSERT INTO knowledge_nodes (id,kind,slug,title,status,confidence,aliases,metadata,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", ['sql-two','ha_device','sql-two','Two','draft',0,'[]',encoded,1,1])).toThrow();
});

test('future schema and unknown saved identity versions preserve the original database', async () => {
  const f = await fixture(); await f.store.upsertNode({ id: 'future-node', kind: 'ha_device', slug: 'future-node', title: 'Future', status: 'draft', metadata: metadata(selector.spaceId, 'device') }); await f.store.close();
  const edit = new Database(f.dbPath); try { edit.run("UPDATE knowledge_nodes SET metadata=json_set(metadata,'$.homeGraphIdentityVersion',2) WHERE id='future-node'"); } finally { edit.close(); }
  const next = await fixture(f.dbPath), before = readFileSync(f.dbPath); expect(() => createHomeGraphNodeIdentityPlanner(next.store).lookup(selector)).toThrow(HomeGraphIdentityHeldError); expect(readFileSync(f.dbPath)).toEqual(before); await next.store.close();
  const future = new Database(f.dbPath); try { future.run(`PRAGMA user_version=${KNOWLEDGE_SCHEMA_VERSION + 1}`); } finally { future.close(); }
  const futureBytes = readFileSync(f.dbPath), incompatible = new KnowledgeStore({ dbPath: f.dbPath }); stores.push(incompatible); await expect(incompatible.init()).rejects.toThrow(); expect(readFileSync(f.dbPath)).toEqual(futureBytes);
});


test('actual snapshot sync preserves installation identity across recognized Home Assistant space aliases', async () => {
  const f = await fixture();
  const original = await f.sync({ knowledgeSpaceId: 'homeassistant:my-house', devices: [{ id: 'device', title: 'Original device' }] });
  const before = createHomeGraphNodeIdentityPlanner(f.store).lookup({ ...selector, spaceId: original.spaceId });
  if (!before) throw new Error('Original snapshot did not publish its device.');
  const updated = await f.sync({ knowledgeSpaceId: 'HOMEASSISTANT:My House', devices: [{ id: 'device', title: 'Updated device' }] });
  expect(updated.spaceId).toBe('HOMEASSISTANT:My House');
  expect(updated.installationId).toBe('my-house'); expect(updated.home.id).toBe(original.home.id);
  expect(updated.home.metadata.homeAssistant).toMatchObject({ installationId: 'my-house' });
  expect(updated.source.metadata.homeAssistant).toMatchObject({ installationId: 'my-house' });
  const device = createHomeGraphNodeIdentityPlanner(f.store).lookup({ ...selector, spaceId: 'homeassistant:my-house' });
  expect(device?.id).toBe(before.id); expect(device?.title).toBe('Updated device');
  expect(device?.metadata.homeAssistant).toMatchObject({ installationId: 'my-house', objectId: 'device' });
  expect(f.store.listNodes().filter(node => node.kind === 'ha_device')).toHaveLength(1);
  const custom = await f.sync({ knowledgeSpaceId: 'Project:My House', installationId: 'Other Installation', devices: [] });
  expect(custom.spaceId).toBe('Project:My House'); expect(custom.installationId).toBe('other-installation');
});
