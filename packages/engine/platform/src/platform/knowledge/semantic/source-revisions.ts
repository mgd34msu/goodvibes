/** Derived cache freshness binds actual saved writer revisions, not another
 * serialization/hash of complete source text on every inspection. */
import { sameKnowledgeRecord } from '../store-record-representation.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeExtractionRecord, KnowledgeSourceRecord } from '../types.js';
import { SemanticIdentityHeldError as Held } from '../store-semantic-fact-selector.js';

export interface SemanticSourceRevision {
  readonly version: 2; readonly sourceId: string; readonly sourceRevision: string;
  readonly extractionId: string; readonly extractionRevision: string;
}
/** What one read of a source's saved enrichment state says: whether it was
 * written against the current source and extraction revisions, and by which
 * extractor. */
export interface SemanticSourceFreshness { readonly current: boolean; readonly extractor: string | undefined }

export function captureSemanticSourceRevision(store: KnowledgeStore, source: KnowledgeSourceRecord, extraction: KnowledgeExtractionRecord): SemanticSourceRevision {
  let result: SemanticSourceRevision | undefined;
  store.assertRecordSnapshotFrame(() => {
    if (store.getSource(source.id) !== source || store.getExtractionBySourceId(source.id) !== extraction || extraction.sourceId !== source.id) throw new Held('stale');
    const savedSource = store.getSourceSnapshot({ id: source.id }), savedExtraction = store.getRecordSnapshot('extraction', extraction.id);
    if (!savedSource.generation || !savedExtraction.generation || !sameKnowledgeRecord(source, savedSource.source) || !sameKnowledgeRecord(extraction, savedExtraction.record)) throw new Held('stale');
    result = Object.freeze({ version: 2, sourceId: source.id, sourceRevision: savedSource.generation, extractionId: extraction.id, extractionRevision: savedExtraction.generation });
    return undefined;
  });
  return result!;
}
export function semanticSourceRevisionMetadata(binding: SemanticSourceRevision): Record<string, unknown> {
  return { semanticSourceVersion: 2, semanticSourceBinding: binding };
}
/** Reconstructible caches require current native revisions. Old text digests,
 * a format this build does not know and an unreadable binding never establish
 * freshness: the source reads as not current, so the next pass rewrites it. */
export function semanticSourceFreshness(store: KnowledgeStore, source: KnowledgeSourceRecord, extraction: KnowledgeExtractionRecord): SemanticSourceFreshness {
  const binding = captureSemanticSourceRevision(store, source, extraction);
  const state = store.getSemanticEnrichmentStateSnapshot(source.id);
  if (!state) return { current: false, extractor: undefined };
  const metadata = state.metadata;
  const extractor = typeof metadata['extractor'] === 'string' ? metadata['extractor'] : undefined;
  if (metadata['semanticSourceVersion'] !== 2) return { current: false, extractor };
  const saved = metadata['semanticSourceBinding'];
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return { current: false, extractor };
  const value = saved as Record<string, unknown>;
  const current = value['version'] === 2 && value['sourceId'] === binding.sourceId && value['sourceRevision'] === binding.sourceRevision
    && value['extractionId'] === binding.extractionId && value['extractionRevision'] === binding.extractionRevision;
  return { current, extractor };
}
