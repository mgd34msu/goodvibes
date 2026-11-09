/** UNRUN native ingest/import local equality regressions; no model comparison. */
import crypto from 'node:crypto';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { observeKnowledgeValue } from '../platform/src/platform/knowledge/local-value-observation.js';
import { knowledgeIngestGuard } from '../platform/src/platform/knowledge/ingest-preparation.js';
import { createKnowledgeIngestUriCanonicalizer } from '../platform/src/platform/knowledge/uri-canonicalization/ingest-owner.js';
import { KnowledgeExtractionJudgmentHoldError } from '../platform/src/platform/knowledge/extraction-policy.js';
import { KnowledgeEntityAliasHoldError } from '../platform/src/platform/knowledge/entity-aliases.js';
import { KnowledgeUriCanonicalizationHeldError } from '../platform/src/platform/knowledge/uri-canonicalization/types.js';
import { ArtifactStore } from '../platform/src/platform/artifacts/store.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { KnowledgeConnectorRegistry } from '../platform/src/platform/knowledge/connectors.js';
import { finalizeKnowledgeIngestedSource, compileKnowledgeSource } from '../platform/src/platform/knowledge/ingest-compile.js';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
const roots: string[] = [], stores: KnowledgeStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = makeProjectTempDir('knowledge-local-values'); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(store); await store.init();
  const context = { store, artifactStore: new ArtifactStore({ rootDir: join(root, 'artifacts') }), connectorRegistry: new KnowledgeConnectorRegistry(),
    emitIfReady() {}, async syncReviewedMemory() {}, async lint() { return []; }, listConnectors() { return []; } };
  const source = await store.upsertSource({ id: 'source', connectorId: 'fixture', sourceType: 'manual', status: 'indexed', metadata: { localValue: 'original' } });
  const extraction = await store.upsertExtraction({ sourceId: source.id, extractorId: 'fixture', format: 'text', excerpt: 'Original exact evidence.' });
  return { context, source, extraction };
}

test('one captured original compares complete nested data and preserves key/scalar distinctions', () => {
  const original = { a: { unset: undefined, number: -0 }, b: [1, 2] }, selected = observeKnowledgeValue(original);
  expect(selected.matches({ a: { unset: undefined, number: -0 }, b: [1, 2] })).toBe(true);
  original.b[1] = 3; expect(selected.matches(original)).toBe(false);
  expect(selected.matches({ a: { number: -0 }, b: [1, 2] })).toBe(false);
  expect(selected.matches({ a: { unset: undefined, number: 0 }, b: [1, 2] })).toBe(false);
  expect(selected.matches({ b: [1, 2], a: { unset: undefined, number: -0 } })).toBe(false);
});

test('descriptor guards do not invoke current getters, proxies or original proxy traps', () => {
  const selected = observeKnowledgeValue({ label: 'original' }); let effects = 0;
  const accessor = Object.defineProperty({}, 'label', { enumerable: true, get() { effects++; return 'original'; } });
  const proxy = new Proxy({ label: 'original' }, { getPrototypeOf(target) { effects++; return Reflect.getPrototypeOf(target); }, ownKeys(target) { effects++; return Reflect.ownKeys(target); } });
  expect(selected.matches(accessor)).toBe(false); expect(selected.matches(proxy)).toBe(false);
  expect(() => observeKnowledgeValue(proxy)).toThrow(); expect(effects).toBe(0);
});

test('large and deep local records gain no arbitrary comparison cap or recursion failure', () => {
  const values = Array.from({ length: 30_001 }, (_, index) => index), selected = observeKnowledgeValue(values);
  expect(selected.matches(values)).toBe(true);
  let deep: { next?: object } = {}, root = deep;
  for (let index = 0; index < 10_001; index++) { const next = {}; deep.next = next; deep = next; }
  expect(observeKnowledgeValue(root).matches(root)).toBe(true);
});

