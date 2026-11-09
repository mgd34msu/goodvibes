import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../sdk/src/platform/artifacts/index.js';
import { tryAcquireArtifactPublication } from '../sdk/src/platform/artifacts/store.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { configureKnowledgeArtifactReferences } from '../sdk/src/platform/knowledge/artifact-reference-ensemble.js';
import { upsertObservedKnowledgeNode } from '../sdk/src/platform/knowledge/store-node-observation.js';
import { materializeGeneratedKnowledgeProjection, type GeneratedKnowledgeProjectionInput } from '../sdk/src/platform/knowledge/generated-projections.js';
import { knowledgeRawRepresentation } from '../sdk/src/platform/knowledge/store-record-representation.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-projection-owner-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge-wiki.sqlite') });
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  configureKnowledgeArtifactReferences({ artifactStore, controlPlaneDirectory: root, stores: [store] });
  const raw = { id: 'device', kind: 'ha_device' as const, slug: 'device', title: 'Device', status: 'active' as const, metadata: { knowledgeSpaceId: 'test' } };
  const target = await upsertObservedKnowledgeNode(store, raw, 'home-assistant-snapshot', raw, () => raw);
  const input: GeneratedKnowledgeProjectionInput = { store, artifactStore, connectorId: 'generated', sourceId: 'generated-page',
    title: 'Device page', filename: 'device.md', markdown: '# Device\nOriginal fact.', canonicalUri: 'knowledge://generated/device',
    projectionKind: 'test', target: { kind: 'node', id: target.id }, assertCurrent: () => {} };
  const first = await materializeGeneratedKnowledgeProjection(input);
  return { store, artifactStore, target, input, first };
}
describe('generated page original output ownership', () => {
  test('an older saved page retains its exact-content clocks without retaining a digest cache', async () => {
    const item = await fixture();
    await item.store.replaceSourceRecord({ ...item.first.source, metadata: { ...item.first.source.metadata, generatedContentHash: 'a'.repeat(40) } });
    const previous = item.store.getSource(item.first.source.id);
    if (!previous?.artifactId) throw new Error('Saved generated page omitted its artifact');
    const oldClock = knowledgeRawRepresentation(previous.metadata).generatedAt;
    const oldCrawl = knowledgeRawRepresentation(previous).lastCrawledAt;
    const next = await materializeGeneratedKnowledgeProjection(item.input);
    expect(next.artifactCreated).toBe(false);
    expect(next.artifact.id).toBe(previous.artifactId);
    expect(knowledgeRawRepresentation(next.source.metadata).generatedAt).toBe(oldClock);
    expect(knowledgeRawRepresentation(next.source).lastCrawledAt).toBe(oldCrawl);
    expect(next.source.metadata.generatedContentHash).toBeNull();
  });
  test('a stale saved content digest cannot conceal changed actual page bytes', async () => {
    const item = await fixture();
    const revised = '# Device\nChanged actual page.';
    await item.store.replaceSourceRecord({ ...item.first.source, metadata: { ...item.first.source.metadata, generatedContentHash: 'obsolete-cache' } });
    const next = await materializeGeneratedKnowledgeProjection({ ...item.input, markdown: revised });
    expect(next.artifactCreated).toBe(true);
    expect(next.artifact.id).not.toBe(item.first.artifact.id);
    expect((await item.artifactStore.readContent(next.artifact.id)).buffer.equals(Buffer.from(revised))).toBe(true);
    expect(next.source.metadata.generatedContentHash).toBeNull();
  });
  test('invalid UTF-8 bytes are not reused as a page containing the replacement character', async () => {
    const item = await fixture();
    const other = await item.artifactStore.create({ kind: 'document', mimeType: 'text/markdown', filename: 'invalid.md', dataBase64: '/w==', retentionMs: 0 });
    await item.store.replaceSourceRecord({ ...item.first.source, artifactId: other.id });
    const next = await materializeGeneratedKnowledgeProjection({ ...item.input, markdown: '\ufffd' });
    expect(next.artifactCreated).toBe(true);
    expect(next.artifact.id).not.toBe(other.id);
    expect((await item.artifactStore.readContent(next.artifact.id)).buffer).toEqual(Buffer.from('\ufffd'));
  });
  test('ordinary guarded success and exact-content artifact reuse retain coherent receipts', async () => {
    const item = await fixture();
    expect(item.store.getSource(item.first.source.id)).toBe(item.first.source);
    expect(item.first.source.artifactId).toBe(item.first.artifact.id);
    const next = await materializeGeneratedKnowledgeProjection(item.input);
    expect(next.artifactCreated).toBe(false); expect(next.artifact.id).toBe(item.first.artifact.id);
    expect(item.store.getSource(next.source.id)).toBe(next.source);
  });
  test('a newer generated source or edge during artifact creation survives stale publication unchanged', async () => {
    for (const change of ['source', 'edge', 'target'] as const) {
      const item = await fixture(); const original = item.artifactStore.createForPublication.bind(item.artifactStore);
      let external: unknown;
      const create = spyOn(item.artifactStore, 'createForPublication').mockImplementation(async (...args) => {
        const artifact = await original(...args);
        if (change === 'source') { await item.store.replaceSourceRecord({ ...item.first.source, title: 'Newer writer' }); external = item.store.getSource(item.first.source.id); }
        if (change === 'edge') external = await item.store.upsertEdge({ ...item.first.linked!, metadata: { writer: 'newer' } });
        if (change === 'target') { const raw = { ...item.target, title: 'Newer device' }; external = await upsertObservedKnowledgeNode(item.store, raw, 'home-assistant-snapshot', raw, () => raw); }
        return artifact;
      });
      try { await expect(materializeGeneratedKnowledgeProjection({ ...item.input, markdown: '# Device\nNew fact.' })).rejects.toThrow(); }
      finally { create.mockRestore(); }
      if (change === 'source') expect(external).toBe(item.store.getSource(item.first.source.id));
      if (change === 'edge') expect(external).toBe(item.store.listEdges().find((edge) => edge.id === item.first.linked!.id));
      if (change === 'target') expect(external).toBe(item.store.getNode(item.target.id));
      expect(item.artifactStore.list().map((artifact) => artifact.id)).toEqual([item.first.artifact.id]);
    }
  });
  test('precommit owner retirement preserves published page and cleans only the unreferenced candidate artifact', async () => {
    const item = await fixture(); let live = true; const original = item.store.applyPreparedIngest.bind(item.store);
    const ingest = spyOn(item.store, 'applyPreparedIngest').mockImplementation(async (...args) => { live = false; return original(...args); });
    try { await expect(materializeGeneratedKnowledgeProjection({ ...item.input, markdown: '# Device\nReplacement.', assertCurrent: () => { if (!live) throw new Error('retired'); } })).rejects.toThrow(); }
    finally { ingest.mockRestore(); }
    expect(item.store.getSource(item.first.source.id)).toBe(item.first.source);
    expect(item.store.listEdges().find((edge) => edge.id === item.first.linked!.id)).toBe(item.first.linked);
    expect(item.artifactStore.list().map((artifact) => artifact.id)).toEqual([item.first.artifact.id]);
  });
  test('successful atomic commit followed by late retirement stays committed with referenced artifact and stale outcome', async () => {
    const item = await fixture(); const controller = new AbortController(); const original = item.store.applyPreparedIngest.bind(item.store);
    const ingest = spyOn(item.store, 'applyPreparedIngest').mockImplementation(async (...args) => { const receipt = await original(...args); controller.abort(); return receipt; });
    try { await expect(materializeGeneratedKnowledgeProjection({ ...item.input, markdown: '# Device\nCommitted replacement.', signal: controller.signal })).rejects.toThrow(); }
    finally { ingest.mockRestore(); }
    const committed = item.store.getSource(item.first.source.id)!;
    expect(committed).not.toBe(item.first.source);
    expect(item.artifactStore.get(committed.artifactId!)).not.toBeNull();
    expect(item.store.listEdges().some((edge) => edge.fromId === committed.id && edge.toId === item.target.id)).toBe(true);
  });
  for (const change of ['output', 'signal'] as const) {
    test(`postcommit ${change} replacement holds the caller without undoing the committed page`, async () => {
      const item = await fixture();
      const input = { ...item.input, markdown: '# Device\nCommitted original request.', signal: new AbortController().signal };
      const original = item.store.applyPreparedIngest.bind(item.store);
      const ingest = spyOn(item.store, 'applyPreparedIngest').mockImplementation(async (...args) => {
        const receipt = await original(...args);
        if (change === 'output') input.markdown = '# Different caller output';
        else input.signal = new AbortController().signal;
        return receipt;
      });
      try { await expect(materializeGeneratedKnowledgeProjection(input)).rejects.toThrow(); }
      finally { ingest.mockRestore(); }
      const committed = item.store.getSource(item.first.source.id)!;
      expect(committed).not.toBe(item.first.source);
      expect(item.artifactStore.get(committed.artifactId!)?.id).toBe(committed.artifactId);
      expect(item.store.getSourceSnapshot({ id: committed.id }).source).toEqual(committed);
      expect(item.store.listEdges().some(edge => edge.fromId === committed.id && edge.toId === item.target.id)).toBe(true);
    });
  }
  test('postcommit replacement is never returned as this operation receipt or overwritten by compensation', async () => {
    const item = await fixture(); const original = item.store.applyPreparedIngest.bind(item.store); let newer: unknown;
    const ingest = spyOn(item.store, 'applyPreparedIngest').mockImplementation(async (...args) => {
      const receipt = await original(...args);
      const own = receipt.sources[0]!;
      await item.store.replaceSourceRecord({ ...own, title: 'Concurrent owner after commit' }); newer = item.store.getSource(own.id);
      return receipt;
    });
    try { await expect(materializeGeneratedKnowledgeProjection({ ...item.input, markdown: '# Device\nOwn candidate.' })).rejects.toThrow(); }
    finally { ingest.mockRestore(); }
    expect(newer).toBe(item.store.getSource(item.first.source.id));
    expect(item.artifactStore.get(item.store.getSource(item.first.source.id)!.artifactId!)).not.toBeNull();
  });
  test('replacing a page never deletes an old generated artifact still referenced by another source', async () => {
    const item = await fixture();
    await item.store.upsertSource({ id: 'another-page', connectorId: 'generated', sourceType: 'document', artifactId: item.first.artifact.id, status: 'indexed' });
    const next = await materializeGeneratedKnowledgeProjection({ ...item.input, markdown: '# Device\nA revised fact.' });
    expect(next.artifact.id).not.toBe(item.first.artifact.id);
    expect(item.artifactStore.get(item.first.artifact.id)).not.toBeNull();
  });
});

