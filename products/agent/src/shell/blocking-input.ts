import { handleSimplePermissionInput, routeCardInput } from '@goodvibes-jev/engine/terminal-shell/blocking-permission-input';
import type { ConversationManager } from '../core/conversation';
import type { PermissionRequest } from '@goodvibes-jev/engine/platform/platform/permissions';
import type { SessionSnapshot } from '@/runtime/index.ts';
import type { ApplyRecoverySnapshotResult } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import type { SystemMessageRouter } from '../core/system-message-router.ts';
import { readConversationMessageSnapshots } from '../core/conversation-message-snapshot.ts';
import type { DaemonRepairPrompt } from './daemon-repair-prompt.ts';

export type PendingPermissionState = PermissionRequest & {
  resolve: (approved: boolean, remember?: boolean) => void;
  /** When the card was put on screen; keys typed within the settle time or as one burst go to the composer. */
  openedAt?: number;
  /** The last key that was passed to the composer as typing. */
  lastTypedAt?: number | undefined;
  /** The person has addressed the card (a key after a pause, or Tab). */
  addressed?: boolean | undefined;
  /** `a` was pressed: Enter now allows for the session, any other key goes back. */
  rememberArmed?: boolean | undefined;
};

export type BlockingInputHandlerOptions = {
  data: string;
  pendingPermission: PendingPermissionState | null;
  /** The sessionId of the offered recovery snapshot, or null when none is pending. Callers key consumeRecovery/removeRecoveryPoint to this exact id, see BlockingInputHandlerResult.recoveryPending. */
  recoveryPending: string | null;
  /**
   * The one-touch daemon repair offer, when this launch made one. A
   * self-contained controller (shell/daemon-repair-prompt.ts) rather than a
   * state field plus callbacks: it owns the awaiting-answer state, the wording
   * and the follow-up, so nothing here has to be threaded back out.
   */
  daemonRepairPrompt: DaemonRepairPrompt | null;
  abortTurn: () => void;
  /** False while the composer holds a draft: keys keep going to it until Tab moves to the card. */
  composerEmpty?: boolean;
  /** Injectable clock for the typing-burst rule; defaults to Date.now(). Tests only. */
  now?: number;
  conversation: ConversationManager;
  systemMessageRouter: SystemMessageRouter;
  render: () => void;
  /**
   * The prompted "yes, resume it" answer (shell/recovery-apply.ts): restores the
   * offered snapshot's session through the platform's apply step, which keeps the
   * snapshot file until the conversation accepted it, replays the journal tail,
   * persists the restored session and moves the runtime onto it. Preferred over
   * {@link consumeRecovery}, which deletes the file before the conversation has
   * accepted it and replays nothing.
   */
  applyRecovery?: ((sessionId: string) => ApplyRecoverySnapshotResult) | undefined;
  /** The older "yes, resume it" primitive (platform consumeRecovery): loads the recovery snapshot and retires its file. Used only when {@link applyRecovery} is not supplied. The caller keys this to the offered snapshot's sessionId. */
  consumeRecovery: () => SessionSnapshot | null;
  /** The prompted "no, and remove it" primitive (platform removeRecoveryPoint): clears the recovery snapshot without loading it. The caller keys this to the offered snapshot's sessionId. */
  removeRecoveryPoint: () => void;
};

export type BlockingInputHandlerResult = {
  handled: boolean;
  pendingPermission: PendingPermissionState | null;
  recoveryPending: string | null;
  // Deliberately no daemonRepairPrompt: the controller owns its own
  // awaiting-answer state, so unlike the fields above there is nothing for the
  // shell to carry back and reassign.
};

