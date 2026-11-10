import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { KNOWLEDGE_SCHEMA_VERSION } from '../platform/src/platform/knowledge/store-schema.js';
import { ProjectPlanningService } from '../platform/src/platform/knowledge/project-planning/service.js';
import * as helpers from '../platform/src/platform/knowledge/project-planning/helpers.js';
import { projectKnowledgeSpaceId } from '../platform/src/platform/knowledge/spaces.js';
import { SQLiteStore } from '../platform/src/platform/state/sqlite-store.js';
import { StoreSchemaDowngradeError } from '../platform/src/platform/state/store-versioning.js';
import type { KnowledgeSourceRecord } from '../platform/src/platform/knowledge/types.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'planning-source-identities-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const prior = installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
  cleanup.push(() => { installJudgmentPort(prior); });
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  await store.init(); cleanup.push(() => store.close());
  return { store, service: new ProjectPlanningService(store), path: store.storagePath };
}

const state = { id: 'current', goal: 'Keep the project plan discoverable' };
const identity = { spaceId: projectKnowledgeSpaceId('alpha'), kind: 'state' as const, artifactId: 'current' };

function sourceInput(source: KnowledgeSourceRecord) {
  // Stored host clocks are not caller input to a semantic publication.
  const { createdAt: _createdAt, updatedAt: _updatedAt, lastCrawledAt: _lastCrawledAt, ...input } = source;
  return input;
}

test('fresh source identity is minted once and resolved by its persisted tuple across updates and restart', async () => {
  const f = await fixture();
  const first = await f.service.upsertState({ projectId: 'alpha', state });
  const sourceId = first.source?.id;
  expect(sourceId).toMatch(/^project-planning-state-[a-p]{8}-[a-p]{4}-[a-p]{4}-[a-p]{4}-[a-p]{12}$/);
  expect(f.store.getPlanningSourceSnapshot(identity).source?.id).toBe(sourceId);
  expect((await f.service.getState({ projectId: 'alpha' })).source?.id).toBe(sourceId);
  expect((await f.service.upsertState({ projectId: 'alpha', state: { ...state, goal: 'A revised goal' } })).source?.id).toBe(sourceId);
  const reopened = new KnowledgeStore({ dbPath: f.path }); cleanup.push(() => reopened.close());
  const service = new ProjectPlanningService(reopened);
  expect((await service.getState({ projectId: 'alpha' })).source?.id).toBe(sourceId);
  expect((await service.upsertState({ projectId: 'alpha', state })).source?.id).toBe(sourceId);
});

test('historical hashed source without canonical URI is found from durable metadata and updated in place', async () => {
  const f = await fixture();
  const seeded = await f.service.upsertState({ projectId: 'alpha', state });
  // Fixed independently recorded deployed-format fixture, not a live derivation.
  const oldId = 'project-planning-state-4b7a24906e974844';
  const raw = new SQLiteStore(f.path, { coordinated: true });
  await raw.init(() => {}, { schemaVersion: KNOWLEDGE_SCHEMA_VERSION });
  raw.run('UPDATE knowledge_sources SET id = ?, canonical_uri = NULL WHERE id = ?', [oldId, seeded.source!.id]);
  await raw.save(); raw.close();
  const reopened = new KnowledgeStore({ dbPath: f.path }); cleanup.push(() => reopened.close());
  const service = new ProjectPlanningService(reopened);
  expect((await service.getState({ projectId: 'alpha' })).source?.id).toBe(oldId);
  const saved = await service.upsertState({ projectId: 'alpha', state: { ...state, goal: 'Updated historical plan' } });
  expect(saved.source?.id).toBe(oldId);
  expect(reopened.getPlanningSourceSnapshot(identity).source?.canonicalUri)
    .toBe(helpers.projectPlanningCanonicalUri(identity.spaceId, identity.kind, identity.artifactId));
  expect(reopened.listSources(100).filter(source => source.metadata['planningArtifactKind'] === 'state')).toHaveLength(1);
});

test('owned publication refuses a second opaque ID for an already committed planning tuple', async () => {
  const f = await fixture();
  const first = await f.service.upsertState({ projectId: 'alpha', state });
  const source = first.source!;
  await expect(f.store.upsertOwnedCanonicalSources([{
    input: { ...sourceInput(source), id: 'competing-new-source' }, generation: null,
  }], () => {}, () => {})).rejects.toMatchObject({ reason: 'state-changed' });
  expect(f.store.getPlanningSourceSnapshot(identity).source?.id).toBe(source.id);
  expect(f.store.getSourceSnapshot({ id: 'competing-new-source' }).source).toBeNull();
});