test('real native ingest guards repeat without SHA and reject a changed current source/extraction', async () => {
  const f = await fixture(), guard = knowledgeIngestGuard(f.context, f.source.id), hashing = spyOn(crypto, 'createHash');
  try { for (let index = 0; index < 5; index++) guard(); expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0); }
  finally { hashing.mockRestore(); }
  await f.context.store.upsertSource({ ...f.source, metadata: { ...f.source.metadata, localValue: 'changed' } });
  expect(guard).toThrow(KnowledgeEntityAliasHoldError);
  const extractionGuard = knowledgeIngestGuard(f.context, f.source.id);
  await f.context.store.upsertExtraction({ ...f.extraction, excerpt: 'Changed original extraction.' });
  expect(extractionGuard).toThrow(KnowledgeEntityAliasHoldError);
});

test('actual URI reservation and cancellation remain bound to the original native read set', async () => {
  const f = await fixture(), uri = 'https://fixture.example.test/owned', signal = new AbortController();
  const reserved = knowledgeIngestGuard(f.context, f.source.id, uri), cancelled = knowledgeIngestGuard(f.context, f.source.id, undefined, signal.signal);
  await f.context.store.upsertSource({ id: 'competing-source', connectorId: 'fixture', sourceType: 'manual', status: 'indexed', canonicalUri: uri });
  expect(reserved).toThrow(KnowledgeEntityAliasHoldError); signal.abort(); expect(cancelled).toThrow(KnowledgeEntityAliasHoldError);
});

test('original attached artifact comparison handles fresh record objects and detects data changes without replacing its method', async () => {
  const f = await fixture(), artifact = await f.context.artifactStore.createFromStream({ kind: 'document', filename: 'original.txt', mimeType: 'text/plain', stream: ['Original bytes.'] });
  const read = f.context.artifactStore.getRecord.bind(f.context.artifactStore), contentPath = read(artifact.id)!.contentPath; let version = 1;
  const native = spyOn(f.context.artifactStore, 'getRecord').mockImplementation(id => { const value = read(id); return value ? { ...value, metadata: { ...value.metadata, originalFixtureVersion: version } } : value; });
  try {
    const uris = createKnowledgeIngestUriCanonicalizer(f.context); uris.reserveSource(f.source.id); uris.attachArtifact(artifact.id);
    const hashing = spyOn(crypto, 'createHash');
    try { uris.assertCurrent(); uris.assertCurrent(); expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0); }
    finally { hashing.mockRestore(); }
    version = 2; expect(() => uris.assertCurrent()).toThrow(KnowledgeUriCanonicalizationHeldError);
    expect(readFileSync(contentPath, 'utf8')).toBe('Original bytes.');
  } finally { native.mockRestore(); }
});

test('actual compile refuses changed borrowed source before publishing its graph', async () => {
  const f = await fixture(), original = f.context.store.listEdges();
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    await expect(compileKnowledgeSource(f.context, { ...f.source, metadata: { ...f.source.metadata, localValue: 'foreign replacement' } }, f.extraction)).rejects.toBeInstanceOf(KnowledgeEntityAliasHoldError);
  });
  expect(f.context.store.listEdges()).toEqual(original); expect(f.context.store.getSource(f.source.id)?.metadata.localValue).toBe('original');
});

test('artifact disappearing during the real initial store await is a typed no-publication hold', async () => {
  const f = await fixture(), artifact = await f.context.artifactStore.createFromStream({ kind: 'document', filename: 'vanishing.txt', mimeType: 'text/plain', stream: ['Original bytes.'] });
  const initialize = f.context.store.init.bind(f.context.store); let remove = false;
  const native = spyOn(f.context.store, 'init').mockImplementation(async (...args) => { await initialize(...args); if (remove) { remove = false; await f.context.artifactStore.delete(artifact.id); } });
  try {
    const uris = createKnowledgeIngestUriCanonicalizer(f.context); uris.reserveSource(f.source.id); uris.attachArtifact(artifact.id); remove = true;
    await expect(finalizeKnowledgeIngestedSource(f.context, { sourceId: f.source.id, artifactId: artifact.id, sourceType: 'manual', connectorId: 'fixture', tags: [], metadata: {} }, uris)).rejects.toBeInstanceOf(KnowledgeExtractionJudgmentHoldError);
    expect(f.context.store.getSource(f.source.id)?.metadata.localValue).toBe('original'); expect(f.context.store.getExtractionBySourceId(f.source.id)?.excerpt).toBe('Original exact evidence.');
  } finally { native.mockRestore(); }
});
