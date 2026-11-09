/** Recognized input identity preflight and actual partial-group ownership. */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../sdk/src/platform/artifacts/store.ts';
import { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.ts';
import { KNOWLEDGE_SCHEMA_VERSION } from '../sdk/src/platform/knowledge/store-schema-version.ts';
import { KnowledgeStore, updateHomeGraphSnapshotGroups } from '../sdk/src/platform/knowledge/store.ts';
import { runHomeGraphSnapshotSync } from '../sdk/src/platform/knowledge/home-graph/sync.ts';
import { HomeGraphObjectIdentityError } from '../sdk/src/platform/knowledge/home-graph/identity-errors.ts';
import { withDecisionModelPolicy } from '../sdk/src/platform/runtime/decision-policy.ts';
import type { HomeGraphSnapshotInput } from '../sdk/src/platform/knowledge/home-graph/types.ts';
const roots: string[] = [], stores: KnowledgeStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'homegraph-groups-')); roots.push(root);
  const artifacts = new ArtifactStore({ rootDir: join(root, 'artifacts') }), store = new KnowledgeStore({ dbPath: join(root, 'knowledge-home-graph.sqlite') }); stores.push(store); await store.init();
  const sync = (snapshot: HomeGraphSnapshotInput) => withDecisionModelPolicy(() => 'Classic - Off', () => runHomeGraphSnapshotSync({ store, artifactStore: artifacts, snapshot: { installationId: 'house', pageAutomation: { enabled: false }, ...snapshot } }));
  const node = (objectId: string) => store.listNodes().find(node => (node.metadata.homeAssistant as { objectId?: string } | undefined)?.objectId === objectId);
  return { root, artifacts, store, sync, node };
}
for (const group of ['entities', 'devices', 'areas', 'automations', 'scripts', 'scenes', 'labels', 'integrations', 'helpers'] as const) {
  test(`identity-free middle item in ${group} refuses before any snapshot/source/earlier-group write`, async () => {
    const f = await fixture(), before = existsSync(f.store.storagePath) ? readFileSync(f.store.storagePath) : null, secret = 'do-not-print-private-payload';
    let error: unknown;
    try { await f.sync({ devices: [{ id: 'valid-device' }], [group]: [{ id: 'valid-first' }, { metadata: { privatePayload: secret } }, { id: 'valid-last' }] }); } catch (failure) { error = failure; }
    expect(error).toBeInstanceOf(HomeGraphObjectIdentityError); expect(String(error)).toContain(`${group} item 2`); expect(String(error)).not.toContain(secret);
    expect(f.store.listSources()).toHaveLength(0); expect(f.store.listNodes()).toHaveLength(0); expect(f.artifacts.list()).toHaveLength(0); expect(existsSync(f.store.storagePath) ? readFileSync(f.store.storagePath) : null).toEqual(before);
  });
}
test('all documented syntactic aliases/name/title still normalize without a raw-body identity fallback', async () => {
  const f = await fixture();
  const result = await f.sync({ entities: [{ entity_id: 'sensor.entity' }, { unique_id: 'unique-entity' }, { slug: 'slug-entity' }, { name: 'Named entity' }, { title: 'Titled entity' }], devices: [{ device_id: 'device-registry-id' }], areas: [{ area_id: 'area-registry-id' }], integrations: [{ integration_id: 'integration-registry-id' }] });
  expect(result.counts.entities).toBe(5); expect(result.counts.devices).toBe(1); expect(result.counts.helpers).toBe(0);
});
test('helpers-only snapshot creates/updates helper entities and retires only its own omitted members', async () => {
  const f = await fixture();
  const initial = await f.sync({ capturedAt: 1_700_000_000_001, entities: [{ entity_id: 'sensor.external', name: 'External' }], devices: [{ device_id: 'kept-device', name: 'Device' }], areas: [{ area_id: 'kept-area' }], integrations: [{ id: 'kept-integration' }] });
  const originalDevice = f.node('kept-device')!, originalSource = f.store.getSource(originalDevice.sourceId!)!;
  const helpers = await f.sync({ capturedAt: 1_700_000_000_002, helpers: [{ entity_id: 'input_boolean.lights', name: 'Lights' }] });
  expect(helpers.counts.helpers).toBe(1); expect(f.node('input_boolean.lights')?.status).toBe('active');
  for (const id of ['sensor.external', 'kept-device', 'kept-area', 'kept-integration']) expect(f.node(id)?.status).toBe('active');
  expect(f.store.getSource(originalSource.id)?.status).toBe('indexed'); expect(f.store.getNode(originalDevice.id)?.sourceId).toBe(originalSource.id);
  await f.sync({ capturedAt: 1_700_000_000_003, helpers: [{ entity_id: 'input_boolean.lights', name: 'Updated lights' }] });
  expect(f.node('input_boolean.lights')?.title).toBe('Updated lights');
  await f.sync({ capturedAt: 1_700_000_000_004, helpers: [] });
  expect(f.node('input_boolean.lights')?.status).toBe('stale'); expect(f.node('sensor.external')?.status).toBe('active'); expect(f.node('kept-device')?.status).toBe('active');
  expect(initial.counts.devices).toBe(1);
});
test('a shared entity survives one group removal, preserves its original body/source, and retires when its remaining group is supplied empty', async () => {
  const f = await fixture();
  await f.sync({ capturedAt: 1_700_000_000_011, entities: [{ entity_id: 'input_boolean.shared', name: 'Shared' }], helpers: [{ entity_id: 'input_boolean.shared', name: 'Shared' }] });
  const original = f.node('input_boolean.shared')!;
  await f.sync({ capturedAt: 1_700_000_000_012, helpers: [] });
  const kept = f.store.getNode(original.id)!;
  expect(kept.status).toBe(original.status); expect(kept.title).toBe(original.title); expect(kept.sourceId).toBe(original.sourceId); expect(kept.createdAt).toBe(original.createdAt); expect(kept.updatedAt).toBe(original.updatedAt);
  expect((kept.metadata.homeAssistant as { snapshotGroups: string[] }).snapshotGroups).toEqual(['entities']); expect(f.store.getSource(original.sourceId!)?.status).toBe('indexed');
  await f.sync({ capturedAt: 1_700_000_000_013, entities: [] }); expect(f.store.getNode(original.id)?.status).toBe('stale');
});


