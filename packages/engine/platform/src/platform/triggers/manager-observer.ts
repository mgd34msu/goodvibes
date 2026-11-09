/** Read-only trigger inspection never sweeps, quarantines or resolves recovery.
 * A fresh native file observation belongs only to this inspection; it cannot
 * promote a second terminal window into an execution owner.
 */
import { TriggerSnapshotStore } from './store.js';
import type { TriggerManagerOptions } from './manager-types.js';
import type { TriggerActionGrant, TriggerEventLogEntry, TriggerRecord, TriggerRecoveryReport } from './types.js';
export function observeTriggers(options: TriggerManagerOptions, now: number): {
  records: readonly TriggerRecord[]; grants: readonly TriggerActionGrant[];
  eventLog: readonly TriggerEventLogEntry[]; report: TriggerRecoveryReport;
} {
  const { snapshot } = new TriggerSnapshotStore(options.storePath, undefined, options.previousStorePath).load(true);
  return { records: snapshot?.triggers ?? [], grants: snapshot?.grants ?? [], eventLog: snapshot?.eventLog ?? [],
    report: { at: now, reason: 'startup', triggersLoaded: snapshot?.triggers.length ?? 0, triggersReaped: 0,
      reapedIds: [], runsReaped: 0, observationsReaped: 0, eventsReaped: 0, orphanedProcesses: [] } };
}
