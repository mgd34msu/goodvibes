/**
 * broker-approval, render a broker-originated approval ask as a real
 * agent-terminal permission card.
 *
 * The shared ApprovalBroker (constructed once in runtime/services.ts,
 * @goodvibes-jev/engine/platform/platform/control-plane) publishes every ask this
 * agent process raises: local tool-call asks (which carry a `localPrompt`,
 * see bootstrap-core.ts's PermissionManager construction, which opens its
 * own card through permissionPromptRef.requestPermission), plus asks with no
 * local prompt attached at all, e.g. one raised by another attached command-
 * authority surface (webui, a channel like Telegram via approval-reply.ts)
 * against this same broker instance. Before this module existed, the second
 * kind was invisible in the agent terminal: the ask sat pending with no
 * surface to answer it here.
 *
 * A local ask's own prompt is opened by the broker immediately AFTER it
 * publishes (see ApprovalBroker.requestApproval), so the open here is
 * deferred one microtask and re-checks: if a card (the local one, or another
 * broker card) is already up, it does nothing, only a genuinely unhandled
 * ask surfaces. The card's resolve answers the broker directly via
 * resolveApproval, so an agent-terminal decision on a broker-originated ask
 * reaches every waiter on that record, including a tool call blocked on it
 * in this same process, and any other surface polling/watching the record.
 *
 * The card is the same one a local ask opens (permissions/prompt.ts), so a
 * broker-originated write or edit shows its change as a diff too, and a
 * multi-edit `edit` opens with its hunks selectable (the terminal-shell keys
 * the TUI card uses); the answer carries `selectedHunks`, which the broker
 * applies. It is narrower than the TUI's broker-approval-card.ts in two ways:
 * no deny-with-reason mode (it does take a command's typed terminal answer),
 * and no CI fix-session concept (the agent does not own build/fix/review
 * worktrees, see DisabledAgentWorktreeRegistry in runtime/services.ts).
 */

import type { PendingPermissionState } from '../shell/blocking-input.ts';
import { buildHunkSelectionState, isHunkSelectable } from '@goodvibes-jev/engine/terminal-shell/hunk-selection';
import type { PermissionPromptRequest } from '@goodvibes-jev/engine/platform/platform/permissions';

/** The broker seam this module answers through, a subset of ApprovalBroker. */
export interface BrokerApprovalBroker {
  getApproval(approvalId: string): BrokerCardRecord | null;
  resolveApproval(
    approvalId: string,
    input: {
      readonly approved: boolean;
      readonly disposition?: 'approved' | 'denied';
      readonly remember?: boolean;
      readonly modifiedArgs?: Record<string, unknown>;
      readonly selectedHunks?: readonly number[];
      readonly actor: string;
      readonly actorSurface?: string;
      /** The revision of the record the card showed. */
      readonly expectedRevision: number | undefined;
    },
  ): Promise<BrokerCardOutcome>;
}

/** The record a card is drawn from. */
export interface BrokerCardRecord {
  readonly id: string;
  readonly callId: string;
  readonly status: string;
  readonly revision: number;
  readonly request: PermissionPromptRequest;
}

/** What the broker did with the card's answer: applied, or refused with the record as it is now. */
export type BrokerCardOutcome =
  | { readonly applied: true; readonly record: BrokerCardRecord }
  | { readonly applied: false; readonly record: BrokerCardRecord | null; readonly refusal: { readonly code: string; readonly reason: string } };

export interface BrokerApprovalChangeParams {
  readonly approval: BrokerCardRecord;
  readonly getPending: () => PendingPermissionState | null;
  readonly setPending: (pending: PendingPermissionState | null) => void;
  readonly broker: BrokerApprovalBroker;
  readonly render: () => void;
  /** Defers the open (default queueMicrotask); injectable so tests run it synchronously. */
  readonly defer?: (callback: () => void) => void;
  /** Told when answering the broker failed, so the owner can be shown why the card came back. */
  readonly onResolveFailed?: (error: unknown) => void;
}

const isActiveStatus = (status: string): boolean => status === 'pending' || status === 'claimed';

/**
 * React to one broker approval change: clear the active card when ITS
 * approval resolves (answered here, elsewhere, or expired), or open a card
 * for a newly-pending broker-originated ask that no local prompt is handling.
 */
export function handleBrokerApprovalChange(params: BrokerApprovalChangeParams): void {
  const { approval, getPending, setPending, broker, render } = params;
  const defer = params.defer ?? queueMicrotask;
  const active = isActiveStatus(approval.status);

  const pending = getPending();
  if (pending && pending.callId === approval.callId) {
    // This is the card already on screen, clear it once its approval
    // resolves, whichever surface (or expiry) resolved it.
    if (!active) { setPending(null); render(); }
    return;
  }
  if (!active) return;

  defer(() => {
    if (getPending()) return; // a local card (or another broker card) is already up
    const current = broker.getApproval(approval.id);
    if (!current || !isActiveStatus(current.status)) return;
    const card: PendingPermissionState = {
      ...current.request,
      openedAt: Date.now(),
      hunkState: isHunkSelectable(current.request) ? buildHunkSelectionState(current.request) : undefined,
      resolve: (approved: boolean, remember = false, modifiedArgs?: Record<string, unknown>, extras?: { readonly selectedHunks?: readonly number[] | undefined }) => {
        void broker.resolveApproval(approval.id, {
          approved,
          // The owner answered this card: an explicit decision, which owner-only asks (workspace trust) require.
          disposition: approved ? 'approved' : 'denied',
          remember,
          ...(approved && modifiedArgs ? { modifiedArgs } : {}),
          ...(approved && extras?.selectedHunks ? { selectedHunks: extras.selectedHunks } : {}),
          actor: 'agent',
          actorSurface: 'agent',
          // The record this card was drawn from: a stale answer is refused and the card is drawn again from the current one.
          expectedRevision: current.revision,
        }).then((outcome) => {
          if (outcome.applied || !outcome.record || !isActiveStatus(outcome.record.status) || getPending()) return;
          const latest = outcome.record;
          defer(() => handleBrokerApprovalChange({ ...params, approval: latest }));
        }, (error: unknown) => {
          // The key press already cleared the card. If the broker still holds the ask open
          // (the answer was not recorded), bring the card back so the ask is not left
          // pending with nothing on screen; an ask that is already resolved needs nothing.
          const latest = broker.getApproval(approval.id);
          if (latest && isActiveStatus(latest.status) && !getPending()) {
            setPending({ ...card, openedAt: Date.now(), lastTypedAt: undefined, addressed: undefined, rememberArmed: undefined });
            render();
          }
          params.onResolveFailed?.(error);
        });
      },
    } as PendingPermissionState;
    setPending(card);
    render();
  });
}
