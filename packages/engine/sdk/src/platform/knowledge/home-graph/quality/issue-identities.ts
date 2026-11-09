/** Saved issue roles, not a digest of user/private identifiers. These labels
 * confer no review authority; the actual issue lifecycle boundary remains owner. */
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import type { KnowledgeStore } from '../../store.js';
import { isLegacyHomeGraphQualityIssue } from '../../store-issue-replacement.js';
import { HomeGraphQualityHeldError as Held } from './types.js';
const apply = Reflect.apply, get = Map.prototype.get, set = Map.prototype.set, values = Map.prototype.values;
const codes: readonly string[] = Object.freeze(['homegraph.device.missing_manual','homegraph.device.unknown_battery']);
export function createHomeGraphQualityIssueIdentities(store: KnowledgeStore, spaceId: string, namespace: string) {
  const pending = new Map<string, ReturnType<typeof prepare>>(), labels = new Set<string>();
  const rowsFor = (code: string, nodeId: string) => {
    const current = store.getSemanticIssueCandidates({ spaceId, namespace, code, nodeId });
    const earlier = store.getSemanticIssueCandidates({ spaceId, namespace: spaceId, code, nodeId }).filter(issue => isLegacyHomeGraphQualityIssue(issue, spaceId));
    const rows = [...current, ...earlier];
    if (rows.length > 1 || rows.some(issue => !['open','resolved'].includes(issue.status)
      || issue.metadata.homeGraphQualityIdentityVersion !== undefined && issue.metadata.homeGraphQualityIdentityVersion !== 1)) throw new Held('malformed');
    return rows;
  };
  function prepare(code: string, nodeId: string) {
    if (!codes.includes(code) || !nodeId) throw new Held('malformed');
    const original = rowsFor(code, nodeId)[0], id = original?.id ?? `hg-issue-${opaqueUuid()}`;
    if (!original && (store.getIssue(id) || labels.has(id))) throw new Held('stale');
    labels.add(id);
    return Object.freeze({ id, original, assertCurrent() {
      const current = rowsFor(code, nodeId);
      if (store.getIssue(id) !== (original ?? null) || current[0] !== original) throw new Held('stale');
    } });
  }
  return Object.freeze({ prepare(code: string, nodeId: string) {
    const key = JSON.stringify([code,nodeId]), previous = apply(get,pending,[key]) as ReturnType<typeof prepare> | undefined;
    if (previous) { previous.assertCurrent(); return previous; }
    const prepared = prepare(code,nodeId); apply(set,pending,[key,prepared]); return prepared;
  }, assertCurrent() { store.assertRecordSnapshotFrame(() => { for (const identity of apply(values,pending,[]) as IterableIterator<ReturnType<typeof prepare>>) identity.assertCurrent(); return undefined; }); } });
}
