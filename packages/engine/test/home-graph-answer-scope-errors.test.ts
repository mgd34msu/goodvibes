import { describe, expect, spyOn, test } from 'bun:test';
import { KnowledgeAnswerQualityHeldError } from '../platform/src/platform/knowledge/semantic/answer-verification/types.js';
import { prepareHomeGraphAnswerScope } from '../platform/src/platform/knowledge/home-graph/answer-scope.js';
import type { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import type { HomeGraphSearchState } from '../platform/src/platform/knowledge/home-graph/search.js';
import { logger } from '../platform/src/platform/utils/logger.js';

describe('Home Graph answer scope', () => {
  test('a defect inside scope preparation is logged, not silently reported as an outage', async () => {
    const logged = spyOn(logger, 'error').mockImplementation(() => {});
    try {
      // A store without its methods makes the guard fail with a TypeError, which no hold class covers.
      const store = {} as unknown as KnowledgeStore;
      const state = { spaceId: 'homeassistant', sources: [], nodes: [], edges: [], extractionBySourceId: new Map() } as unknown as HomeGraphSearchState;
      await expect(prepareHomeGraphAnswerScope({ store, spaceId: 'homeassistant', query: { query: 'Which lights are on?' }, results: [], state }))
        .rejects.toBeInstanceOf(KnowledgeAnswerQualityHeldError);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0]?.[0])).toContain('unclassified error');
      expect(JSON.stringify(logged.mock.calls[0]?.[1])).toContain('listSourcesInSpace is not a function');
    } finally { logged.mockRestore(); }
  });
});
