/** Synthetic storage and explicit readings only; no provider or user state. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { inferKnowledgeInjectionTrustTier } from '../platform/src/platform/knowledge/shared.js';
import {
  decideKnowledgeConsolidationCandidate as decide,
  refreshKnowledgeConsolidationCandidates as refresh,
  runKnowledgeConsolidation as run,
  type KnowledgeConsolidationContext,
} from '../platform/src/platform/knowledge/consolidation.js';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '../platform/src/platform/state/index.js';
import { authoredPrivacyAnswer, type AuthoredPrivacy } from './_helpers/authored-error-readings.js';

const roots: string[] = [];
const memories: MemoryStore[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => {
  installJudgmentPort(previous);
  for (const memory of memories.splice(0)) memory.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function readings(keep = 0.97, cls = 'architecture', confidence = 0.97, privacy?: AuthoredPrivacy) {
  const readPrivacy = authoredPrivacyAnswer(privacy ?? { parts: [] });
  const fake = fakePort((name, question, state) => {
    if (name === 'keep') return noulAnswer(keep);
    if (name === 'memory_class') return choiceAnswer(question, cls, confidence);
    if (name === 'kind') return readPrivacy(name, question, state);
    throw new Error(`Unexpected fixture question: ${name}`);
  });
  installJudgmentPort(fake.port);
  return fake;
}

async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-consolidation-judgment-'));
  roots.push(root);
  const configManager = new ConfigManager({ configDir: join(root, 'config') });
  const memory = new MemoryStore(join(root, 'memory.sqlite'), {
    embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }), enableVectorIndex: false,
  });
  memories.push(memory);
  const dbPath = join(root, 'knowledge.sqlite');
  const store = new KnowledgeStore({ dbPath });
  await store.init();
  const context: KnowledgeConsolidationContext = { store, memoryRegistry: new MemoryRegistry(memory), syncReviewedMemory: async () => {} };
  async function source(summary = 'Persist order and outbox event in the same transaction.', count = 1) {
    const record = await store.upsertSource({ connectorId: 'url', sourceType: 'url', title: 'Outbox invariant', summary, sessionId: 'synthetic-session', tags: ['outbox'], status: 'indexed' });
    for (let i = 0; i < count; i++) await store.upsertUsageRecord({ targetKind: 'source', targetId: record.id, usageKind: 'search-hit', sessionId: 'synthetic-session', score: 1 });
    return record;
  }
  return { context, store, memory, source, dbPath };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function pauseReading(fake: ReturnType<typeof readings>) {
  const started = deferred(); const release = deferred();
  installJudgmentPort({ ...fake.port, async ask(request) {
    started.resolve(); await release.promise; return fake.port.ask(request);
  } });
  return { started: started.promise, release: release.resolve };
}

describe('knowledge consolidation reading', () => {
  test('a rarely used durable decision reaches the queue and uses its content class', async () => {
    const h = await harness(); await h.source(); const fake = readings();
    const [candidate] = await refresh(h.context);
    expect(candidate?.score).toBe(97);
    expect(candidate?.suggestedMemoryClass).toBe('architecture');
    expect(candidate?.metadata.judgmentOutcome).toBe('act');
    expect(candidate?.metadata.usageCount).toBe(1);
    expect(candidate?.metadata.subjectRevision).toBe(h.store.getSourceGeneration(candidate!.subjectId));
    expect(candidate?.metadata).not.toHaveProperty('subjectFingerprint');
    expect(candidate?.evidence).toContain('used 1 time(s) in the last 30 days');
    expect(fake.requests).toHaveLength(1);
    expect(JSON.stringify(fake.requests[0]?.state)).toContain('Persist order and outbox event');
    expect(h.memory.isReady).toBe(false);
  });

  test('the complete summary is judged and retained rather than a misleading display prefix', async () => {
    const h = await harness();
    const summary = 'Historical design detail. '.repeat(20) + 'This approach is superseded; do not use it for current orders.';
    await h.source(summary); const fake = readings(); const [candidate] = await refresh(h.context);
    expect(JSON.stringify(fake.requests[0]?.state)).toContain('This approach is superseded');
    expect(candidate?.summary).toBe(summary);
  });

  test('the requested limit bounds model requests independently of worth', async () => {
    const h = await harness(); await h.source(); await h.source('Another invariant.');
    const fake = readings(0.03); expect(await refresh(h.context, 1)).toEqual([]);
    expect(fake.requests).toHaveLength(1);
  });

  test('structured source identifiers retain every colon and their exact provenance', async () => {
    const h = await harness();
    const source = await h.store.upsertSource({ id: 'source:fixture:outbox', connectorId: 'url', sourceType: 'url', title: 'Outbox invariant', summary: 'Persist order and outbox event in one transaction.', status: 'indexed' });
    await h.store.upsertUsageRecord({ targetKind: 'source', targetId: source.id, usageKind: 'search-hit' });
    readings(); await run(h.context, 'deep-consolidation', { autoPromote: true });
    expect(h.store.listConsolidationCandidates()[0]?.subjectId).toBe(source.id);
    expect(h.memory.retrieve()[0]?.provenance).toContainEqual({ kind: 'event', ref: source.id, label: 'knowledge source' });
  });

  test('high usage and relations do not override a no reading', async () => {
    const h = await harness(); await h.source('Lunch arrives in five minutes.', 30); readings(0.03, 'fact');
    const report = await run(h.context, 'deep-consolidation', { autoPromote: true });
    expect(report.metrics.acceptedCount).toBe(0);
    expect(h.store.listConsolidationCandidates()).toHaveLength(0);
    expect(h.memory.isReady).toBe(false);
  });

  test('confirm-band worth is review staging, never an unattended durable write', async () => {
    const h = await harness(); await h.source(); readings(0.75);
    await run(h.context, 'deep-consolidation', { autoPromote: true });
    const [candidate] = h.store.listConsolidationCandidates();
    expect(candidate?.status).toBe('open');
    expect(candidate?.metadata.judgmentOutcome).toBe('confirm');
    expect(h.memory.isReady).toBe(false);
    await decide(h.context, candidate!.id, 'accept', { decidedBy: 'owner', memoryClass: 'decision' });
    expect(h.memory.retrieve()[0]?.cls).toBe('decision');
    const memory = h.memory.retrieve()[0]!;
    expect(memory.reviewState).toBe('reviewed');
    expect(memory.reviewedBy).toBe('owner');
    expect(memory.reviewedAt).toBeNumber();
    expect(inferKnowledgeInjectionTrustTier(memory.reviewState)).toBe('reviewed');
    expect(h.store.getConsolidationCandidate(candidate!.id)?.metadata.decisionAuthority).toBe('operator');
  });

  test('uncertain class blocks automatic promotion even when worth acts', async () => {
    const h = await harness(); await h.source(); readings(0.97, 'architecture', 0.65);
    await run(h.context, 'deep-consolidation', { autoPromote: true });
    expect(h.store.listConsolidationCandidates()[0]?.metadata.classOutcome).toBe('confirm');
    expect(h.memory.isReady).toBe(false);
  });

  test('unsettled worth does not stage, supersede or write', async () => {
    const h = await harness(); await h.source(); readings(); const [before] = await refresh(h.context);
    readings(0.5); await run(h.context, 'deep-consolidation', { autoPromote: true });
    expect(h.store.getConsolidationCandidate(before!.id)).toEqual(before!);
    expect(h.memory.isReady).toBe(false);
  });

  test('missing and failed ports preserve state and fail visibly', async () => {
    const h = await harness(); await h.source();
    await expect(run(h.context, 'deep-consolidation', { autoPromote: true })).rejects.toThrow('No judgment port');
    const fake = readings();
    installJudgmentPort({ ...fake.port, async ask() { throw new Error('Synthetic transport unavailable'); } });
    await expect(refresh(h.context)).rejects.toThrow('Synthetic transport unavailable');
    expect(h.store.listConsolidationCandidates()).toHaveLength(0);
    expect(h.memory.isReady).toBe(false);
  });

  test('a later unavailable reading holds the entire automatic promotion batch', async () => {
    const h = await harness(); await h.source(); await h.source('A second independently observed constraint.');
    const fake = readings(); let calls = 0;
    installJudgmentPort({ ...fake.port, async ask(request) {
      if (++calls === 2) throw new Error('Synthetic later reading unavailable');
      return fake.port.ask(request);
    } });
    await expect(run(h.context, 'deep-consolidation', { autoPromote: true })).rejects.toThrow('later reading unavailable');
    expect(h.store.listConsolidationCandidates()).toHaveLength(1);
    expect(h.store.listConsolidationCandidates()[0]?.status).toBe('open');
    expect(h.memory.isReady).toBe(false);
  });

  test('source-refresh remains a review candidate rather than a memory promotion', async () => {
    const h = await harness(); const source = await h.source();
    await h.store.upsertSource({ ...source, status: 'stale' }); readings();
    await run(h.context, 'deep-consolidation', { autoPromote: true });
    expect(h.store.listConsolidationCandidates()[0]?.candidateType).toBe('source-refresh');
    expect(h.store.listConsolidationCandidates()[0]?.status).toBe('open');
    expect(h.memory.isReady).toBe(false);
  });

  test('known protected content is refused before the fake port receives it', async () => {
    const h = await harness(); await h.source('Authorization: Bearer synthetic-secret-token'); const fake = readings();
    await expect(refresh(h.context)).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
    expect(h.store.listConsolidationCandidates()).toHaveLength(0);
  });

  test('auto promotion keeps source and session provenance, and reruns are idempotent', async () => {
    const h = await harness(); const source = await h.source();
    const usage = h.store.listUsageRecords()[0]!;
    const fake = readings(0.97, 'runbook', 0.97, { parts: [], fields: { ready: 'other', path: 'other', id: 'other', cls: 'other' } });
    await run(h.context, 'deep-consolidation', { autoPromote: true });
    const candidate = h.store.listConsolidationCandidates()[0]!;
    const memory = h.memory.retrieve()[0]!;
    expect(candidate.status).toBe('accepted');
    expect(memory.cls).toBe('runbook');
    expect(memory.provenance).toEqual(expect.arrayContaining([
      { kind: 'session', ref: source.sessionId },
      { kind: 'event', ref: source.id, label: 'knowledge source' },
      { kind: 'event', ref: candidate.id, label: 'knowledge consolidation candidate' },
    ]));
    expect(memory.confidence).toBe(97);
    expect(memory.reviewState).toBe('fresh');
    expect(memory.reviewedBy).toBeUndefined();
    expect(memory.reviewedAt).toBeUndefined();
    expect(inferKnowledgeInjectionTrustTier(memory.reviewState)).toBe('fresh');
    expect(candidate.metadata.decisionAuthority).toBe('automatic');
    await run(h.context, 'deep-consolidation', { autoPromote: true });
    await decide(h.context, candidate.id, 'accept', { decidedBy: 'later retry' });
    expect(h.memory.retrieve()).toHaveLength(1);
    expect(h.store.getConsolidationCandidate(candidate.id)).toEqual(candidate);
    expect(fake.requests[0]).toMatchObject({
      state: { subject: { title: 'Outbox invariant', summary: source.summary, kind: 'url', status: 'indexed',
        trust: 'untrusted-reference-material', reviewState: 'unreviewed' },
        usage: { count: 1, usageKinds: ['search-hit'], sessionCount: 1, lastUsedAt: new Date(usage.createdAt).toISOString(), relationCount: 0 } },
      context: { battery: 'engine.knowledge.consolidation' },
    });
    expect(Object.keys(fake.requests[0]!.questions)).toEqual(['keep', 'memory_class']);
    expect(fake.requests).toHaveLength(1);
  });

  test('terminal history cannot fill the result limit and starve a new open candidate', async () => {
    const h = await harness(); await h.source(); readings();
    await run(h.context, 'deep-consolidation', { autoPromote: true, limit: 1 });
    const settled = h.store.listConsolidationCandidates()[0]!;
    await h.source('The billing transaction keeps its own outbox event.'); readings(0.9);
    await run(h.context, 'deep-consolidation', { autoPromote: true, limit: 1 });
    expect(h.memory.retrieve()).toHaveLength(2);
    expect(h.store.getConsolidationCandidate(settled.id)).toEqual(settled);
  });

  test('terminal operator decisions survive refresh without another model call', async () => {
    const h = await harness(); await h.source(); const fake = readings(); const [candidate] = await refresh(h.context);
    const rejected = await decide(h.context, candidate!.id, 'reject', { decidedBy: 'owner', memoryClass: 'fact' });
    installJudgmentPort(undefined);
    expect(await refresh(h.context)).toEqual([rejected]);
    expect(fake.requests).toHaveLength(1);
    expect(h.memory.isReady).toBe(false);
  });

  test('an operator decision during the reading preserves the complete terminal record', async () => {
    const h = await harness(); await h.source(); const fake = readings(); const [candidate] = await refresh(h.context);
    const paused = pauseReading(fake); const refreshing = refresh(h.context); await paused.started;
    const rejected = await decide(h.context, candidate!.id, 'reject', { decidedBy: 'owner', memoryClass: 'ownership' });
    paused.release(); await refreshing;
    expect(h.store.getConsolidationCandidate(candidate!.id)).toEqual(rejected);
  });

  test('changed content during a reading cannot authorize the new subject', async () => {
    const h = await harness(); const source = await h.source(); const paused = pauseReading(readings());
    const refreshing = refresh(h.context); await paused.started;
    await h.store.upsertSource({ ...source, summary: 'The design was superseded; this assertion is no longer true.' });
    paused.release(); expect(await refreshing).toEqual([]);
    expect(h.memory.isReady).toBe(false);
  });

  test('an explicitly accepted stale snapshot fails before memory write', async () => {
    const h = await harness(); const source = await h.source(); readings(); const [candidate] = await refresh(h.context);
    await h.store.upsertSource({ ...source, summary: 'Changed after the reading.' });
    await expect(decide(h.context, candidate!.id, 'accept')).rejects.toThrow('stale');
    expect(h.memory.isReady).toBe(false);
  });

  test('restoring source A after B during a reading does not restore the old candidate permission', async () => {
    const h = await harness(); const source = await h.source();
    const originalRevision = h.store.getSourceGeneration(source.id);
    const paused = pauseReading(readings()); const refreshing = refresh(h.context); await paused.started;
    await h.store.upsertSource({ ...source, summary: 'Intermediate changed claim.' });
    await h.store.upsertSource(source);
    expect(h.store.getSource(source.id)?.summary).toBe(source.summary);
    expect(h.store.getSourceGeneration(source.id)).not.toBe(originalRevision);
    paused.release(); expect(await refreshing).toEqual([]);
    expect(h.memory.isReady).toBe(false);
  });

  test('acceptance rejects an A-B-A source change and keeps the candidate open for refresh', async () => {
    const h = await harness(); const source = await h.source(); readings(); const [candidate] = await refresh(h.context);
    await h.store.upsertSource({ ...source, summary: 'Temporarily changed claim.' }); await h.store.upsertSource(source);
    await expect(decide(h.context, candidate!.id, 'accept')).rejects.toThrow('stale');
    expect(h.store.getConsolidationCandidate(candidate!.id)?.status).toBe('open');
    expect(h.memory.isReady).toBe(false);
    const [refreshed] = await refresh(h.context);
    expect(refreshed?.metadata.subjectRevision).not.toBe(candidate!.metadata.subjectRevision);
    await decide(h.context, refreshed!.id, 'accept');
    expect(h.memory.retrieve()).toHaveLength(1);
  });

  test('digest-only previews require a fresh reading while terminal decisions remain idempotent', async () => {
    const h = await harness(); await h.source(); readings(); const [candidate] = await refresh(h.context);
    // Shape of an open preview written by a released digest-based reader.
    const { subjectRevision: _revision, ...metadata } = candidate!.metadata;
    const oldMetadata = { ...metadata, subjectFingerprint: 'a'.repeat(64) };
    const sqlite = (h.store as unknown as { sqlite: { run(sql: string, values: unknown[]): void; save(): Promise<void> } }).sqlite;
    sqlite.run('UPDATE knowledge_consolidation_candidates SET metadata = ? WHERE id = ?', [JSON.stringify(oldMetadata), candidate!.id]);
    await sqlite.save(); await h.store.close();
    const restarted = new KnowledgeStore({ dbPath: h.dbPath });
    const context = { ...h.context, store: restarted };
    try {
      await restarted.init();
      await expect(decide(context, candidate!.id, 'accept')).rejects.toThrow('stale');
      expect(h.memory.isReady).toBe(false);
      const [refreshed] = await refresh(context);
      expect(refreshed?.metadata.subjectRevision).toBe(restarted.getSourceGeneration(candidate!.subjectId));
      const accepted = await decide(context, candidate!.id, 'accept');
      installJudgmentPort(undefined);
      expect(await decide(context, candidate!.id, 'accept')).toEqual(accepted);
      expect(h.memory.retrieve()).toHaveLength(1);
    } finally { await restarted.close(); }
  });

  test('an unchanged persisted row revision accepts after reopening without another decision reading', async () => {
    const h = await harness(); await h.source(); const fake = readings(); const [candidate] = await refresh(h.context);
    await h.store.close(); const restarted = new KnowledgeStore({ dbPath: h.dbPath });
    try {
      await restarted.init();
      const originalRevision = candidate!.metadata.subjectRevision;
      if (typeof originalRevision !== 'string') throw new Error('Consolidation fixture lost its native source revision');
      expect(restarted.getSourceGeneration(candidate!.subjectId)).toBe(originalRevision);
      await decide({ ...h.context, store: restarted }, candidate!.id, 'accept');
      expect(h.memory.retrieve()).toHaveLength(1); expect(fake.requests).toHaveLength(1);
    } finally { await restarted.close(); }
  });

  test('a node and source sharing an ID do not share consolidation evidence', async () => {
    const h = await harness(); const source = await h.source();
    await h.store.upsertNode({ id: source.id, kind: 'topic', slug: 'separate-node', title: 'Separate node', summary: 'Only the node summary.', status: 'draft' });
    await h.store.upsertUsageRecord({ targetKind: 'node', targetId: source.id, usageKind: 'search-hit' });
    const fake = readings(); const candidates = await refresh(h.context);
    const node = candidates.find(candidate => candidate.subjectKind === 'node');
    const sourceCandidate = candidates.find(candidate => candidate.subjectKind === 'source');
    expect(node?.summary).toBe('Only the node summary.');
    expect(node?.metadata.subjectRevision).toBe(h.store.getRecordGeneration('node', source.id));
    expect(sourceCandidate?.metadata.subjectRevision).toBe(h.store.getSourceGeneration(source.id));
    expect(node?.metadata.subjectRevision).not.toBe(sourceCandidate?.metadata.subjectRevision);
    expect(fake.requests.some(request => JSON.stringify(request.state).includes('Only the node summary.'))).toBe(true);
    await h.store.upsertSource({ ...source, summary: 'Unrelated source edit.' });
    await expect(decide(h.context, sourceCandidate!.id, 'accept')).rejects.toThrow('stale');
    await decide(h.context, node!.id, 'accept'); expect(h.memory.retrieve()).toHaveLength(1);
  });

  test('the reading and its row revision refer to the same persisted source instead of a stale cache', async () => {
    const h = await harness(); const source = await h.source();
    const sqlite = (h.store as unknown as { sqlite: { run(sql: string, values: unknown[]): void; save(): Promise<void> } }).sqlite;
    sqlite.run('UPDATE knowledge_sources SET summary = ? WHERE id = ?', ['Actual persisted source statement.', source.id]);
    await sqlite.save();
    expect(h.store.getSource(source.id)?.summary).toBe(source.summary);
    const fake = readings(); const [candidate] = await refresh(h.context);
    expect(candidate?.summary).toBe('Actual persisted source statement.');
    expect(candidate?.metadata.subjectRevision).toBe(h.store.getSourceGeneration(source.id));
    expect(JSON.stringify(fake.requests[0]?.state)).toContain('Actual persisted source statement.');
    expect(JSON.stringify(fake.requests[0]?.state)).not.toContain(source.summary!);
  });

  test('the row revision is checked at the memory write boundary after a delayed registry call', async () => {
    const h = await harness(); const source = await h.source(); readings(); const [candidate] = await refresh(h.context);
    const add = h.context.memoryRegistry.add.bind(h.context.memoryRegistry);
    h.context.memoryRegistry.add = async (input, operation) => {
      await h.store.upsertSource({ ...source, summary: 'Changed after memory initialization.' });
      return add(input, operation);
    };
    await expect(decide(h.context, candidate!.id, 'accept')).rejects.toThrow('changed before its memory write');
    expect(h.memory.retrieve()).toHaveLength(0);
    expect(h.store.getConsolidationCandidate(candidate!.id)?.status).toBe('open');
  });

  test('concurrent accepts serialize and create one durable record', async () => {
    const h = await harness(); await h.source(); readings(); const [candidate] = await refresh(h.context);
    const results = await Promise.all([decide(h.context, candidate!.id, 'accept'), decide(h.context, candidate!.id, 'accept')]);
    expect(results[0]?.metadata.acceptedMemoryId).toBe(results[1]?.metadata.acceptedMemoryId);
    expect(h.memory.retrieve()).toHaveLength(1);
  });

  test('retry after candidate persistence failure recovers the committed memory by provenance', async () => {
    const h = await harness(); await h.source(); readings(); const [candidate] = await refresh(h.context);
    const upsert = h.store.upsertConsolidationCandidate.bind(h.store);
    h.store.upsertConsolidationCandidate = async () => { throw new Error('Synthetic candidate save failure'); };
    await expect(decide(h.context, candidate!.id, 'accept')).rejects.toThrow('Synthetic candidate save failure');
    expect(h.memory.retrieve()).toHaveLength(1);
    h.store.upsertConsolidationCandidate = upsert;
    await decide(h.context, candidate!.id, 'accept');
    expect(h.memory.retrieve()).toHaveLength(1);
    expect(h.store.getConsolidationCandidate(candidate!.id)?.status).toBe('accepted');
  });
});
