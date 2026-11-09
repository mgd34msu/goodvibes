/** Saved auxiliary roles reuse their actual row, not a digest of another ID. */
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeIssueRecord, KnowledgeRefinementTaskRecord } from '../types.js';
import { observeKnowledgeValue } from '../local-value-observation.js';
import type { SemanticIssueSelector } from '../store-semantic-node-selector.js';
import { SemanticIdentityHeldError as Held } from '../store-semantic-fact-selector.js';
const taskStates: readonly string[] = Object.freeze(['detected', 'queued', 'searching', 'evaluating', 'extracting', 'applying', 'verified', 'closed', 'blocked', 'suppressed', 'needs_review', 'cancelled', 'failed']);
function prepare<T extends { readonly id: string }>(read: () => readonly T[], readId: (id: string) => T | null, prefix: string) {
  const rows = read(); if (rows.length > 1) throw new Held('ambiguous');
  const original = rows[0], observed = observeKnowledgeValue(original ?? null);
  const id = original?.id ?? `${prefix}-${opaqueUuid()}`;
  if (!original && readId(id)) throw new Held('stale');
  return Object.freeze({ id, original, assertCurrent() {
    const current = read();
    if (readId(id) !== (original ?? null)) throw new Held('stale');
    if (current.length > 1 || current[0] !== original || !observed.matches(current[0] ?? null)) throw new Held('stale');
  } });
}
export function prepareSemanticIssueIdentity(store: KnowledgeStore, input: SemanticIssueSelector) {
  const selector = Object.freeze({ ...input });
  return prepare<KnowledgeIssueRecord>(() => {
    const rows = store.getSemanticIssueCandidates(selector);
    if (rows.some(row => row.status !== 'open' && row.status !== 'resolved')) throw new Held('unsupported-format');
    return rows;
  }, id => store.getIssue(id), selector.code === 'knowledge.intrinsic_gap' ? 'sem-intrinsic-gap-issue' : 'sem-issue');
}
export function prepareSemanticRefinementTaskIdentity(store: KnowledgeStore, spaceId: string, gapId: string) {
  return prepare<KnowledgeRefinementTaskRecord>(() => {
    const rows = store.getSemanticRefinementTaskCandidates(spaceId, gapId);
    if (rows.some(row => !taskStates.includes(row.state))) throw new Held('unsupported-format');
    return rows;
  }, id => store.getRefinementTask(id), 'kref');
}
