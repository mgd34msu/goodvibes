/** Actual saved generated references only. No fresh identifier is issued here.
 * The old protocol's two digests verify the exact synthetic-reference recipe,
 * rather than raw protected material copied into an arbitrary URI. They neither
 * determine a knowledge scope nor authorize a publication. */
import { createHash } from 'node:crypto';
import type { KnowledgeStore } from './store.js';
import type { KnowledgeSourceRecord } from './types.js';
import type { KnowledgeSourceSnapshot } from './store-source-generation.js';
import { hasGeneratedKnowledgeSourceReferences, registerGeneratedKnowledgeSourceReferences } from './source-structural-references.js';
import { savedGeneratedProjectionIdentity } from './store-generated-projection-selector.js';
import { KnowledgeSourceQualityHeldError } from './source-quality.js';

/** Called after comparing the exact original native row in scope-selection's
 * synchronous read frame. JSON/metadata alone cannot mint this producer fact. */
export function retainStoredGeneratedProjectionReferences(store: KnowledgeStore, source: KnowledgeSourceRecord,
  original: KnowledgeSourceSnapshot): void {
  if (source.connectorId !== 'knowledge-projection' || hasGeneratedKnowledgeSourceReferences(store, source)) return;
  if (store.getSource(source.id) !== source || original.source?.id !== source.id || original.generation === null
    || store.getSourceGeneration(source.id) !== original.generation) throw new KnowledgeSourceQualityHeldError('stale');
  if (Object.hasOwn(source.metadata, 'projectionIdentityVersion')) {
    let identity: ReturnType<typeof savedGeneratedProjectionIdentity>;
    try { identity = savedGeneratedProjectionIdentity(source); }
    catch { return; } // Unknown shapes keep ordinary complete URI admission.
    const canonicalUri = source.canonicalUri, sourceUri = source.sourceUri;
    if (identity && typeof canonicalUri === 'string' && typeof sourceUri === 'string') {
      registerGeneratedKnowledgeSourceReferences(store, source, { id: source.id, canonicalUri, sourceUri });
    }
    return;
  }
  const { projectionKind, targetKind, targetId } = source.metadata;
  if (source.metadata.generatedProjection !== true || source.metadata.generatedKnowledgePage !== true
    || typeof targetKind !== 'string' || typeof targetId !== 'string' || projectionKind !== `knowledge-${targetKind}`
    || !knownTarget(targetKind, targetId) || !/^kg-gen-[0-9a-f]{24}$/.test(source.id)
    || source.sourceUri !== source.canonicalUri
    || typeof source.canonicalUri !== 'string'
    || !new RegExp(`^knowledge://generated/knowledge-${targetKind}/[0-9a-f]{20}$`).test(source.canonicalUri)) return;
  // Only a real earlier saved reference reaches these historical verifiers.
  const id = `kg-gen-${createHash('sha256').update(`${projectionKind}:${targetId}`).digest('hex').slice(0, 24)}`;
  const canonicalUri = `knowledge://generated/${projectionKind}/${createHash('sha256').update(targetId).digest('hex').slice(0, 20)}`;
  if (source.id !== id || source.canonicalUri !== canonicalUri) return;
  registerGeneratedKnowledgeSourceReferences(store, source, { id, canonicalUri, sourceUri: canonicalUri });
}
function knownTarget(kind: string, targetId: string): boolean {
  if (kind === 'overview' || kind === 'bundle') return targetId === kind;
  if (kind === 'dashboard') return targetId === 'dashboard:backlinks' || targetId === 'dashboard:source-health';
  return ['source', 'node', 'issue', 'rollup'].includes(kind) && targetId.startsWith(`${kind}:`) && targetId.length > kind.length + 1;
}
