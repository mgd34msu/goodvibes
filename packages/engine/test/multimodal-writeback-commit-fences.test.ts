import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import type { KnowledgeIngestContext } from '../platform/src/platform/knowledge/ingest-context.js';
import { configureKnowledgeArtifactReferences } from '../platform/src/platform/knowledge/artifact-reference-ensemble.js';
import type { ArtifactCreatedLeaf } from '../platform/src/platform/artifacts/storage-ownership.js';
import type { ArtifactStreamCreateInput } from '../platform/src/platform/artifacts/types.js';
/** Deferred real artifact/SQLite persistence through the actual daemon media routes. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '../errors/src/index.js';
import { ArtifactStore } from '../platform/src/platform/artifacts/store.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { KnowledgeService } from '../platform/src/platform/knowledge/service.js';
import { KnowledgeConnectorRegistry } from '../platform/src/platform/knowledge/connectors.js';
import { MultimodalService } from '../platform/src/platform/multimodal/service.js';
import { buildMediaRouteContext } from '../platform/src/platform/daemon/http/router-route-contexts.js';
import { createDaemonMediaRouteHandlers } from '../daemon-api/src/media-routes.js';
import { waitFor } from './_helpers/test-timeout.js';

const roots: string[] = [], stores: KnowledgeStore[] = [], services: KnowledgeService[] = [];
let previous: ReturnType<typeof installJudgmentPort>, installed = false;
afterEach(async () => { for (const service of services.splice(0)) service.dispose(); for (const store of stores.splice(0)) await store.close(); if (installed) installJudgmentPort(previous); installed = false; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const request = (body: unknown, signal?: AbortSignal) => new Request('http://localhost/api/multimodal/writeback', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, ...(signal ? { signal } : {}) });

for (const phase of ['artifact', 'knowledge'] as const) for (const change of ['cancel', 'source', 'port', 'permission', 'generic-cancel'] as const) {
  test(`${change} during real ${phase} await leaves no canceled analysis or SQLite source`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'multimodal-fence-')); roots.push(root);
    const fake = fakePort((_name, _question, state) => noulAnswer((state as { candidate?: { term: string } }).candidate?.term === 'AI' ? 0.99 : 0.01));
    previous = installJudgmentPort(fake.port); installed = true;
    const artifacts = new ArtifactStore({ rootDir: join(root, 'artifacts') });
    const store = new KnowledgeStore({ dbPath: join(root, 'knowledge-wiki.sqlite') }); stores.push(store); await store.init();
    configureKnowledgeArtifactReferences({ artifactStore: artifacts, controlPlaneDirectory: root, stores: [store] });
    const knowledge = new KnowledgeService(store, artifacts, new KnowledgeConnectorRegistry(), { memoryRegistry: { add() {}, getAll: () => [], getStore: () => undefined } as never,
      semanticService: { enrichSource: async () => {}, queueBackgroundSelfImprove() {} } as never });
    services.push(knowledge);
    const source = await artifacts.create({ kind: 'image', mimeType: 'image/png', text: 'image', filename: 'source.png' });
    const media = { status: async () => [], findProvider: () => ({ analyze: async () => ({ providerId: 'fixture', text: 'AI', labels: [], metadata: {} }) }) };
    const voice = { getStatus: async () => ({ providers: [] }) };
    const service = new MultimodalService(artifacts, media as never, voice as never, knowledge);
    let allowed = true;
    const handlers = createDaemonMediaRouteHandlers(buildMediaRouteContext({ artifactStore: artifacts, configManager: { get: () => undefined } as never,
      mediaProviders: media as never, voiceService: voice as never, webSearchService: {} as never, multimodalService: service,
      parseJsonBody: async req => await req.json() as Record<string, unknown>, requireAdmin: () => allowed ? null : new Response('Denied', { status: 403 }),
    }));
    const analyzed = await handlers.postMultimodalAnalyze(request({ artifactId: source.id }));
    expect(analyzed.status).toBe(201);
    const { analysis } = await analyzed.json() as { analysis: unknown };
    const entered = gate(), release = gate();
    type SpoolInput = { readonly leaf: ArtifactCreatedLeaf; readonly stream: ArtifactStreamCreateInput['stream']; readonly expectedSizeBytes?: number | undefined; readonly assertCurrent?: (() => void) | undefined; readonly signal?: AbortSignal | undefined };
    const spooler = artifacts as unknown as { writeStreamContent(input: SpoolInput): Promise<{ sizeBytes: number }> };
    const originalSpool = spooler.writeStreamContent.bind(artifacts);
    const originalApply = store.applyPreparedIngest.bind(store);
    const artifactSpy = phase === 'artifact' ? spyOn(spooler, 'writeStreamContent').mockImplementation(async input => originalSpool({ ...input,
      stream: (async function* () { yield Buffer.from('partial owned analysis'); entered.resolve(); await release.promise; if (change === 'generic-cancel') throw new Error('Synthetic spool error'); yield Buffer.from('rest'); })(), expectedSizeBytes: undefined,
    })) : undefined;
    const knowledgeSpy = phase === 'knowledge' ? spyOn(store, 'applyPreparedIngest').mockImplementation(async (...args) => {
      entered.resolve(); await release.promise; if (change === 'generic-cancel') throw new Error('Synthetic transaction preparation error'); return originalApply(...args);
    }) : undefined;
    const controller = new AbortController();
    const pending = handlers.postMultimodalWriteback(request({ analysis }, controller.signal));
    await entered.promise;
    if (change === 'cancel' || change === 'generic-cancel') controller.abort();
    if (change === 'source') artifacts.delete(source.id);
    if (change === 'port') installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
    if (change === 'permission') allowed = false;
    release.resolve();
    try {
      expect((await pending).status).toBe(400);
      expect(store.listSources()).toHaveLength(0); expect(store.listExtractions()).toHaveLength(0); expect(store.listNodes()).toHaveLength(0);
      if (phase === 'knowledge') {
        // This genuinely fresh family has no published reference image. Its
        // canceled candidate stays held until a real clean publication can
        // prove it unreferenced; startup/cleanup must not invent empty evidence.
        const candidates = artifacts.list().filter(item => item.id !== source.id);
        expect(candidates).toHaveLength(1);
        const clean = await store.upsertSource({ id: 'actual-clean-boundary', connectorId: 'test', sourceType: 'document', title: 'Cleanup boundary', status: 'indexed' });
        await waitFor(() => artifacts.get(candidates[0]!.id) === null);
        await store.deleteSource(clean.id);
      }
      expect(artifacts.list().map(item => item.id)).toEqual(change === 'source' ? [] : [source.id]);
      expect(readdirSync(artifacts.storagePath).filter(name => !name.startsWith(source.id))).toEqual([]);
      expect(store.listSources()).toHaveLength(0); expect(store.listExtractions()).toHaveLength(0); expect(store.listNodes()).toHaveLength(0);
      const reopened = new KnowledgeStore({ dbPath: join(root, 'knowledge-wiki.sqlite') }); stores.push(reopened); await reopened.init();
      expect(reopened.listSources()).toHaveLength(0); expect(reopened.listExtractions()).toHaveLength(0);
    } finally { artifactSpy?.mockRestore(); knowledgeSpy?.mockRestore(); }
  });
}

test('guarded ingestion reports the true commit before a later generic completion failure', async () => {
  const { ingestKnowledgeArtifact } = await import('../platform/src/platform/knowledge/ingest-inputs.js');
  const root = mkdtempSync(join(tmpdir(), 'multimodal-commit-receipt-')); roots.push(root);
  previous = installJudgmentPort(fakePort(() => noulAnswer(0.99)).port); installed = true;
  const artifacts = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge-wiki.sqlite') }); stores.push(store); await store.init();
  const artifact = await artifacts.create({ kind: 'document', mimeType: 'text/plain', text: 'AI is the central topic.' });
  const bus = new RuntimeEventBus(), emitted = spyOn(bus, 'emit');
  const context: KnowledgeIngestContext = { store, artifactStore: artifacts, connectorRegistry: new KnowledgeConnectorRegistry(),
    emitIfReady(fn, sessionId) { fn(bus, { traceId: 'ingest-commit', sessionId: sessionId ?? 'ingest-session', source: 'test' }); },
    syncReviewedMemory: async () => { throw new Error('Synthetic post-commit completion failure'); }, lint: async () => [], listConnectors: () => [] };
  let committed: string | undefined;
  await expect(ingestKnowledgeArtifact(context, { artifactId: artifact.id }, { assertCurrent() {}, onCommitted: id => { committed = id; throw new Error('Synthetic observer failure after actual commit'); } })).rejects.toThrow('Synthetic post-commit completion failure');
  expect(committed).toBeDefined(); expect(store.getSource(committed!)?.status).toBe('indexed');
  expect(artifacts.get(artifact.id)).not.toBeNull();
  const events = emitted.mock.calls.map(([, envelope]) => envelope.type);
  expect(events).toContain('KNOWLEDGE_EXTRACTION_COMPLETED');
  expect(events).not.toContain('KNOWLEDGE_EXTRACTION_FAILED');
  emitted.mockRestore();
});


test('ordinary precommit extraction failure still emits the actual failed event without a published extraction', async () => {
  const { createKnowledgeIngestUriCanonicalizer } = await import('../platform/src/platform/knowledge/uri-canonicalization/ingest-owner.js');
  const { prepareKnowledgeExtraction } = await import('../platform/src/platform/knowledge/prepared-extraction.js');
  const { finalizeKnowledgeIngestedSource } = await import('../platform/src/platform/knowledge/ingest-compile.js');
  const root = mkdtempSync(join(tmpdir(), 'knowledge-precommit-failed-event-')); roots.push(root);
  previous = installJudgmentPort(fakePort(() => noulAnswer(0.99)).port); installed = true;
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(store); await store.init();
  const artifacts = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const artifact = await artifacts.create({ kind: 'document', mimeType: 'text/plain', text: 'A synthetic document.' });
  const original = await store.upsertSource({ id: 'precommit-source', connectorId: 'manual', sourceType: 'document', status: 'indexed' });
  const bus = new RuntimeEventBus(), emitted = spyOn(bus, 'emit');
  const context: KnowledgeIngestContext = { store, artifactStore: artifacts, connectorRegistry: new KnowledgeConnectorRegistry(),
    emitIfReady(fn, sessionId) { fn(bus, { traceId: 'precommit', sessionId: sessionId ?? 'session', source: 'test' }); },
    syncReviewedMemory: async () => {}, lint: async () => [], listConnectors: () => [] };
  const uris = createKnowledgeIngestUriCanonicalizer(context); uris.reserveSource(original.id); uris.attachArtifact(artifact.id);
  const token = await prepareKnowledgeExtraction(context, original.id, artifact.id, uris);
  const failure = spyOn(store, 'applyPreparedIngest').mockRejectedValue(new Error('Synthetic precommit failure'));
  try {
    await expect(finalizeKnowledgeIngestedSource(context, { sourceId: original.id, artifactId: artifact.id, preparedExtraction: token,
      sourceType: 'document', connectorId: 'manual', tags: [], metadata: {} }, uris)).rejects.toThrow('Synthetic precommit failure');
    expect(store.getSource(original.id)).toBe(original); expect(store.getExtractionBySourceId(original.id)).toBeNull();
    const events = emitted.mock.calls.map(([, envelope]) => envelope.type);
    expect(events).toContain('KNOWLEDGE_EXTRACTION_FAILED'); expect(events).not.toContain('KNOWLEDGE_EXTRACTION_COMPLETED');
  } finally { failure.mockRestore(); emitted.mockRestore(); }
});


test('actual ingest drains a returned async ownership notification and returns the indexed source before it settles', async () => {
  const { ingestKnowledgeArtifact } = await import('../platform/src/platform/knowledge/ingest-inputs.js');
  const root = mkdtempSync(join(tmpdir(), 'ingest-async-notification-')); roots.push(root);
  previous = installJudgmentPort(fakePort(() => noulAnswer(0.99)).port); installed = true;
  const artifacts = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(store); await store.init();
  const artifact = await artifacts.create({ kind: 'document', mimeType: 'text/plain', text: 'A synthetic original document.' });
  const context: KnowledgeIngestContext = { store, artifactStore: artifacts, connectorRegistry: new KnowledgeConnectorRegistry(),
    emitIfReady() {}, syncReviewedMemory: async () => {}, lint: async () => [], listConnectors: () => [] };
  const release = Promise.withResolvers<void>(), unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  let notified: string | undefined, settled = false;
  try {
    const result = await ingestKnowledgeArtifact(context, { artifactId: artifact.id }, {
      assertCurrent() {}, deferSemanticEnrichment: true,
      async onCommitted(id) { notified = id; await release.promise; settled = true; throw Error('Synthetic delayed ownership notification rejection'); },
    });
    expect(notified).toBe(result.source.id); expect(settled).toBe(false);
    expect(result.source.status).toBe('indexed'); expect(store.getSource(result.source.id)).toBe(result.source);
    expect(store.getExtractionBySourceId(result.source.id)?.artifactId).toBe(artifact.id);
    release.resolve(); await new Promise<void>(resolve => setImmediate(resolve)); await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(true); expect(unhandled).toEqual([]); expect(artifacts.getRecord(artifact.id)).not.toBeNull();
  } finally { release.resolve(); process.off('unhandledRejection', onUnhandled); }
});
