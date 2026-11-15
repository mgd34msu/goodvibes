import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { reviewKnowledgeIssue } from '../platform/src/platform/knowledge/review.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('a review refused because its issue changed leaves the source untouched', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-knowledge-review-atomic-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const source = await store.upsertSource({ connectorId: 'url', sourceType: 'url', title: 'Example', canonicalUri: 'https://example.test/', status: 'indexed' });
  const [issue] = await store.replaceIssues([{
    id: 'issue-atomic', severity: 'warning', code: 'source-unlinked', message: 'No links.', sourceId: source.id,
    metadata: { namespace: 'knowledge:lint', subjectFingerprint: 'same' },
  }], 'knowledge:lint');
  const real = store.getIssue.bind(store);
  let reads = 0;
  // The first read is the review's own snapshot; every later one sees an operator's concurrent change.
  spyOn(store, 'getIssue').mockImplementation((id: string) => {
    const current = real(id);
    return current && ++reads > 1 ? { ...current, message: 'Changed by someone else.' } : current;
  });
  await expect(reviewKnowledgeIssue(store, { issueId: issue!.id, action: 'forget', reviewer: 'operator' })).rejects.toThrow(/changed before its explicit review/);
  expect(store.getSource(source.id)?.status).toBe('indexed');
  expect(store.getSource(source.id)?.metadata.staleReason).toBeUndefined();
});
