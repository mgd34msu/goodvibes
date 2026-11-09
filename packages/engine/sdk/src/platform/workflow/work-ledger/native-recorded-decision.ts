/** Actual saved native admission reading, never a checkpoint's own act flag. */
import { canonicalJson, type DecisionLog, type EntryType } from '@goodvibes-jev/judgment';
import { NativeWorkExecutionError, type NativeWorkExecutionRecord } from './native-execution-types.js';

export function assertNativeRecordedDecision(record: NativeWorkExecutionRecord, log: Pick<DecisionLog, 'get'>): void {
  for (const id of record.decision.judgmentDecisionIds) {
    const entry = log.get(id);
    if (!entry || entry.status !== 'answered' || entry.context.site !== 'work-ledger.native-start'
      || !entry.notes.some(note => note.kind === 'action' && note.action === `autonomous:claim:${record.decision.decisionId}`)
      || !entry.notes.some(note => note.kind === 'readings' && note.readings !== null && typeof note.readings === 'object' && !Array.isArray(note.readings)
        && canonicalJson(note.readings['autonomousDecision']) === canonicalJson(record.decision as unknown as EntryType))) throw new NativeWorkExecutionError('unavailable');
  }
}
