/**
 * Approve, deny, claim and cancel for the Work view's approval detail, and the
 * push-notification hand-off (#approval-action=…&approval-id=…): Allow opens the
 * approval for review, Deny denies it.
 *
 * Moved from the old Approvals view unchanged in behavior: a partial hunk
 * approval sends an index array only (the daemon computes the edit), and every
 * toast reports what the daemon RECORDED (the response's `recorded` block), not
 * what was sent. See lib/approvals.ts.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { client as platformClient } from '../../lib/goodvibes';
import type { ApprovalActionResult, ApprovalApproveInput } from '../../lib/goodvibes';
import { queryKeys } from '../../lib/queries';
import { refetchAfterDecision } from '../../lib/approval-refresh';
import { isDurableRememberTier, recordedAnswerDelivered, recordedReasonStored, recordedRememberTier } from '../../lib/approvals';
import { parseApprovalActionFromHash, stripApprovalActionFragment } from '../../lib/push/approval-action-link';
import { formatError, isSessionClosedError } from '../../lib/errors';
import { useToast } from '../../lib/toast';

/** What an approve action carries beyond the id. */
export interface ApprovalApproveRequest {
  readonly id: string;
  /** The revision of the record the person was shown; a stale one is refused and the reading shown again. */
  readonly expectedRevision: number;
  readonly selectedHunks?: readonly number[];
  /** The remember tier picked (undefined = just this once). */
  readonly rememberTier?: string;
  /** Exec-prompt answer text feeding the waiting command. */
  readonly answer?: string;
  /** How many hunks the request has, to word a partial approval. */
  readonly totalHunks?: number;
}

const ACTION_TARGET = { approve: 'approved', deny: 'denied', claim: 'claimed', cancel: 'cancelled' } as const;
type ApprovalAction = keyof typeof ACTION_TARGET;

/**
 * The toast for a decision the daemon did not apply, or null when it did.
 *
 * Acting on an approval that already ended (an expired ask opened from a push
 * notification, one another surface answered first) returns 200 with the
 * record unchanged. The daemon reports that as `applied: false` with its own
 * refusal; a daemon predating that field is read from the returned status.
 */
export function describeUnappliedDecision(
  result: ApprovalActionResult | undefined,
  action: ApprovalAction,
): { title: string; description: string; tone: 'info' } | null {
  if (!result) return null;
  if (result.applied) return null;
  const status = result.approval?.status ?? 'unknown';
  // The daemon's refusal says why (settled, changed since it was shown, expired, owner's own decision); the
  // returned record and reading are what the list shows after the refetch.
  const refusal = result.refusal;
  const changed = refusal?.code === 'APPROVAL_CHANGED';
  return {
    title: changed ? 'It changed while you were looking; nothing was done' : `Already ${status}, nothing changed`,
    description: refusal?.reason ?? `This approval is ${status}, so it could not be ${ACTION_TARGET[action]}.`,
    tone: 'info',
  };
}

/** The revision an approval reads now, for an action that was not given the one it was shown at. */
async function currentRevision(id: string): Promise<number> {
  const listed = await platformClient.operator.approvals.list({ approvalId: id });
  const record = listed.approvals.find((entry) => entry.id === id);
  if (!record) throw new Error(`Approval ${id} is not in the daemon's approvals.`);
  return record.revision;
}

function friendlyError(error: unknown): string {
  if (isSessionClosedError(error)) return 'That session is closed. The approval can no longer be actioned.';
  return formatError(error);
}

export interface ApprovalActionsOptions {
  /** Open an approval's detail so the person reviews it (a push "Allow" lands here). */
  readonly onOpenApproval?: (id: string) => void;
  /** Act on a push notification's hand-off fragment (default true); only Work does, so the chat leaves it to Work. */
  readonly pushHandoff?: boolean;
}