test('native group bookkeeping preserves unrelated raw JSON integer/decimal tokens, clocks, source, status and saved review fields', async () => {
  const f = await fixture(); await f.sync({ entities: [{ entity_id: 'input_boolean.precise', name: 'Precise' }], helpers: [{ entity_id: 'input_boolean.precise', name: 'Precise' }] });
  const id = f.node('input_boolean.precise')!.id, path = f.store.storagePath; await f.store.close();
  // A real saved older/native JSON record can contain numeric tokens that a JS
  // parse/stringify round trip would change. Keep them in the actual SQLite cell.
  const setup = new SQLiteStore(path, { coordinated: true }); await setup.init(() => {}, { schemaVersion: KNOWLEDGE_SCHEMA_VERSION });
  try {
    const metadata = setup.exec('SELECT metadata FROM knowledge_nodes WHERE id = ?', [id])[0]!.values[0]![0]; if (typeof metadata !== 'string') throw Error('Missing actual metadata cell');
    const precise = metadata.slice(0, -1) + ',"precise":9007199254740993,"decimal":1.2300,"review":{"action":"approve","reviewer":"owner"}}';
    setup.run('UPDATE knowledge_nodes SET metadata = ? WHERE id = ?', [precise, id]); await setup.save();
  } finally { setup.close(); }
  const store = new KnowledgeStore({ dbPath: path }); stores.push(store); await store.init();
  const original = store.getNode(id)!, before = store.getRecordSnapshot('node', id).raw!;
  const next = await updateHomeGraphSnapshotGroups(store, original, ['entities'], () => {}), after = store.getRecordSnapshot('node', id).raw!;
  expect(after.metadata).toContain('"precise":9007199254740993'); expect(after.metadata).toContain('"decimal":1.2300');
  for (const key of Object.keys(before)) if (key !== 'metadata' && key !== 'gv_revision' && key !== 'gv_content_revision') expect(after[key]).toEqual(before[key]);
  expect(after.gv_revision).not.toBe(before.gv_revision); expect(after.gv_content_revision).not.toBe(before.gv_content_revision);
  expect(next.sourceId).toBe(original.sourceId); expect(next.status).toBe(original.status); expect(next.metadata.review).toEqual(original.metadata.review); expect(next.createdAt).toBe(original.createdAt); expect(next.updatedAt).toBe(original.updatedAt);
});


test('overlapping entity/helper values publish once with the final supplied value, complete membership and unchanged input counts', async () => {
  const f = await fixture();
  const result = await f.sync({ entities: [{ entity_id: 'input_boolean.shared', name: 'Earlier' }, { entity_id: 'sensor.repeated', name: 'First' }, { entity_id: 'sensor.repeated', name: 'Final' }], helpers: [{ entity_id: 'input_boolean.shared', name: 'Helper final' }] });
  expect(result.counts.entities).toBe(3); expect(result.counts.helpers).toBe(1);
  expect(f.node('input_boolean.shared')?.title).toBe('Helper final'); expect(f.node('sensor.repeated')?.title).toBe('Final');
  expect((f.node('input_boolean.shared')!.metadata.homeAssistant as { snapshotGroups: string[] }).snapshotGroups).toEqual(['entities', 'helpers']);
  expect(f.store.listNodes().filter(node => node.kind === 'ha_entity')).toHaveLength(2);
});
