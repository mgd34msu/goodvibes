import { useKnowledgeAnswerReadings } from './_helpers/knowledge-answer-readings.js';

const qualityReadings = useKnowledgeAnswerReadings();
beforeEach(() => { qualityReadings.set({
  pagePriorityDefault: 0.01,
  initialEvidenceCandidates: [['source', 'House', 0.01], ['node', 'House', 0.01], ['node', 'Kitchen Sensor', 0.01], ['node', 'Kitchen Sensor passport', 0.01]],
  homeGraph: [['Kitchen Sensor', { batteryApplicable: 0.99, manualApplicable: 0.01 }]],
}); });

import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { HomeGraphService } from '../platform/src/platform/knowledge/index.js';
import { runHomeGraphSyncSelfImprovementPump } from '../platform/src/platform/knowledge/home-graph/sync-self-improvement.js';
import { sourcesLinkedToNode, readHomeGraphState } from '../platform/src/platform/knowledge/home-graph/state.js';
import { createHomeGraphService, useHomeGraphFixtures } from './_helpers/homegraph-service-fixtures.js';

useHomeGraphFixtures();

const sensorSnapshot = (installationId: string) => ({
  installationId,
  devices: [{ id: 'kitchen-sensor', name: 'Kitchen Sensor', manufacturer: 'Acme', model: 'KS-1' }],
});

