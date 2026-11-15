import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort, type DecisionModelPolicy } from '@goodvibes-jev/engine/errors';
import { JudgmentError, type JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { ArtifactStore } from '../platform/src/platform/artifacts/store.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { KnowledgeConnectorRegistry } from '../platform/src/platform/knowledge/connectors.js';
import { ingestKnowledgeArtifact, ingestKnowledgeUrl, pickKnowledgeRefreshCandidates, refreshKnowledgeSources } from '../platform/src/platform/knowledge/ingest-inputs.js';
import { reviewKnowledgeIssue } from '../platform/src/platform/knowledge/review.js';

const roots: string[] = [], stores: KnowledgeStore[] = [];
let previous: JudgmentPort | undefined, installed = false;
afterEach(async () => {
  if (installed) installJudgmentPort(previous); installed = false;
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  previous = installJudgmentPort(fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic unavailable decision chain'); }).port); installed = true;
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-source-refresh-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(store); await store.init();
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts'), allowPrivateHostFetches: true });
  const context = { store, artifactStore, connectorRegistry: new KnowledgeConnectorRegistry(), emitIfReady() {},
    async syncReviewedMemory() {}, async lint() { return []; }, listConnectors() { return []; }, async semanticEnrichSource() {} };
  return { store, context };
}
const classic = <T>(operation: () => T) => withDecisionModelPolicy(() => 'Classic - Off' as DecisionModelPolicy, operation);
const html = '<html><head><title>Network manual</title></head><body><article><h1>Network setup</h1><p>Keep the power connected.</p></article></body></html>';

test('a refresh that cannot fetch keeps an indexed source indexed and records the crawl error', async () => {
  const { store, context } = await fixture();
  let up = true;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return up ? new Response(html, { headers: { 'content-type': 'text/html' } }) : new Response('down', { status: 503 });
  } });
  try {
    await classic(async () => {
      const ingested = await ingestKnowledgeUrl(context, { url: `http://127.0.0.1:${server.port}/manual`, allowPrivateHosts: true });
      expect(ingested.source.status, ingested.source.crawlError).toBe('indexed');
      up = false;
      server.stop(true);
      const refreshed = await refreshKnowledgeSources(context, [store.getSource(ingested.source.id)!]);
      const after = store.getSource(ingested.source.id)!;
      expect(refreshed).toBe(0);
      expect(after.status).toBe('indexed');
      expect(after.crawlError).toBeTruthy();
      expect(after.metadata.lastCrawlFailedAt).toBeDefined();
      expect(store.getExtractionBySourceId(ingested.source.id)).not.toBeNull();
    });
  } finally { server.stop(true); }
});

test('a private-host ingest keeps its fetch intent so the refresh is not refused', async () => {
  const { store, context } = await fixture();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return new Response(html, { headers: { 'content-type': 'text/html' } }); } });
  try {
    await classic(async () => {
      const ingested = await ingestKnowledgeUrl(context, { url: `http://127.0.0.1:${server.port}/manual`, allowPrivateHosts: true });
      const intent = store.getSource(ingested.source.id)!.metadata.knowledgeIntent as Record<string, unknown> | undefined;
      expect(intent?.remoteFetchMode).toBe('allow-private-hosts');
      expect(await refreshKnowledgeSources(context, [store.getSource(ingested.source.id)!])).toBe(1);
    });
  } finally { server.stop(true); }
});

test('an artifact ingest of a private-host uri keeps its fetch intent so the refresh is not refused', async () => {
  const { store, context } = await fixture();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return new Response(html, { headers: { 'content-type': 'text/html' } }); } });
  try {
    await classic(async () => {
      const ingested = await ingestKnowledgeArtifact(context, { uri: `http://127.0.0.1:${server.port}/manual`, allowPrivateHosts: true });
      const intent = store.getSource(ingested.source.id)!.metadata.knowledgeIntent as Record<string, unknown> | undefined;
      expect(intent?.remoteFetchMode).toBe('allow-private-hosts');
      expect(await refreshKnowledgeSources(context, [store.getSource(ingested.source.id)!])).toBe(1);
    });
  } finally { server.stop(true); }
});

test('a first ingest that cannot fetch is still recorded failed', async () => {
  const { context } = await fixture();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return new Response('down', { status: 503 }); } });
  const url = `http://127.0.0.1:${server.port}/missing`;
  server.stop(true);
  await classic(async () => {
    const result = await ingestKnowledgeUrl(context, { url, allowPrivateHosts: true });
    expect(result.source.status).toBe('failed');
  });
});

test('forgetting a source in review retires it, and a stale refresh leaves it forgotten', async () => {
  const { store, context } = await fixture();
  const source = await store.upsertSource({ connectorId: 'url', sourceType: 'url', title: 'Old manual', sourceUri: 'https://example.invalid/old', canonicalUri: 'https://example.invalid/old', status: 'indexed' });
  const issue = await store.upsertIssue({ severity: 'warning', code: 'fixture', message: 'Outdated', sourceId: source.id });
  await reviewKnowledgeIssue(store, { issueId: issue.id, action: 'forget' });
  expect(store.getSource(source.id)?.status).toBe('stale');
  expect(pickKnowledgeRefreshCandidates(context, 'stale', undefined).map((entry) => entry.id)).not.toContain(source.id);
  expect(pickKnowledgeRefreshCandidates(context, 'stale', [source.id]).map((entry) => entry.id)).toContain(source.id);
});
