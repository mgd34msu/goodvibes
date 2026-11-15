/**
 * Knowledge store integrity: what a write, a delete or a reload leaves in memory
 * and in the saved file must agree, and a half-applied change must not survive.
 */
import { afterEach, expect, setSystemTime, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { KnowledgeProjectionIdentityHeldError, generatedProjectionIdentityMetadata } from '../platform/src/platform/knowledge/store-generated-projection-selector.js';
import { createKnowledgeIssueOperatorMutation } from '../platform/src/platform/knowledge/store-lifecycle-authority.js';
import { mapScheduleRow } from '../platform/src/platform/knowledge/store-schema.js';
import { createKnowledgeWorkLedgerStorage } from '../platform/src/platform/knowledge/store-work-ledger.js';
import type { SQLiteStore } from '../platform/src/platform/state/sqlite-store.js';
import { logger } from '../platform/src/platform/utils/logger.js';

const roots: string[] = [];
const stores: KnowledgeStore[] = [];
afterEach(async () => {
  setSystemTime();
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function path(): string {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-integrity-'));
  roots.push(root);
  return join(root, 'knowledge.sqlite');
}
async function open(file: string): Promise<KnowledgeStore> {
  const store = new KnowledgeStore({ dbPath: file });
  stores.push(store);
  await store.init();
  return store;
}
async function reopen(store: KnowledgeStore, file: string): Promise<KnowledgeStore> {
  await store.close();
  stores.splice(stores.indexOf(store), 1);
  return open(file);
}
const source = (id: string, extra: Record<string, unknown> = {}) => ({ id, connectorId: 'fixture', sourceType: 'manual' as const, status: 'indexed' as const, ...extra });
const fact = (id: string, sourceId: string, metadata: Record<string, unknown> = {}) => ({ id, kind: 'fact' as const, slug: id, title: id, confidence: 50, sourceId, metadata });
const extraction = (id: string, sourceId: string) => ({ id, sourceId, extractorId: 'fixture', format: 'text' as const });

interface RunProbe { sqlite: Pick<SQLiteStore, 'run'> }
const sqliteOf = (store: KnowledgeStore): Pick<SQLiteStore, 'run'> => (store as unknown as RunProbe).sqlite;

// ── job runs ─────────────────────────────────────────────────────────────────

test('a job run keeps its first creation time after later updates, a reload and a restart', async () => {
  const file = path();
  let store = await open(file);
  setSystemTime(new Date(1_000_000));
  const first = await store.upsertJobRun({ id: 'run-1', jobId: 'job', status: 'queued', mode: 'inline' });
  setSystemTime(new Date(2_000_000));
  const second = await store.upsertJobRun({ id: 'run-1', jobId: 'job', status: 'running', mode: 'inline' });
  expect(second.createdAt).toBe(first.createdAt);
  store = await reopen(store, file);
  expect(store.getJobRun('run-1')!.createdAt).toBe(first.createdAt);
  expect(store.getJobRun('run-1')!.updatedAt).toBe(2_000_000);
});

test('a late write cannot move a settled job run back to running or queued', async () => {
  const store = await open(path());
  const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
  try {
    await store.upsertJobRun({ id: 'run-1', jobId: 'job', status: 'queued', mode: 'inline' });
    await store.upsertJobRun({ id: 'run-1', jobId: 'job', status: 'running', mode: 'inline' });
    await store.upsertJobRun({ id: 'run-1', jobId: 'job', status: 'completed', mode: 'inline', completedAt: 5 });
    const late = await store.upsertJobRun({ id: 'run-1', jobId: 'job', status: 'running', mode: 'inline' });
    expect(late.status).toBe('completed');
    expect(store.getJobRun('run-1')!.status).toBe('completed');
    expect(store.getJobRun('run-1')!.completedAt).toBe(5);
    expect(warn).toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

// ── usage retention ──────────────────────────────────────────────────────────

test('usage records beyond the retention cap are dropped oldest-first, in memory and in the saved file', async () => {
  const file = path();
  let store = await open(file);
  for (let at = 1; at <= 5; at++) {
    setSystemTime(new Date(at * 1000));
    await store.upsertUsageRecord({ id: `use-${at}`, targetKind: 'source', targetId: 's', usageKind: 'item-open' });
  }
  expect(store.pruneUsageRecords(2)).toBe(3);
  expect(store.listUsageRecords(100).map((record) => record.id).sort()).toEqual(['use-4', 'use-5']);
  // The next ordinary write saves the pruned image.
  setSystemTime(new Date(6000));
  await store.upsertUsageRecord({ id: 'use-6', targetKind: 'source', targetId: 's', usageKind: 'item-open' });
  store = await reopen(store, file);
  expect(store.listUsageRecords(100).map((record) => record.id).sort()).toEqual(['use-4', 'use-5', 'use-6']);
});

test('recording usage without bound stays within the retention cap', async () => {
  const store = await open(path());
  await store.batch(async () => {
    for (let index = 0; index < 11_001; index++) await store.upsertUsageRecord({ targetKind: 'source', targetId: 's', usageKind: 'item-open' });
  });
  expect(store.status().usageCount).toBe(10_000);
});

// ── operator-reviewed issues ─────────────────────────────────────────────────

test('replacing a namespace keeps an issue an operator reviewed and drops one nobody touched', async () => {
  const store = await open(path());
  await store.upsertSource(source('s'));
  const metadata = { namespace: 'lint' };
  await store.upsertIssue({ id: 'untouched', severity: 'info', code: 'c', message: 'm', sourceId: 's', metadata });
  await store.upsertIssue({ id: 'reviewed', severity: 'info', code: 'c', message: 'm', sourceId: 's', metadata });
  await store.upsertIssue({ id: 'reviewed', severity: 'info', code: 'c', message: 'm', status: 'open', sourceId: 's', metadata: { ...metadata, review: { action: 'reopen' } } },
    createKnowledgeIssueOperatorMutation(store.getIssue('reviewed')!));
  expect(store.getIssue('reviewed')!.metadata.review).toBeDefined();
  await store.replaceIssues([], 'lint');
  expect(store.getIssue('untouched')).toBeNull();
  expect(store.getIssue('reviewed')).not.toBeNull();
});

// ── displaced rows ───────────────────────────────────────────────────────────

test('a second extraction for one source replaces the first in memory exactly as it does in the file', async () => {
  const file = path();
  let store = await open(file);
  await store.upsertSource(source('s'));
  await store.upsertExtraction(extraction('e1', 's'));
  await store.upsertExtraction(extraction('e2', 's'));
  expect(store.listExtractions(100).map((record) => record.id)).toEqual(['e2']);
  expect(store.getExtractionBySourceId('s')!.id).toBe('e2');
  store = await reopen(store, file);
  expect(store.listExtractions(100).map((record) => record.id)).toEqual(['e2']);
});

test('restoring an edge under a new id for the same endpoints leaves one edge in memory and in the file', async () => {
  const file = path();
  let store = await open(file);
  const edge = (id: string) => ({ id, fromKind: 'source' as const, fromId: 'a', toKind: 'source' as const, toId: 'b', relation: 'links_to', weight: 1, metadata: {}, createdAt: 1, updatedAt: 1 });
  await store.replaceEdgeRecord(edge('edge-1'));
  await store.replaceEdgeRecord(edge('edge-2'));
  expect(store.listEdges().map((record) => record.id)).toEqual(['edge-2']);
  store = await reopen(store, file);
  expect(store.listEdges().map((record) => record.id)).toEqual(['edge-2']);
});

// ── delete ───────────────────────────────────────────────────────────────────

test('deleting a source also deletes the nodes it produced, and keeps a node another live source still backs', async () => {
  const file = path();
  let store = await open(file);
  await store.upsertSource(source('gone'));
  await store.upsertSource(source('other'));
  await store.upsertNode(fact('only-gone', 'gone'));
  await store.upsertNode(fact('shared', 'gone', { sourceIds: ['gone', 'other'] }));
  await store.upsertNode(fact('unrelated', 'other'));
  await store.upsertEdge({ fromKind: 'node', fromId: 'only-gone', toKind: 'source', toId: 'gone', relation: 'supports_fact' });
  await store.upsertIssue({ id: 'node-issue', severity: 'info', code: 'c', message: 'm', nodeId: 'only-gone' });

  expect(await store.deleteSource('gone')).toBe(true);
  const ids = () => store.listNodes(100).map((node) => node.id).sort();
  expect(ids()).toEqual(['shared', 'unrelated']);
  expect(store.getIssue('node-issue')).toBeNull();
  expect(store.listEdges()).toEqual([]);
  store = await reopen(store, file);
  expect(ids()).toEqual(['shared', 'unrelated']);
  expect(store.getSource('gone')).toBeNull();
});

test('a delete that fails part-way leaves every row and map as it was', async () => {
  const file = path();
  const store = await open(file);
  await store.upsertSource(source('s'));
  await store.upsertNode(fact('n', 's'));
  await store.upsertEdge({ fromKind: 'node', fromId: 'n', toKind: 'source', toId: 's', relation: 'supports_fact' });
  await store.upsertIssue({ id: 'i', severity: 'info', code: 'c', message: 'm', nodeId: 'n' });

  const sqlite = sqliteOf(store);
  const run = sqlite.run.bind(sqlite);
  sqlite.run = (sql, params) => {
    if (sql.startsWith('DELETE FROM knowledge_nodes')) throw new Error('disk full');
    run(sql, params);
  };
  await expect(store.deleteNode('n')).rejects.toThrow('disk full');
  sqlite.run = run;

  expect(store.getNode('n')).not.toBeNull();
  expect(store.getIssue('i')).not.toBeNull();
  expect(store.listEdges().length).toBe(1);
  expect(await store.deleteNode('n')).toBe(true);
  expect(store.getIssue('i')).toBeNull();
  expect(store.listEdges()).toEqual([]);
});

// ── partial source updates ───────────────────────────────────────────────────

test('a status-only source update keeps the title, addresses, summary and description', async () => {
  const file = path();
  let store = await open(file);
  await store.upsertSource(source('s', { title: 'Title', sourceUri: 'https://a.example/x', canonicalUri: 'https://a.example/x', summary: 'Sum', description: 'Desc' }));
  await store.upsertSource({ id: 's', connectorId: 'fixture', sourceType: 'manual', status: 'failed' });
  const kept = store.getSource('s')!;
  expect([kept.status, kept.title, kept.sourceUri, kept.canonicalUri, kept.summary, kept.description])
    .toEqual(['failed', 'Title', 'https://a.example/x', 'https://a.example/x', 'Sum', 'Desc']);
  expect(store.getSourceByCanonicalUri('https://a.example/x')!.id).toBe('s');
  store = await reopen(store, file);
  expect(store.getSource('s')!.canonicalUri).toBe('https://a.example/x');
});

// ── generated projection identity ────────────────────────────────────────────

test('a source that carries another projection\'s identity is refused and the projection survives', async () => {
  const store = await open(path());
  const identity = { scopeKind: 'space' as const, spaceId: 'space-1', targetKind: 'overview' as const, targetId: 'overview' };
  const projection = (id: string) => ({
    id, connectorId: 'knowledge-projection', sourceType: 'manual' as const, status: 'indexed' as const,
    metadata: generatedProjectionIdentityMetadata(identity),
  });
  await store.upsertSource(projection('projection-a'));
  await expect(store.upsertSource(projection('imposter'))).rejects.toBeInstanceOf(KnowledgeProjectionIdentityHeldError);
  expect(store.getSource('projection-a')).not.toBeNull();
  expect(store.getSource('imposter')).toBeNull();
  // The projection's own row still updates.
  await store.upsertSource({ ...projection('projection-a'), title: 'Renewed' });
  expect(store.getSource('projection-a')!.title).toBe('Renewed');
});

// ── stored schedules ─────────────────────────────────────────────────────────

test('a stored schedule that cannot run loads disabled with the reason, and a good one is unchanged', () => {
  const columns = ['id', 'job_id', 'label', 'enabled', 'schedule', 'last_run_at', 'next_run_at', 'metadata', 'created_at', 'updated_at'];
  const row = (id: string, schedule: string) => mapScheduleRow(columns, [id, 'job', 'label', 1, schedule, null, 1_700_000_000_000, '{}', 1, 1]);
  for (const bad of ['x', '{"kind":"at","at":0}', '{"kind":"weird"}', 'null']) {
    const loaded = row('bad', bad);
    expect(loaded.enabled).toBe(false);
    expect(loaded.nextRunAt).toBeUndefined();
    expect(String(loaded.metadata.disabledReason)).toContain('stored schedule');
  }
  const good = row('good', '{"kind":"every","intervalMs":3600000}');
  expect(good.enabled).toBe(true);
  expect(good.nextRunAt).toBe(1_700_000_000_000);
  expect(good.metadata.disabledReason).toBeUndefined();
});

// ── work ledger observation ──────────────────────────────────────────────────

test('a ledger feed that cannot be read is reported once, not silently and not on every poll', async () => {
  let failure: Error | null = new Error('Work ledger persisted format is invalid');
  const sqlite = { readPersisted: () => { if (failure) throw failure; throw new Error('ledger read is not part of this probe'); } } as unknown as SQLiteStore;
  const storage = createKnowledgeWorkLedgerStorage(sqlite, 'project', () => undefined);
  const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
  try {
    const stops = [storage.subscribe(() => undefined), storage.subscribe(() => undefined), storage.subscribe(() => undefined)];
    await Promise.resolve();
    expect(warn).toHaveBeenCalledTimes(1);
    failure = new Error('Work ledger persisted identity is invalid');
    stops.push(storage.subscribe(() => undefined));
    await Promise.resolve();
    expect(warn).toHaveBeenCalledTimes(2);
    for (const stop of stops) stop();
  } finally {
    warn.mockRestore();
    await storage.close();
  }
});

test('a subscriber is told once per distinct failure that the ledger feed is unavailable, including one that subscribes later', async () => {
  let failure: Error | null = new Error('Work ledger persisted format is invalid');
  const sqlite = { readPersisted: () => { if (failure) throw failure; throw new Error('ledger read is not part of this probe'); } } as unknown as SQLiteStore;
  const storage = createKnowledgeWorkLedgerStorage(sqlite, 'project', () => undefined);
  const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
  const first: string[] = [];
  const late: string[] = [];
  try {
    const stopFirst = storage.subscribe(() => undefined, reason => first.push(reason));
    await Promise.resolve();
    const stopLate = storage.subscribe(() => undefined, reason => late.push(reason));
    await Promise.resolve();
    expect(first).toEqual(['Work ledger persisted format is invalid']);
    expect(late).toEqual(['Work ledger persisted format is invalid']);
    failure = new Error('Work ledger persisted identity is invalid');
    const stopThird = storage.subscribe(() => undefined, reason => first.push(reason));
    await Promise.resolve();
    expect(first.slice(1)).toEqual(['Work ledger persisted identity is invalid', 'Work ledger persisted identity is invalid']);
    stopFirst(); stopLate(); stopThird();
  } finally {
    warn.mockRestore();
    await storage.close();
  }
});

test('a schedule write keeps the store from reloading its own saved file', async () => {
  const store = await open(path());
  await store.upsertSchedule({ jobId: 'job', label: 'job', schedule: { kind: 'every', intervalMs: 60_000 } });
  expect(await store.refreshIfChanged()).toBe(false);
});

// ── reads see other processes' saves ─────────────────────────────────────────

test('a store adopts a record another store saved, without writing anything itself', async () => {
  const file = path();
  const reader = await open(file);
  const writer = await open(file);
  await writer.upsertSource(source('from-writer'));
  expect(reader.getSource('from-writer')).toBeNull();

  expect(await reader.refreshIfChanged()).toBe(true);
  expect(reader.listSources(100).map((record) => record.id)).toEqual(['from-writer']);
  // Nothing changed since: no second reload.
  expect(await reader.refreshIfChanged()).toBe(false);
});

test('a store keeps its own saves as current and does not reload after them', async () => {
  const store = await open(path());
  await store.upsertSource(source('mine'));
  expect(await store.refreshIfChanged()).toBe(false);
});
