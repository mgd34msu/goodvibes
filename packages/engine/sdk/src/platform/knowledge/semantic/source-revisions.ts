/** Derived cache freshness binds actual saved writer revisions, not another
 * serialization/hash of complete source text on every inspection. */
import { captureStrictJudgmentJson } from '../../gate/judgment-result.js';
import { sameKnowledgeRecord } from '../store-record-representation.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeExtractionRecord, KnowledgeSemanticEnrichmentStateRecord, KnowledgeSourceRecord } from '../types.js';
import { SemanticIdentityHeldError as Held } from '../store-semantic-fact-selector.js';
import { historicalSourceSemanticHash } from './utils.js';

export interface SemanticSourceRevision {
  readonly version: 2; readonly sourceId: string; readonly sourceRevision: string;
  readonly extractionId: string; readonly extractionRevision: string;
}
const apply = Reflect.apply, weakGet = WeakMap.prototype.get, weakSet = WeakMap.prototype.set, freeze = Object.freeze;
const NativeWeakRef = WeakRef, deref = WeakRef.prototype.deref;
interface RevisionOwner { readonly store: WeakRef<KnowledgeStore>; readonly source: WeakRef<KnowledgeSourceRecord>; readonly extraction: WeakRef<KnowledgeExtractionRecord> }
// A copied/retained tiny cache binding must not keep the complete source store
// alive. The actual call arguments independently keep their owners alive.
const revisions = new WeakMap<SemanticSourceRevision, RevisionOwner>();
export function captureSemanticSourceRevision(store: KnowledgeStore, source: KnowledgeSourceRecord, extraction: KnowledgeExtractionRecord): SemanticSourceRevision {
  let result: SemanticSourceRevision | undefined;
  store.assertRecordSnapshotFrame(() => {
    if (store.getSource(source.id) !== source || store.getExtractionBySourceId(source.id) !== extraction || extraction.sourceId !== source.id) throw new Held('stale');
    const savedSource = store.getSourceSnapshot({ id: source.id }), savedExtraction = store.getRecordSnapshot('extraction', extraction.id);
    if (!savedSource.generation || !savedExtraction.generation || !sameKnowledgeRecord(source, savedSource.source) || !sameKnowledgeRecord(extraction, savedExtraction.record)) throw new Held('stale');
    result = freeze({ version: 2, sourceId: source.id, sourceRevision: savedSource.generation, extractionId: extraction.id, extractionRevision: savedExtraction.generation });
    return undefined;
  });
  apply(weakSet, revisions, [result!, freeze({ store: new NativeWeakRef(store), source: new NativeWeakRef(source), extraction: new NativeWeakRef(extraction) })]);
  return result!;
}
export function semanticSourceRevisionMetadata(binding: SemanticSourceRevision): Record<string, unknown> {
  if (!apply(weakGet, revisions, [binding])) throw new Held('malformed');
  return { semanticSourceVersion: 2, semanticSourceBinding: binding };
}
const historical = new WeakMap<KnowledgeSemanticEnrichmentStateRecord, { binding: string; hash: string; current: boolean }>();
/** Old text commitments are computed only when an actual saved old state asks
 * for its exact old recipe, once for that state plus native source revisions. */
export function semanticSourceIsCurrent(store: KnowledgeStore, source: KnowledgeSourceRecord, extraction: KnowledgeExtractionRecord,
  supplied?: SemanticSourceRevision): boolean {
  const binding = captureSemanticSourceRevision(store, source, extraction);
  if (supplied) {
    const original = apply(weakGet, revisions, [supplied]) as RevisionOwner | undefined;
    if (!original || apply(deref, original.store, []) !== store || apply(deref, original.source, []) !== source || apply(deref, original.extraction, []) !== extraction) throw new Held('malformed');
    if (JSON.stringify(supplied) !== JSON.stringify(binding)) throw new Held('stale');
  }
  const state = store.getSemanticEnrichmentStateSnapshot(source.id); if (!state) return false;
  const metadata = captureStrictJudgmentJson(state.metadata), version = metadata.semanticSourceVersion;
  if (version !== undefined && version !== 2) throw new Held('unsupported-format');
  if (version === 2) {
    const saved = metadata.semanticSourceBinding;
    if (!saved || typeof saved !== 'object' || Array.isArray(saved) || Object.keys(saved).length !== 5) throw new Held('malformed');
    const value = saved as Record<string, unknown>;
    if (value['version'] !== 2 || ['sourceId', 'sourceRevision', 'extractionId', 'extractionRevision'].some(key => typeof value[key] !== 'string' || !value[key])) throw new Held('malformed');
    return value['sourceId'] === binding.sourceId && value['sourceRevision'] === binding.sourceRevision
      && value['extractionId'] === binding.extractionId && value['extractionRevision'] === binding.extractionRevision;
  }
  const hash = metadata.textHash ?? state.textHash;
  if (typeof hash !== 'string' || !/^[a-f0-9]{16}$/.test(hash)) return false;
  const key = JSON.stringify(binding), previous = apply(weakGet, historical, [state]) as { binding: string; hash: string; current: boolean } | undefined;
  if (previous?.binding === key && previous.hash === hash) return previous.current;
  const current = historicalSourceSemanticHash(source, extraction) === hash;
  apply(weakSet, historical, [state, Object.freeze({ binding: key, hash, current })]); return current;
}
