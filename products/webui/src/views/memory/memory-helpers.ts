/**
 * memory-helpers.ts, pure logic for MemoryView, kept separate so the honesty rules
 * are independently testable without mounting the view.
 */
import {
  type MemoryClass,
  type MemoryProvenanceLink,
  type MemoryRecord,
  type MemoryReviewState,
  type MemoryScope,
} from '../../lib/goodvibes';
import { whenLabel } from '../../lib/when-label';

export const MEMORY_CLASSES: readonly MemoryClass[] = [
  'decision', 'constraint', 'incident', 'pattern', 'fact', 'risk', 'runbook', 'architecture', 'ownership',
];

export const MEMORY_SCOPES: readonly MemoryScope[] = ['session', 'project', 'team'];

/**
 * Where each scope applies and who sees it, one line each. Scope says what a
 * record is about and is used to find and filter it; it does not hide a record
 * or keep it out of answers: the store is the daemon's, read by every program
 * and device signed in to it.
 */
export const MEMORY_SCOPE_LINES: Readonly<Record<MemoryScope, string>> = {
  session: 'About one conversation’s work. Seen by every app and device signed in to this daemon.',
  project: 'About this project, the usual choice. Seen by every app and device signed in to this daemon.',
  team: 'About how you work across projects. Seen by every app and device signed in to this daemon.',
};

/**
 * What a record's confidence is, in words: a rating someone gave (the person
 * who saved or reviewed it, or the agent), not a measurement, and records rated
 * below the recall floor are not brought into answers.
 */
export function confidenceMeaning(recallFloor: number | undefined): string {
  const floor = recallFloor === undefined
    ? 'Records rated too low are not brought into answers.'
    : `Records rated below ${String(recallFloor)}% are not brought into answers.`;
  return `How sure this record is said to be: a rating given when it was saved or reviewed, not a measurement. ${floor}`;
}

export const MEMORY_REVIEW_STATES: readonly MemoryReviewState[] = ['fresh', 'reviewed', 'stale', 'contradicted'];

/** A consolidation proposal's id as memory.consolidation.decide names it: `<kind>:<sorted ids>`. */
export function consolidationProposalId(proposal: { readonly kind: string; readonly ids: readonly string[] }): string {
  return `${proposal.kind}:${[...proposal.ids].sort().join(',')}`;
}

export type ConsolidationAction = 'keep-first' | 'keep-second' | 'both-stand' | 'keep-both' | 'delete' | 'keep';

/** The answers each proposal kind takes, labelled for the person deciding; first/second follow the proposal's ids. */
export const CONSOLIDATION_CHOICES: Readonly<Record<'contradiction' | 'cross-scope-duplicate' | 'stale-delete', readonly { readonly action: ConsolidationAction; readonly label: string }[]>> = {
  contradiction: [
    { action: 'keep-first', label: 'Keep the first, mark the second stale' },
    { action: 'keep-second', label: 'Keep the second, mark the first stale' },
    { action: 'both-stand', label: 'Both stand' },
  ],
  'cross-scope-duplicate': [
    { action: 'keep-first', label: 'Keep the first, mark the second stale' },
    { action: 'keep-second', label: 'Keep the second, mark the first stale' },
    { action: 'keep-both', label: 'Keep both' },
  ],
  'stale-delete': [
    { action: 'delete', label: 'Delete it' },
    { action: 'keep', label: 'Keep it' },
  ],
};

/** The store's documented baseline trust (memory-recall-contract.ts's
 * MIN_PROMPT_MEMORY_CONFIDENCE), MemoryStore.add stamps new records at this
 * confidence, and it is the recall-injection floor. Kept only as a documented fact for
 * tests; the live UI never uses this constant directly, it reads the actual
 * `recallFloor` a search result carries on the wire (isBelowRecallFloor below), so a
 * retuned store floor can never leave this hardcoded number silently stale. */
export const RECALL_CONFIDENCE_FLOOR = 60;

/** Split tags input the same way KnowledgeView's ingest form does (comma separated,
 * trimmed, blanks dropped), kept local rather than imported since it is one line. */
export function splitTags(value: string): string[] {
  return value.split(',').map((tag) => tag.trim()).filter(Boolean);
}

/** Review state badge tone, matching the severity a reader would expect: fresh/reviewed
 * read as fine, stale/contradicted are the flagged states the recall contract excludes
 * outright regardless of confidence. */
export function reviewStateTone(state: MemoryReviewState): 'ok' | 'warning' | 'bad' | 'neutral' {
  switch (state) {
    case 'reviewed': return 'ok';
    case 'fresh': return 'neutral';
    case 'stale': return 'warning';
    case 'contradicted': return 'bad';
    default: return 'neutral';
  }
}

export function isFlaggedReviewState(state: MemoryReviewState): boolean {
  return state === 'stale' || state === 'contradicted';
}

/** A confidence below the recall floor never clears prompt-injection even when the
 * record is not flagged, surfaced so a browsing operator can see WHY a record would
 * be silently skipped by the agent, without needing recall:true search semantics.
 * `recallFloor` is the live wire value (MemorySearchResult.recallFloor) the caller
 * searched against, required, not defaulted, so this never silently substitutes a
 * hardcoded number for the store's actual configured floor. */
export function isBelowRecallFloor(record: MemoryRecord, recallFloor: number): boolean {
  return record.confidence < recallFloor;
}

export function formatConfidence(confidence: number): string {
  return `${Math.round(confidence)}%`;
}

/** The row's words for a confidence: "rated 82% sure". */
export function confidenceRating(confidence: number): string {
  return `rated ${formatConfidence(confidence)} sure`;
}

export function formatProvenanceLink(link: MemoryProvenanceLink): string {
  return link.label ? `${link.label} (${link.kind}: ${link.ref})` : `${link.kind}: ${link.ref}`;
}

export function formatTimestamp(value: number | undefined): string {
  return whenLabel(value) || '—';
}
