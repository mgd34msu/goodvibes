/** Offline routes use the real platform service adapter, canonical rerank and owned result retention. */
import { afterEach, expect, test } from 'bun:test';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '../errors/src/index.js';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { buildMediaRouteContext } from '../platform/src/platform/daemon/http/router-route-contexts.js';
import { createDaemonMediaRouteHandlers } from '../daemon-api/src/media-routes.js';
import { multimodalFixture, termChoice } from './_helpers/multimodal-entities.js';

let previous: ReturnType<typeof installJudgmentPort>;
let installed = false;
afterEach(() => { if (installed) installJudgmentPort(previous); installed = false; });
function routes(kind: 'image' | 'audio' | 'video' | 'document' = 'image', text?: string) {
  const fixture = multimodalFixture(kind, text);
  const fake = fakePort(termChoice({ AI: 0.9, receipt: 0.05, EU: 0.05 }));
  if (!installed) { previous = installJudgmentPort(fake.port); installed = true; } else installJudgmentPort(fake.port);
  let admin = true;
  const handlers = createDaemonMediaRouteHandlers(buildMediaRouteContext({
    artifactStore: fixture.artifactStore as never, configManager: { get: () => undefined } as never,
    mediaProviders: fixture.mediaProviders as never, voiceService: fixture.voiceService as never,
    webSearchService: {} as never, multimodalService: fixture.service,
    parseJsonBody: async request => await request.json() as Record<string, unknown>,
    requireAdmin: () => admin ? null : new Response('Unauthorized', { status: 403 }),
  }));
  const request = (body: unknown, signal?: AbortSignal) => new Request('http://localhost/api/multimodal/analyze', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, ...(signal ? { signal } : {}),
  });
  return { ...fixture, handlers, request, fake, deny: () => { admin = false; } };
}

for (const kind of ['image', 'audio', 'video', 'document'] as const) {
  test(`${kind}: actual daemon analysis renders entities and later explicit write-back retains ownership`, async () => {
    const fixture = routes(kind);
    if (kind === 'video') fixture.add('transcript', 'document');
    const response = await fixture.handlers.postMultimodalAnalyze(fixture.request({ artifactId: 'source', includePacket: true, detail: 'detailed',
      ...(kind === 'video' ? { metadata: { transcriptArtifactId: 'transcript' } } : {}),
    }));
    expect(response.status).toBe(201);
    const body = await response.json() as { analysis: { entities: string[] }; packet: { rendered: string } };
    expect(body.analysis.entities).toEqual(['AI']); expect(body.packet.rendered).toContain('Entities: AI');
    expect(fixture.writes).toHaveLength(0);
    const packet = await fixture.handlers.postMultimodalPacket(fixture.request({ analysis: body.analysis }));
    expect(packet.status).toBe(200);
    const writeback = await fixture.handlers.postMultimodalWriteback(fixture.request({ analysis: body.analysis }));
    expect(writeback.status).toBe(201); expect(fixture.writes).toHaveLength(1);
    expect(fixture.ingests[0]).toMatchObject({ tags: expect.arrayContaining(['AI']) });
  });
}

for (const [condition, status] of [['artifact', 400], ['forgery', 409], ['not held', 410], ['unauthorized', 403]] as const) {
  test(`later daemon write-back rejects ${condition} without persistence`, async () => {
    const fixture = routes();
    const response = await fixture.handlers.postMultimodalAnalyze(fixture.request({ artifactId: 'source' }));
    expect(response.status).toBe(201);
    const body = await response.json() as { analysis: Record<string, unknown> };
    if (condition === 'artifact') fixture.records.delete('source');
    if (condition === 'forgery') body.analysis.entities = ['invented'];
    if (condition === 'not held') body.analysis.id = 'mm-from-before-a-restart';
    if (condition === 'unauthorized') fixture.deny();
    const writeback = await fixture.handlers.postMultimodalWriteback(fixture.request({ analysis: body.analysis }));
    expect(writeback.status).toBe(status);
    if (condition === 'not held') expect(((await writeback.json()) as { next?: string[] }).next?.[0]).toContain('writeback');
    expect(fixture.writes).toHaveLength(0); expect(fixture.ingests).toHaveLength(0);
  });
}

