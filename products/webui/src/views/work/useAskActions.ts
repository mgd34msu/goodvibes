/**
 * Carrying out an ask's choice, wherever the ask card is drawn (Work's detail,
 * the chat's inline card). An approval is answered through `approvals.*`
 * (useApprovalActions: every action names the revision it was shown, so a stale
 * one is refused and shown again); an inbox item through `inbox.answer` with the
 * choice's own value (a question's option, a purchase window's `go` or `stop`)
 * or the person's own words. The toast says what the daemon recorded.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { client as platformClient } from '../../lib/goodvibes';
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
    onError: (error) => toast({ title: 'The answer was not sent', description: formatError(error), tone: 'danger' }),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: queryKeys.ownerInbox }); },
  });

  /** Carry out `choice` on `ask`. Returns false when the choice needs more from the person first. */
  function choose(ask: OpenAsk, choice: AskChoice, input: ChoiceInput = {}): void {
    const record = ask.approval;
    if (record) {
      const revision = record.revision;
      if (choice.id === 'no') {
        approvals.deny.mutate({ id: record.id, expectedRevision: revision, ...(input.text?.trim() ? { reason: input.text.trim() } : {}) });
        return;
      }
      approvals.approve.mutate({
        id: record.id,
        expectedRevision: revision,
        ...(choice.id === 'remember' && input.rememberTier ? { rememberTier: input.rememberTier } : {}),
        ...(input.selectedHunks ? { selectedHunks: input.selectedHunks } : {}),
        ...(input.totalHunks !== undefined ? { totalHunks: input.totalHunks } : {}),
        ...(input.answer !== undefined ? { answer: input.answer } : {}),
      });
      return;
    }
    if (!ask.item) return;
    if (choice.id === 'own-words') {
      if (input.text?.trim()) inbox.mutate({ itemId: ask.item.id, text: input.text.trim() });
      return;
    }
    inbox.mutate({ itemId: ask.item.id, ...(choice.value !== undefined ? { option: choice.value } : { option: choice.label }), ...(input.text?.trim() ? { text: input.text.trim() } : {}) });
  }

  const busy = approvals.approve.isPending || approvals.deny.isPending || approvals.claim.isPending || approvals.cancel.isPending || inbox.isPending;
  return { choose, busy, inbox };
}

export type AskActions = ReturnType<typeof useAskActions>;
