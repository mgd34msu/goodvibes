import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort, decisionModelPolicyState, type DecisionModelPolicy } from '@goodvibes-jev/engine/errors';
import { JudgmentError, type JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { withDecisionModelPolicy } from '../sdk/src/platform/runtime/decision-policy.js';
import { ArtifactStore } from '../sdk/src/platform/artifacts/store.js';
import { KnowledgeService } from '../sdk/src/platform/knowledge/service.js';
import type { MemoryStore } from '../sdk/src/platform/state/index.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { KnowledgeConnectorRegistry } from '../sdk/src/platform/knowledge/connectors.js';
import { ingestKnowledgeArtifact, ingestKnowledgeUrl } from '../sdk/src/platform/knowledge/ingest-inputs.js';
import { createKnowledgeUriCanonicalizer } from '../sdk/src/platform/knowledge/uri-canonicalization/reader.js';
import { extractKnowledgeArtifact } from '../sdk/src/platform/knowledge/extractors.js';
import { searchKnowledge } from '../sdk/src/platform/knowledge/packet.js';
import { createCompressedPdfBuffer } from './_helpers/homegraph-service-fixtures.js';

const roots: string[] = [], stores: KnowledgeStore[] = [];
let previous: JudgmentPort | undefined, installed = false;
afterEach(async () => {
  if (installed) installJudgmentPort(previous); installed = false;
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function install(port: JudgmentPort | undefined) { previous = installJudgmentPort(port); installed = true; }
function outage() {
  const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic unavailable decision chain'); }); install(fake.port); return fake.requests;
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-classic-ingest-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(store); await store.init();
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  let enrichments = 0;
  const context = { store, artifactStore, connectorRegistry: new KnowledgeConnectorRegistry(), emitIfReady() {},
    async syncReviewedMemory() {}, async lint() { return []; }, listConnectors() { return []; },
    async semanticEnrichSource() { enrichments++; },
  };
  return { store, artifactStore, context, enrichments: () => enrichments };
}
const under = <T>(policy: DecisionModelPolicy, operation: () => T) => withDecisionModelPolicy(() => policy, operation);

test.each(['Classic - Off', 'Preferred'] as const)('%s retains unknown URI ref parameters instead of merging source identities', async policy => {
  const requests = outage();
  await under(policy, async () => {
    let current = true;
    const reader = createKnowledgeUriCanonicalizer({ assertCurrent() { if (!current) throw new Error('Retired source'); } });
    const first = await reader.canonicalize('https://example.invalid/manual?ref=chapter-one&utm_source=synthetic');
    expect(first).toBe('https://example.invalid/manual?ref=chapter-one');
    const attempted = requests.length; expect(attempted).toBe(policy === 'Preferred' ? 1 : 0);
    const second = await reader.canonicalize('https://example.invalid/manual?ref=chapter-two');
    expect(second).toBe('https://example.invalid/manual?ref=chapter-two'); expect(second).not.toBe(first);
    expect(requests).toHaveLength(attempted);
    current = false; expect(reader.assertCurrent).toThrow('stale');
  });
});

test('an uncertain URI reading does not authorize Classic normalization', async () => {
  const fake = fakePort(() => noulAnswer(0.5)); install(fake.port);
  await under('Preferred', async () => {
    const reader = createKnowledgeUriCanonicalizer();
    await expect(reader.canonicalize('https://example.invalid/manual?ref=chapter')).rejects.toMatchObject({ reason: 'uncertain' });
    expect(decisionModelPolicyState().operation).toBe('decision');
  });
});

test('Classic HTTP ingestion stores literal HTML, declared identities and no semantic receipts', async () => {
  const { context, store, enrichments } = await fixture(); const requests = outage(); let fetches = 0;
  const html = '<html><head><title>Network manual</title></head><body><nav>Catalog</nav><article><h1>Network setup</h1><p>Network recovery: keep the power connected.</p></article></body></html>';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    fetches++; expect(new URL(request.url).searchParams.get('ref')).toBe('network');
    return new Response(html, { headers: { 'content-type': 'text/html' } });
  } });
  try {
    await under('Classic - Off', async () => {
      const result = await ingestKnowledgeUrl(context, { url: `http://127.0.0.1:${server.port}/manual?ref=network`,
        allowPrivateHosts: true, tags: ['project:alpha'], metadata: { project: 'alpha' } });
      expect(result.source.status).toBe('indexed'); expect(result.source.metadata.provenance).toBe('classic');
      expect(result.source.canonicalUri).toContain('ref=network');
      expect(result.extraction?.structure.searchText).toContain('keep the power connected');
      expect(result.extraction?.metadata).toMatchObject({ provenance: 'classic', semanticAssessment: 'not-evaluated' });
      const project = store.listNodes().find(node => node.kind === 'project' && node.title === 'alpha');
      expect(project?.metadata.nodeObservation).toMatchObject({ origin: 'source-declaration' });
      expect(project?.metadata.nodeActivation).toBeUndefined(); expect(project?.aliases).toEqual([]);
      const found = await searchKnowledge({ store, deferUsage() {}, emitIfReady() {} }, 'network');
      expect(found.some(row => row.id === result.source.id)).toBe(true);
      expect(store.listSources()).toHaveLength(1); expect(store.listExtractions()).toHaveLength(1);
    });
    expect(fetches).toBe(1); expect(enrichments()).toBe(0); expect(requests).toHaveLength(0);
  } finally { server.stop(true); }
});

