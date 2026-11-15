import { useKnowledgeAnswerReadings } from './_helpers/knowledge-answer-readings.js';

const qualityReadings = useKnowledgeAnswerReadings();
beforeEach(() => { qualityReadings.set({
  pagePriority: [['LG webOS Smart TV', 0.99], ['LG webOS Smart TV passport', 0.99]],
  pagePriorityDefault: 0.01,
  initialEvidenceCandidates: [],
  repairUseful: [],
  activation: [],
  homeGraph: [],
  quality: [],
  authorities: [],
}); });

import { beforeEach, expect, spyOn, test } from 'bun:test';
import { SQLiteStore } from '../platform/src/platform/state/sqlite-store.js';
import { createHomeGraphService, useHomeGraphFixtures } from './_helpers/homegraph-service-fixtures.js';

useHomeGraphFixtures();

test('a large sync opens a read image per changed database state, not one per fence check', async () => {
  const { service } = createHomeGraphService();
  const opens = spyOn(SQLiteStore.prototype as unknown as { openPrivateReadImage: () => unknown }, 'openPrivateReadImage');
  const deviceCount = 33;
  const synced = await service.syncSnapshot({
    installationId: 'house-1',
    devices: Array.from({ length: deviceCount }, (_, index) => ({ id: `device-${index}`, name: `Generic Device ${index}`, manufacturer: 'Vendor', model: `M${index}` })),
  });
  expect(synced.generated.devicePassports).toBe(deviceCount);
  const opened = opens.mock.calls.length;
  opens.mockRestore();
  // Every fence check used to open its own image (about 70 per device); an image now serves every frame over the same unchanged database, so the count follows the writes between pages.
  expect(opened).toBeLessThanOrEqual(deviceCount * 5);
});
