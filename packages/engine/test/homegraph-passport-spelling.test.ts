import { useKnowledgeAnswerReadings } from './_helpers/knowledge-answer-readings.js';

const qualityReadings = useKnowledgeAnswerReadings();
beforeEach(() => { qualityReadings.set({
  pagePriorityDefault: 0.01,
  initialEvidenceCandidates: [['source', 'House', 0.01], ['node', 'House', 0.01], ['node', 'Kitchen Sensor', 0.01], ['node', 'Kitchen Sensor passport', 0.01]],
  homeGraph: [['Kitchen Sensor', { batteryApplicable: 0.01, manualApplicable: 0.01 }]],
}); });

import { beforeEach, describe, expect, test } from 'bun:test';
import { createHomeGraphService, useHomeGraphFixtures } from './_helpers/homegraph-service-fixtures.js';

useHomeGraphFixtures();

describe('device passport identity', () => {
  test('the passport records the device\'s own object id however the caller spelled the device', async () => {
    const { service, store } = createHomeGraphService();
    await service.syncSnapshot({ installationId: 'house-1', devices: [{ id: 'kitchen-sensor', name: 'Kitchen Sensor', manufacturer: 'Acme', model: 'KS-1' }] });
    const device = (await service.browse({ installationId: 'house-1' })).nodes.find((node) => node.title === 'Kitchen Sensor');
    expect(device).toBeDefined();
    // The node id is one spelling of the device; the Home Assistant object id is the canonical one.
    await service.refreshDevicePassport({ installationId: 'house-1', deviceId: device!.id });
    const passports = store.listNodes().filter((node) => node.kind === 'ha_device_passport');
    expect(passports).toHaveLength(1);
    expect(passports[0]?.metadata.deviceId).toBe('kitchen-sensor');
  });
});
