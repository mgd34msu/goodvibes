/** Actual saved native admission reading, never a checkpoint's own act flag. */
import { canonicalJson, type DecisionLog, type EntryType } from '@goodvibes/judgment';
import type { JevDecision } from '@goodvibes/judgment/decisions';
import { NativeWorkExecutionError, type NativeWorkExecutionRecord } from './native-execution-types.js';

/**
 * The id prefix of a start the owner made while no decision model was set: the
 * owner pressing Start is the decision, so no reading exists to look up. Its one
 * reading id is its own decision id.
 */
export const OWNER_START_DECISION_PREFIX = 'owner-start:';

/** Whether this start was the owner's own act with no decision model set, not a reading. */
export function isOwnerStartDecision(decision: Pick<JevDecision, 'decisionId' | 'judgmentDecisionIds'>): boolean {
  return decision.decisionId.startsWith(OWNER_START_DECISION_PREFIX)
    && decision.judgmentDecisionIds.length === 1 && decision.judgmentDecisionIds[0] === decision.decisionId;
}

export function assertNativeRecordedDecision(record: NativeWorkExecutionRecord, log: Pick<DecisionLog, 'get'>): void {
  if (isOwnerStartDecision(record.decision)) return;
  for (const id of record.decision.judgmentDecisionIds) {
    const entry = log.get(id);
    if (!entry || entry.status !== 'answered' || entry.context.site !== 'work-ledger.native-start'
      || !entry.notes.some(note => note.kind === 'action' && note.action === `autonomous:claim:${record.decision.decisionId}`)
      || !entry.notes.some(note => note.kind === 'readings' && note.readings !== null && typeof note.readings === 'object' && !Array.isArray(note.readings)
        && canonicalJson(note.readings['autonomousDecision']) === canonicalJson(record.decision as unknown as EntryType))) throw new NativeWorkExecutionError('unavailable');
  }
}
