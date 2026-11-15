import { describe, expect, test } from 'bun:test';
import { createAskPageRecovery } from '../platform/src/platform/knowledge/home-graph/ask-page-recovery.js';
import type { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';

function fixture() {
  let serialised = 0;
  const source = { id: 's1', metadata: {} };
  const extraction = { toJSON: () => { serialised += 1; return { text: 'x' }; } };
  const node = { id: 'd1', kind: 'ha_device', metadata: {} };
  const store = {
    listNodesInSpace: () => [node],
    listSourcesInSpace: () => [source],
    getExtractionBySourceId: () => extraction,
    getNode: () => node,
    getSource: () => source,
    listEdges: () => [],
  } as unknown as KnowledgeStore;
  const recovery = createAskPageRecovery(store, 'space', () => {});
  return { recovery, source, count: () => serialised, reset: () => { serialised = 0; } };
}

describe('Ask page recovery guard', () => {
  test('the per-write guard compares identity and never serialises stored content', () => {
    const { recovery, count, reset } = fixture();
    reset();
    for (let i = 0; i < 50; i += 1) recovery.assertCurrent();
    expect(count()).toBe(0);
  });

  test('the settle check still detects an in-place content change', () => {
    const { recovery, source } = fixture();
    (source as { metadata: Record<string, unknown> }).metadata['edited'] = true;
    expect(() => recovery.assertCurrent()).not.toThrow();
    expect(() => recovery.assertUnchanged()).toThrow();
  });
});