test('authority removal cannot downgrade a guarded hold into legacy compensation', async () => {
  const item = await fixture();
  const input = { ...item.input, markdown: '# New projection' };
  const original = item.artifactStore.createForPublication.bind(item.artifactStore); let newer: unknown;
  const create = spyOn(item.artifactStore, 'createForPublication').mockImplementation(async (...args) => {
    const artifact = await original(...args);
    await item.store.replaceSourceRecord({ ...item.first.source, title: 'New owner while awaiting artifact' });
    newer = item.store.getSource(item.first.source.id);
    input.assertCurrent = undefined;
    return artifact;
  });
  try { await expect(materializeGeneratedKnowledgeProjection(input)).rejects.toThrow(); }
  finally { create.mockRestore(); }
  expect(newer).toBe(item.store.getSource(item.first.source.id));
  expect(item.artifactStore.get(item.first.artifact.id)).not.toBeNull();
});

test('store replacement after commit cannot delete the original stores referenced artifact', async () => {
  const item = await fixture(); const other = await fixture();
  const input = { ...item.input, markdown: '# Newly committed projection' };
  const original = item.store.applyPreparedIngest.bind(item.store);
  const ingest = spyOn(item.store, 'applyPreparedIngest').mockImplementation(async (...args) => {
    const receipt = await original(...args); input.store = other.store; return receipt;
  });
  try { await expect(materializeGeneratedKnowledgeProjection(input)).rejects.toThrow(); }
  finally { ingest.mockRestore(); }
  const committed = item.store.getSource(item.first.source.id)!;
  expect(item.artifactStore.get(committed.artifactId!)).not.toBeNull();
});