test('Preferred alias outage preserves the prepared artifact and commits the ingest exactly once', async () => {
  const { context, store, artifactStore, enrichments } = await fixture(); const requests = outage();
  const artifact = await artifactStore.createFromStream({ kind: 'document', filename: 'network.md', mimeType: 'text/markdown',
    sourceUri: 'https://example.invalid/network', stream: ['# Network setup\n\nKeep the power connected.'] });
  let committed = 0;
  await under('Preferred', async () => {
    const result = await ingestKnowledgeArtifact(context, { artifactId: artifact.id, tags: ['project:alpha'], metadata: { project: 'alpha' } }, {
      onCommitted() { committed++; },
    });
    expect(result.source.status).toBe('indexed'); expect(result.artifactId).toBe(artifact.id);
    expect(result.source.metadata.provenance).toBe('classic'); expect(decisionModelPolicyState().operation).toBe('classic');
    expect(store.listSources()).toHaveLength(1); expect(store.listExtractions()).toHaveLength(1); expect(committed).toBe(1);
  });
  expect(requests.length).toBeGreaterThan(0); expect(enrichments()).toBe(0);
});

test.each([
  ['text/plain', 'notes.txt', 'Network recovery instructions.'],
  ['text/markdown', 'notes.md', '# Network\n\nRecovery instructions.'],
  ['application/json', 'notes.json', '{"network":"recovery"}'],
  ['text/csv', 'notes.csv', 'network,state\nrouter,recovery'],
  ['application/xml', 'notes.xml', '<network>recovery</network>'],
])('Classic %s parsing is locally usable and explicitly unassessed', async (mimeType, filename, text) => {
  const requests = outage();
  await under('Classic - Off', async () => {
    const result = await extractKnowledgeArtifact({ id: 'synthetic-artifact', mimeType, filename }, Buffer.from(text));
    expect(result.metadata).toMatchObject({ provenance: 'classic', semanticAssessment: 'not-evaluated' });
    expect(result.structure.searchText).toContain('recovery');
  });
  expect(requests).toHaveLength(0);
});

test('Classic PDF ingestion retains parsed text without readability or encoding judgments', async () => {
  const { context, artifactStore } = await fixture(); const requests = outage();
  const artifact = await artifactStore.createFromStream({ kind: 'document', mimeType: 'application/pdf', filename: 'manual.pdf',
    stream: [createCompressedPdfBuffer('Network recovery keeps the power connected.')] });
  const result = await under('Classic - Off', () => ingestKnowledgeArtifact(context, { artifactId: artifact.id }));
  expect(result.source.status).toBe('indexed');
  expect(result.extraction?.structure.searchText).toContain('power connected');
  expect(result.extraction?.metadata.provenance).toBe('classic'); expect(requests).toHaveLength(0);
});

test('Classic cancelled or revoked ingest performs no fetch or source publication', async () => {
  const { context, store } = await fixture(); const requests = outage(); let fetches = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { fetches++; return new Response('Network'); } });
  try {
    await under('Classic - Off', async () => {
      const input = { url: `http://127.0.0.1:${server.port}/manual`, allowPrivateHosts: true };
      const controller = new AbortController(); controller.abort();
      await expect(ingestKnowledgeUrl(context, input, { signal: controller.signal })).rejects.toThrow();
      await expect(ingestKnowledgeUrl(context, input, { assertCurrent() { throw new Error('Revoked source'); } })).rejects.toThrow();
      expect(store.listSources()).toEqual([]);
    });
    expect(fetches).toBe(0); expect(requests).toHaveLength(0);
  } finally { server.stop(true); }
});


test('Classic reindex recompiles stored sources without starting semantic enrichment', async () => {
  const { store, context, artifactStore } = await fixture(); const requests = outage();
  const artifact = await artifactStore.createFromStream({ kind: 'document', filename: 'network.md', mimeType: 'text/markdown',
    stream: ['# Network setup\n\nKeep the power connected.'] });
  const memoryStore = { async init() {}, get() { return null; } } as unknown as MemoryStore;
  const service = new KnowledgeService(store, artifactStore, undefined, {
    memoryRegistry: { async add() { throw new Error('Unexpected memory write'); }, getAll() { return []; }, getStore() { return memoryStore; } },
  });
  try {
    await under('Classic - Off', async () => {
      const ingested = await ingestKnowledgeArtifact(context, { artifactId: artifact.id, metadata: { project: 'alpha' } });
      const reindexed = await service.reindex();
      expect(reindexed).toMatchObject({ provenance: 'classic', semanticEnrichment: 'not-evaluated' });
      expect(store.getSource(ingested.source.id)?.status).toBe('indexed');
      expect(store.listSources()).toHaveLength(1);
      expect((await service.search('network')).some(row => row.id === ingested.source.id)).toBe(true);
    });
    expect(requests).toHaveLength(0);
  } finally { service.dispose(); }
});
