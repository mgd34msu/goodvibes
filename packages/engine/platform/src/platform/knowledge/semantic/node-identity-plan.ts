import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import type { KnowledgeStore } from '../store.js';
import { semanticNodeSelector, semanticNodeScopeMatches, semanticNodeCandidateParams, type SemanticNodeSelector } from '../store-semantic-node-selector.js';
import { SemanticIdentityHeldError as Held } from '../store-semantic-fact-selector.js';
const apply = Reflect.apply, weakGet = WeakMap.prototype.get, weakSet = WeakMap.prototype.set;
const mapGet = Map.prototype.get, mapSet = Map.prototype.set, mapValues = Map.prototype.values, freeze = Object.freeze;
export interface PlannedSemanticNodeIdentity { readonly id: string; readonly selector: SemanticNodeSelector; assertCurrent(): void }
const owners = new WeakMap<object, { readonly store: KnowledgeStore; readonly prepare: (selector: SemanticNodeSelector) => PlannedSemanticNodeIdentity; readonly assertCurrent: () => void }>();
export function createSemanticNodeIdentityPlanner(store: KnowledgeStore) {
  const pending = new Map<string, PlannedSemanticNodeIdentity>(), labels = new Map<string, string>();
  const candidates = (selector: SemanticNodeSelector) => store.getSemanticNodeCandidates(selector);
  const assertSelected = (identity: Pick<PlannedSemanticNodeIdentity, 'id' | 'selector'>, rows: ReturnType<typeof candidates>) => {
    const selected = store.getNode(identity.id);
    if (selected && !semanticNodeScopeMatches(selected, identity.selector)) throw new Held('stale');
    if (rows.some(row => semanticNodeScopeMatches(row, identity.selector) && row.id !== identity.id)) throw new Held('stale');
  };
  const planner = freeze({
    prepare(input: SemanticNodeSelector): PlannedSemanticNodeIdentity {
      const selector = semanticNodeSelector(input), key = JSON.stringify(selector);
      const previous = apply(mapGet, pending, [key]) as PlannedSemanticNodeIdentity | undefined;
      if (previous) { previous.assertCurrent(); return previous; }
      const selected = candidates(selector).filter(row => semanticNodeScopeMatches(row, selector)); if (selected.length > 1) throw new Held('ambiguous');
      const prefix = selector.role === 'entity' ? 'sem-entity' : selector.role === 'gap' ? 'sem-gap' : selector.role === 'wiki' ? 'sem-page' : 'sem-intrinsic-gap';
      const id = selected[0]?.id ?? `${prefix}-${opaqueUuid()}`;
      if ((!selected.length && store.getRecordSnapshot('node', id).record !== null) || (apply(mapGet, labels, [id]) !== undefined && apply(mapGet, labels, [id]) !== key)) throw new Held('stale');
      const identity = freeze({ id, selector, assertCurrent() { assertSelected({ id, selector }, candidates(selector)); } });
      apply(mapSet, labels, [id, key]);
      apply(mapSet, pending, [key, identity]); return identity;
    },
    assertCurrent() {
      // One indexed native query per actual source/kind (or intrinsic subject),
      // not one repeated full row read for every label in the same pass.
      store.assertRecordSnapshotFrame(() => {
        const groups = new Map<string, ReturnType<typeof candidates>>();
        for (const identity of apply(mapValues, pending, []) as IterableIterator<PlannedSemanticNodeIdentity>) {
          const key = JSON.stringify(semanticNodeCandidateParams(identity.selector));
          let rows = apply(mapGet, groups, [key]) as ReturnType<typeof candidates> | undefined;
          if (!rows) { rows = candidates(identity.selector); apply(mapSet, groups, [key, rows]); }
          assertSelected(identity, rows);
        }
        return undefined;
      });
    },
  });
  apply(weakSet, owners, [planner, freeze({ store, prepare: planner.prepare, assertCurrent: planner.assertCurrent })]); return planner;
}
export type SemanticNodeIdentityPlanner = ReturnType<typeof createSemanticNodeIdentityPlanner>;
export function prepareSemanticNodeIdentity(planner: SemanticNodeIdentityPlanner, store: KnowledgeStore, selector: SemanticNodeSelector): PlannedSemanticNodeIdentity {
  const owner = apply(weakGet, owners, [planner]) as { readonly store: KnowledgeStore; readonly prepare: (selector: SemanticNodeSelector) => PlannedSemanticNodeIdentity } | undefined;
  if (!owner || owner.store !== store) throw new Held('malformed');
  return owner.prepare(selector);
}
