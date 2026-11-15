import type { ArtifactDescriptor, ArtifactKind } from '../../platform/src/platform/artifacts/types.js';
import { MultimodalService } from '../../platform/src/platform/multimodal/service.js';

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

/**
 * A fake-port answerer for the one entity request: each term's share of the
 * Choice is its weight (unnamed terms weigh 0), "none" weighs `none`. Any other
 * question (a document's readability reading) is answered yes.
 */
export function termChoice(weights: Readonly<Record<string, number>>, none = 0) {
  return (_name: string, question: { readonly criteria?: unknown }, state: unknown) => {
    const candidates = (state as { candidates?: { id: string; content: { term: string } }[] } | undefined)?.candidates;
    if (!Array.isArray(candidates)) return { type: 'noul', noul: 0.99 };
    const options = Object.keys(question.criteria as Record<string, unknown>);
    const raw = options.map(option => option === 'none' ? none : weights[candidates.find(candidate => candidate.id === option)?.content.term ?? ''] ?? 0);
    const total = raw.reduce((sum, value) => sum + value, 0);
    const probabilities = Object.fromEntries(options.map((option, index) => [option, total > 0 ? raw[index]! / total : option === 'none' ? 1 : 0]));
    const choice = options.reduce((best, option) => probabilities[option]! > probabilities[best]! ? option : best, options[0]!);
    return { type: 'choice', choice, confidence: probabilities[choice]!, probabilities };
  };
}