test('equal markdown with a different requested filename creates the requested artifact', async () => {
  const item = await fixture();
  const next = await materializeGeneratedKnowledgeProjection({ ...item.input, filename: 'renamed-device.md' });
  expect(next.artifactCreated).toBe(true);
  expect(next.artifact.id).not.toBe(item.first.artifact.id);
  expect(next.artifact.filename).toBe('renamed-device.md');
  expect(next.source.metadata.filename).toBe('renamed-device.md');
});

test('equal bytes in a different artifact kind/mime cannot satisfy a generated markdown page', async () => {
  const item = await fixture();
  const other = await item.artifactStore.create({ kind: 'data', mimeType: 'text/plain', filename: 'device.md', text: item.input.markdown, retentionMs: 0 });
  await item.store.replaceSourceRecord({ ...item.first.source, artifactId: other.id });
  const next = await materializeGeneratedKnowledgeProjection(item.input);
  expect(next.artifact.id).not.toBe(other.id);
  expect(next.artifact.kind).toBe('document'); expect(next.artifact.mimeType).toBe('text/markdown');
});

test('an asynchronous read fence cannot be erased into an apparently reusable artifact', async () => {
  const item = await fixture(), originalRead = item.artifactStore.readContent.bind(item.artifactStore);
  const read = spyOn(item.artifactStore, 'readContent').mockImplementation(async (...args) => ({
    ...await originalRead(...args),
    assertCurrent: (() => Promise.reject(new Error('Original read failed'))) as unknown as () => void,
  }));
  const create = spyOn(item.artifactStore, 'createForPublication');
  try {
    await expect(materializeGeneratedKnowledgeProjection(item.input)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(item.store.getSource(item.first.source.id)).toBe(item.first.source);
  } finally { read.mockRestore(); create.mockRestore(); }
});


test('a missing previous content file can be regenerated without acquiring deletion authority over its replacement', async () => {
  const item = await fixture();
  const old = item.artifactStore.getRecord(item.first.artifact.id);
  if (!old) throw new Error('Missing original artifact record');
  rmSync(old.contentPath);
  const next = await materializeGeneratedKnowledgeProjection(item.input);
  expect(next.artifactCreated).toBe(true);
  expect(next.artifact.id).not.toBe(old.id);
  expect((await item.artifactStore.readContent(next.artifact.id)).buffer).toEqual(Buffer.from(item.input.markdown));
  expect(item.store.getSource(next.source.id)?.artifactId).toBe(next.artifact.id);
});


for (const reuse of [false, true]) {
  test(`actual ${reuse ? 'reused' : 'new'} artifact publication lease spans the awaited source commit and drains before returning`, async () => {
    const item = await fixture(), original = item.store.applyPreparedIngest.bind(item.store);
    let candidateId: string | undefined;
    const ingest = spyOn(item.store, 'applyPreparedIngest').mockImplementation(async (...args) => {
      candidateId = args[0].sources[0]?.artifactId;
      if (!candidateId) throw new Error('Missing publication artifact');
      const originalArtifact = item.artifactStore.captureOriginal(candidateId);
      expect(tryAcquireArtifactPublication(originalArtifact)).toBeNull();
      const result = await original(...args);
      expect(tryAcquireArtifactPublication(originalArtifact)).toBeNull();
      return result;
    });
    let result: Awaited<ReturnType<typeof materializeGeneratedKnowledgeProjection>>;
    try { result = await materializeGeneratedKnowledgeProjection({ ...item.input, ...(reuse ? {} : { markdown: '# Changed while owned' }) }); }
    finally { ingest.mockRestore(); }
    expect(result.artifactCreated).toBe(!reuse);
    if (!candidateId) throw new Error('Actual materializer did not retain its candidate artifact');
    expect(result.artifact.id).toBe(candidateId);
    const acquired = tryAcquireArtifactPublication(item.artifactStore.captureOriginal(result.artifact.id));
    expect(acquired).not.toBeNull(); acquired?.release();
  });
}

test('a failed fresh source commit releases its exact artifact lease before real ensemble cleanup, preserving the original error', async () => {
  const item = await fixture(); let candidateId: string | undefined;
  const ingest = spyOn(item.store, 'applyPreparedIngest').mockImplementation(async (...args) => {
    candidateId = args[0].sources[0]?.artifactId;
    if (!candidateId) throw new Error('Missing publication artifact');
    expect(tryAcquireArtifactPublication(item.artifactStore.captureOriginal(candidateId))).toBeNull();
    throw new Error('Exact source publication failed');
  });
  try {
    await expect(materializeGeneratedKnowledgeProjection({ ...item.input, markdown: '# Failing candidate' })).rejects.toThrow('Exact source publication failed');
  } finally { ingest.mockRestore(); }
  if (!candidateId) throw new Error('Fresh candidate was not created');
  expect(item.artifactStore.get(candidateId)).toBeNull();
  expect(item.store.getSource(item.first.source.id)).toBe(item.first.source);
  expect(item.artifactStore.get(item.first.artifact.id)).not.toBeNull();
});
