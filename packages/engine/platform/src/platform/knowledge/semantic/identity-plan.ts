/** One actual semantic write pass reuses exact complete claims, not hashes or
 * global plaintext caches. Final indexed absence checks reject another ID. */
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import type { KnowledgeStore } from '../store.js';
import { SemanticIdentityHeldError, semanticFactSelector, semanticFactScopeMatches, type SemanticFactSelector } from '../store-semantic-fact-selector.js';

export interface PlannedSemanticFactIdentity {
  readonly id: string; readonly selector: SemanticFactSelector;
  assertCurrent(): void;
}
const freeze = Object.freeze;
const apply = Reflect.apply, weakGet = WeakMap.prototype.get, weakSet = WeakMap.prototype.set;
const mapGet = Map.prototype.get, mapSet = Map.prototype.set, mapValues = Map.prototype.values;
const issuers = new WeakMap<object, { readonly store: KnowledgeStore; readonly prepare: (input: Parameters<typeof semanticFactSelector>[0]) => PlannedSemanticFactIdentity; readonly assertCurrent: () => void }>();
export function createSemanticFactIdentityPlanner(store: KnowledgeStore) {
  const planned = new Map<string, PlannedSemanticFactIdentity>(), allocated = new Map<string, string>();
  function matching(selector: SemanticFactSelector) {
    return store.getSemanticFactIdentityCandidates(selector).filter(record => semanticFactScopeMatches(record, selector));
  }
  const planner = freeze({
    prepare(input: Parameters<typeof semanticFactSelector>[0]): PlannedSemanticFactIdentity {
      const selector = semanticFactSelector(input), key = JSON.stringify(selector), previous = apply(mapGet, planned, [key]) as PlannedSemanticFactIdentity | undefined;
      if (previous) { previous.assertCurrent(); return previous; }
      const existing = matching(selector);
      if (existing.length > 1) throw new SemanticIdentityHeldError('ambiguous');
      const id = existing[0]?.id ?? `sem-fact-${opaqueUuid()}`;
      if (!existing.length && (store.getNode(id) || store.getRecordGeneration('node', id) !== null || apply(mapGet, allocated, [id]) !== undefined)) {
        throw new SemanticIdentityHeldError('stale');
      }
      apply(mapSet, allocated, [id, key]);
      const identity = freeze({ id, selector, assertCurrent() {
        // The normal activation readset independently protects this selected
        // row/absence and sources. Its own publication may fill/update this ID;
        // an unrelated matching row must never be silently adopted instead.
        if (matching(selector).some(record => record.id !== id)) throw new SemanticIdentityHeldError('stale');
      } });
      apply(mapSet, planned, [key, identity]); return identity;
    },
    assertCurrent() {
      store.assertRecordSnapshotFrame(() => {
        for (const identity of apply(mapValues, planned, []) as IterableIterator<PlannedSemanticFactIdentity>) identity.assertCurrent();
        return undefined;
      });
    },
  });
  apply(weakSet, issuers, [planner, { store, prepare: planner.prepare, assertCurrent: planner.assertCurrent }]); return planner;
}
export type SemanticFactIdentityPlanner = ReturnType<typeof createSemanticFactIdentityPlanner>;
export function prepareSemanticFactIdentity(planner: SemanticFactIdentityPlanner, store: KnowledgeStore, input: Parameters<typeof semanticFactSelector>[0]): PlannedSemanticFactIdentity {
  const issuer = apply(weakGet, issuers, [planner]) as { readonly store: KnowledgeStore; readonly prepare: (input: Parameters<typeof semanticFactSelector>[0]) => PlannedSemanticFactIdentity } | undefined;
  if (!issuer || issuer.store !== store) throw new SemanticIdentityHeldError('malformed');
  return issuer.prepare(input);
}

/** Accept only the original pass owner, before calling any supplied method. */
export function assertSemanticFactIdentityPlanner(planner: SemanticFactIdentityPlanner, store: KnowledgeStore): void {
  const issuer = apply(weakGet, issuers, [planner]) as { readonly store: KnowledgeStore; readonly assertCurrent: () => void } | undefined;
  if (!issuer || issuer.store !== store) throw new SemanticIdentityHeldError('malformed');
  issuer.assertCurrent();
}
