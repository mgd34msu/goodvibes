import type {
  WorkLedgerReadEvent,
  WorkLedgerReadBinding,
  WorkLedgerReadSnapshot,
} from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger';
import type { OperatorNativeWorkExecutionClient } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-execution-client';
export type NativeWorkLedgerBinding = WorkLedgerReadBinding & { readonly execution?: OperatorNativeWorkExecutionClient };
/** Purge legacy manifests as soon as read authority narrows, including already displayed history. */
export function projectWorkLedgerHistory(
  events: readonly WorkLedgerReadEvent[],
  provenance: WorkLedgerReadSnapshot['provenance'],
): WorkLedgerReadEvent[] {
  return events.map((event) =>
    event.type === 'import_legacy' && provenance === 'requires_read_knowledge'
      ? {
          type: event.type,
          sequence: event.sequence,
          actorId: event.actorId,
          requestId: event.requestId,
          at: event.at,
          works: event.works,
          manifest: null,
          provenance: 'requires_read_knowledge',
        }
      : event,
  );
}
/** Notifications are hints; only contiguous durable events advance the history cursor. */
export function nextWorkLedgerCursor(events: readonly WorkLedgerReadEvent[], cursor: number, gapMessage: string): number {
  let next = cursor;
  for (const event of events) {
    if (event.sequence !== next + 1) throw new Error(gapMessage);
    next = event.sequence;
  }
  return next;
}
