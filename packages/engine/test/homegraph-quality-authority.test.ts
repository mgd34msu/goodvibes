import { JudgmentError } from '@goodvibes-jev/judgment';
import * as crypto from 'node:crypto';
import { seedHomeAssistantObservation } from './_helpers/homegraph-observation-fixtures.js';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ArtifactStore } from '../platform/src/platform/artifacts/index.js';
import { SQLiteStore } from '../platform/src/platform/state/sqlite-store.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { refreshHomeGraphQualityIssues, homeGraphQualityNamespace } from '../platform/src/platform/knowledge/home-graph/quality.js';
import { refreshHomeGraphDevicePassport } from '../platform/src/platform/knowledge/home-graph/generated-pages.js';
import { runHomeGraphSnapshotSync } from '../platform/src/platform/knowledge/home-graph/sync.js';
import { reviewHomeGraphFact } from '../platform/src/platform/knowledge/home-graph/review.js';
import type { KnowledgeNodeRecord } from '../platform/src/platform/knowledge/types.js';
import { buildHomeGraphMetadata } from '../platform/src/platform/knowledge/home-graph/helpers.js';
import { readHomeGraphState } from '../platform/src/platform/knowledge/home-graph/state.js';
import { sameKnowledgeRecord } from '../platform/src/platform/knowledge/store-record-representation.js';
import { recordKnowledgeNodeRevisions } from '../platform/src/platform/knowledge/store-node-history.js';
import { createKnowledgeNodeOperatorMutation, retainKnowledgeNodeRecord } from '../platform/src/platform/knowledge/store-node-authority.js';
let previous: JudgmentPort | undefined;
const roots: string[] = [], stores: KnowledgeStore[] = [];
const spaceId = 'homeassistant:quality-fixture', installationId = 'quality-fixture';
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(async () => { installJudgmentPort(previous); await Promise.all(stores.splice(0).map(store => store.close())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function readings(battery = 0.99, manual = 0.99) {
  const fake = fakePort((name) => {
    if (name === 'batteryApplicable__batteryApplicable') return noulAnswer(battery);
    if (['manualApplicable', 'manufacturerPresent', 'modelPresent', 'batteryTypePresent'].includes(name.split('__').at(-1)!)) return noulAnswer(manual);
    throw new Error(`Unexpected quality fixture question: ${name}`);
  });
  installJudgmentPort(fake.port); return fake;
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-quality-')); roots.push(root);
  const dbPath = join(root, 'knowledge.sqlite'), store = new KnowledgeStore({ dbPath }); stores.push(store);
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const node = await seedHomeAssistantObservation(store, { id: 'LOCAL_DEVICE', kind: 'ha_device', slug: 'lamp', title: 'Mains service hub', summary: 'Physical equipment with internal backup battery.', aliases: [], status: 'active', metadata: { knowledgeSpaceId: spaceId, homeAssistant: { objectKind: 'device', objectId: 'lamp' }, private: 'DO_NOT_TRANSMIT' } });
  const entity = await seedHomeAssistantObservation(store, { id: 'LOCAL_ENTITY', kind: 'ha_entity', slug: 'sensor', title: 'Telemetry', status: 'active', metadata: { knowledgeSpaceId: spaceId, homeAssistant: { entityId: 'binary_sensor.lamp' } } });
  await store.upsertEdge({ fromKind: 'node', fromId: entity.id, toKind: 'node', toId: node.id, relation: 'belongs_to_device', metadata: { knowledgeSpaceId: spaceId } });
  const run = (signal?: AbortSignal) => refreshHomeGraphQualityIssues(store, spaceId, installationId, { signal });
  const snapshot = () => JSON.stringify(readHomeGraphState(store, spaceId));
  return { root, dbPath, store, node, entity, artifactStore, run, snapshot };
}
/** Fixed actual earlier-format fixtures; production does not derive fresh IDs. */
function legacyIssue(space: string, installation: string, code: string, message: string, subject: { readonly nodeId: string }) {
  if (space !== spaceId || installation !== installationId || subject.nodeId !== 'LOCAL_DEVICE') throw Error('Unexpected older fixture tuple');
  const id = code === 'homegraph.device.missing_manual' ? 'hg-issue-adbdae61b9d5a9664a6a521e' : code === 'homegraph.device.unknown_battery' ? 'hg-issue-bc6bee5d2b03fbd74b1be1f3' : undefined;
  if (!id) throw Error('Unexpected older fixture code');
  return { id, code, severity: 'warning' as const, message, nodeId: subject.nodeId,
    metadata: buildHomeGraphMetadata(space,installation,{ namespace: space, subjectId: subject.nodeId }) };
}
function legacyHomeGraphQualityFingerprint(node: KnowledgeNodeRecord, code: string): string {
  if (node.id !== 'LOCAL_DEVICE') throw Error('Unexpected older fixture subject');
  if (code === 'homegraph.device.missing_manual') return 'e478e9c07c83abbbb1b602f0';
  if (code === 'homegraph.device.unknown_battery') return '099efb8aac110367ecc4485d';
  throw Error('Unexpected older fixture code');
}

describe('Home Graph whole-pass quality authority', () => {
  test('creates new issues with reading provenance, relation scope and no operator authority; settled no removes only ordinary issues', async () => {
    const { store, run } = await fixture(); const fake = readings();
    const issues = await run(); expect(issues).toHaveLength(2);
    for (const issue of issues) { expect(issue.metadata.qualityReading).toBeDefined(); expect(issue.metadata.review).toBeUndefined(); }
    const sent = JSON.stringify(fake.requests); expect(sent).toContain('binary_sensor.lamp');
    for (const absent of ['LOCAL_DEVICE', 'LOCAL_ENTITY', 'DO_NOT_TRANSMIT', 'issueLifecycle']) expect(sent).not.toContain(absent);
    readings(0.01, 0.01); expect(await run()).toHaveLength(0); expect(store.listIssuesInSpace(spaceId)).toHaveLength(0);
  });
  test('later uncertainty, unavailable, protected input or cancellation leaves every old issue byte-identical', async () => {
    for (const mode of ['uncertain', 'unavailable', 'protected', 'cancelled', 'missing'] as const) {
      const { store, node, run, snapshot } = await fixture(); readings(); await run(); const fake = readings(0.01, 0.5); const controller = new AbortController();
      if (mode === 'unavailable') installJudgmentPort({ ...fake.port, ask: async () => { throw new JudgmentError('unavailable', 'offline'); } });
      if (mode === 'missing') installJudgmentPort(undefined);
      if (mode === 'protected') await seedHomeAssistantObservation(store, { ...node, summary: 'Authorization: Bearer synthetic' });
      if (mode === 'cancelled') installJudgmentPort({ ...fake.port, async ask(request) { const result = await fake.port.ask(request); controller.abort(); return result; } });
      const before = snapshot(); await expect(run(controller.signal)).rejects.toThrow(); expect(snapshot()).toBe(before);
      if (mode === 'protected') expect(fake.requests).toHaveLength(0);
    }
  });
  test('full selected-device preflight refuses a later protected device before the first request', async () => {
    const { store, run } = await fixture();
    await seedHomeAssistantObservation(store, { id: 'LATE_DEVICE', kind: 'ha_device', slug: 'late', title: 'Late', summary: 'Authorization: Bearer synthetic', metadata: { knowledgeSpaceId: spaceId } });
    const fake = readings(); await expect(run()).rejects.toThrow(); expect(fake.requests).toHaveLength(0);
  });
  test('snapshots nodes, entities, relations, source membership and operator issues before awaited reads', async () => {
    for (const changed of ['node', 'entity', 'edge', 'source', 'review'] as const) {
      const { store, node, entity, run, snapshot } = await fixture(); readings(); const issues = await run();
      const fake = readings(0.01, 0.01); let done = false, afterChange = ''; let mutationError: unknown;
      installJudgmentPort({ ...fake.port, async ask(request) {
        const result = await fake.port.ask(request);
        if (!done) { done = true; try {
          if (changed === 'node' || changed === 'entity') { const current = changed === 'node' ? node : entity; await seedHomeAssistantObservation(store, { ...current, summary: 'Concurrent correction.' }); }
          if (changed === 'edge') await store.upsertEdge({ fromKind: 'node', fromId: entity.id, toKind: 'node', toId: node.id, relation: 'related_to', metadata: { knowledgeSpaceId: spaceId } });
          if (changed === 'source') await store.upsertSource({ connectorId: 'manual', sourceType: 'manual', title: 'New source', status: 'indexed', canonicalUri: 'manual://new-source', metadata: { knowledgeSpaceId: spaceId } });
          if (changed === 'review') await reviewHomeGraphFact(store, spaceId, installationId, { knowledgeSpaceId: spaceId, issueId: issues[0]!.id, action: 'accept', reviewer: 'owner' });
          afterChange = snapshot();
        } catch (error) { mutationError = error; throw error; } }
        return result;
      } });
      let failure: unknown; try { await run(); } catch (error) { failure = error; }
      expect(mutationError).toBeUndefined(); expect(failure).toMatchObject({ reason: 'stale' }); expect(snapshot()).toBe(afterChange);
    }
  });
  test('resolved and explicitly reopened operator issues survive absent regenerated set', async () => {
    const { store, run } = await fixture(); readings(); const issues = await run();
    await reviewHomeGraphFact(store, spaceId, installationId, { knowledgeSpaceId: spaceId, issueId: issues[0]!.id, action: 'accept', reviewer: 'owner' });
    await reviewHomeGraphFact(store, spaceId, installationId, { knowledgeSpaceId: spaceId, issueId: issues[1]!.id, action: 'accept', reviewer: 'owner' });
    await reviewHomeGraphFact(store, spaceId, installationId, { knowledgeSpaceId: spaceId, issueId: issues[1]!.id, action: 'edit', reviewer: 'owner' });
    const before = JSON.stringify(store.listIssuesInSpace(spaceId)); readings(0.01, 0.01); await run();
    expect(JSON.stringify(store.listIssuesInSpace(spaceId))).toBe(before);
  });
  test('final store boundary checks cancellation before any new issue or delete', async () => {
    const { store, run, snapshot } = await fixture(); readings(); await run(); readings(0.01, 0.01);
    const before = snapshot(), controller = new AbortController(), original = store.replaceIssuesGuarded.bind(store);
    const spy = spyOn(store, 'replaceIssuesGuarded').mockImplementation(async (...args) => { controller.abort(); return original(...args); });
    try { await expect(run(controller.signal)).rejects.toThrow('aborted'); expect(snapshot()).toBe(before); } finally { spy.mockRestore(); }
  });
  test('a legacy review arriving at store entry is a typed stale hold before replacement', async () => {
    const { store, node, run, snapshot } = await fixture();
    const legacy = legacyIssue(spaceId, installationId, 'homegraph.device.missing_manual', 'Legacy', { nodeId: node.id });
    const issue = await store.upsertIssue({ ...legacy, metadata: { ...legacy.metadata, generated: true } });
    readings(0.01, 0.99); const original = store.replaceIssuesGuarded.bind(store); let afterReview = '';
    const spy = spyOn(store, 'replaceIssuesGuarded').mockImplementation(async (...args) => {
      await reviewHomeGraphFact(store, spaceId, installationId, { issueId: issue.id, action: 'accept', reviewer: 'owner' });
      afterReview = snapshot(); return original(...args);
    });
    try { await expect(run()).rejects.toThrow('stale'); expect(snapshot()).toBe(afterReview); } finally { spy.mockRestore(); }
  });
  test('SQL failures restore rows and caches atomically before reload, including a fresh issue replacement', async () => {
    const { store, dbPath, run, snapshot } = await fixture(); readings(); const before = snapshot();
    const original = SQLiteStore.prototype.run; let writes = 0, database: SQLiteStore | undefined;
    const spy = spyOn(SQLiteStore.prototype, 'run').mockImplementation(function(this: SQLiteStore, sql, params) {
      database = this; if (sql.includes('INSERT OR REPLACE INTO knowledge_issues') && ++writes === 2) throw new Error('synthetic SQL failure');
      return original.call(this, sql, params);
    });
    try { await expect(run()).rejects.toThrow('synthetic SQL failure'); } finally { spy.mockRestore(); }
    expect(snapshot()).toBe(before); expect(database!.exec('SELECT COUNT(*) FROM knowledge_issues')[0]!.values[0]![0]).toBe(0);
    const reloaded = new KnowledgeStore({ dbPath }); stores.push(reloaded); await reloaded.init(); expect(JSON.stringify(readHomeGraphState(reloaded, spaceId))).toBe(before);
    expect(await run()).toHaveLength(2); expect(store.listIssuesInSpace(spaceId)).toHaveLength(2);
  });
  test('quality hold reporting does not falsely undo the structural snapshot import', async () => {
    const { store, artifactStore } = await fixture(); installJudgmentPort(undefined);
    const result = await runHomeGraphSnapshotSync({ store, artifactStore, snapshot: { installationId, devices: [{ id: 'new', name: 'New physical device' }], pageAutomation: { enabled: false } } });
    expect(result.ok).toBe(true); expect(result.quality).toEqual({ status: 'held', reason: 'unconfigured' }); expect(result.created.issues).toBe(0);
    expect(store.getSource(result.source.id)).not.toBeNull(); expect(store.listNodesInSpace(spaceId).some((node) => node.title === 'New physical device')).toBe(true);
  });
  test('snapshot reports retained legacy authority as partial derived quality', async () => {
    const { store, artifactStore, node } = await fixture();
    const legacy = legacyIssue(spaceId, installationId, 'homegraph.device.missing_manual', 'Legacy', { nodeId: node.id });
    const issue = await store.upsertIssue({ ...legacy, metadata: { ...legacy.metadata, generated: true, subjectFingerprint: legacyHomeGraphQualityFingerprint(node, legacy.code) } });
    await reviewHomeGraphFact(store, spaceId, installationId, { issueId: issue.id, action: 'accept', reviewer: 'owner' });
    const before = store.getIssue(issue.id); readings(0.01, 0.99);
    const result = await runHomeGraphSnapshotSync({ store, artifactStore, snapshot: { installationId, pageAutomation: { enabled: false } } });
    expect(result.quality).toEqual({ status: 'partial', reason: 'legacy-reviewed-state-retained', retainedLegacyIssues: 1 });
    expect(store.getIssue(issue.id)).toEqual(before);
  });
  test('passport uncertainty is before node, fact, source, edge or artifact writes', async () => {
    const { store, artifactStore, snapshot } = await fixture(); readings(0.5);
    const before = snapshot();
    await expect(refreshHomeGraphDevicePassport({ store, artifactStore, spaceId, installationId, input: { deviceId: 'lamp' } })).rejects.toThrow('unsettled');
    expect(snapshot()).toBe(before); expect(artifactStore.list(20)).toEqual([]);
  });
  test('changed related entity, summary or aliases creates a new lifecycle after resolution; reordering does not', async () => {
    for (const change of ['entity', 'summary', 'aliases'] as const) {
      const { store, node, entity, run } = await fixture(); readings(); const [issue] = await run();
      await reviewHomeGraphFact(store, spaceId, installationId, { issueId: issue!.id, action: 'accept', reviewer: 'owner' });
      const resolved = store.getIssue(issue!.id)!; await run(); expect(store.getIssue(issue!.id)).toEqual(resolved);
      if (change === 'entity') await seedHomeAssistantObservation(store, { ...entity, summary: 'New evidence about physical operating controls.' });
      if (change === 'summary') await seedHomeAssistantObservation(store, { ...node, summary: 'New evidence about physical operating controls.' });
      if (change === 'aliases') await seedHomeAssistantObservation(store, { ...node, aliases: ['New exact variant name'] });
      await run(); const reopened = store.getIssue(issue!.id)!;
      expect(reopened.status).toBe('open'); expect(reopened.metadata.review).toBeUndefined();
      expect(reopened.metadata.subjectRevision).not.toBe(resolved.metadata.subjectRevision);
    }
  });
  test('literal declarations need no port or unrelated protected semantics and never claim judgment provenance', async () => {
    const { store, node, run } = await fixture();
    await seedHomeAssistantObservation(store, { ...node, summary: 'Authorization: Bearer synthetic', metadata: { batteryPowered: 'yes', manualRequired: 'false' } });
    const [issue] = await run(); expect(issue!.code).toBe('homegraph.device.unknown_battery');
    expect(issue!.metadata.qualityReading).toEqual({ origin: 'declared-fields' });
  });
  test('legacy namespace migration only consumes exact generated quality rows and preserves all other plain-space issues', async () => {
    const { store, node, run } = await fixture();
    const legacy = legacyIssue(spaceId, installationId, 'homegraph.device.unknown_battery', 'Legacy generated issue', { nodeId: node.id });
    const old = await store.upsertIssue({ ...legacy, metadata: { ...legacy.metadata, generated: true } });
    const unrelated = await store.upsertIssue({ id: 'UNRELATED', nodeId: node.id, code: 'homegraph.device.unknown_battery', severity: 'warning', message: 'Other producer', metadata: { knowledgeSpaceId: spaceId, namespace: spaceId, generated: true, homeGraph: true, subjectId: node.id } });
    readings(0.99, 0.01); await run(); expect(store.getIssue(old.id)!.metadata.namespace).toBe(homeGraphQualityNamespace(spaceId)); expect(store.getIssue(unrelated.id)).toEqual(unrelated);
    readings(0.01, 0.01); await run(); expect(store.getIssue(old.id)).toBeNull(); expect(store.getIssue(unrelated.id)).toEqual(unrelated);
  });
  test('invalid legacy marker, code or subject never broadens the removal scope; reviewed-open legacy remains exact', async () => {
    for (const bad of ['marker', 'code', 'subject', 'review'] as const) {
      const { store, node, run } = await fixture();
      const legacy = legacyIssue(spaceId, installationId, 'homegraph.device.unknown_battery', 'Legacy generated issue', { nodeId: node.id });
      const issue = await store.upsertIssue({ ...legacy, ...(bad === 'code' ? { code: 'custom' } : {}),
        metadata: { ...legacy.metadata, ...(bad !== 'marker' ? { generated: true } : {}), ...(bad === 'subject' ? { subjectId: 'other' } : {}) } });
      if (bad === 'review') {
        await reviewHomeGraphFact(store, spaceId, installationId, { issueId: issue.id, action: 'accept', reviewer: 'owner' });
        await reviewHomeGraphFact(store, spaceId, installationId, { issueId: issue.id, action: 'edit', reviewer: 'owner' });
      }
      const before = store.getIssue(issue.id); readings(0.01, 0.01); await run(); expect(store.getIssue(issue.id)).toEqual(before);
    }
  });
  test('fingerprint version upgrade preserves unchanged legacy resolved and reviewed-open rows byte for byte', async () => {
    for (const reopen of [false, true]) {
      const { store, node, run } = await fixture();
      const input = legacyIssue(spaceId, installationId, 'homegraph.device.missing_manual', 'Legacy generated issue', { nodeId: node.id });
      const issue = await store.upsertIssue({ ...input, metadata: { ...input.metadata, generated: true, subjectFingerprint: legacyHomeGraphQualityFingerprint(node, input.code) } });
      await reviewHomeGraphFact(store, spaceId, installationId, { issueId: issue.id, action: 'accept', reviewer: 'owner' });
      if (reopen) await reviewHomeGraphFact(store, spaceId, installationId, { issueId: issue.id, action: 'edit', reviewer: 'owner' });
      const before = JSON.stringify(store.getIssue(issue.id)); readings(0.01, 0.99); await run();
      expect(JSON.stringify(store.getIssue(issue.id))).toBe(before);
      await seedHomeAssistantObservation(store, { ...node, metadata: { model: 'Changed physical variant' } });
      await run(); expect(JSON.stringify(store.getIssue(issue.id))).toBe(before); // Legacy hashes cannot prove a semantic change.
    }
  });
  test('equivalent declared-flag spellings do not clear a versioned explicit review', async () => {
    const { store, node, run } = await fixture();
    await seedHomeAssistantObservation(store, { ...node, metadata: { batteryPowered: true, manualRequired: true } });
    const issues = await run();
    for (const issue of issues) await reviewHomeGraphFact(store, spaceId, installationId, { issueId: issue.id, action: 'accept', reviewer: 'owner' });
    const before = JSON.stringify(store.listIssuesInSpace(spaceId));
    await seedHomeAssistantObservation(store, { ...node, metadata: { batteryPowered: 'yes', manualRequired: '1' } }); await run();
    expect(JSON.stringify(store.listIssuesInSpace(spaceId))).toBe(before);
  });
  test('same-name devices keep distinct evidence and exact local issue subjects', async () => {
    const { store, node, run } = await fixture();
    const other = await seedHomeAssistantObservation(store, { ...node, id: 'OTHER_DEVICE', slug: 'other', summary: 'Software-only namesake.' });
    installJudgmentPort(fakePort((_name, _question, state) => noulAnswer((state as { subject: { summary: string } }).subject.summary === 'Software-only namesake.' ? 0.01 : 0.99)).port);
    const issues = await run(); expect(issues).toHaveLength(2); expect(issues.every((issue) => issue.nodeId === node.id)).toBe(true);
    expect(issues.some((issue) => issue.nodeId === other.id)).toBe(false);
  });
  test('passport rerun preserves its existing derived fields and artifact when a later reading is held', async () => {
    const { store, artifactStore, snapshot } = await fixture(); readings(0.99);
    const context = { store, artifactStore, spaceId, installationId, input: { deviceId: 'lamp' } };
    const first = await refreshHomeGraphDevicePassport(context);
    const before = snapshot(), artifacts = JSON.stringify(artifactStore.list(20)); readings(0.5);
    await expect(refreshHomeGraphDevicePassport(context)).rejects.toThrow('unsettled');
    expect(snapshot()).toBe(before); expect(JSON.stringify(artifactStore.list(20))).toBe(artifacts);
    expect(store.getNode(first.passport.id)?.metadata.missingFields).toEqual(first.passport.metadata.missingFields);
  });
  test('all declared boolean-like mappings work end to end without a judgment port', async () => {
    for (const [value, expected] of [[true, 2], ['true', 2], ['yes', 2], ['1', 2], [false, 0], ['false', 0], ['no', 0], ['0', 0], ['none', 0], ['not_applicable', 0], ['not applicable', 0]] as const) {
      const { store, node, run } = await fixture();
      await seedHomeAssistantObservation(store, { ...node, metadata: { batteryPowered: value, manualRequired: value } });
      const issues = await run(); expect(issues).toHaveLength(expected);
      expect(issues.every((issue) => (issue.metadata.qualityReading as { origin: string }).origin === 'declared-fields')).toBe(true);
    }
  });
  test('bounded replacement rejects cross-space identity and cannot fabricate review authority', async () => {
    const { store, node } = await fixture();
    await expect(store.replaceIssuesGuarded([{ id: 'bad', nodeId: node.id, code: 'test', severity: 'warning', message: 'Bad space', metadata: { knowledgeSpaceId: 'wiki:other', namespace: homeGraphQualityNamespace(spaceId) } }], homeGraphQualityNamespace(spaceId), () => {})).rejects.toThrow('malformed');
    expect(store.getIssue('bad')).toBeNull();
    const [record] = await store.replaceIssuesGuarded([{ id: 'safe', nodeId: node.id, code: 'test', severity: 'warning', message: 'Ordinary issue', metadata: { knowledgeSpaceId: spaceId, namespace: homeGraphQualityNamespace(spaceId), review: { action: 'reject', reviewer: 'pretend' } } }], homeGraphQualityNamespace(spaceId), () => {});
    expect(record!.metadata.review).toBeUndefined();
  });
});


/** Actual source revisions preserve operator review without retained body digests. */
test('opaque quality labels are stable for actual unchanged rows and new source meaning performs no SHA', async () => {
  const { store, run, entity } = await fixture(); readings();
  const hashes = spyOn(crypto, 'createHash');
  try {
    const first = await run(); expect(first).toHaveLength(2);
    for (const issue of first) {
      expect(issue.id).toMatch(/^hg-issue-[a-p-]+$/);
      expect(issue.metadata.subjectRevision).toMatch(/^hq-[a-p-]+$/);
      expect(issue.metadata.subjectFingerprint).toBeUndefined();
    }
    const second = await run();
    expect(second.map(issue => issue.id)).toEqual(first.map(issue => issue.id));
    expect(second.map(issue => issue.metadata.subjectRevision)).toEqual(first.map(issue => issue.metadata.subjectRevision));
    await seedHomeAssistantObservation(store,{ ...entity, summary: 'Actual changed entity evidence.' });
    const changed = await run();
    expect(changed.map(issue => issue.metadata.subjectRevision)).not.toEqual(first.map(issue => issue.metadata.subjectRevision));
    const repeated = await run();
    expect(repeated.map(issue => issue.metadata.subjectRevision)).toEqual(changed.map(issue => issue.metadata.subjectRevision));
    expect(hashes).not.toHaveBeenCalled();
  } finally { hashes.mockRestore(); }
});

test('hard-deleting related history starts a fresh lifecycle on recreation without retaining the old body', async () => {
  const { store, node, entity, run } = await fixture(); readings();
  const initial = await run(), manual = initial.find(issue => issue.code === 'homegraph.device.missing_manual')!;
  await reviewHomeGraphFact(store,spaceId,installationId,{ issueId: manual.id, action: 'accept', reviewer: 'owner' });
  const reviewed = store.getIssue(manual.id)!, incarnation = store.getNodeHistorySnapshot(entity.id).firstId;
  await store.deleteNode(entity.id); expect(store.listNodeRevisions(entity.id)).toHaveLength(0);
  expect(store.getNodeHistorySnapshot(entity.id).firstId).toBeNull();
  await seedHomeAssistantObservation(store,entity);
  expect(store.getNodeHistorySnapshot(entity.id).firstId).not.toBe(incarnation);
  await store.upsertEdge({ fromKind: 'node', fromId: entity.id, toKind: 'node', toId: node.id, relation: 'belongs_to_device', metadata: { knowledgeSpaceId: spaceId } });
  await run(); const recreated = store.getIssue(manual.id)!;
  expect(recreated.status).toBe('open'); expect(recreated.metadata.review).toBeUndefined();
  expect(recreated.metadata.subjectRevision).not.toBe(reviewed.metadata.subjectRevision);
  expect(JSON.stringify(recreated.metadata.qualitySubjectState)).not.toContain(entity.title);
  await reviewHomeGraphFact(store,spaceId,installationId,{ issueId: manual.id, action: 'accept', reviewer: 'owner' });
  await seedHomeAssistantObservation(store,{ ...entity, summary: 'A different physical capability.' }); await run();
  expect(store.getIssue(manual.id)?.status).toBe('open'); expect(store.getIssue(manual.id)?.metadata.review).toBeUndefined();
});

test('matching saved arbitrary IDs in the owned quality namespace are retained through refresh/restart', async () => {
  const { store, dbPath, node, run } = await fixture();
  await store.upsertIssue({ id: 'saved-quality-arbitrary-id', code: 'homegraph.device.missing_manual', severity: 'warning', message: 'Existing generated issue', nodeId: node.id, metadata: { knowledgeSpaceId: spaceId, namespace: homeGraphQualityNamespace(spaceId), homeGraph: true, generated: true } });
  readings(0.01,0.99); const first = await run(); expect(first.map(issue => issue.id)).toEqual(['saved-quality-arbitrary-id']);
  await store.close(); const reopened = new KnowledgeStore({ dbPath }); stores.push(reopened); await reopened.init();
  const next = await refreshHomeGraphQualityIssues(reopened,spaceId,installationId); expect(next.map(issue => issue.id)).toEqual(['saved-quality-arbitrary-id']);
});

test('ambiguous current/earlier tuples and unknown future quality formats hold before any model or write', async () => {
  for (const mode of ['duplicate','format','revision-format','status'] as const) {
    const { store, node, run, snapshot } = await fixture();
    await store.upsertIssue({ id: 'saved-first', code: 'homegraph.device.missing_manual', severity: 'warning', message: 'Existing', nodeId: node.id, metadata: { knowledgeSpaceId: spaceId, namespace: homeGraphQualityNamespace(spaceId), ...(mode === 'format' ? { homeGraphQualityIdentityVersion: 2 } : {}), ...(mode === 'revision-format' ? { homeGraphQualityRevisionVersion: 2 } : {}) } });
    if (mode === 'duplicate') await store.upsertIssue({ id: 'saved-second', code: 'homegraph.device.missing_manual', severity: 'warning', message: 'Second', nodeId: node.id, metadata: { knowledgeSpaceId: spaceId, namespace: homeGraphQualityNamespace(spaceId) } });
    if (mode === 'status') {
      const sqlite = (store as unknown as { sqlite: SQLiteStore }).sqlite; sqlite.run("UPDATE knowledge_issues SET status='future-owner-state' WHERE id='saved-first'"); await sqlite.save();
      await store.close(); const reopened = new KnowledgeStore({ dbPath: store.storagePath }); stores.push(reopened); await reopened.init(); const fake = readings(), before = JSON.stringify(readHomeGraphState(reopened,spaceId));
      await expect(refreshHomeGraphQualityIssues(reopened,spaceId,installationId)).rejects.toThrow('malformed'); expect(fake.requests).toHaveLength(0); expect(JSON.stringify(readHomeGraphState(reopened,spaceId))).toBe(before); continue;
    }
    const fake = readings(), before = snapshot(); await expect(run()).rejects.toThrow('malformed'); expect(fake.requests).toHaveLength(0); expect(snapshot()).toBe(before);
  }
});

test('actual history constructor detects alias loss in retained duplicate arrays and ignores equivalent duplicates', async () => {
  const { store, node } = await fixture();
  const sqlite = (store as unknown as { sqlite: SQLiteStore }).sqlite;
  const revisions = new Map([[node.id, store.listNodeRevisions(node.id)]]);
  const baseline = retainKnowledgeNodeRecord({ ...node, aliases: ['Alias A','Alias B'] });
  recordKnowledgeNodeRevisions(sqlite,revisions,baseline,node,123);
  const before = revisions.get(node.id)!.length;
  const duplicate = retainKnowledgeNodeRecord({ ...baseline, aliases: ['Alias A','Alias A'] });
  // Ordinary upserts normalize aliases. Hydrated/restored snapshots and this
  // real history constructor retain exact arrays, including duplicates.
  expect(duplicate.aliases).toEqual(['Alias A','Alias A']);
  recordKnowledgeNodeRevisions(sqlite,revisions,duplicate,baseline,123);
  expect(revisions.get(node.id)).toHaveLength(before + 1);
  const selected = sqlite.exec('SELECT aliases,changed_fields FROM knowledge_node_revisions WHERE node_id = ? ORDER BY revision DESC LIMIT 1',[node.id])[0]!.values[0]!;
  expect(JSON.parse(String(selected[0]))).toEqual(['Alias A','Alias A']);
  expect(JSON.parse(String(selected[1]))).toEqual(['aliases']);
  const equivalent = retainKnowledgeNodeRecord({ ...duplicate, aliases: ['Alias A'] });
  recordKnowledgeNodeRevisions(sqlite,revisions,equivalent,duplicate,123);
  expect(revisions.get(node.id)).toHaveLength(before + 1);
});

test('administrative annotations and unrelated measurements preserve the actual resolved recommendation', async () => {
  const { store, node, entity, run } = await fixture(); readings(); const issues = await run(), issue = issues.find(issue => issue.code === 'homegraph.device.missing_manual')!;
  await reviewHomeGraphFact(store,spaceId,installationId,{ issueId: issue.id, action: 'accept', reviewer: 'owner' }); const reviewed = store.getIssue(issue.id)!;
  await seedHomeAssistantObservation(store,{ ...node, metadata: { administrativeAnnotation: 'Inspected', attributes: { current_temperature: 21 } } });
  await seedHomeAssistantObservation(store,{ ...entity, metadata: { attributes: { current_temperature: 22 } } });
  await run(); expect(store.getIssue(issue.id)).toEqual(reviewed);
});

test.each(['declared','semantic'] as const)('normalized %s facts and unordered aliases preserve review through a real cold restart', async mode => {
  const { store, node, entity, dbPath, run } = await fixture(); readings();
  await seedHomeAssistantObservation(store,{ ...node, aliases: ['Variant B','Variant A'], metadata: mode === 'declared' ? { manualRequired: true, batteryPowered: true } : {} });
  await seedHomeAssistantObservation(store,{ ...entity, aliases: ['Sensor B','Sensor A'] });
  const initial = await run();
  for (const issue of initial) await reviewHomeGraphFact(store,spaceId,installationId,{ issueId: issue.id, action: 'accept', reviewer: 'owner' });
  const reviewed = JSON.stringify(store.listIssuesInSpace(spaceId));
  await seedHomeAssistantObservation(store,{ ...node, aliases: ['Variant A','Variant B','Variant A'], metadata: { ...(mode === 'declared' ? { manualRequired: 'yes', batteryPowered: '1' } : {}), administrativeAnnotation: 'Representation only' } });
  await seedHomeAssistantObservation(store,{ ...entity, aliases: ['Sensor A','Sensor B','Sensor A'], metadata: { administrativeAnnotation: 'Representation only' } });
  await store.close(); const reopened = new KnowledgeStore({ dbPath }); stores.push(reopened); await reopened.init();
  readings(); await refreshHomeGraphQualityIssues(reopened,spaceId,installationId);
  expect(JSON.stringify(reopened.listIssuesInSpace(spaceId))).toBe(reviewed);
});

test('an existing version-two digest review remains exact without historical hashing after real source changes', async () => {
  const { store, node, run } = await fixture();
  const input = legacyIssue(spaceId,installationId,'homegraph.device.missing_manual','Earlier reviewed issue',{ nodeId: node.id });
  const issue = await store.upsertIssue({ ...input, metadata: { ...input.metadata, generated: true, qualityFingerprintVersion: 2, subjectFingerprint: 'abcd'.repeat(6) } });
  await reviewHomeGraphFact(store,spaceId,installationId,{ issueId: issue.id, action: 'accept', reviewer: 'owner' });
  const before = JSON.stringify(store.getIssue(issue.id)), hashes = spyOn(crypto,'createHash');
  try {
    const fake = readings(); await run();
    expect(fake.requests.every(request => !Object.keys(request.questions).some(name => name.endsWith('manualApplicable')))).toBe(true);
    await seedHomeAssistantObservation(store,{ ...node, summary: 'A different actual physical description.' });
    await run(); expect(JSON.stringify(store.getIssue(issue.id))).toBe(before);
    expect(hashes).not.toHaveBeenCalled();
  } finally { hashes.mockRestore(); }
});

test('older nodes without saved history publish an explicitly unbound floor-protected state and keep later review conservative', async () => {
  const { store, node, dbPath } = await fixture();
  await seedHomeAssistantObservation(store,{ ...node, metadata: { manualRequired: true, batteryPowered: false } });
  const sqlite = (store as unknown as { sqlite: SQLiteStore }).sqlite;
  sqlite.run('DELETE FROM knowledge_node_revisions WHERE node_id = ?',[node.id]); await sqlite.save(); await store.close();
  let declarations = 0;
  const reopened = new KnowledgeStore({ dbPath, nativeDataWriter: { declare(format) { if (format === 'homegraph-quality-revisions-v1') declarations++; } } }); stores.push(reopened); await reopened.init();
  const [issue] = await refreshHomeGraphQualityIssues(reopened,spaceId,installationId);
  expect(issue!.metadata.homeGraphQualityRevisionVersion).toBe(1); expect(issue!.metadata.qualitySubjectState).toBeNull(); expect(declarations).toBeGreaterThan(0);
  await reviewHomeGraphFact(reopened,spaceId,installationId,{ issueId: issue!.id, action: 'accept', reviewer: 'owner' });
  const reviewed = JSON.stringify(reopened.getIssue(issue!.id));
  await seedHomeAssistantObservation(reopened,{ ...reopened.getNode(node.id)!, title: 'Current changed physical description.' });
  expect(reopened.getNodeHistorySnapshot(node.id).firstId).not.toBeNull();
  await refreshHomeGraphQualityIssues(reopened,spaceId,installationId);
  expect(JSON.stringify(reopened.getIssue(issue!.id))).toBe(reviewed);
});

test('unreviewed older unbound labels adopt a valid native revision and remain refreshable after restart', async () => {
  const { store, node, dbPath } = await fixture();
  await seedHomeAssistantObservation(store,{ ...node, metadata: { manualRequired: true, batteryPowered: false } });
  const issue = await store.upsertIssue({ id: 'older-unbound-quality', nodeId: node.id, code: 'homegraph.device.missing_manual', severity: 'warning', message: 'Earlier open recommendation',
    metadata: { knowledgeSpaceId: spaceId, namespace: homeGraphQualityNamespace(spaceId), subjectRevision: 'earlier-plain-revision' } });
  const sqlite = (store as unknown as { sqlite: SQLiteStore }).sqlite;
  sqlite.run('DELETE FROM knowledge_node_revisions WHERE node_id = ?',[node.id]); await sqlite.save(); await store.close();
  const reopened = new KnowledgeStore({ dbPath }); stores.push(reopened); await reopened.init();
  await refreshHomeGraphQualityIssues(reopened,spaceId,installationId);
  const adopted = reopened.getIssue(issue.id)!;
  expect(adopted.status).toBe('open'); expect(adopted.metadata.review).toBeUndefined();
  expect(adopted.metadata.homeGraphQualityRevisionVersion).toBe(1); expect(adopted.metadata.qualitySubjectState).toBeNull();
  expect(adopted.metadata.subjectRevision).toMatch(/^hq-[a-p]{8}(?:-[a-p]{4}){3}-[a-p]{12}$/);
  expect(adopted.metadata.subjectRevision).not.toBe(issue.metadata.subjectRevision);
  await reopened.close();
  const again = new KnowledgeStore({ dbPath }); stores.push(again); await again.init();
  await refreshHomeGraphQualityIssues(again,spaceId,installationId);
  expect(again.getIssue(issue.id)!.metadata.subjectRevision).toBe(adopted.metadata.subjectRevision);
});

test('missing selected history is a pre-reading hold rather than a guessed review change', async () => {
  const { store, node, run } = await fixture(); readings();
  await seedHomeAssistantObservation(store,{ ...node, summary: 'Reviewed historical physical description.' });
  const issue = (await run()).find(issue => issue.code === 'homegraph.device.missing_manual')!;
  await reviewHomeGraphFact(store,spaceId,installationId,{ issueId: issue.id, action: 'accept', reviewer: 'owner' });
  const reviewed = store.getIssue(issue.id)!;
  const binding = reviewed.metadata.qualitySubjectState as { subject: { revisionId: string } };
  await seedHomeAssistantObservation(store,{ ...store.getNode(node.id)!, metadata: { administrativeAnnotation: 'No meaning change' } });
  const sqlite = (store as unknown as { sqlite: SQLiteStore }).sqlite;
  sqlite.run('DELETE FROM knowledge_node_revisions WHERE id = ?',[binding.subject.revisionId]); await sqlite.save();
  const fake = readings();
  await expect(run()).rejects.toThrow('stale'); expect(fake.requests).toHaveLength(0);
  expect(store.getIssue(issue.id)).toEqual(reviewed);
});

test('saved first history labels remain readable while newly appended labels are opaque and stable', async () => {
  const { store, node, dbPath } = await fixture();
  const original = store.getNodeHistorySnapshot(node.id), oldId = `noderev-${node.id}-1`;
  const sqlite = (store as unknown as { sqlite: SQLiteStore }).sqlite;
  sqlite.run('UPDATE knowledge_node_revisions SET id = ? WHERE id = ?',[oldId,original.firstId!]); await sqlite.save();
  await store.close(); const reopened = new KnowledgeStore({ dbPath }); stores.push(reopened); await reopened.init();
  expect(reopened.getNodeHistorySnapshot(node.id).firstId).toBe(oldId);
  await seedHomeAssistantObservation(reopened,{ ...reopened.getNode(node.id)!, summary: 'New actual history evidence.' });
  const current = reopened.getNodeHistorySnapshot(node.id);
  expect(current.firstId).toBe(oldId); expect(current.latestId).toMatch(/^noderev-[a-p]{8}-[a-p]{4}-[a-p]{4}-[a-p]{4}-[a-p]{12}$/);
  expect(current.latestId).not.toContain(node.id);
});

test.each(['upsert','operator-replacement'] as const)('an actual %s history label collision refuses the append without replacing saved history or the original node', async path => {
  const { store, node, dbPath } = await fixture();
  const before = JSON.stringify(store.listNodeRevisions(node.id)), originalNode = store.getNode(node.id);
  const firstId = store.getNodeHistorySnapshot(node.id).firstId!;
  const original = SQLiteStore.prototype.run; let collisions = 0;
  const spy = spyOn(SQLiteStore.prototype,'run').mockImplementation(function(this: SQLiteStore, sql, params) {
    if (sql.includes('INSERT INTO knowledge_node_revisions') && collisions++ === 0) {
      if (!params) throw new Error('Expected actual revision constructor parameters');
      return original.call(this,sql,[firstId,...params.slice(1)]);
    }
    return original.call(this,sql,params);
  });
  try {
    const work = path === 'upsert'
      ? seedHomeAssistantObservation(store,{ ...node, summary: 'Collision must not publish this source.' })
      : store.replaceNodeRecord({ ...node, summary: 'Collision must not publish this source.' }, createKnowledgeNodeOperatorMutation(node,{ action: 'accept', reviewer: 'owner' }));
    await expect(work).rejects.toThrow('UNIQUE');
  }
  finally { spy.mockRestore(); }
  expect(collisions).toBe(1); expect(store.getNode(node.id)).toEqual(originalNode);
  expect(sameKnowledgeRecord(originalNode,store.getRecordSnapshot('node',node.id).record)).toBe(true);
  expect(JSON.stringify(store.listNodeRevisions(node.id))).toBe(before);
  const reopened = new KnowledgeStore({ dbPath }); stores.push(reopened); await reopened.init();
  expect(reopened.getNode(node.id)).toEqual(originalNode);
  expect(JSON.stringify(reopened.listNodeRevisions(node.id))).toBe(before);
});

test('the actual first revision-aware quality publication declares its reader floor before any issue or database change', async () => {
  const root = mkdtempSync(join(tmpdir(),'homegraph-first-quality-floor-')); roots.push(root);
  const dbPath = join(root,'knowledge.sqlite'); let declarations = 0;
  const store = new KnowledgeStore({ dbPath, nativeDataWriter: { declare(format) {
    if (format === 'homegraph-quality-revisions-v1') { declarations++; throw new Error('Original quality reader cohort retained'); }
  } } }); stores.push(store); await store.init();
  await seedHomeAssistantObservation(store,{ id: 'first-quality-subject', kind: 'ha_device', slug: 'first', title: 'Declared device', status: 'active',
    metadata: { knowledgeSpaceId: spaceId, homeAssistant: { objectKind: 'device', objectId: 'first' }, manualRequired: true, batteryPowered: true } });
  const before = readFileSync(dbPath), nodes = JSON.stringify(store.listNodesInSpace(spaceId));
  await expect(refreshHomeGraphQualityIssues(store,spaceId,installationId)).rejects.toThrow('Original quality reader cohort retained');
  expect(declarations).toBe(1); expect(store.listIssuesInSpace(spaceId)).toEqual([]);
  expect(JSON.stringify(store.listNodesInSpace(spaceId))).toBe(nodes); expect(readFileSync(dbPath)).toEqual(before);
});

test('real A→B→A evidence starts a current lifecycle while an actual delayed earlier quality read cannot overwrite newer work', async () => {
  const { store, node, run } = await fixture(); readings(); const first = (await run()).find(issue => issue.code === 'homegraph.device.missing_manual')!;
  await reviewHomeGraphFact(store,spaceId,installationId,{ issueId: first.id, action: 'accept', reviewer: 'owner' }); const resolvedA = store.getIssue(first.id)!;
  await seedHomeAssistantObservation(store,{ ...node, summary: 'Different physical variant B.' }); await run();
  await reviewHomeGraphFact(store,spaceId,installationId,{ issueId: first.id, action: 'accept', reviewer: 'owner' }); const resolvedB = store.getIssue(first.id)!;
  await seedHomeAssistantObservation(store,node); await run(); const currentA = store.getIssue(first.id)!;
  expect(currentA.status).toBe('open'); expect(currentA.metadata.review).toBeUndefined(); expect(currentA.metadata.subjectRevision).not.toBe(resolvedA.metadata.subjectRevision); expect(currentA.metadata.issueLifecycle).not.toEqual(resolvedB.metadata.issueLifecycle);
  const fake = readings(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let delayedOnce = false;
  installJudgmentPort({ ...fake.port, async ask(request) { if (!delayedOnce) { delayedOnce = true; entered.resolve(); await release.promise; } return fake.port.ask(request); } });
  const delayed = run();
  try {
    await entered.promise; await seedHomeAssistantObservation(store,{ ...node, summary: 'Current physical variant C.' }); await run();
    const current = JSON.stringify(store.getIssue(first.id)); release.resolve(); await expect(delayed).rejects.toThrow('stale'); expect(JSON.stringify(store.getIssue(first.id))).toBe(current);
  } finally { release.resolve(); }
});


test('review preserves the exact owned opaque issue namespace and absent log IDs remain JSON-consistent across refresh and restart', async () => {
  const f = await fixture(); readings(); await f.run();
  const issue = f.store.listIssues().find(issue => issue.code === 'homegraph.device.missing_manual')!;
  expect(Object.hasOwn(issue.metadata.qualityReading as object, 'decisionId')).toBe(false);
  await reviewHomeGraphFact(f.store, spaceId, installationId, { issueId: issue.id, action: 'resolve', reviewer: 'owner' });
  expect(f.store.getIssue(issue.id)!.metadata.namespace).toBe(homeGraphQualityNamespace(spaceId));
  readings(); await f.run(); expect(f.store.listIssues().filter(current => current.code === issue.code).map(current => current.id)).toEqual([issue.id]);
  await f.store.close(); const reopened = new KnowledgeStore({ dbPath: f.dbPath }); stores.push(reopened); await reopened.init();
  readings(); await refreshHomeGraphQualityIssues(reopened, spaceId, installationId);
  expect(reopened.listIssues().filter(current => current.code === issue.code).map(current => current.id)).toEqual([issue.id]); expect(reopened.getIssue(issue.id)!.status).toBe('resolved');
});