/** Lets every already-queued continuation run; nothing here waits on a clock. */
async function settleQueuedWork(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('Home Graph reset waits for every writer', () => {
  test('a refinement run in flight holds a reset, and a new run during the reset is refused', async () => {
    const { store, artifactStore, service: seeder } = createHomeGraphService();
    await seeder.syncSnapshot(sensorSnapshot('alpha'));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const semanticService = {
      isBackgroundWorkPaused: () => false,
      addObjectProfiles: () => {},
      selfImprove: async () => { entered.resolve(); await release.promise; return {}; },
    } as never;
    const service = new HomeGraphService(store, artifactStore, { semanticService });
    try {
      const refinement = service.runRefinement({ knowledgeSpaceId: 'homeassistant:alpha' });
      await entered.promise;

      let resetDone = false;
      const reset = service.resetSpace({ knowledgeSpaceId: 'homeassistant:alpha' }).then((result) => { resetDone = true; return result; });
      await settleQueuedWork();
      expect(resetDone).toBe(false);
      expect(store.listNodes(Number.MAX_SAFE_INTEGER).length).toBeGreaterThan(0);
      await expect(service.runRefinement({ knowledgeSpaceId: 'homeassistant:alpha' })).rejects.toThrow(/is being reset/);

      release.resolve();
      await refinement;
      await reset;
      expect(resetDone).toBe(true);
      expect(store.listNodes(Number.MAX_SAFE_INTEGER).length).toBe(0);
    } finally {
      release.resolve();
      await service.dispose();
    }
  });
});

describe('Home Graph review', () => {
  test('a fact review whose issue write fails names the applied node, and repeating it finishes', async () => {
    const { service, store } = createHomeGraphService();
    await service.syncSnapshot(sensorSnapshot('house'));
    const issue = (await service.listIssues({ installationId: 'house', status: 'open' })).issues.find((item) => item.code === 'homegraph.device.unknown_battery')!;
    const original = store.upsertIssue.bind(store);
    let failed = false;
    const spy = spyOn(store, 'upsertIssue').mockImplementation(async (...args: Parameters<typeof original>) => {
      if (!failed && args[0].id === issue.id) { failed = true; throw new Error('disk full'); }
      return original(...args);
    });
    try {
      await expect(service.reviewFact({ installationId: 'house', issueId: issue.id, action: 'resolve', value: { batteryPowered: false } }))
        .rejects.toThrow(/was applied to node .*was not updated \(disk full\)\. Repeat the review/);
      const device = store.listNodes(Number.MAX_SAFE_INTEGER).find((node) => node.kind === 'ha_device')!;
      expect(device.metadata.batteryPowered).toBe(false);

      const repeated = await service.reviewFact({ installationId: 'house', issueId: issue.id, action: 'resolve', value: { batteryPowered: false } });
      expect(repeated.issue?.status).toBe('resolved');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('Home Graph snapshot and passport serialization', () => {
  test('two snapshots of one new installation run one after the other and both finish', async () => {
    const { service, store } = createHomeGraphService();
    const original = store.upsertSource.bind(store);
    const gate = Promise.withResolvers<void>();
    let upserts = 0;
    const spy = spyOn(store, 'upsertSource').mockImplementation(async (...args: Parameters<typeof original>) => {
      upserts += 1;
      if (upserts === 1) await gate.promise;
      return original(...args);
    });
    try {
      const first = service.syncSnapshot(sensorSnapshot('fresh'));
      const second = service.syncSnapshot(sensorSnapshot('fresh'));
      await settleQueuedWork();
      // The second snapshot has not started writing while the first is held.
      expect(upserts).toBe(1);
      gate.resolve();
      const results = await Promise.all([first, second]);
      expect(results.map((result) => result.spaceId)).toEqual(['homeassistant:fresh', 'homeassistant:fresh']);
      expect(upserts).toBeGreaterThan(1);
    } finally {
      gate.resolve();
      spy.mockRestore();
    }
  });

  test('refreshes of one passport by node id and by object id never overlap', async () => {
    const { service, store } = createHomeGraphService();
    await service.syncSnapshot(sensorSnapshot('house'));
    const device = (await service.browse({ installationId: 'house' })).nodes.find((node) => node.title === 'Kitchen Sensor')!;
    const original = store.applyPreparedIngest.bind(store);
    const gate = Promise.withResolvers<void>();
    let publications = 0;
    const spy = spyOn(store, 'applyPreparedIngest').mockImplementation(async (...args: Parameters<typeof original>) => {
      publications += 1;
      if (publications === 1) await gate.promise;
      return original(...args);
    });
    try {
      const byNode = service.refreshDevicePassport({ installationId: 'house', deviceId: device.id });
      const byObject = service.refreshDevicePassport({ installationId: 'house', deviceId: 'kitchen-sensor' });
      await settleQueuedWork();
      expect(publications).toBe(1);
      gate.resolve();
      await Promise.all([byNode, byObject]);
      expect(store.listNodes().filter((node) => node.kind === 'ha_device_passport')).toHaveLength(1);
    } finally {
      gate.resolve();
      spy.mockRestore();
    }
  });
});

describe('Home Graph sync self-improvement pump', () => {
  test('promoted facts with no accepted source ids refresh no pages', async () => {
    let calls = 0;
    const untouchedStore = new Proxy({}, { get: () => { throw new Error('the pump must not read the store without accepted sources'); } });
    await runHomeGraphSyncSelfImprovementPump({
      store: untouchedStore as never,
      artifactStore: {} as never,
      reportBackgroundError: () => {},
      semanticService: {
        isBackgroundWorkPaused: () => calls > 0,
        selfImprove: async () => {
          calls += 1;
          return { scannedGaps: 1, candidateGaps: 1, processedGaps: 1, createdGaps: 0, repairableGaps: 1, suppressedGaps: 0, skippedGaps: 0,
            searched: 1, ingestedSources: 0, linkedRepairs: 0, blockedGaps: 0, closedGaps: 0, queuedTasks: 0, truncated: false,
            budgetExhausted: false, taskIds: [], ingestedSourceIds: [], acceptedSourceIds: [], promotedFactCount: 1, errors: [] };
        },
      } as never,
    }, 'homeassistant:house-1', 'house-1', new AbortController().signal);
    expect(calls).toBe(1);
  });
});

describe('Home Graph linked sources', () => {
  test('a source named only by a describing fact\'s metadata counts as linked to the device', async () => {
    const { service, store } = createHomeGraphService();
    await service.syncSnapshot(sensorSnapshot('house'));
    const spaceId = 'homeassistant:house';
    const device = store.listNodes(Number.MAX_SAFE_INTEGER).find((node) => node.kind === 'ha_device')!;
    const source = await service.ingestNote({ installationId: 'house', title: 'Sensor manual', body: 'The Kitchen Sensor takes a CR2032 battery.' });
    const before = readHomeGraphState(store, spaceId);
    expect(sourcesLinkedToNode(device.id, before).some((item) => item.id === source.source.id)).toBe(false);

    const fact = await store.upsertNode({
      id: 'fact-metadata-only', kind: 'fact', slug: 'fact-metadata-only', title: 'Battery', summary: 'CR2032', aliases: [], status: 'active',
      confidence: 80, sourceId: undefined,
      metadata: { knowledgeSpaceId: spaceId, homeAssistant: { installationId: 'house', objectKind: 'fact', objectId: 'fact-metadata-only' }, semanticKind: 'fact', sourceIds: [source.source.id] },
    });
    await store.upsertEdge({ fromKind: 'node', fromId: fact.id, toKind: 'node', toId: device.id, relation: 'describes', metadata: { knowledgeSpaceId: spaceId } });

    const after = readHomeGraphState(store, spaceId);
    expect(sourcesLinkedToNode(device.id, after).some((item) => item.id === source.source.id)).toBe(true);
  });
});
