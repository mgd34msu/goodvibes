/**
 * memory-consolidation-proposals.ts
 *
 * The memory-review surface's view of idle consolidation's proposals (a
 * contradiction, a cross-scope duplicate, a stale-delete candidate). They are
 * kept in the memory store once each and listed by the consolidation
 * scheduler (MemoryConsolidationScheduler.listProposals), so the list is the
 * same after a restart and a proposal found by several passes appears once.
 * Each line jumps into the EXISTING review flow (`/memory review <id> <state>`,
 * the review action of /memory, terminal-shell/memory-command.ts) rather than adding a
 * second, parallel review mechanism.
 */
import type { MemoryConsolidationProposal } from '@goodvibes/engine/platform/platform/state';

/** The narrow scheduler slice this module needs. */
export interface ConsolidationReceiptSource {
  listProposals(): readonly MemoryConsolidationProposal[];
}

/** Every proposal still waiting for a person, oldest first, each once. */
export function listPendingConsolidationProposals(
  source: ConsolidationReceiptSource,
): readonly MemoryConsolidationProposal[] {
  return source.listProposals();
}

const PROPOSAL_KIND_LABELS: Readonly<Record<MemoryConsolidationProposal['kind'], string>> = {
  contradiction: 'contradiction',
  'cross-scope-duplicate': 'cross-scope duplicate',
  'stale-delete': 'stale, never referenced',
};

/**
 * One legible review-queue line per proposal: what kind of judgment flagged
 * it, why, which record ids it references, and the exact command that jumps
 * into the existing review flow for the first referenced id, so a proposal
 * is never just a queue entry with no story.
 */
export function formatConsolidationProposalForReview(proposal: MemoryConsolidationProposal): string {
  const kindLabel = PROPOSAL_KIND_LABELS[proposal.kind] ?? proposal.kind;
  const idList = proposal.ids.join(', ');
  const jumpId = proposal.ids[0];
  const jumpHint = jumpId ? `, review: /memory review ${jumpId} <state>` : '';
  return `  [${kindLabel}] ${idList}: ${proposal.reason}${jumpHint}`;
}
