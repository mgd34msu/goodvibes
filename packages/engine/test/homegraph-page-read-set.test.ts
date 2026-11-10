import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { SQLiteStore, type SqlDatabase } from '../platform/src/platform/state/sqlite-store.js';
import { retainHomeGraphPageInputs } from '../platform/src/platform/knowledge/home-graph/page-read-set.js';
import { KnowledgeSourceQualityHeldError } from '../platform/src/platform/knowledge/source-quality.js';
import { seedHomeAssistantObservation } from './_helpers/homegraph-observation-fixtures.js';

const resources: { root: string; store: KnowledgeStore }[] = [];
afterEach(async () => {
  for (const { root, store } of resources.splice(0)) {
    try { await store.close(); } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

function expectStale(read: () => void): void {
  let failure: unknown;
  try { read(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(KnowledgeSourceQualityHeldError);
  expect(failure).toMatchObject({ reason: 'stale' });
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'homegraph-page-read-set-'));
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); resources.push({ root, store });
  await store.init();
  const metadata = { knowledgeSpaceId: 'homeassistant:read-set' };
  const source = await store.upsertSource({ id: 'page-source', connectorId: 'homeassistant', sourceType: 'manual',
    title: 'Actual page reference', status: 'indexed', metadata });
  const extraction = await store.upsertExtraction({ id: 'page-extraction', sourceId: source.id, extractorId: 'text',
    format: 'text', excerpt: 'Original page source body.', metadata });
  const device = await seedHomeAssistantObservation(store, { id: 'page-device', kind: 'ha_device', slug: 'page-device',
    title: 'Actual device', status: 'active', metadata: { ...metadata, homeAssistant: { objectKind: 'device', objectId: 'device' } } });
  const area = await seedHomeAssistantObservation(store, { id: 'page-area', kind: 'ha_area', slug: 'page-area',
    title: 'Actual area', status: 'active', metadata: { ...metadata, homeAssistant: { objectKind: 'area', objectId: 'area' } } });
  const edge = await store.upsertEdge({ fromKind: 'node', fromId: device.id, toKind: 'node', toId: area.id,
    relation: 'located_in', metadata });
  const retain = () => retainHomeGraphPageInputs(store, { sources: [source], nodes: [device, area], edges: [edge] });
  return { root, store, source, extraction, device, area, edge, retain, metadata };
}

test('page guards compare every original record and edge generation in closed batches', async () => {
  const f = await fixture(), current = f.retain();
  const sqlite = (f.store as unknown as { sqlite: SQLiteStore }).sqlite;
  const reader = sqlite as unknown as { readPrivatePersistedRows(sql: string, params: string[], closedReadSet?: boolean): ReturnType<SqlDatabase['exec']> };
  const read = reader.readPrivatePersistedRows.bind(sqlite);
  const queries: { sql: string; params: string[]; closed: boolean }[] = [];
  const reading = spyOn(reader, 'readPrivatePersistedRows').mockImplementation((sql, params, closedReadSet) => {
    queries.push({ sql, params: [...params], closed: closedReadSet === true });
    return read(sql, params, closedReadSet);
  });
  try {
    expect(current).not.toThrow();
    expect(queries.filter(query => query.sql.startsWith('SELECT gv_revision FROM '))).toEqual([
      { sql: 'SELECT gv_revision FROM knowledge_sources WHERE id = ? LIMIT 1', params: [f.source.id], closed: true },
      { sql: 'SELECT gv_revision FROM knowledge_extractions WHERE id = ? LIMIT 1', params: [f.extraction.id], closed: true },
      { sql: 'SELECT gv_revision FROM knowledge_nodes WHERE id = ? LIMIT 1', params: [f.device.id], closed: true },
      { sql: 'SELECT gv_revision FROM knowledge_nodes WHERE id = ? LIMIT 1', params: [f.area.id], closed: true },
      { sql: 'SELECT gv_revision FROM knowledge_edges WHERE id = ? LIMIT 1', params: [f.edge.id], closed: true },
    ]);
    expect(queries.some(query => query.sql.startsWith('SELECT * FROM knowledge_edges'))).toBe(false);
  } finally { reading.mockRestore(); }
});

for (const kind of ['record', 'edge'] as const) for (const layer of ['store-instance', 'store-prototype', 'sqlite-instance', 'sqlite-prototype'] as const) {
  test(`a replaced ${layer} ${kind} generation getter cannot forge the original page read-set after a real revision change`, async () => {
    const f = await fixture(), current = f.retain();
    const sqlite = (f.store as unknown as { sqlite: SQLiteStore }).sqlite;
    const expected = kind === 'record' ? f.store.getRecordGenerations([
      { kind: 'source', id: f.source.id }, { kind: 'extraction', id: f.extraction.id },
      { kind: 'node', id: f.device.id }, { kind: 'node', id: f.area.id },
    ]) : f.store.getEdgeGenerations([f.edge.id]);
    const table = kind === 'record' ? 'knowledge_nodes' : 'knowledge_edges', id = kind === 'record' ? f.device.id : f.edge.id;
    const original = sqlite.exec(`SELECT gv_revision FROM ${table} WHERE id = ?`, [id])[0]?.values[0]?.[0];
    const revision = `kr-${(original === `kr-${'a'.repeat(32)}` ? 'b' : 'a').repeat(32)}`;
    sqlite.run(`UPDATE ${table} SET gv_revision = ? WHERE id = ?`, [revision, id]); await sqlite.save();
    const storeMethod = kind === 'record' ? 'getRecordGenerations' : 'getEdgeGenerations';
    const sqliteMethod = kind === 'record' ? 'readPersistedRecordGenerations' : 'readPersistedEdgeGenerations';
    const spoof = layer === 'store-instance' ? spyOn(f.store, storeMethod).mockReturnValue(expected)
      : layer === 'store-prototype' ? spyOn(KnowledgeStore.prototype, storeMethod).mockReturnValue(expected)
      : layer === 'sqlite-instance' ? spyOn(sqlite, sqliteMethod).mockReturnValue(expected)
      : spyOn(SQLiteStore.prototype, sqliteMethod).mockReturnValue(expected);
    try { expectStale(current); expect(spoof).not.toHaveBeenCalled(); }
    finally { spoof.mockRestore(); }
  });
}

test.each(['source', 'extraction', 'node', 'edge'] as const)('a changed actual %s cannot reuse the retained page input', async kind => {
  const f = await fixture(), current = f.retain();
  if (kind === 'source') await f.store.upsertSource({ ...f.source, summary: 'Changed source observation.' });
  if (kind === 'extraction') await f.store.upsertExtraction({ ...f.extraction, excerpt: 'Changed extracted body.' });
  if (kind === 'node') await seedHomeAssistantObservation(f.store, { ...f.device, summary: 'Changed physical observation.' });
  if (kind === 'edge') await f.store.replaceEdgeRecord({ ...f.edge, weight: 0.25 });
  expectStale(current);
});

test.each(['source', 'extraction', 'node', 'edge'] as const)('the original %s generation is checked even while its in-memory contents remain identical', async kind => {
  const f = await fixture(), current = f.retain();
  const sqlite = (f.store as unknown as { sqlite: SQLiteStore }).sqlite;
  const table = kind === 'source' ? 'knowledge_sources' : kind === 'extraction' ? 'knowledge_extractions' : kind === 'node' ? 'knowledge_nodes' : 'knowledge_edges';
  const id = kind === 'source' ? f.source.id : kind === 'extraction' ? f.extraction.id : kind === 'node' ? f.device.id : f.edge.id;
  const original = sqlite.exec(`SELECT gv_revision FROM ${table} WHERE id = ?`, [id])[0]?.values[0]?.[0];
  const revision = `kr-${(original === `kr-${'a'.repeat(32)}` ? 'b' : 'a').repeat(32)}`;
  expect(current).not.toThrow();
  sqlite.run(`UPDATE ${table} SET gv_revision = ? WHERE id = ?`, [revision, id]); await sqlite.save();
  expectStale(current);
});

test.each(['source', 'extraction', 'node', 'edge'] as const)('a missing original %s cannot become a successful page check', async kind => {
  const f = await fixture(), current = f.retain();
  if (kind === 'source') await f.store.deleteSource(f.source.id);
  if (kind === 'node') await f.store.deleteNode(f.device.id);
  if (kind === 'edge') await f.store.deleteEdge(f.edge.id);
  if (kind === 'extraction') {
    const sqlite = (f.store as unknown as { sqlite: SQLiteStore }).sqlite;
    sqlite.run('DELETE FROM knowledge_extractions WHERE id = ?', [f.extraction.id]); await sqlite.save();
  }
  expectStale(current);
});

test('same-byte physical replacement inside an original record getter retires the complete native frame', async () => {
  const f = await fixture(), current = f.retain(), getNode = f.store.getNode.bind(f.store);
  const original = readFileSync(f.store.storagePath); let replaced = false;
  const reading = spyOn(f.store, 'getNode').mockImplementation(id => {
    if (!replaced && id === f.device.id) {
      replaced = true; const path = f.store.storagePath + '.replacement';
      writeFileSync(path, original); renameSync(path, f.store.storagePath);
    }
    return getNode(id);
  });
  try { expectStale(current); expect(replaced).toBe(true); }
  finally { reading.mockRestore(); }
  expect(readFileSync(f.store.storagePath)).toEqual(original);
});

test('new selected-endpoint links retire the original edge window while unrelated links do not', async () => {
  const f = await fixture(), current = f.retain();
  const left = await seedHomeAssistantObservation(f.store, { id: 'outside-left', kind: 'ha_device', slug: 'outside-left', title: 'Other device', status: 'active', metadata: f.metadata });
  const right = await seedHomeAssistantObservation(f.store, { id: 'outside-right', kind: 'ha_area', slug: 'outside-right', title: 'Other area', status: 'active', metadata: f.metadata });
  await f.store.upsertEdge({ fromKind: 'node', fromId: left.id, toKind: 'node', toId: right.id, relation: 'located_in', metadata: f.metadata });
  expect(current).not.toThrow();
  await f.store.upsertEdge({ fromKind: 'source', fromId: f.source.id, toKind: 'node', toId: f.area.id, relation: 'source_for', metadata: f.metadata });
  expectStale(current);
});

test('an empty page read-set performs no native work even after its unused store closes', async () => {
  const f = await fixture(); await f.store.close();
  const frame = spyOn(f.store, 'assertRecordSnapshotFrame');
  try { const current = retainHomeGraphPageInputs(f.store, { sources: [], nodes: [], edges: [] }); expect(current).not.toThrow(); expect(frame).not.toHaveBeenCalled(); }
  finally { frame.mockRestore(); }
});
