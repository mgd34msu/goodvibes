/**
 * Shows each change the daemon put to the owner instead of applying it
 * (lib/owner-approval.ts): a notice that it is waiting for the owner's
 * approval while it is pending, then what became of it. The approval is read
 * again every few seconds only while a change waits; when it settles, the
 * settings and session views are refreshed so they show what the daemon now
 * holds.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { client as platformClient } from '../../lib/goodvibes';
import { useToast } from '../../lib/toast';
import { queryKeys } from '../../lib/queries';
import {
  dismissOwnerApproval,
  outcomeOfApprovalStatus,
  ownerApprovalChanges,
  settleOwnerApproval,
  subscribeOwnerApprovals,
  type OwnerApprovalOutcome,
} from '../../lib/owner-approval';

const POLL_MS = 3000;

const OUTCOME_TEXT: Record<Exclude<OwnerApprovalOutcome, 'pending'>, { readonly title: string; readonly tone: 'success' | 'warning' }> = {
  approved: { title: 'The owner approved the change; it is applied', tone: 'success' },
  denied: { title: 'The owner declined the change; nothing changed', tone: 'warning' },
  expired: { title: 'The change expired unanswered; nothing changed', tone: 'warning' },
  cancelled: { title: 'The change was cancelled; nothing changed', tone: 'warning' },
};

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
      toast({ title: text.title, description: change.summary, tone: text.tone });
      void queryClient.invalidateQueries({ queryKey: queryKeys.config });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      dismissOwnerApproval(change.approvalId);
    }
  }, [changes, toast, dismiss, queryClient]);

  // Follow each pending approval until it settles; nothing is read while none waits.
  const pendingIds = changes.filter((change) => change.outcome === 'pending').map((change) => change.approvalId).join(',');
  useEffect(() => {
    if (!pendingIds) return;
    let stopped = false;
    const read = async (): Promise<void> => {
      for (const approvalId of pendingIds.split(',')) {
        try {
          const snapshot = await platformClient.operator.invoke('approvals.list', { approvalId });
          const record = snapshot.approvals.find((entry) => entry.id === approvalId);
          if (stopped) return;
          // An id the daemon no longer holds was cancelled with it.
          settleOwnerApproval(approvalId, record ? outcomeOfApprovalStatus(record.status) : 'cancelled');
        } catch {
          // A read that failed is tried again on the next tick.
        }
      }
    };
    const timer = setInterval(() => { void read(); }, POLL_MS);
    void read();
    return () => { stopped = true; clearInterval(timer); };
  }, [pendingIds]);

  return null;
}