export function useApprovalActions({ onOpenApproval, pushHandoff = true }: ApprovalActionsOptions = {}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const approve = useMutation({
    mutationFn: ({ id, expectedRevision, selectedHunks, rememberTier, answer }: ApprovalApproveRequest) => {
      const input: ApprovalApproveInput = {
        expectedRevision,
        ...(selectedHunks && selectedHunks.length > 0 ? { selectedHunks } : {}),
        ...(rememberTier ? { rememberTier, remember: true } : {}),
        ...(answer !== undefined ? { modifiedArgs: { answer } } : {}),
      };
      return platformClient.operator.approvals.approve(id, input);
    },
    onSuccess: async (result, variables) => {
      await refetchAfterDecision(queryClient, queryKeys.approvals);
      const unapplied = describeUnappliedDecision(result, 'approve');
      if (unapplied) { toast(unapplied); return; }
      const selectedCount = variables.selectedHunks?.length ?? 0;
      const isPartial = selectedCount > 0
        && variables.totalHunks !== undefined
        && selectedCount < variables.totalHunks;
      const title = isPartial ? `Approved ${selectedCount} of ${variables.totalHunks} hunks` : 'Approved';
      const recordedTier = recordedRememberTier(result);
      if (variables.rememberTier) {
        if (recordedTier) {
          if (isDurableRememberTier(recordedTier)) {
            await queryClient.invalidateQueries({ queryKey: queryKeys.permissionRules });
          }
          toast({ title, description: `Remembered (${recordedTier}): matching asks will not prompt again.`, tone: 'success' });
        } else {
          toast({ title, description: 'The daemon did not record the remember request, this decision applied once.', tone: 'info' });
        }
        return;
      }
      if (variables.answer !== undefined) {
        toast(recordedAnswerDelivered(result)
          ? { title: 'Answer sent', description: 'The reply is feeding the waiting command.', tone: 'success' }
          : { title, description: 'The daemon did not record the answer. The command was approved without input and may stop on its prompt.', tone: 'info' });
        return;
      }
      toast({ title, tone: 'success' });
    },
    onError: (error: unknown) => {
      toast({ title: 'Approve failed', description: friendlyError(error), tone: 'danger' });
    },
  });

  const deny = useMutation({
    // The one optional reason rides both wire fields (note + reason).
    // A deny from a push hand-off names no revision: refusing is always safe, so it denies the record as it reads now.
    mutationFn: async ({ id, expectedRevision, reason }: { id: string; expectedRevision?: number; reason?: string }) =>
      platformClient.operator.approvals.deny(id, {
        expectedRevision: expectedRevision ?? await currentRevision(id),
        ...(reason ? { note: reason, reason } : {}),
      }),
    onSuccess: async (result, variables) => {
      await refetchAfterDecision(queryClient, queryKeys.approvals);
      const unapplied = describeUnappliedDecision(result, 'deny');
      if (unapplied) { toast(unapplied); return; }
      toast(variables.reason && recordedReasonStored(result)
        ? { title: 'Denied', description: 'Reason fed back with the denial.', tone: 'info' }
        : { title: 'Denied', tone: 'info' });
    },
    onError: (error: unknown) => {
      toast({ title: 'Deny failed', description: friendlyError(error), tone: 'danger' });
    },
  });

  const claim = useMutation({
    mutationFn: ({ id, expectedRevision }: { id: string; expectedRevision: number }) => platformClient.operator.approvals.claim(id, { expectedRevision }),
    onSuccess: async (result) => {
      await refetchAfterDecision(queryClient, queryKeys.approvals);
      toast(describeUnappliedDecision(result, 'claim') ?? { title: 'Claimed', tone: 'info' });
    },
    onError: (error: unknown) => {
      toast({ title: 'Claim failed', description: friendlyError(error), tone: 'danger' });
    },
  });

  const cancel = useMutation({
    mutationFn: ({ id, expectedRevision }: { id: string; expectedRevision: number }) => platformClient.operator.approvals.cancel(id, { expectedRevision }),
    onSuccess: async (result) => {
      await refetchAfterDecision(queryClient, queryKeys.approvals);
      toast(describeUnappliedDecision(result, 'cancel') ?? { title: 'Cancelled', tone: 'info' });
    },
    onError: (error: unknown) => {
      toast({ title: 'Cancel failed', description: friendlyError(error), tone: 'danger' });
    },
  });

  // Push-notification action hand-off: an "Allow"/"Deny" tap opens the app at
  // #approval-action=…&approval-id=… (the service worker cannot act itself).
  // The fragment is plain URL text anyone can put in front of a signed-in
  // person, so "Allow" only opens the approval for review: the person sees what
  // is being asked and presses Approve. "Deny" is applied once on mount, since
  // refusing is always safe. The fragment is scrubbed so a reload does not
  // re-fire it.
  const handoffDoneRef = useRef(false);
  const denyRef = useRef(deny.mutate);
  const openRef = useRef(onOpenApproval);
  useLayoutEffect(() => {
    denyRef.current = deny.mutate;
    openRef.current = onOpenApproval;
  });
  useEffect(() => {
    if (handoffDoneRef.current || !pushHandoff) return;
    const intent = parseApprovalActionFromHash(window.location.hash);
    if (!intent) return;
    handoffDoneRef.current = true;
    stripApprovalActionFragment();
    if (intent.action === 'approve') openRef.current?.(intent.approvalId);
    else denyRef.current({ id: intent.approvalId });
  }, [pushHandoff]);

  return { approve, deny, claim, cancel };
}

export type ApprovalActions = ReturnType<typeof useApprovalActions>;
