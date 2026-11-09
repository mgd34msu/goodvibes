import { hashState, type EntryType, type JsonValue } from '@goodvibes-jev/judgment';

/** The two saved acceptance/rejection cache bindings must include the complete
 * original prepared records, even when the model view replaces old bodies with
 * native storage references. Only the commitment is saved: retaining another
 * full private evidence copy in each historical check would duplicate input.
 * Callers are readTarget's UnitCheck refusal hold and final-answer-review reuse.
 * This is local bookkeeping; never place the original records in the model view. */
export function completionEvidenceCommitment(evaluation: EntryType, originalPreparedEvidence: JsonValue): string {
  return hashState({ evaluation, originalPreparedEvidence });
}
