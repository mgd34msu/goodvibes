/** Mutation-local labels chosen from actual saved source facts. Lookup has no
 * registration side effects; a capture without an explicit event time is new. */
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import type { KnowledgeStore } from '../store.js';
import { getKnowledgeSpaceId } from '../spaces.js';
import { homeGraphIdentitySpace, HomeGraphIdentityHeldError as Held } from '../store-homegraph-node-selector.js';
import { homeGraphSourceSelector, homeGraphSourceMatches, type HomeGraphSourceSelector } from '../store-homegraph-source-selector.js';
const apply = Reflect.apply, get = Map.prototype.get, set = Map.prototype.set;
export interface HomeGraphSourceIdentity {
  readonly id: string;
  readonly canonicalUri: string;
  readonly selector: HomeGraphSourceSelector;
  readonly metadata: Readonly<Record<string, unknown>>;
  assertCurrent(): void;
}
export function createHomeGraphSourceIdentityPlanner(store: KnowledgeStore) {
  const pending = new Map<string, HomeGraphSourceIdentity>(), labels = new Set<string>();
  const candidates = (selector: HomeGraphSourceSelector) => selector.role === 'snapshot' && selector.capturedAt === undefined ? []
    : store.getHomeGraphSourceCandidates(selector).filter(source => { if (!homeGraphSourceMatches(source, selector)) return false; if (!['pending','indexed','failed','stale'].includes(source.status)) throw new Held('unsupported-format'); return true; });
  return Object.freeze({
    lookup(input: HomeGraphSourceSelector) { const rows = candidates(homeGraphSourceSelector(input)); if (rows.length > 1) throw new Held('ambiguous'); return rows[0]; },
    prepare(input: HomeGraphSourceSelector): HomeGraphSourceIdentity {
      const selector = homeGraphSourceSelector(input), key = JSON.stringify(selector);
      const previous = apply(get, pending, [key]) as HomeGraphSourceIdentity | undefined;
      if (previous) { previous.assertCurrent(); return previous; }
      const rows = candidates(selector); if (rows.length > 1) throw new Held('ambiguous'); const saved = rows[0];
      const token = !saved || !saved.canonicalUri && selector.role !== 'documentation-candidate' ? opaqueUuid() : undefined, id = saved?.id ?? `hg-src-${token!}`;
      if (!saved && (store.getSource(id) || labels.has(id))) throw new Held('stale');
      const canonicalUri = saved?.canonicalUri ?? (selector.role === 'documentation-candidate' ? selector.value! : `homegraph://source/${token!}`);
      const metadata: Record<string, unknown> = { homeGraphSourceIdentityVersion: 1, homeGraphIdentitySpace: selector.spaceId,
        ...(selector.locator ? { homeGraphSourceLocator: selector.locator } : {}) };
      // A known physical/native alias chooses the old row without rebinding its
      // actual saved role key or public canonical URI to the new spelling.
      if (saved && selector.role === 'generated-page') {
        if (selector.projectionKind === 'device-passport') metadata.deviceId = saved.metadata.deviceId;
        if (selector.projectionKind === 'room-page' && saved.metadata.areaId !== undefined) metadata.areaId = saved.metadata.areaId;
      }
      const identity = Object.freeze({ id, canonicalUri, selector, metadata: Object.freeze(metadata), assertCurrent() {
        const current = store.getSource(id);
        if (saved && !current || current && (selector.role === 'snapshot' && selector.capturedAt === undefined
          ? current.connectorId !== 'homeassistant' || homeGraphIdentitySpace(getKnowledgeSpaceId(current)) !== selector.spaceId || current.metadata.homeGraphSourceKind !== 'snapshot'
          : !homeGraphSourceMatches(current, selector)) || candidates(selector).some(source => source.id !== id)) throw new Held('stale');
      } });
      apply(set, pending, [key, identity]); labels.add(id); return identity;
    },
  });
}
