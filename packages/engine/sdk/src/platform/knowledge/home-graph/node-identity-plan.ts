/** Once-only labels for one actual Home Graph mutation pass. Saved native
 * tuples keep their IDs/slugs; reads alone never allocate or persist a label. */
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import type { KnowledgeStore } from '../store.js';
import { homeGraphNodeSelector, homeGraphNodeMatches, HomeGraphIdentityHeldError as Held, type HomeGraphNodeSelector } from '../store-homegraph-node-selector.js';
const apply = Reflect.apply, mapGet = Map.prototype.get, mapSet = Map.prototype.set, mapValues = Map.prototype.values;
const weakGet = WeakMap.prototype.get, weakSet = WeakMap.prototype.set;
export interface HomeGraphNodeIdentity {
  readonly id: string;
  readonly slug: string;
  readonly objectId: string;
  readonly selector: HomeGraphNodeSelector;
  assertCurrent(): void;
}
const owners = new WeakMap<object, { readonly store: KnowledgeStore; readonly prepare: (selector: HomeGraphNodeSelector) => HomeGraphNodeIdentity }>();
export function createHomeGraphNodeIdentityPlanner(store: KnowledgeStore) {
  const pending = new Map<string, HomeGraphNodeIdentity>(), labels = new Map<string, string>();
  const candidates = (selector: HomeGraphNodeSelector) => store.getHomeGraphNodeCandidates(selector).filter(record => homeGraphNodeMatches(record, selector));
  const planner = Object.freeze({
    lookup(input: HomeGraphNodeSelector) {
      const selector = homeGraphNodeSelector(input), rows = candidates(selector);
      if (rows.length > 1) throw new Held('ambiguous'); return rows[0];
    },
    prepare(input: HomeGraphNodeSelector): HomeGraphNodeIdentity {
      const selector = homeGraphNodeSelector(input), key = JSON.stringify(selector);
      const previous = apply(mapGet, pending, [key]) as HomeGraphNodeIdentity | undefined;
      if (previous) { previous.assertCurrent(); return previous; }
      const rows = candidates(selector); if (rows.length > 1) throw new Held('ambiguous');
      const saved = rows[0], id = saved?.id ?? `hg-node-${opaqueUuid()}`, slug = saved?.slug ?? id;
      if (!saved && (store.getNode(id) || apply(mapGet, labels, [id]) !== undefined)) throw new Held('stale');
      const savedHome = saved?.metadata.homeAssistant;
      const objectId = savedHome && typeof savedHome === 'object' && !Array.isArray(savedHome) && typeof (savedHome as Record<string, unknown>).objectId === 'string' ? (savedHome as { objectId: string }).objectId : selector.objectId;
      const identity = Object.freeze({ id, slug, objectId, selector, assertCurrent() {
        const live = store.getNode(id);
        if (saved && !live || live && !homeGraphNodeMatches(live, selector) || candidates(selector).some(record => record.id !== id)) throw new Held('stale');
      } });
      apply(mapSet, pending, [key, identity]); apply(mapSet, labels, [id, key]); return identity;
    },
    assertCurrent() {
      store.assertRecordSnapshotFrame(() => {
        for (const identity of apply(mapValues, pending, []) as IterableIterator<HomeGraphNodeIdentity>) identity.assertCurrent();
        return undefined;
      });
    },
  });
  apply(weakSet, owners, [planner, Object.freeze({ store, prepare: planner.prepare })]); return planner;
}
export type HomeGraphNodeIdentityPlanner = ReturnType<typeof createHomeGraphNodeIdentityPlanner>;
export function prepareHomeGraphNodeIdentity(planner: HomeGraphNodeIdentityPlanner, store: KnowledgeStore, selector: HomeGraphNodeSelector): HomeGraphNodeIdentity {
  const owner = apply(weakGet, owners, [planner]) as { readonly store: KnowledgeStore; readonly prepare: (selector: HomeGraphNodeSelector) => HomeGraphNodeIdentity } | undefined;
  if (!owner || owner.store !== store) throw new Held('stale'); return owner.prepare(selector);
}
