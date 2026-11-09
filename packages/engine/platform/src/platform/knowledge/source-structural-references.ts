import { isDeepStrictEqual } from 'node:util';
import type { KnowledgeStore } from './store.js';
import type { KnowledgeExtractionRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from './types.js';
import { KnowledgeGeneratedFactSupportHeldError } from './semantic/verification/types.js';
import { captureOwnedJson } from '../gate/judgment-input.js';
import { captureStrictJudgmentJson } from '../gate/judgment-result.js';
import { knowledgeJudgmentRepresentation, sameKnowledgeRecord } from './store-record-representation.js';
import { hasKnowledgeNodePublication, knowledgeNodePublicationGeneration } from './store.js';
import { createSemanticNodeIdentityPlanner, prepareSemanticNodeIdentity, type SemanticNodeIdentityPlanner } from './semantic/node-identity-plan.js';
import { semanticNodeScopeMatches, type SemanticNodeSelector } from './store-semantic-node-selector.js';

// Native registry lookups cannot be replaced by a later prototype override.
const weakMapGet = WeakMap.prototype.get, weakMapSet = WeakMap.prototype.set, applyWeakMap = Reflect.apply;
function readNativeReference<K extends object, V>(map: WeakMap<K, V>, key: K): V | undefined {
  return applyWeakMap(weakMapGet, map, [key]) as V | undefined;
}
function writeNativeReference<K extends object, V>(map: WeakMap<K, V>, key: K, value: V): void {
  applyWeakMap(weakMapSet, map, [key, value]);
}

interface SourceIdentity { readonly id: string; readonly canonicalUri: string; readonly sourceUri?: string | undefined; }
interface ExtractionIdentity { readonly id: string; readonly sourceId: string; }
const sourceIdentities = new WeakMap<KnowledgeSourceRecord, SourceIdentity & { readonly store: KnowledgeStore; readonly snapshot: unknown }>();
const answerAliases = new WeakMap<KnowledgeSourceRecord, { readonly original: KnowledgeSourceRecord; readonly snapshot: unknown }>();
const extractionIdentities = new WeakMap<KnowledgeExtractionRecord, ExtractionIdentity & { readonly store: KnowledgeStore; readonly snapshot: unknown }>();
const activationReferences = new WeakMap<KnowledgeNodeRecord, { readonly store: KnowledgeStore; readonly original: unknown;
  readonly evidence: readonly { readonly source: KnowledgeSourceRecord | null; readonly extraction: KnowledgeExtractionRecord | null; readonly proof: object | undefined }[] }>();
const nodeIdentities = new WeakMap<KnowledgeNodeRecord, { readonly store: KnowledgeStore; readonly snapshot: unknown; readonly generation: string }>();

/** Bind an identifier constructed here to its actual SQL publication. This
 * proves its origin only; content and semantic acceptance remain independent. */
export function prepareGeneratedKnowledgeNodeIdentity(store: KnowledgeStore,
  selector: SemanticNodeSelector, planner: SemanticNodeIdentityPlanner = createSemanticNodeIdentityPlanner(store)) {
  const identity = prepareSemanticNodeIdentity(planner, store, selector), id = identity.id;
  const previous = store.getNode(id) ?? undefined;
  return Object.freeze({ id, metadata: Object.freeze({ semanticIdentityVersion: 1 }), assertCurrent: identity.assertCurrent,
    retain(record: KnowledgeNodeRecord): void {
    identity.assertCurrent();
    if (record.id !== id || !semanticNodeScopeMatches(record, identity.selector) || store.getNode(id) !== record
      || !hasKnowledgeNodePublication(store, record, previous)) throw new KnowledgeGeneratedFactSupportHeldError('stale');
    const generation = knowledgeNodePublicationGeneration(store, record, previous);
    if (generation === null) throw new KnowledgeGeneratedFactSupportHeldError('stale');
    writeNativeReference(nodeIdentities, record, Object.freeze({ store, snapshot: captureReferenceRecord(record), generation }));
  } });
}

/** Copies, raw replacements and reopened records inherit no native ID proof. */
export function projectGeneratedKnowledgeNodeIdentity(store: KnowledgeStore, record: KnowledgeNodeRecord) {
  const known = readNativeReference(nodeIdentities, record);
  if (!known) return undefined;
  const assertCurrent = () => {
    if (known.store !== store || store.getNode(record.id) !== record || !matchesReferenceRecord(record, known.snapshot)
      || store.getRecordGeneration('node', record.id) !== known.generation) throw new KnowledgeGeneratedFactSupportHeldError('stale');
  };
  assertCurrent();
  return Object.freeze({ id: 'generated-node-reference', assertCurrent });
}
const projections = new WeakMap<object, { readonly store: KnowledgeStore; readonly source: SourceIdentity;
  readonly sourceRecord: KnowledgeSourceRecord; readonly sourceSnapshot: unknown; readonly extractionRecord: KnowledgeExtractionRecord | null;
  readonly extractionSnapshot: unknown; readonly extraction?: ExtractionIdentity | undefined }>();
/** Complete immutable private values, retained only with their native owner.
 * Strict capture refuses accessors/hidden data before equality can inspect it.
 */
function captureReferenceRecord(value: unknown): unknown {
  try { return captureStrictJudgmentJson(value); }
  catch { throw new KnowledgeGeneratedFactSupportHeldError('malformed'); }
}
function matchesReferenceRecord(value: unknown, snapshot: unknown): boolean {
  return isDeepStrictEqual(captureReferenceRecord(value), snapshot);
}

/** Only a producer that just generated these exact local references may register them. No prefix/metadata inference. */
export function registerGeneratedKnowledgeSourceReferences(store: KnowledgeStore, source: KnowledgeSourceRecord, generated: SourceIdentity): void {
  if (store.getSource(source.id) !== source || source.id !== generated.id || source.canonicalUri !== generated.canonicalUri
    || (generated.sourceUri !== undefined && source.sourceUri !== generated.sourceUri)) throw new KnowledgeGeneratedFactSupportHeldError('stale');
  writeNativeReference(sourceIdentities, source, Object.freeze({ ...generated, store, snapshot: captureReferenceRecord(source) }));
}

/** Existing actual producer registration only; never infer one from a prefix. */
export function hasGeneratedKnowledgeSourceReferences(store: KnowledgeStore, source: KnowledgeSourceRecord): boolean {
  return currentSourceIdentity(source)?.store === store;
}

/** Retain native reference facts through the producer's own record update.
 * The original observation retires; the updated row still gets full preflight. */
export function captureGeneratedKnowledgeSourceUpdate(store: KnowledgeStore, source: KnowledgeSourceRecord): ((updated: KnowledgeSourceRecord) => void) | undefined {
  const known = currentSourceIdentity(source);
  if (!known || known.store !== store) return undefined;
  let published = false;
  return updated => {
    if (published || !matchesReferenceRecord(source, known.snapshot)) throw new KnowledgeGeneratedFactSupportHeldError('stale');
    published = true;
    registerGeneratedKnowledgeSourceReferences(store, updated, known);
  };
}
/** A derived extraction ID is registered only against an already known generated source identity. */
export function registerGeneratedKnowledgeExtractionReferences(store: KnowledgeStore, source: KnowledgeSourceRecord, extraction: KnowledgeExtractionRecord, generatedId: string): void {
  if (currentSourceIdentity(source)?.store !== store) return;
  if (store.getSource(source.id) !== source || store.getExtractionBySourceId(source.id) !== extraction || extraction.id !== generatedId || extraction.sourceId !== source.id) throw new KnowledgeGeneratedFactSupportHeldError('stale');
  writeNativeReference(extractionIdentities, extraction, Object.freeze({ id: generatedId, sourceId: source.id, store, snapshot: captureReferenceRecord(extraction) }));
}
function currentSourceIdentity(source: KnowledgeSourceRecord) {
  const identity = readNativeReference(sourceIdentities, source);
  if (identity && (identity.store.getSource(source.id) !== source || !matchesReferenceRecord(source, identity.snapshot))) throw new KnowledgeGeneratedFactSupportHeldError('stale');
  return identity;
}

/** Issued by the native activation writer for its actual generated receipt. */
export function retainKnowledgeNodeActivationReferences(store: KnowledgeStore, record: KnowledgeNodeRecord,
  evidence: readonly { readonly source: KnowledgeSourceRecord | null; readonly extraction: KnowledgeExtractionRecord | null }[],
  proofs: readonly (object | undefined)[]): void {
  writeNativeReference(activationReferences, record, { store, original: captureOwnedJson(record),
    evidence: evidence.map((entry, index) => ({ ...entry, proof: proofs[index] })) });
}

export function projectKnowledgeNodeActivationMetadata(store: KnowledgeStore, node: KnowledgeNodeRecord, metadata: unknown): unknown {
  const known = readNativeReference(activationReferences, node);
  if (!known) return metadata;
  if (known.store !== store || store.getNode(node.id) !== node || !sameKnowledgeRecord(known.original, node)) throw new KnowledgeGeneratedFactSupportHeldError('stale');
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return metadata;
  const activation: unknown = Object.getOwnPropertyDescriptor(metadata, 'nodeActivation')?.value;
  if (!activation || typeof activation !== 'object' || Array.isArray(activation)) return metadata;
  const projected: Record<string, unknown> = { ...activation };
  if (Object.hasOwn(activation, 'candidateHash')) projected.candidateHash = 'activation-candidate-reference';
  if (Object.hasOwn(activation, 'evidenceHash')) projected.evidenceHash = 'activation-evidence-reference';
  const evidence: unknown = Object.getOwnPropertyDescriptor(activation, 'evidence')?.value;
  if (Array.isArray(evidence)) projected.evidence = evidence.map((entry: unknown, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const native = known.evidence[index];
    const references = native?.source ? projectKnowledgeSourceReferences(native.source, native.extraction, native.proof) : undefined;
    return { ...entry,
      ...(Object.hasOwn(entry, 'sourceHash') ? { sourceHash: 'activation-source-content-reference' } : {}),
      ...(Object.hasOwn(entry, 'extractionHash') ? { extractionHash: 'activation-extraction-content-reference' } : {}),
      ...(references ? { sourceId: references.sourceId, ...(references.extractionId ? { extractionId: references.extractionId } : {}) } : {}) };
  });
  const subjects: unknown = Object.getOwnPropertyDescriptor(activation, 'subjects')?.value;
  if (Array.isArray(subjects)) projected.subjects = subjects.map((entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? { ...entry, ...(Object.hasOwn(entry, 'nodeHash') ? { nodeHash: 'activation-subject-content-reference' } : {}) } : entry);
  return { ...metadata, nodeActivation: projected };
}

/** Page ranking may omit only references backed by the exact current native
 * source and store. All other fields, including metadata, retain full preflight. */
export function knowledgePageCandidateRepresentation(store: KnowledgeStore | undefined, candidate: unknown): unknown {
  captureOwnedJson(candidate);
  const raw = captureOwnedJson(knowledgeJudgmentRepresentation(candidate));
  if (!store || !raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const slots = Object.getOwnPropertyDescriptors(raw);
  const id: unknown = slots.id?.value;
  if (typeof id !== 'string') return raw;
  const replacements = new Map<string, unknown>();
  const source = store.getSource(id);
  if (source && source === candidate) {
    const identity = currentSourceIdentity(source);
    if (identity?.store !== store) return raw;
    replacements.set('id', 'source-reference');
    replacements.set('canonicalUri', undefined);
    if (identity.sourceUri !== undefined) replacements.set('sourceUri', undefined);
  } else {
    const node = store.getNode(id);
    if (!node || node !== candidate) return raw;
    // Persisted native rows have plain JSON slots. A newly attached hidden
    // subtree cannot inherit their stored representation or reference proof.
    try { captureStrictJudgmentJson(node); } catch { throw new KnowledgeGeneratedFactSupportHeldError('malformed'); }
    replacements.set('metadata', projectKnowledgeNodeActivationMetadata(store, node, slots.metadata?.value));
    const sourceId: unknown = slots.sourceId?.value;
    if (typeof sourceId === 'string') {
      const origin = store.getSource(sourceId);
      if (origin && currentSourceIdentity(origin)?.store === store) replacements.set('sourceId', 'source-reference');
    }
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(slots)) {
    Object.defineProperty(result, key, { ...descriptor, value: replacements.has(key) ? replacements.get(key) : descriptor.value });
  }
  return captureOwnedJson(result);
}
/** Minimize only exact currently stored producer-minted URI fields. Copies retain ordinary preflight. */
export function knowledgeSourceJudgmentUris(source: KnowledgeSourceRecord) {
  const identity = currentSourceIdentity(source);
  return { url: source.url, sourceUri: identity?.sourceUri === undefined ? source.sourceUri : undefined,
    canonicalUri: identity ? undefined : source.canonicalUri };
}
/** Only this owned projection may recover a producer-minted source for local bookkeeping.
 * A JSON copy, caller-created alias, changed projection, or reopened store cannot inherit it.
 * The consumer still reads the full original content through ordinary judgment preflight.
 */
export function withKnowledgeSourceAnswerAliases(source: KnowledgeSourceRecord): KnowledgeSourceRecord {
  const identity = currentSourceIdentity(source);
  const result = { ...source, sourceId: source.id, url: source.sourceUri ?? source.canonicalUri };
  if (identity) writeNativeReference(answerAliases, result, { original: source, snapshot: captureReferenceRecord(result) });
  return result;
}
export function restoreKnowledgeSourceAnswerAliases(store: KnowledgeStore, source: KnowledgeSourceRecord): KnowledgeSourceRecord {
  const known = readNativeReference(answerAliases, source);
  if (!known) return source;
  const identity = currentSourceIdentity(known.original);
  if (!identity || identity.store !== store || !matchesReferenceRecord(source, known.snapshot)) {
    throw new KnowledgeGeneratedFactSupportHeldError('stale');
  }
  return known.original;
}
/** Capture from actual current store records. The opaque proof is never serialized or recovered from JSON. */
export function captureKnowledgeSourceReferences(store: KnowledgeStore, source: KnowledgeSourceRecord | null, extraction: KnowledgeExtractionRecord | null): object | undefined {
  if (!source) return undefined;
  const identity = readNativeReference(sourceIdentities, source);
  if (!identity || identity.store !== store || store.getSource(source.id) !== source
    || store.getExtractionBySourceId(source.id) !== extraction) return undefined;
  currentSourceIdentity(source);
  if (extraction && extraction.sourceId !== source.id) throw new KnowledgeGeneratedFactSupportHeldError('stale');
  const proof = Object.freeze({});
  const extractionIdentity = extraction ? readNativeReference(extractionIdentities, extraction) : undefined;
  if (extractionIdentity && (extractionIdentity.store !== store || !matchesReferenceRecord(extraction, extractionIdentity.snapshot))) throw new KnowledgeGeneratedFactSupportHeldError('stale');
  writeNativeReference(projections, proof, { store, source: identity, sourceRecord: source, sourceSnapshot: identity.snapshot,
    extractionRecord: extraction, extractionSnapshot: extractionIdentity?.snapshot ?? captureReferenceRecord(extraction),
    extraction: extractionIdentity?.store === store ? extractionIdentity : undefined });
  return proof;
}
/** Read-set guards still bind full records; this proof concerns structural reference fields only. */
export function projectKnowledgeSourceReferences(source: KnowledgeSourceRecord, extraction: KnowledgeExtractionRecord | null | undefined, proof: object | undefined) {
  const known = proof ? readNativeReference(projections, proof) : undefined;
  if (!known) return undefined;
  if (known.store.getSource(known.source.id) !== known.sourceRecord
    || known.store.getExtractionBySourceId(known.source.id) !== known.extractionRecord
    || !matchesReferenceRecord(known.sourceRecord, known.sourceSnapshot) || !matchesReferenceRecord(known.extractionRecord, known.extractionSnapshot)
    || (source !== known.sourceRecord && !matchesReferenceRecord(source, known.sourceSnapshot))
    || (extraction !== known.extractionRecord && !matchesReferenceRecord(extraction, known.extractionSnapshot))
    || source.id !== known.source.id || source.canonicalUri !== known.source.canonicalUri
    || (known.source.sourceUri !== undefined && source.sourceUri !== known.source.sourceUri)
    || (known.extraction && (extraction?.id !== known.extraction.id || extraction.sourceId !== known.extraction.sourceId))) {
    throw new KnowledgeGeneratedFactSupportHeldError('stale');
  }
  return { sourceId: 'source-reference', extractionId: known.extraction ? 'extraction-reference' : undefined,
    omitCanonicalUri: true, omitSourceUri: known.source.sourceUri !== undefined };
}
