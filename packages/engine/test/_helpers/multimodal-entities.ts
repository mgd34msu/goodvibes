import type { ArtifactDescriptor, ArtifactKind } from '../../sdk/src/platform/artifacts/types.js';
import { MultimodalService } from '../../sdk/src/platform/multimodal/service.js';

export function multimodalFixture(kind: ArtifactKind = 'image', text = 'receipt receipt receipt AI EU') {
  const records = new Map<string, ArtifactDescriptor>();
  const bodies = new Map<string, string>();
  const writes: unknown[] = [], ingests: unknown[] = [], usages: unknown[] = [];
  const providerCalls = { image: 0, audio: 0 };
  const add = (id: string, type: ArtifactKind, content = text, metadata: Record<string, unknown> = {}) => {
    const descriptor: ArtifactDescriptor = { id, kind: type, mimeType: type === 'document' ? 'text/plain' : `${type}/test`,
      filename: `${id}.txt`, sizeBytes: content.length, createdAt: 1,
      acquisitionMode: 'inline-data', fetchMode: 'not-applicable', metadata };
    records.set(id, descriptor); bodies.set(id, content); return descriptor;
  };
  add('source', kind);
  const artifactStore = {
    get: (id: string) => records.get(id) ?? null,
    delete: (id: string) => records.delete(id),
    readContent: async (id: string) => ({ record: { ...records.get(id)!, contentPath: '', metadataPath: '' }, buffer: Buffer.from(bodies.get(id)!) }),
    create: async (input: unknown, ownership?: { assertCurrent?: () => void }) => { ownership?.assertCurrent?.(); writes.push(input); return add(`write-${writes.length}`, 'document', 'analysis'); },
  };
  // This is an API fixture, not native publication/cleanup evidence. Genuine
  // file/lease behavior is exercised by the separate original-cleanup tests.
  const createForPublication = async (input: unknown, ownership?: { assertCurrent?: () => void }) => {
    const artifact = await publicationStore.create(input, ownership); let released = false;
    const assertCurrent = () => { if (records.get(artifact.id) !== artifact) throw new Error('Fixture original artifact changed.'); };
    return { artifact, original: { id: artifact.id, assertCurrent, deleteOriginal: () => { throw new Error('Fixture cannot mint native original deletion.'); } },
      lease: { assertCurrent: () => { if (released) throw new Error('Fixture publication ended.'); }, release: () => { released = true; } } };
  };
  const publicationStore = { ...artifactStore, createForPublication };
  const mediaProviders = { status: async () => [], findProvider: () => ({ analyze: async () => { providerCalls.image++; return { providerId: 'fixture-image', text, labels: [], metadata: {} }; } }) };
  const voiceService = { getStatus: async () => ({ providers: [] }), transcribe: async () => { providerCalls.audio++; return { providerId: 'fixture-audio', text, segments: [{ text }], metadata: {} }; } };
  const knowledgeService = { ingestArtifact: async (input: unknown, ownership?: { assertCurrent?: () => void; onCommitted?: (id: string) => void }) => { ownership?.assertCurrent?.(); ingests.push(input); ownership?.onCommitted?.('knowledge'); return { source: { id: 'knowledge' } }; },
    recordUsage: async (input: unknown) => { usages.push(input); }, cleanupUnreferencedArtifact: async () => 'unavailable' as const };
  const service = new MultimodalService(publicationStore as never, mediaProviders as never, voiceService as never, knowledgeService as never);
  return { service, records, bodies, writes, ingests, usages, add, artifactStore: publicationStore, mediaProviders, voiceService, knowledgeService, providerCalls };
}
