/**
 * Carrying out an ask's choice, wherever the ask card is drawn (Work's detail,
 * the chat's inline card). An approval is answered through `approvals.*`
 * (useApprovalActions: every action names the revision it was shown, so a stale
 * one is refused and shown again); an inbox item through `inbox.answer` with the
 * choice's own value (a question's option, a purchase window's `go` or `stop`)
 * or the person's own words. The toast says what the daemon recorded.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { client as platformClient, isPressRefused } from '../../lib/goodvibes';
import { formatError } from '../../lib/errors';
import { queryKeys } from '../../lib/queries';
import { useToast } from '../../lib/toast';
import type { AskChoice, OpenAsk } from '../../lib/asks';
import type { ApprovalActions } from './useApprovalActions';

export interface ChoiceInput {
  /** Free text: a question's own answer, or the reason for a No. */
  readonly text?: string;
  /** The remember tier picked in "Don't ask again…". */
  readonly rememberTier?: string;
  /** For "Apply selected": the edit hunks kept, by index. */
  readonly selectedHunks?: readonly number[];
  readonly totalHunks?: number;
  /** For a command waiting on its terminal: the reply it is sent. */
  readonly answer?: string;
}

type InboxOutcome =
  | { readonly applied: true; readonly delivery?: { readonly state?: string; readonly to?: string; readonly reason?: string }; readonly item?: { readonly answer?: { readonly text?: string } } }
  | { readonly applied: false; readonly refusal: { readonly reason: string; readonly next?: readonly string[] } };

export function useAskActions(approvals: ApprovalActions) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const inbox = useMutation({
    mutationFn: async (input: { itemId: string; option?: string; text?: string }) =>
      (await platformClient.operator.invoke('inbox.answer', input)) as InboxOutcome,
    onSuccess: (outcome) => {
      if (!outcome.applied) {
        toast({ title: 'Not sent', description: [outcome.refusal.reason, outcome.refusal.next?.[0]].filter(Boolean).join(' '), tone: 'warning' });
        return;
      }
      const delivery = outcome.delivery;
      if (delivery?.state === 'undeliverable') {
        toast({ title: 'Answer saved, not deliverable', description: delivery.reason ?? `It cannot reach ${delivery.to ?? 'the asker'}.`, tone: 'warning' });
      } else if (delivery?.state === 'waiting') {
        toast({ title: 'Answer saved', description: delivery.reason ?? `It reaches ${delivery.to ?? 'the asker'} when it is next opened.`, tone: 'success' });
      } else {
        toast({ title: 'Answer sent', description: outcome.item?.answer?.text, tone: 'success' });
      }
    },
    // A refusal recorded nothing. Any other failure may have recorded the answer: the inbox
    // shows it as answered once re-read, and an answer sent again is refused as already answered.
    onError: (error) => toast(isPressRefused(error)
      ? { title: 'The answer was not sent', description: formatError(error), tone: 'danger' }
      : { title: 'The answer may have been sent', description: `${formatError(error)}. The inbox is read again to show whether it was recorded; an item already answered refuses a second answer.`, tone: 'warning' }),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: queryKeys.ownerInbox }); },
  });

  /**
   * Carry out `choice` on `ask`, with what the person added (a reason, a tier, the hunks kept).
   * Resolves true only when the daemon answered that it applied the choice; a refusal or a
   * failed send resolves false (the mutation's toast has already said which).
   */
  async function choose(ask: OpenAsk, choice: AskChoice, input: ChoiceInput = {}): Promise<boolean> {
    try {
      const record = ask.approval;
      if (record) {
        const revision = record.revision;
        if (choice.id === 'no') {
          const result = await approvals.deny.mutateAsync({ id: record.id, expectedRevision: revision, ...(input.text?.trim() ? { reason: input.text.trim() } : {}) });
          return result.applied === true;
        }
        const result = await approvals.approve.mutateAsync({
          id: record.id,
          expectedRevision: revision,
          ...(choice.id === 'remember' && input.rememberTier ? { rememberTier: input.rememberTier } : {}),
          ...(input.selectedHunks ? { selectedHunks: input.selectedHunks } : {}),
          ...(input.totalHunks !== undefined ? { totalHunks: input.totalHunks } : {}),
          ...(input.answer !== undefined ? { answer: input.answer } : {}),
        });
        return result.applied === true;
      }
      if (!ask.item) return false;
      if (choice.id === 'own-words') {
        if (!input.text?.trim()) return false;
        return (await inbox.mutateAsync({ itemId: ask.item.id, text: input.text.trim() })).applied;
      }
      const outcome = await inbox.mutateAsync({ itemId: ask.item.id, ...(choice.value !== undefined ? { option: choice.value } : { option: choice.label }), ...(input.text?.trim() ? { text: input.text.trim() } : {}) });
      return outcome.applied;
    } catch {
      // The mutation's onError has already told the person; nothing is recorded as decided here.
      return false;
    }
  }

  const busy = approvals.approve.isPending || approvals.deny.isPending || approvals.claim.isPending || approvals.cancel.isPending || inbox.isPending;
  return { choose, busy, inbox };
}

export type AskActions = ReturnType<typeof useAskActions>;
