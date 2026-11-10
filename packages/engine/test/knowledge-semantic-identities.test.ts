import * as crypto from 'node:crypto';
/** Source regressions: authored during coding; execution is deferred. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { createSemanticFactIdentityPlanner, assertSemanticFactIdentityPlanner, prepareSemanticFactIdentity } from '../platform/src/platform/knowledge/semantic/identity-plan.js';
import { semanticFactIdentityMetadata, SemanticIdentityHeldError } from '../platform/src/platform/knowledge/store-semantic-fact-selector.js';
import { captureSemanticSourceRevision, semanticSourceIsCurrent, semanticSourceRevisionMetadata } from '../platform/src/platform/knowledge/semantic/source-revisions.js';
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import type { NativeDataWriteOwner } from '../platform/src/platform/runtime/native-reader-compatibility.js';

const roots: string[] = [], stores: KnowledgeStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function open(dbPath?: string, nativeDataWriter?: NativeDataWriteOwner) {
  if (!dbPath) { const root = mkdtempSync(join(tmpdir(), 'semantic-identities-')); roots.push(root); dbPath = join(root, 'knowledge.sqlite'); }
  const store = new KnowledgeStore({ dbPath, ...(nativeDataWriter ? { nativeDataWriter } : {}) }); stores.push(store); await store.init(); return { store, dbPath };
}
const claim = { spaceId: 'house', kind: 'specification', title: '温度', summary: '高', value: '高', subjectIds: ['device'] };
async function save(store: KnowledgeStore, identity: ReturnType<ReturnType<typeof createSemanticFactIdentityPlanner>['prepare']>) {
  const selector = identity.selector;
  return store.upsertNode({ id: identity.id, kind: 'fact', slug: identity.id, title: selector.title, ...(selector.summary === null ? {} : { summary: selector.summary }), status: 'draft', metadata: {
    knowledgeSpaceId: selector.spaceId, semanticKind: 'fact', factKind: selector.factKind, ...(selector.value === null ? {} : { value: selector.value }), ...semanticFactIdentityMetadata(selector),
  } });
}

test('complete exact claims preserve Unicode, punctuation, case, qualifiers and tagged subject sets', async () => {
  const { store } = await open(); const pass = createSemanticFactIdentityPlanner(store);
  const inputs = [claim, { ...claim, title: '湿度', value: '低' }, { ...claim, title: 'C++' }, { ...claim, title: 'C#' },
    { ...claim, value: '-5' }, { ...claim, value: '5' }, { ...claim, title: 'USB' }, { ...claim, title: 'usb' },
    { ...claim, summary: 'high only while charging' }, { ...claim, subjectIds: ['A|B'] }, { ...claim, subjectIds: ['A', 'B'] },
    { ...claim, subjectIds: ['Device'] }, { ...claim, subjectIds: [], fallbackScope: 'device' }];
  const ids = inputs.map(input => pass.prepare(input).id);
  expect(new Set(ids).size).toBe(inputs.length);
  expect(ids.every(id => /^sem-fact-[a-p-]+$/.test(id))).toBe(true);
  expect(pass.prepare({ ...claim, subjectIds: ['device', 'other'], fallbackScope: 'source-a' }).id)
    .toBe(pass.prepare({ ...claim, subjectIds: ['other', 'device', 'device'], fallbackScope: 'source-b' }).id);
});

test('saved exact subject claim keeps its opaque original ID across sources and actual restart', async () => {
  const { store, dbPath } = await open(), pass = createSemanticFactIdentityPlanner(store);
  const identity = pass.prepare({ ...claim, fallbackScope: 'source-a' }); await save(store, identity); await store.close(); stores.splice(stores.indexOf(store), 1);
  const reopened = (await open(dbPath)).store;
  expect(createSemanticFactIdentityPlanner(reopened).prepare({ ...claim, fallbackScope: 'source-b' }).id).toBe(identity.id);
});

test('historical lossy ID is adopted only for its exact stored claim and ambiguous historical origin is held', async () => {
  const { store } = await open();
  await store.upsertNode({ id: 'sem-fact-old-lossy', kind: 'fact', slug: 'old-claim', title: claim.title, summary: claim.summary, status: 'draft', sourceId: 'a', metadata: {
    knowledgeSpaceId: 'house', semanticKind: 'fact', factKind: claim.kind, value: claim.value, subjectIds: claim.subjectIds,
  } });
  expect(createSemanticFactIdentityPlanner(store).prepare(claim).id).toBe('sem-fact-old-lossy');
  expect(createSemanticFactIdentityPlanner(store).prepare({ ...claim, title: '湿度' }).id).not.toBe('sem-fact-old-lossy');
  await store.upsertNode({ id: 'ambiguous-old', kind: 'fact', slug: 'ambiguous-old', title: 'Unscoped', status: 'draft', sourceId: 'a', metadata: {
    knowledgeSpaceId: 'house', semanticKind: 'fact', factKind: 'note', sourceIds: ['a', 'b'],
  } });
  expect(() => createSemanticFactIdentityPlanner(store).prepare({ spaceId: 'house', kind: 'note', title: 'Unscoped', fallbackScope: 'a' })).toThrow(SemanticIdentityHeldError);
});

test('actual saved competing ID invalidates an original absent plan without catalog-wide churn', async () => {
  const { store } = await open(); const first = createSemanticFactIdentityPlanner(store).prepare(claim);
  await store.upsertNode({ id: 'unrelated', kind: 'topic', slug: 'unrelated', title: 'Unrelated', status: 'draft' }); first.assertCurrent();
  const winner = createSemanticFactIdentityPlanner(store).prepare(claim); await save(store, winner);
  expect(() => first.assertCurrent()).toThrow(SemanticIdentityHeldError);
  expect(createSemanticFactIdentityPlanner(store).prepare(claim).id).toBe(winner.id);
});

test('duplicate exact historical rows and future identity formats preserve all original rows', async () => {
  const { store } = await open();
  const input = { kind: 'fact' as const, title: claim.title, summary: claim.summary, status: 'draft' as const, metadata: {
    knowledgeSpaceId: 'house', semanticKind: 'fact', factKind: claim.kind, value: claim.value, subjectIds: claim.subjectIds,
  } };
  await store.upsertNode({ ...input, id: 'old-a', slug: 'old-a' }); await store.upsertNode({ ...input, id: 'old-b', slug: 'old-b' });
  const before = JSON.stringify(store.listNodes());
  expect(() => createSemanticFactIdentityPlanner(store).prepare(claim)).toThrow(SemanticIdentityHeldError); expect(JSON.stringify(store.listNodes())).toBe(before);
  await store.upsertNode({ ...input, title: 'Future', id: 'future', slug: 'future', metadata: { ...input.metadata, semanticIdentityVersion: 77 } });
  expect(() => createSemanticFactIdentityPlanner(store).prepare({ ...claim, title: 'Future' })).toThrow(SemanticIdentityHeldError);
  expect(store.getNode('future')?.metadata.semanticIdentityVersion).toBe(77);
});

test('planner copies and late WeakMap overrides cannot execute forged pass methods or issue native identity', async () => {
  const { store } = await open(), pass = createSemanticFactIdentityPlanner(store); let getter = 0;
  const fake = Object.create(null, { prepare: { get() { getter++; return pass.prepare; } }, assertCurrent: { get() { getter++; return pass.assertCurrent; } } });
  const oldGet = WeakMap.prototype.get;
  try { WeakMap.prototype.get = () => ({ store, prepare: pass.prepare, assertCurrent: pass.assertCurrent });
    expect(() => assertSemanticFactIdentityPlanner(fake, store)).toThrow(SemanticIdentityHeldError);
    expect(() => prepareSemanticFactIdentity(fake, store, claim)).toThrow(SemanticIdentityHeldError);
  } finally { WeakMap.prototype.get = oldGet; }
  expect(getter).toBe(0);
});

test('actual staged import declares the identity reader floor before publishing clone rows', async () => {
  let denyIdentity = true; const seen: string[] = [];
  const { store, dbPath } = await open(undefined, { declare(format) { seen.push(format); if (format === 'knowledge-semantic-identities-v1' && denyIdentity) throw new Error('old reader retained'); } });
  await store.upsertSource({ id: 'baseline-source', connectorId: 'fixture', sourceType: 'manual', status: 'indexed' });
  const identity = createSemanticFactIdentityPlanner(store).prepare(claim), selector = identity.selector;
  const node = { id: identity.id, kind: 'fact' as const, slug: identity.id, title: selector.title, summary: selector.summary!, status: 'draft' as const,
    metadata: { knowledgeSpaceId: 'house', semanticKind: 'fact', factKind: claim.kind, value: claim.value, ...semanticFactIdentityMetadata(selector) } };
  const original = readFileSync(dbPath);
  const input = { sources: [], extractions: [], nodes: [], edges: [], issues: [] };
  await expect(store.applyPreparedIngest(input, async () => ({ nodes: [node], edges: [], issues: [] }))).rejects.toThrow('old reader retained');
  expect(readFileSync(dbPath)).toEqual(original); expect(store.getNode(identity.id)).toBeNull(); expect(seen).toContain('knowledge-semantic-identities-v1');
  denyIdentity = false;
  await store.applyPreparedIngest(input, async () => ({ nodes: [node], edges: [], issues: [] })); expect(store.getNode(identity.id)?.id).toBe(identity.id);
});

async function sourceFixture() {
  const item = await open(); const source = await item.store.upsertSource({ id: 'source', connectorId: 'fixture', sourceType: 'manual', status: 'indexed' });
  const extraction = await item.store.upsertExtraction({ id: 'extraction', sourceId: source.id, extractorId: 'fixture', format: 'text', excerpt: 'The exact original source.' });
  return { ...item, source, extraction };
}
test('fresh cache uses actual saved source/extraction revisions, refuses copied provenance and detects equal-row rewrites', async () => {
  const { store, source, extraction } = await sourceFixture(); const revision = captureSemanticSourceRevision(store, source, extraction);
  await store.upsertSemanticEnrichmentState({ sourceId: source.id, metadata: semanticSourceRevisionMetadata(revision) });
  expect(semanticSourceIsCurrent(store, source, extraction, revision)).toBe(true);
  expect(() => semanticSourceIsCurrent(store, source, extraction, { ...revision })).toThrow(SemanticIdentityHeldError);
  const updated = await store.upsertExtraction({ ...extraction });
  expect(semanticSourceIsCurrent(store, source, updated)).toBe(false);
});
test('old source cache is cold without hashing and native cache mutation cannot forge a hit', async () => {
  const { store, source, extraction } = await sourceFixture();
  await store.upsertSemanticEnrichmentState({ sourceId: source.id, textHash: '0123456789abcdef', metadata: { extractor: 'llm' } });
  expect(semanticSourceIsCurrent(store, source, extraction)).toBe(false); expect(semanticSourceIsCurrent(store, source, extraction)).toBe(false);
  store.getSemanticEnrichmentState(source.id)!.metadata.semanticSourceVersion = 2;
  store.getSemanticEnrichmentState(source.id)!.metadata.semanticSourceBinding = captureSemanticSourceRevision(store, source, extraction);
  expect(() => semanticSourceIsCurrent(store, source, extraction)).toThrow(SemanticIdentityHeldError);
});
test('fresh and historical cache checks issue no source digests', async () => {
  const { store, source, extraction } = await sourceFixture();
  const oldHash = '0123456789abcdef';
  await store.upsertSemanticEnrichmentState({ sourceId: source.id, textHash: oldHash });
  const hashing = spyOn(crypto, 'createHash');
  try {
    expect(semanticSourceIsCurrent(store, source, extraction)).toBe(false);
    expect(semanticSourceIsCurrent(store, source, extraction)).toBe(false);
    expect(hashing.mock.calls.filter(call => call[0] === 'sha256')).toHaveLength(0);
    await store.upsertSemanticEnrichmentState({ sourceId: source.id, metadata: semanticSourceRevisionMetadata(captureSemanticSourceRevision(store, source, extraction)) });
    hashing.mockClear();
    expect(semanticSourceIsCurrent(store, source, extraction)).toBe(true);
    expect(semanticSourceIsCurrent(store, source, extraction)).toBe(true);
    expect(hashing.mock.calls.filter(call => call[0] === 'sha256')).toHaveLength(0);
  } finally { hashing.mockRestore(); }
});
test('future saved source-cache format is held instead of treated as a cache miss and overwritten', async () => {
  const { store, source, extraction } = await sourceFixture(); await store.upsertSemanticEnrichmentState({ sourceId: source.id, metadata: { semanticSourceVersion: 19 } });
  const before = JSON.stringify(store.getSemanticEnrichmentState(source.id));
  expect(() => semanticSourceIsCurrent(store, source, extraction)).toThrow(SemanticIdentityHeldError); expect(JSON.stringify(store.getSemanticEnrichmentState(source.id))).toBe(before);
});


test('a fresh random label cannot overwrite an unrelated actual row or another claim in this pass', async () => {
  const { store } = await open();
  const uuid = '00000000-0000-4000-8000-000000000001' as const, id = `sem-fact-${opaqueUuid(uuid)}`;
  const original = await store.upsertNode({ id, kind: 'topic', slug: 'unrelated-original', title: 'Unrelated original', status: 'draft' });
  const generate = spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(uuid);
  try {
    expect(() => createSemanticFactIdentityPlanner(store).prepare(claim)).toThrow(SemanticIdentityHeldError);
    expect(store.getNode(id)).toBe(original);
    await store.deleteNode(id);
    const pass = createSemanticFactIdentityPlanner(store); pass.prepare(claim);
    expect(() => pass.prepare({ ...claim, title: 'Different claim' })).toThrow(SemanticIdentityHeldError);
    expect(store.getNode(id)).toBeNull();
  } finally { generate.mockRestore(); }
});