test('a packet is built from any analysis the caller holds', async () => {
  const fixture = routes();
  const response = await fixture.handlers.postMultimodalAnalyze(fixture.request({ artifactId: 'source' }));
  const body = await response.json() as { analysis: Record<string, unknown> };
  body.analysis.id = 'mm-from-before-a-restart';
  const packet = await fixture.handlers.postMultimodalPacket(fixture.request({ analysis: body.analysis }));
  expect(packet.status).toBe(200);
});

test('daemon metadata never grants write-back and blocked private-host policy still runs', async () => {
  const fixture = routes();
  const response = await fixture.handlers.postMultimodalAnalyze(fixture.request({ artifactId: 'source', metadata: { writeback: true } }));
  // Source metadata is never used as explicit write-back permission.
  expect(response.status).toBe(201); expect(fixture.writes).toHaveLength(0);
  fixture.deny();
  const denied = await fixture.handlers.postMultimodalAnalyze(fixture.request({ artifact: { uri: 'http://127.0.0.1/file', allowPrivateHosts: true } }));
  expect(denied.status).toBe(403); expect(fixture.writes).toHaveLength(0);
});

test('a failed entity reading does not stop a requested write-back', async () => {
  const fixture = routes(); installJudgmentPort(fakePort(() => ({ type: 'text', text: 'AI' })).port);
  const response = await fixture.handlers.postMultimodalAnalyze(fixture.request({ artifactId: 'source', writeback: true, includePacket: true }));
  expect(response.status).toBe(201); expect(fixture.writes).toHaveLength(1);
  const body = await response.json() as { writeback: { metadata: Record<string, unknown> } };
  expect(body.writeback.metadata).toMatchObject({ entityAssessment: 'not-evaluated', entityAssessmentSkipped: 'unavailable' });
});

test('new canceled write-back request cannot reuse an otherwise current analysis', async () => {
  const fixture = routes();
  const response = await fixture.handlers.postMultimodalAnalyze(fixture.request({ artifactId: 'source' }));
  const body = await response.json() as { analysis: unknown };
  const controller = new AbortController(); controller.abort();
  const writeback = await fixture.handlers.postMultimodalWriteback(fixture.request({ analysis: body.analysis }, controller.signal));
  expect(writeback.status).toBe(400); expect(fixture.writes).toHaveLength(0);
});

test.each(['Classic - Off', 'Preferred'] as const)('%s actual daemon media routes retain unassessed output and authenticate explicit writeback', async policy => {
  const f = routes();
  const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic exhausted chain'); }); installJudgmentPort(fake.port);
  await withDecisionModelPolicy(() => policy, async () => {
    const analyzed = await f.handlers.postMultimodalAnalyze(f.request({ artifactId: 'source', includePacket: true, detail: 'detailed' }));
    expect(analyzed.status).toBe(201);
    const body = await analyzed.json() as { analysis: { entities: string[]; metadata: Record<string, unknown> }; packet: { rendered: string } };
    expect(body.analysis.entities).toEqual([]); expect(body.analysis.metadata).toMatchObject({ provenance: 'classic', entityAssessment: 'not-evaluated' });
    expect(body.packet.rendered).toContain('was not performed'); expect(f.providerCalls.image).toBe(1);
    expect((await f.handlers.postMultimodalPacket(f.request({ analysis: body.analysis }))).status).toBe(200);
    const written = await f.handlers.postMultimodalWriteback(f.request({ analysis: body.analysis }));
    expect(written.status).toBe(201); expect(f.ingests).toHaveLength(1);
    const attempted = fake.requests.length;
    expect(policy === 'Classic - Off' ? attempted === 0 : attempted > 0).toBe(true);
    f.deny();
    expect((await f.handlers.postMultimodalWriteback(f.request({ analysis: body.analysis }))).status).toBe(403);
    expect(f.ingests).toHaveLength(1); expect(fake.requests).toHaveLength(attempted); expect(f.providerCalls.image).toBe(1);
  });
});
