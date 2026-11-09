/** UNRUN: distinct native UUIDs sharing the old32bit prefix must never
 * overwrite one another in the real persisted knowledge tables. */
import { expect, spyOn, test } from 'bun:test';
import * as nodeCrypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';

test('separate sources, extractions, edges and job runs retain their full generated identities after reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'knowledge-full-identities-')), dbPath = join(directory, 'knowledge.sqlite');
  let store = new KnowledgeStore({ dbPath }); await store.init();
  let sequence = 0;
  const next = (): ReturnType<typeof nodeCrypto.randomUUID> => {
    sequence++;
    return `12345678-1234-4234-8234-${sequence.toString(16).padStart(12, '0')}`;
  };
  const native = spyOn(nodeCrypto, 'randomUUID').mockImplementation(next);
  const web = spyOn(globalThis.crypto, 'randomUUID').mockImplementation(next);
  try {
    const sourceA = await store.upsertSource({ connectorId: 'test', sourceType: 'document', status: 'indexed', title: 'first' });
    const sourceB = await store.upsertSource({ connectorId: 'test', sourceType: 'document', status: 'indexed', title: 'second' });
    const extractionA = await store.upsertExtraction({ sourceId: sourceA.id, extractorId: 'test', format: 'text', summary: 'first body' });
    const extractionB = await store.upsertExtraction({ sourceId: sourceB.id, extractorId: 'test', format: 'text', summary: 'second body' });
    const edgeA = await store.upsertEdge({ fromKind: 'source', fromId: sourceA.id, toKind: 'source', toId: sourceB.id, relation: 'related_to' });
    const edgeB = await store.upsertEdge({ fromKind: 'source', fromId: sourceB.id, toKind: 'source', toId: sourceA.id, relation: 'related_to' });
    const jobA = await store.upsertJobRun({ jobId: 'first', mode: 'inline', status: 'completed' });
    const jobB = await store.upsertJobRun({ jobId: 'second', mode: 'inline', status: 'completed' });
    for (const [a, b] of [[sourceA, sourceB], [extractionA, extractionB], [edgeA, edgeB], [jobA, jobB]]) {
      expect(a!.id).not.toBe(b!.id);
      expect(a!.id).toMatch(/-[a-p]{8}-[a-p]{4}-[a-p]{4}-[a-p]{4}-[a-p]{12}$/);
    }
    await store.close(); store = new KnowledgeStore({ dbPath }); await store.init();
    expect(store.getSource(sourceA.id)?.title).toBe('first'); expect(store.getSource(sourceB.id)?.title).toBe('second');
    expect(store.getExtractionBySourceId(sourceA.id)?.summary).toBe('first body'); expect(store.getExtractionBySourceId(sourceB.id)?.summary).toBe('second body');
    expect(store.listEdges().map(edge => edge.id).sort()).toEqual([edgeA.id, edgeB.id].sort());
    expect(store.getJobRun(jobA.id)?.jobId).toBe('first'); expect(store.getJobRun(jobB.id)?.jobId).toBe('second');
  } finally { web.mockRestore(); native.mockRestore(); await store.close(); rmSync(directory, { recursive: true, force: true }); }
});