test('ambiguous persisted planning identities are refused rather than selected by row order', async () => {
  const f = await fixture();
  const seeded = await f.service.upsertState({ projectId: 'alpha', state });
  await f.store.upsertSource({ ...seeded.source!, id: 'historical-duplicate-source', canonicalUri: undefined });
  await expect(f.service.getState({ projectId: 'alpha' })).rejects.toMatchObject({ reason: 'state-changed' });
});

test('a single batch cannot publish duplicate absent tuples or overwrite one selected source twice', async () => {
  const f = await fixture();
  const seeded = await f.service.upsertState({ projectId: 'alpha', state });
  const source = seeded.source!;
  const metadata = { ...source.metadata, planningArtifactId: 'new-state' };
  const input = { ...sourceInput(source), metadata, canonicalUri: helpers.projectPlanningCanonicalUri(identity.spaceId, 'state', 'new-state') };
  await expect(f.store.upsertOwnedCanonicalSources([
    { input: { ...input, id: 'first-new-source' }, generation: null },
    { input: { ...input, id: 'second-new-source' }, generation: null },
  ], () => {}, () => {})).rejects.toMatchObject({ reason: 'state-changed' });
  expect(f.store.getPlanningSourceSnapshot({ ...identity, artifactId: 'new-state' }).source).toBeNull();
  expect(f.store.getSourceSnapshot({ id: 'first-new-source' }).source).toBeNull();
  expect(f.store.getSourceSnapshot({ id: 'second-new-source' }).source).toBeNull();
  const original = f.store.getPlanningSourceSnapshot(identity);
  await expect(f.store.upsertOwnedCanonicalSources([
    { input: sourceInput(source), generation: original.generation },
    { input: { ...sourceInput(source), summary: 'must not overwrite the first write' }, generation: original.generation },
  ], () => {}, () => {})).rejects.toMatchObject({ reason: 'state-changed' });
  expect(f.store.getPlanningSourceSnapshot(identity)).toEqual(original);
});

test('schema twelve migrates source identities and revisions unchanged and refuses old writers before their schema runs', async () => {
  const f = await fixture();
  const seeded = await f.service.upsertState({ projectId: 'alpha', state });
  // Actual old saved source identity, retained without a runtime hash formatter.
  const historicalId = 'project-planning-state-4b7a24906e974844';
  await f.store.close();
  const raw = new SQLiteStore(f.path, { coordinated: true });
  await raw.init(() => {}, { schemaVersion: KNOWLEDGE_SCHEMA_VERSION });
  raw.run('UPDATE knowledge_sources SET id = ?, canonical_uri = NULL WHERE id = ?', [historicalId, seeded.source!.id]);
  const before = raw.exec('SELECT * FROM knowledge_sources ORDER BY id');
  raw.run('PRAGMA user_version = 11'); await raw.save(); raw.close();
  const alreadyOpenOldWriter = new SQLiteStore(f.path, { coordinated: true });
  await alreadyOpenOldWriter.init(() => {}, { schemaVersion: 11 });
  cleanup.push(() => alreadyOpenOldWriter.close());
  const migrated = new KnowledgeStore({ dbPath: f.path }); cleanup.push(() => migrated.close());
  await migrated.init();
  const check = new SQLiteStore(f.path, { coordinated: true });
  await check.init(() => {}, { schemaVersion: KNOWLEDGE_SCHEMA_VERSION });
  expect(check.exec('SELECT * FROM knowledge_sources ORDER BY id')).toEqual(before);
  check.close();
  expect(migrated.getPlanningSourceSnapshot(identity).source?.id).toBe(historicalId);
  const bytes = readFileSync(f.path);
  alreadyOpenOldWriter.run("UPDATE knowledge_sources SET summary = 'obsolete writer must not publish' WHERE id = ?", [historicalId]);
  await expect(alreadyOpenOldWriter.save()).rejects.toThrow();
  expect(readFileSync(f.path)).toEqual(bytes);
  let oldSchemaCalls = 0;
  const olderWriter = new SQLiteStore(f.path, { coordinated: true });
  try {
    await expect(olderWriter.init(() => { oldSchemaCalls++; }, { schemaVersion: 11 }))
      .rejects.toBeInstanceOf(StoreSchemaDowngradeError);
    expect(oldSchemaCalls).toBe(0);
    expect(readFileSync(f.path)).toEqual(bytes);
  } finally { olderWriter.close(); }
});
