import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeStore, KnowledgeStoreConflictError } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { SQLiteStore } from '@goodvibes-jev/engine/platform/platform/state';
import { normalizeEverySchedule } from '../platform/src/platform/automation/schedules.js';

const roots: string[] = [];
const stores: KnowledgeStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function path(): string { const root = mkdtempSync(join(tmpdir(), 'knowledge-reload-')); roots.push(root); return join(root, 'knowledge.sqlite'); }
async function open(file: string): Promise<KnowledgeStore> { const store = new KnowledgeStore({ dbPath: file }); stores.push(store); await store.init(); return store; }
const source = (id: string) => ({ id, connectorId: 'fixture', sourceType: 'manual' as const, status: 'indexed' as const });

test('a write that loses the save race to another process reloads the store instead of fencing it forever', async () => {
  const file = path();
  const a = await open(file); await a.upsertSource(source('seed'));
  const b = await open(file);
  const schedule = await b.upsertSchedule({ jobId: 'knowledge-lint', label: 'Lint', enabled: true, schedule: normalizeEverySchedule('1h'), metadata: {} });

  await expect(a.upsertSource(source('lost'))).rejects.toBeInstanceOf(KnowledgeStoreConflictError);
  expect(a.getSource('lost')).toBeNull();
  expect(a.getSchedule(schedule.id)).not.toBeNull();

  await a.upsertSource(source('retried'));
  const reopened = await open(file);
  expect(reopened.getSource('retried')).not.toBeNull();
  expect(reopened.getSchedule(schedule.id)).not.toBeNull();
});

test('a fenced SQLite cache reports not ready and init() reopens it from disk', async () => {
  const file = path();
  const schema = (db: { run(sql: string): void }) => db.run('CREATE TABLE IF NOT EXISTS fixture (value TEXT)');
  const store = new SQLiteStore(file, { coordinated: true });
  await store.init(schema); store.run("INSERT INTO fixture VALUES ('original')"); await store.save();
  const result = await store.transactPersisted(db => { db.run("INSERT INTO fixture VALUES ('published')"); return { changed: true, value: 1 }; },
    () => { throw new Error('mirror refresh failed'); });
  // The change is durable; the failed mirror refresh is reported on the result.
  expect(result).toEqual({ kind: 'completed', value: 1, fenced: true });
  expect(store.isReady).toBe(false);
  expect(() => store.run("INSERT INTO fixture VALUES ('refused')")).toThrow('cache fenced');

  await store.init(schema);
  expect(store.isReady).toBe(true);
  store.run("INSERT INTO fixture VALUES ('after-reopen')"); await store.save();
  const reopened = new SQLiteStore(file, { coordinated: true }); await reopened.init(schema);
  expect(reopened.exec('SELECT value FROM fixture ORDER BY rowid')[0]?.values).toEqual([['original'], ['published'], ['after-reopen']]);
  store.close(); reopened.close();
});
