import { JudgmentError } from '@goodvibes-jev/judgment';
import * as qualityFingerprint from '../platform/src/platform/knowledge/home-graph/quality/fingerprint.js';
import { seedHomeAssistantObservation } from './_helpers/homegraph-observation-fixtures.js';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
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
      expect(reopened.metadata.subjectFingerprint).not.toBe(resolved.metadata.subjectFingerprint);
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


/** Source regressions for the reviewed-meaning commitment and real new labels. UNRUN. */
test('opaque quality issue IDs are chosen once while unchanged native inputs reuse their semantic commitment', async () => {
  const { store, run, entity } = await fixture(); readings();
  const digest = spyOn(qualityFingerprint, 'homeGraphQualitySubjectFingerprint');
  try {
    const first = await run(); expect(first).toHaveLength(2); expect(digest).toHaveBeenCalledTimes(2);
    for (const issue of first) expect(issue.id).toMatch(/^hg-issue-[a-p-]+$/);
    const second = await run(); expect(second.map(issue => issue.id)).toEqual(first.map(issue => issue.id)); expect(digest).toHaveBeenCalledTimes(2);
    await seedHomeAssistantObservation(store,{ ...entity, summary: 'Actual changed entity evidence.' });
    await run(); expect(digest).toHaveBeenCalledTimes(4); await run(); expect(digest).toHaveBeenCalledTimes(4);
  } finally { digest.mockRestore(); }
});

test('hard-deleting related history and recreating identical semantic evidence preserves review; changed evidence reopens', async () => {
  const { store, node, entity, run } = await fixture(); readings(); const initial = await run(), manual = initial.find(issue => issue.code === 'homegraph.device.missing_manual')!;
  await reviewHomeGraphFact(store,spaceId,installationId,{ issueId: manual.id, action: 'accept', reviewer: 'owner' }); const reviewed = store.getIssue(manual.id)!;
  await store.deleteNode(entity.id); expect(store.listNodeRevisions(entity.id)).toHaveLength(0);
  await seedHomeAssistantObservation(store,entity); await store.upsertEdge({ fromKind: 'node', fromId: entity.id, toKind: 'node', toId: node.id, relation: 'belongs_to_device', metadata: { knowledgeSpaceId: spaceId } });
  await run(); expect(store.getIssue(manual.id)).toEqual(reviewed);
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
  for (const mode of ['duplicate','format','status'] as const) {
    const { store, node, run, snapshot } = await fixture();
    await store.upsertIssue({ id: 'saved-first', code: 'homegraph.device.missing_manual', severity: 'warning', message: 'Existing', nodeId: node.id, metadata: { knowledgeSpaceId: spaceId, namespace: homeGraphQualityNamespace(spaceId), ...(mode === 'format' ? { homeGraphQualityIdentityVersion: 2 } : {}) } });
    if (mode === 'duplicate') await store.upsertIssue({ id: 'saved-second', code: 'homegraph.device.missing_manual', severity: 'warning', message: 'Second', nodeId: node.id, metadata: { knowledgeSpaceId: spaceId, namespace: homeGraphQualityNamespace(spaceId) } });
    if (mode === 'status') {
      const sqlite = (store as unknown as { sqlite: SQLiteStore }).sqlite; sqlite.run("UPDATE knowledge_issues SET status='future-owner-state' WHERE id='saved-first'"); await sqlite.save();
      await store.close(); const reopened = new KnowledgeStore({ dbPath: store.storagePath }); stores.push(reopened); await reopened.init(); const fake = readings(), before = JSON.stringify(readHomeGraphState(reopened,spaceId));
      await expect(refreshHomeGraphQualityIssues(reopened,spaceId,installationId)).rejects.toThrow('malformed'); expect(fake.requests).toHaveLength(0); expect(JSON.stringify(readHomeGraphState(reopened,spaceId))).toBe(before); continue;
    }
    const fake = readings(), before = snapshot(); await expect(run()).rejects.toThrow('malformed'); expect(fake.requests).toHaveLength(0); expect(snapshot()).toBe(before);
  }
});

test('administrative annotations and unrelated measurements preserve the actual resolved recommendation', async () => {
  const { store, node, entity, run } = await fixture(); readings(); const issues = await run(), issue = issues.find(issue => issue.code === 'homegraph.device.missing_manual')!;
  await reviewHomeGraphFact(store,spaceId,installationId,{ issueId: issue.id, action: 'accept', reviewer: 'owner' }); const reviewed = store.getIssue(issue.id)!;
  await seedHomeAssistantObservation(store,{ ...node, metadata: { administrativeAnnotation: 'Inspected', attributes: { current_temperature: 21 } } });
  await seedHomeAssistantObservation(store,{ ...entity, metadata: { attributes: { current_temperature: 22 } } });
  await run(); expect(store.getIssue(issue.id)).toEqual(reviewed);
});

test('real A→B→A evidence starts a current lifecycle while an actual delayed earlier quality read cannot overwrite newer work', async () => {
  const { store, node, run } = await fixture(); readings(); const first = (await run()).find(issue => issue.code === 'homegraph.device.missing_manual')!;
  await reviewHomeGraphFact(store,spaceId,installationId,{ issueId: first.id, action: 'accept', reviewer: 'owner' }); const resolvedA = store.getIssue(first.id)!;
  await seedHomeAssistantObservation(store,{ ...node, summary: 'Different physical variant B.' }); await run();
  await reviewHomeGraphFact(store,spaceId,installationId,{ issueId: first.id, action: 'accept', reviewer: 'owner' }); const resolvedB = store.getIssue(first.id)!;
  await seedHomeAssistantObservation(store,node); await run(); const currentA = store.getIssue(first.id)!;
  expect(currentA.status).toBe('open'); expect(currentA.metadata.review).toBeUndefined(); expect(currentA.metadata.subjectFingerprint).toBe(resolvedA.metadata.subjectFingerprint); expect(currentA.metadata.issueLifecycle).not.toEqual(resolvedB.metadata.issueLifecycle);
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
