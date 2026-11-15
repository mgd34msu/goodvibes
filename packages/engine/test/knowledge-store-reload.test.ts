import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeStore } from '@goodvibes-jev/engine/platform/platform/knowledge';

const roots: string[] = [];
const stores: KnowledgeStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function path(): string { const root = mkdtempSync(join(tmpdir(), 'knowledge-reload-')); roots.push(root); return join(root, 'knowledge.sqlite'); }
async function open(file: string): Promise<KnowledgeStore> { const store = new KnowledgeStore({ dbPath: file }); stores.push(store); await store.init(); return store; }
const source = (id: string) => ({ id, connectorId: 'fixture', sourceType: 'manual' as const, status: 'indexed' as const });

// Two owners of one file stand in for the daemon and a terminal: no write of
// either is refused or lost, and each sees the other's commits.
test('writes from two owners of one knowledge file both land and each sees the other', async () => {
  const file = path();
  const a = await open(file);
  const b = await open(file);
  await a.upsertSource(source('from-a'));
  expect(await b.refreshIfChanged()).toBe(true);
  expect(b.getSource('from-a')).not.toBeNull();

  await b.upsertSource(source('from-b'));
  await a.upsertSource(source('from-a-again'));
  expect(a.getSource('from-b')).not.toBeNull();

  const reopened = await open(file);
  for (const id of ['from-a', 'from-b', 'from-a-again']) expect(reopened.getSource(id)).not.toBeNull();
});
