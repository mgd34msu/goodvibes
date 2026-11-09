/** UNRUN: actual reset/writeback consumers retain original files and the complete
 * native knowledge reference ensemble rather than trusting cached descriptors. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../platform/src/platform/artifacts/store.ts';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.ts';
import { configureKnowledgeArtifactReferences } from '../platform/src/platform/knowledge/artifact-reference-ensemble.ts';
import { resetHomeGraphSpace } from '../platform/src/platform/knowledge/home-graph/reset.ts';
import { knowledgeSpaceMetadata } from '../platform/src/platform/knowledge/spaces.ts';
import { MultimodalService } from '../platform/src/platform/multimodal/service.ts';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.ts';
const roots: string[] = [], stores: KnowledgeStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'artifact-consumer-')); roots.push(root);
  const artifacts = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const home = new KnowledgeStore({ dbPath: join(root, 'knowledge-home-graph.sqlite') }), wiki = new KnowledgeStore({ dbPath: join(root, 'knowledge-wiki.sqlite') }); stores.push(home, wiki); await Promise.all([home.init(), wiki.init()]);
  configureKnowledgeArtifactReferences({ artifactStore: artifacts, controlPlaneDirectory: root, stores: [home, wiki] });
  return { root, artifacts, home, wiki };
}
test('Home Graph reset preserves an unstamped shared artifact referenced by a separately persisted wiki source', async () => {
  const f = await fixture(), artifact = await f.artifacts.create({ kind: 'document', text: 'shared', mimeType: 'text/plain', retentionMs: 0 });
  await f.home.upsertSource({ connectorId: 'homeassistant', sourceType: 'document', status: 'indexed', artifactId: artifact.id, metadata: knowledgeSpaceMetadata('homeassistant:house') });
  await f.wiki.upsertSource({ connectorId: 'wiki', sourceType: 'document', status: 'indexed', artifactId: artifact.id });
  const reset = await resetHomeGraphSpace(f.home, f.artifacts, { installationId: 'house' });
  expect(reset.deleted.sources).toBe(1); expect(reset.deletedArtifacts).toBe(0); expect(reset.preservedArtifacts).toBe(1); expect(reset.artifactCleanup.referenced).toBe(1); expect(f.artifacts.getRecord(artifact.id)).not.toBeNull();
});
test('reset captures original files before the DB await and refuses a same-byte replacement introduced by the reset continuation', async () => {
  const f = await fixture(), artifact = await f.artifacts.create({ kind: 'document', text: 'original', retentionMs: 0, metadata: knowledgeSpaceMetadata('homeassistant:house') }), record = f.artifacts.getRecord(artifact.id)!;
  await f.home.upsertSource({ connectorId: 'homeassistant', sourceType: 'document', status: 'indexed', artifactId: artifact.id, metadata: knowledgeSpaceMetadata('homeassistant:house') });
  const native = f.home.deleteKnowledgeSpace.bind(f.home), reset = spyOn(f.home, 'deleteKnowledgeSpace').mockImplementation(async (...args) => {
    const result = await native(...args), bytes = readFileSync(record.contentPath); renameSync(record.contentPath, `${record.contentPath}.retained`); writeFileSync(record.contentPath, bytes, { mode: 0o600 }); return result;
  });
  try { const result = await resetHomeGraphSpace(f.home, f.artifacts, { installationId: 'house' }); expect(result.deletedArtifacts).toBe(0); expect(result.artifactCleanup.held).toBe(1); expect(readFileSync(record.contentPath).toString()).toBe('original'); }
  finally { reset.mockRestore(); }
});
test('an unbound reset acknowledges data reset but reports unavailable artifact cleanup instead of deleting by ID', async () => {
  const root = mkdtempSync(join(tmpdir(), 'artifact-unbound-reset-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'custom.sqlite') }); stores.push(store); await store.init();
  const artifacts = new ArtifactStore({ rootDir: join(root, 'custom-artifacts') }), artifact = await artifacts.create({ kind: 'document', text: 'keep', metadata: knowledgeSpaceMetadata('homeassistant:house') });
  const result = await resetHomeGraphSpace(store, artifacts, { installationId: 'house' }); expect(result.artifactCleanup.unavailable).toBe(1); expect(result.deletedArtifacts).toBe(0); expect(artifacts.getRecord(artifact.id)).not.toBeNull();
});
async function multimodalFixture(onIngest: (id: string, f: Awaited<ReturnType<typeof fixture>>) => Promise<never>) {
  const f = await fixture(), source = await f.artifacts.create({ kind: 'document', mimeType: 'text/plain', filename: 'source.txt', text: 'A safe source document.', retentionMs: 0 });
  const service = new MultimodalService(f.artifacts, {} as never, {} as never, {
    ingestArtifact: async (input: { artifactId: string }, owner: { assertCurrent(): void }) => { owner.assertCurrent(); return onIngest(input.artifactId, f); },
    cleanupUnreferencedArtifact: f.wiki.cleanupUnreferencedArtifact.bind(f.wiki),
  } as never);
  return { ...f, source, service };
}
test('failed multimodal writeback keeps a fresh analysis artifact another native family actually referenced', async () => withDecisionModelPolicy(() => 'Classic - Off', async () => {
  const failure = new Error('Primary ingest failure'); let analysisId = '';
  const f = await multimodalFixture(async (id, owner) => { analysisId = id; await owner.home.upsertSource({ connectorId: 'concurrent', sourceType: 'document', status: 'indexed', artifactId: id }); throw failure; });
  const analysis = await f.service.analyze({ artifactId: f.source.id }); await expect(f.service.writeBackAnalysis(analysis)).rejects.toBe(failure);
  expect(f.artifacts.getRecord(analysisId)).not.toBeNull();
}));
test('failed multimodal writeback removes only its unreferenced actual original after releasing its own lease', async () => withDecisionModelPolicy(() => 'Classic - Off', async () => {
  const failure = new Error('Primary ingest failure'); let analysisPath = '', metadata = '';
  const f = await multimodalFixture(async (id, owner) => { const record = owner.artifacts.getRecord(id)!; analysisPath = record.contentPath; metadata = record.metadataPath; throw failure; });
  const analysis = await f.service.analyze({ artifactId: f.source.id }); await expect(f.service.writeBackAnalysis(analysis)).rejects.toBe(failure);
  expect(existsSync(analysisPath)).toBe(false); expect(existsSync(metadata)).toBe(false); expect(existsSync(`${metadata}.projection-lock`)).toBe(false);
}));
test('invalid asynchronous writeback owners reject and drain before creating an analysis artifact', async () => withDecisionModelPolicy(() => 'Classic - Off', async () => {
  const f = await multimodalFixture(async () => { throw new Error('Ingest must not be reached.'); });
  const analysis = await f.service.analyze({ artifactId: f.source.id }), count = f.artifacts.list(100).length;
  await expect(f.service.writeBackAnalysis(analysis, {}, { assertCurrent: async () => { throw Error('Borrowed asynchronous failure'); } })).rejects.toThrow('synchronously'); expect(f.artifacts.list(100)).toHaveLength(count);
}));
test('two actual analyses with the same UUID prefix keep separate original identities', async () => withDecisionModelPolicy(() => 'Classic - Off', async () => {
  const f = await multimodalFixture(async () => { throw Error('No writeback expected.'); }); let tail = 1;
  const uuid = spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => `00000000-0000-4000-8000-${String(tail++).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`);
  try { const first = await f.service.analyze({ artifactId: f.source.id }), second = await f.service.analyze({ artifactId: f.source.id }); expect(first.id).not.toBe(second.id); }
  finally { uuid.mockRestore(); }
}));
