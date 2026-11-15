import { useKnowledgeAnswerReadings } from './_helpers/knowledge-answer-readings.js';

const readings = useKnowledgeAnswerReadings();

import { describe, expect, test } from 'bun:test';
import { HomeGraphRoutes } from '../platform/src/platform/daemon/http/home-graph-routes.js';
import type { HomeGraphService } from '../platform/src/platform/knowledge/index.js';
import { createHomeGraphService, useHomeGraphFixtures } from './_helpers/homegraph-service-fixtures.js';

useHomeGraphFixtures();

type Call = { readonly method: string; readonly input: Record<string, unknown> };

function routesWith(options: { admin: boolean; callerId?: string }) {
  const calls: Call[] = [];
  const service = {
    ask: async (input: Record<string, unknown>) => { calls.push({ method: 'ask', input }); return { ok: true }; },
    reviewFact: async (input: Record<string, unknown>) => { calls.push({ method: 'reviewFact', input }); return { ok: true }; },
  } as unknown as HomeGraphService;
  const routes = new HomeGraphRoutes({
    artifactStore: {} as never,
    homeGraphService: service,
    parseJsonBody: async (req) => await req.json() as Record<string, unknown>,
    parseOptionalJsonBody: async (req) => await req.json() as Record<string, unknown>,
    requireAdmin: () => (options.admin ? null : Response.json({ error: 'admin required' }, { status: 403 })),
    callerId: () => options.callerId,
  });
  const post = (path: string, body: Record<string, unknown>) => routes.handle(new Request(`http://daemon.local/api/homeassistant/home-graph/${path}`, { method: 'POST', body: JSON.stringify(body) }));
  return { calls, post };
}

describe('Home Graph caller authority', () => {
  test('a review records the authenticated caller as reviewer and keeps the body name only as claimed', async () => {
    const { calls, post } = routesWith({ admin: true, callerId: 'token-ops' });
    await post('facts/review', { issueId: 'i1', action: 'accept', reviewer: 'someone-else' });
    expect(calls).toEqual([{ method: 'reviewFact', input: { issueId: 'i1', action: 'accept', reviewer: 'token-ops', claimedReviewer: 'someone-else' } }]);
  });

  test('a review from a caller with no recognised principal records no body-chosen reviewer', async () => {
    const { calls, post } = routesWith({ admin: true });
    await post('facts/review', { issueId: 'i1', action: 'accept', reviewer: 'someone-else' });
    expect(calls[0]!.input.reviewer).toBeUndefined();
    expect(calls[0]!.input.claimedReviewer).toBe('someone-else');
  });

  test('ask from a caller that is not admin is read-only; an admin ask is not', async () => {
    const denied = routesWith({ admin: false });
    await denied.post('ask', { query: 'battery' });
    expect(denied.calls[0]!.input.readOnly).toBe(true);
    const admin = routesWith({ admin: true });
    await admin.post('ask', { query: 'battery' });
    expect(admin.calls[0]!.input.readOnly).toBeUndefined();
  });
});

describe('Home Graph read-only ask', () => {
  test('answers without repairing extractions, refreshing device pages or queueing enrichment', async () => {
    readings.set({
      initialEvidenceDefault: 0.01,
      initialEvidenceCandidates: [['source', 'Front door battery', 0.99]],
      excerpts: [['The front door sensor uses a CR2032 battery.', 0.99]],
      objectAlignment: [{ query: 'CR2032 front door', objects: [
        { title: 'Front Door Sensor', concreteObject: 0.99, integrationObject: 0.01, aligned: 0.99 },
      ] }],
    });
    const { service } = createHomeGraphService();
    await service.syncSnapshot({
      installationId: 'house-1',
      areas: [{ id: 'entry', name: 'Entry' }],
      devices: [{ id: 'front-door-sensor', name: 'Front Door Sensor', areaId: 'entry' }],
      entities: [{ id: 'binary_sensor.front_door', entityId: 'binary_sensor.front_door', name: 'Front Door', deviceId: 'front-door-sensor', areaId: 'entry' }],
    });
    await service.ingestNote({
      installationId: 'house-1', title: 'Front door battery', body: 'The front door sensor uses a CR2032 battery.',
      category: 'maintenance', target: { kind: 'device', id: 'front-door-sensor', relation: 'has_manual' },
    });
    const internals = service as unknown as { repairStaleExtractionsForAsk: (...args: unknown[]) => Promise<number>; queueAnswerEnrichment: (...args: unknown[]) => void };
    const writes: string[] = [];
    const repair = internals.repairStaleExtractionsForAsk.bind(service);
    const enrich = internals.queueAnswerEnrichment.bind(service);
    internals.repairStaleExtractionsForAsk = async (...args) => { writes.push('repair'); return repair(...args); };
    internals.queueAnswerEnrichment = (...args) => { writes.push('enrich'); enrich(...args); };

    const answer = await service.ask({ installationId: 'house-1', query: 'CR2032 front door', includeLinkedObjects: true, readOnly: true });
    expect(answer.ok).toBe(true);
    expect(writes).toEqual([]);
    expect(answer.answer.refinement?.pageRefreshRequested).not.toBe(true);

    await service.ask({ installationId: 'house-1', query: 'CR2032 front door', includeLinkedObjects: true });
    expect(writes).toContain('repair');
    expect(writes).toContain('enrich');
  });
});