export function handleBlockingShellInput(options: BlockingInputHandlerOptions): BlockingInputHandlerResult {
  const {
    data,
    pendingPermission,
    recoveryPending,
    daemonRepairPrompt,
    abortTurn,
    conversation,
    systemMessageRouter,
    render,
    applyRecovery,
    consumeRecovery,
    removeRecoveryPoint,
  } = options;

  if (pendingPermission) {
    // A sentence being typed when the card appeared keeps going to the composer:
    // only a key after a pause (or Tab) addresses the card.
    const now = options.now ?? Date.now();
    const routed = routeCardInput(
      data,
      // A card with no recorded opening time has no settle time; the burst rule still applies.
      { openedAt: pendingPermission.openedAt ?? 0, lastTypedAt: pendingPermission.lastTypedAt, addressed: pendingPermission.addressed },
      now,
      options.composerEmpty ?? true,
    );
    if (!routed.answer) {
      return {
        handled: false,
        pendingPermission: { ...pendingPermission, lastTypedAt: routed.card.lastTypedAt },
        recoveryPending,
      };
    }
    const req: PendingPermissionState = routed.card.addressed ? { ...pendingPermission, addressed: true } : pendingPermission;
    // "For session" is not offered for an ask the owner is asked again.
    const canRemember = req.rememberEffect !== 'owner-asked-again';
    if (req.rememberArmed) {
      if (data === '\r' || data === '\n') {
        req.resolve(true, true);
        render();
        return { handled: true, pendingPermission: null, recoveryPending };
      }
      systemMessageRouter.high('[Approval] Not remembered. Answer the request: y allows once, a then Enter allows for this session, n denies.');
      render();
      return { handled: true, pendingPermission: { ...req, rememberArmed: undefined }, recoveryPending };
    }
    if (canRemember && data.toLowerCase().trim() === 'a') {
      // Remembering is never one bare key: Enter confirms it.
      systemMessageRouter.high('[Approval] Press Enter to allow this for the rest of the session, or any other key to go back.');
      render();
      return { handled: true, pendingPermission: { ...req, rememberArmed: true }, recoveryPending };
    }
    if (
      handleSimplePermissionInput(data, {
        escapeDenies: true,
        abortOnDeny: true,
        resolve: (approved) => req.resolve(approved, false),
        abort: abortTurn,
        render,
      })
    )
      return { handled: true, pendingPermission: null, recoveryPending };

    render();
    return { handled: true, pendingPermission: req, recoveryPending };
  }

  if (recoveryPending) {
    if (data === '\x12') {
      if (applyRecovery) {
        const result = applyRecovery(recoveryPending);
        if (result.applied) {
          const replayed = result.journalReplay.replayed;
          systemMessageRouter.high(
            `[Recovery] Session restored (${result.messageCount} messages${replayed > 0 ? `, including ${replayed} recorded after the last snapshot` : ''}).`,
          );
          if (result.journalReplay.failed !== undefined) {
            systemMessageRouter.high(`[Recovery] Recovery of the journal failed (${result.journalReplay.failed}); it was kept and will be retried on the next resume.`);
          }
        } else if (result.refusal === 'apply-failed') {
          systemMessageRouter.high('[Recovery] The saved session could not be restored. The saved copy is still on disk and will be offered again at the next launch.');
        } else if (result.refusal === 'unusable-snapshot') {
          systemMessageRouter.high('[Recovery] The saved session was damaged and held no conversation, so it was discarded. Nothing was changed in this session.');
        } else {
          systemMessageRouter.high('[Recovery] Failed to restore saved data. The saved copy, if any, was left on disk.');
        }
        render();
        return { handled: true, pendingPermission: null, recoveryPending: null };
      }
      // consumeRecovery only retires the snapshot file once the load actually
      // succeeds, a bad read leaves it on disk instead of silently
      // destroying data that was never actually recovered.
      const recovery = consumeRecovery();
      if (recovery) {
        try {
          conversation.fromJSON({ messages: readConversationMessageSnapshots(recovery.messages) });
          systemMessageRouter.high('[Recovery] Session restored.');
        } catch {
          systemMessageRouter.high('[Recovery] The saved session could not be applied, and the saved copy has already been consumed.');
        }
      } else {
        systemMessageRouter.high('[Recovery] Failed to restore saved data.');
      }
      render();
      return { handled: true, pendingPermission: null, recoveryPending: null };
    }

    if (data === '\x1b' || data === '\x03') {
      systemMessageRouter.high('[Recovery] Discarded recovery data.');
      removeRecoveryPoint();
      render();
      return { handled: true, pendingPermission: null, recoveryPending: null };
    }

    systemMessageRouter.high('[Recovery] Ignored saved session; starting a new prompt.');
    removeRecoveryPoint();
    render();
    return { handled: false, pendingPermission: null, recoveryPending: null };
  }

  // Daemon repair: 'y' then Enter repairs, EVERY other key declines, default
  // no, matching the workspace prompt below and every other boot-time offer.
  // Declining changes nothing whatsoever and is remembered for the rest of the
  // session, so the question is asked once and never turn after turn.
  if (daemonRepairPrompt?.pending()) {
    daemonRepairPrompt.answer(data);
    return { handled: true, pendingPermission: null, recoveryPending };
  }

  // The first-start workspace question is a selection modal now
  // (shell/workspace-registration-question.ts): it receives only the keys aimed
  // at it, so nothing here waits on a question the screen does not show.
  return { handled: false, pendingPermission, recoveryPending };
}
