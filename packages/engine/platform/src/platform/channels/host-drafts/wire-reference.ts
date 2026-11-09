import { createHash } from 'node:crypto';
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import { JudgmentInputError, snapshotJudgmentInput } from '../../gate/judgment-input.js';

const historicalReference = /^draft-reference-[a-p]{32}$/;
const storedReference = /^draft-reference-v2-[a-p]{8}-[a-p]{4}-[a-p]{4}-[a-p]{4}-[a-p]{12}$/;

/** Allocate once, beside the native row. A reference grants no authority. */
export function createChannelDraftWireReference(id: string): string {
  try { snapshotJudgmentInput({ draftId: id }); return id; }
  catch (error) {
    if (!(error instanceof JudgmentInputError) || error.problem !== 'card-material') throw error;
    return `draft-reference-v2-${opaqueUuid()}`;
  }
}

/** Read an actual stored reference; ordinary lookups never derive a private-ID digest. */
export function channelDraftWireReference(id: string, reference?: string): string {
  if (reference !== undefined) {
    if (reference !== id && !isNativeDraftWireReference(reference)) throw new Error('Invalid stored draft reference');
    snapshotJudgmentInput({ draftId: reference });
    return reference;
  }
  snapshotJudgmentInput({ draftId: id });
  return id;
}

function historicalReferenceFor(id: string): string {
  const digest = createHash('sha256').update(JSON.stringify(['channel-draft-reference', id])).digest('hex').slice(0, 32);
  return `draft-reference-${Array.from(digest, nibble => String.fromCharCode(97 + Number.parseInt(nibble, 16))).join('')}`;
}

/** One-time bridge for an actual saved pre-field Agent row during authorized sync/send. */
export function historicalChannelDraftWireReference(id: string): string {
  try { snapshotJudgmentInput({ draftId: id }); return id; }
  catch (error) {
    if (!(error instanceof JudgmentInputError) || error.problem !== 'card-material') throw error;
    return historicalReferenceFor(id);
  }
}

/** Only an actual incoming old handle selects this compatibility computation. */
export function matchesHistoricalDraftWireReference(id: string, reference: string): boolean {
  return historicalReference.test(reference) && historicalReferenceFor(id) === reference;
}

export function isHistoricalDraftWireReference(id: string): boolean {
  return historicalReference.test(id);
}

export function isNativeDraftWireReference(id: string): boolean {
  return historicalReference.test(id) || storedReference.test(id);
}
