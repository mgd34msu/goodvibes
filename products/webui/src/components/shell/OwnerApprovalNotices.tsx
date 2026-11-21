/**
 * Shows each change the daemon put to the owner instead of applying it
 * (lib/owner-approval.ts): a notice that it is waiting for the owner's
 * approval while it is pending, then what became of it. While a change waits,
 * its approval is read when an `approval-update` frame names it, and once
 * whenever the live stream becomes ready or reports dropped frames; nothing is
 * read on a clock. When it settles, the settings and session views are
 * refreshed so they show what the daemon now holds.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { client as platformClient } from '../../lib/goodvibes';
import { useToast } from '../../lib/toast';
import { queryKeys } from '../../lib/queries';
import { subscribeEvents } from '../../lib/event-stream';
import {
  dismissOwnerApproval,
  outcomeOfApprovalStatus,
  ownerApprovalChanges,
  settleOwnerApproval,
  subscribeOwnerApprovals,
  type OwnerApprovalOutcome,
} from '../../lib/owner-approval';

/** The approval broker's wire event (tagged with the `gate` domain); its payload carries the `approval` record. */
const APPROVAL_UPDATE_WIRE_EVENT = 'approval-update';

function approvalIdOfFrame(payload: unknown): string | null {
  const approval = typeof payload === 'object' && payload !== null ? (payload as { approval?: unknown }).approval : undefined;
  const id = typeof approval === 'object' && approval !== null ? (approval as { id?: unknown }).id : undefined;
  return typeof id === 'string' ? id : null;
}

const OUTCOME_TEXT: Record<Exclude<OwnerApprovalOutcome, 'pending'>, { readonly title: string; readonly tone: 'success' | 'warning' }> = {
  approved: { title: 'The owner approved the change; it is applied', tone: 'success' },
  denied: { title: 'The owner declined the change; nothing changed', tone: 'warning' },
  expired: { title: 'The change expired unanswered; nothing changed', tone: 'warning' },
  cancelled: { title: 'The change was cancelled; nothing changed', tone: 'warning' },
  left: { title: 'This tab signed out or changed daemon while the change waited', tone: 'warning' },
};

/** The notice's description per outcome; `left` says where the approval is still decided. */
function outcomeDescription(outcome: Exclude<OwnerApprovalOutcome, 'pending'>, summary: string): string {
  return outcome === 'left'
    ? `${summary} is still decided by the owner on the daemon that asked; this tab no longer follows it.`
    : summary;
}

export function OwnerApprovalNotices(): null {
  const changes = useSyncExternalStore(subscribeOwnerApprovals, ownerApprovalChanges, ownerApprovalChanges);
  const { toast, dismiss } = useToast();
  const queryClient = useQueryClient();
  const pendingToasts = useRef(new Map<string, string>());

  // A notice per change: persistent while pending, replaced by the outcome when it settles.
  useEffect(() => {
    for (const change of changes) {
      if (change.outcome === 'pending') {
        if (!pendingToasts.current.has(change.approvalId)) {
          pendingToasts.current.set(change.approvalId, toast({
            title: 'Waiting for the owner\'s approval',
            description: `${change.summary} loosens a setting only the owner changes. Nothing has changed yet; it is applied when he approves it (approval ${change.approvalId}).`,
            tone: 'info',
            durationMs: 0,
          }));
        }
        continue;
      }
      const shown = pendingToasts.current.get(change.approvalId);
      if (shown) dismiss(shown);
      pendingToasts.current.delete(change.approvalId);
      const text = OUTCOME_TEXT[change.outcome];
      toast({ title: text.title, description: outcomeDescription(change.outcome, change.summary), tone: text.tone });
      void queryClient.invalidateQueries({ queryKey: queryKeys.config });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      dismissOwnerApproval(change.approvalId);
    }
  }, [changes, toast, dismiss, queryClient]);

  // Follow each pending approval until it settles; nothing is subscribed or read while none waits.
  const pendingIds = changes.filter((change) => change.outcome === 'pending').map((change) => change.approvalId).join(',');
  useEffect(() => {
    if (!pendingIds) return undefined;
    let stopped = false;
    const waiting = new Set(pendingIds.split(','));
    const read = async (approvalId: string): Promise<void> => {
      const change = ownerApprovalChanges().find((entry) => entry.approvalId === approvalId && entry.outcome === 'pending');
      if (!change) return;
      try {
        const snapshot = await platformClient.operator.invoke('approvals.list', { approvalId });
        if (stopped) return;
        const record = snapshot.approvals.find((entry) => entry.id === approvalId);
        // Settled only under the lifetime that raised the change (settleOwnerApproval checks it after
        // this await): there, an id the daemon no longer holds was cancelled with it.
        settleOwnerApproval(approvalId, record ? outcomeOfApprovalStatus(record.status) : 'cancelled', change.lifetime);
      } catch {
        // A failed read is tried again on the next frame naming it, or when the stream is ready again.
      }
    };
    const readAll = () => { for (const approvalId of waiting) void read(approvalId); };
    const unsubscribe = subscribeEvents({
      domains: ['gate'],
      events: [APPROVAL_UPDATE_WIRE_EVENT],
      onEvent: (_name, payload) => {
        const approvalId = approvalIdOfFrame(payload);
        // A frame whose record cannot be read names no id: every waiting approval is read once.
        if (approvalId === null) readAll();
        else if (waiting.has(approvalId)) void read(approvalId);
      },
      // Once ready (the change may have settled before the stream carried it) and after any
      // reconnect or dropped frames, each waiting approval is read once.
      onReady: readAll,
      onGap: readAll,
    });
    return () => { stopped = true; unsubscribe(); };
  }, [pendingIds]);

  return null;
}
