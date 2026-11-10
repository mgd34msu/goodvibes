import { retainOwnedJson, type RetainedOwnedJson } from '../gate/judgment-input.js';
import { KnowledgeNodeActivationHeldError } from './activation/types.js';
import { sameKnowledgeRecord } from './store-record-representation.js';
import type { KnowledgeStore } from './store.js';

interface EvidenceWitness { readonly original: unknown; readonly owned: RetainedOwnedJson; }
// One witness per actual producer object in this store. Nodes observing a large
// source share it; neither its text nor a derived ID is a global cache key.
// Old observations retain their original witness when the producer edits it.
const witnesses = new WeakMap<KnowledgeStore, WeakMap<object, EvidenceWitness>>();

function captureEvidence(store: KnowledgeStore, evidence: unknown): EvidenceWitness {
  const original = evidence ?? null;
  if (!original || typeof original !== 'object') return { original, owned: retainOwnedJson(original) };
  let records = witnesses.get(store);
  if (!records) { records = new WeakMap(); witnesses.set(store, records); }
  const existing = records.get(original);
  if (existing) {
    try { existing.owned.assertCurrent(); return existing; }
    catch { /* A new preparation owns the new value; previous proofs stay stale. */ }
  }
  const witness = Object.freeze({ original, owned: retainOwnedJson(original) });
  records.set(original, witness);
  return witness;
}

/** Private producer evidence, never a receipt accepted from disk or the wire.
 * Same-object checks validate retained data slots without copying its body.
 * A replacement object must equal the complete detached original value.
 */
export function prepareObservedEvidenceCheck(store: KnowledgeStore, evidence: unknown, readEvidence: () => unknown): () => void {
  const witness = captureEvidence(store, evidence);
  return () => {
    // Preserve an owner's own cancellation/currentness failure verbatim.
    const current = readEvidence() ?? null;
    try {
      if (current === witness.original) witness.owned.assertCurrent();
      else if (!sameKnowledgeRecord(current, witness.owned.snapshot)) throw new KnowledgeNodeActivationHeldError('stale');
    } catch { throw new KnowledgeNodeActivationHeldError('stale'); }
  };
}
