import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'bun:test';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { reviewKnowledgeIssue } from '../platform/src/platform/knowledge/review.js';

const tmpRoots: string[] = [], stores: KnowledgeStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('knowledge review decisions', () => {
  test('preserves resolved generated issues across namespace replacement', async () => {
    const store = createStore();
    const source = await store.upsertSource({
      connectorId: 'url',
      sourceType: 'url',
      title: 'Example source',
      canonicalUri: 'https://example.test/',
      tags: ['example'],
      status: 'indexed',
      metadata: { namespace: 'knowledge:lint' },
    });
    const [issue] = await store.replaceIssues([{
      id: `issue-source-unlinked-${source.id}`,
      severity: 'warning',
      code: 'source-unlinked',
      message: 'Source has no compiled knowledge links yet.',
      sourceId: source.id,
      metadata: { namespace: 'knowledge:lint', subjectFingerprint: 'same' },
    }], 'knowledge:lint');

    const reviewed = await reviewKnowledgeIssue(store, {
      issueId: issue!.id,
      action: 'reject',
      reviewer: 'llm-review',
      value: { category: 'not_applicable', reason: 'The source is intentionally standalone.' },
    });
    const refreshed = await store.replaceIssues([{
      id: issue!.id,
      severity: 'warning',
      code: 'source-unlinked',
      message: 'Source has no compiled knowledge links yet.',
      sourceId: source.id,
      metadata: { namespace: 'knowledge:lint', subjectFingerprint: 'same' },
    }], 'knowledge:lint');

    expect(reviewed.issue.status).toBe('resolved');
    expect(refreshed[0]?.status).toBe('resolved');
    expect(refreshed[0]?.metadata.review).toMatchObject({ action: 'reject', reviewer: 'llm-review' });
    expect(refreshed[0]?.metadata.review).toEqual(reviewed.issue.metadata.review);
  });
});

function createStore(): KnowledgeStore {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-knowledge-review-'));
  tmpRoots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  stores.push(store);
  return store;
}
