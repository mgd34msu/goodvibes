import { routeCardInput } from '@goodvibes/engine/terminal-shell/blocking-permission-input';
import { handleAskCardKey, type AskCardResolveExtras } from '@goodvibes/engine/terminal-shell/ask-card-input';
import type { AskCardState } from '@goodvibes/engine/terminal-shell/renderer/ask-card';
import type { PermissionRequest } from '@goodvibes/engine/platform/platform/permissions';
import type { HunkSelectionState } from '@goodvibes/engine/terminal-shell/hunk-selection';
import { describeCrashRecovery, type CrashRecoveryReport } from '@goodvibes/engine/terminal-shell/session-crash-recovery';
import type { SystemMessageRouter } from '../core/system-message-router.ts';

export type PendingPermissionState = PermissionRequest & AskCardState & {
  /**
   * `modifiedArgs.answer` carries the text typed into a command's terminal prompt (an `exec:prompt` ask);
   * for a multi-edit `edit` with only some changes applied, `modifiedArgs` holds those edits and
   * `extras.selectedHunks` their indices, which the approval broker applies. `extras.rememberTier` is
   * the "don't ask again" choice; `extras.reason` the reason typed with a refusal.
   */
  resolve: (approved: boolean, remember?: boolean, modifiedArgs?: Record<string, unknown>, extras?: AskCardResolveExtras) => void;
  /** Present when the ask is a multi-edit `edit` (isHunkSelectable): which changes are applied, and the cursor. */
  hunkState?: HunkSelectionState | undefined;
  /** When the card was put on screen; keys typed within the settle time or as one burst go to the composer. */
  openedAt?: number;
  /** The last key that was passed to the composer as typing. */
  lastTypedAt?: number | undefined;
  /** The person has addressed the card (a key after a pause, or Tab). */
  addressed?: boolean | undefined;
};

export type BlockingInputHandlerOptions = {
  data: string;
  pendingPermission: PendingPermissionState | null;
  /** The sessionId of the offered recovery snapshot, or null when none is pending. Callers key applyRecovery/removeRecoveryPoint to this exact id, see BlockingInputHandlerResult.recoveryPending. */
  recoveryPending: string | null;
  abortTurn: () => void;
  /** False while the composer holds a draft: keys keep going to it until Tab moves to the card. */
  composerEmpty?: boolean;
  /** Injectable clock for the typing-burst rule; defaults to Date.now(). Tests only. */
  now?: number;
  systemMessageRouter: SystemMessageRouter;
  render: () => void;
  /**
   * The prompted "yes, resume it" answer (shell/recovery-apply.ts): restores the
   * offered snapshot's session through the platform's apply step, which keeps the
   * snapshot file until the conversation accepted it, replays the journal tail,
   * persists the restored session and moves the runtime onto it.
   */
  applyRecovery: (sessionId: string) => CrashRecoveryReport;
  /** The prompted "no, and remove it" primitive (platform removeRecoveryPoint): clears the recovery snapshot without loading it. The caller keys this to the offered snapshot's sessionId. */
  removeRecoveryPoint: () => void;
};

export type BlockingInputHandlerResult = {
  handled: boolean;
  pendingPermission: PendingPermissionState | null;
  recoveryPending: string | null;
};

export function handleBlockingShellInput(options: BlockingInputHandlerOptions): BlockingInputHandlerResult {
  const {
    data,
    pendingPermission,
    recoveryPending,
    abortTurn,
    systemMessageRouter,
    render,
    applyRecovery,
    removeRecoveryPoint,
  } = options;

  if (pendingPermission) {
    // Ctrl+C is always the hard abort: deny and stop the turn, even while a
    // draft or a typing burst sends every other key to the composer.
    if (data === '\x03') {
      pendingPermission.resolve(false, false);
      abortTurn();
      render();
      return { handled: true, pendingPermission: null, recoveryPending };
    }
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
    // The card's own keys (terminal-shell ask-card-input.ts): the terminal app's scheme. Enter
    // presses the selected button, which opens on "Yes, once", or "No" for what cannot be undone.
    const result = handleAskCardKey(req, data);
    if (result.handled) render();
    return { handled: result.handled, pendingPermission: result.pending, recoveryPending };
  }

  if (recoveryPending) {
    if (data === '\x12') {
      const result = applyRecovery(recoveryPending);
      if (result.applied) {
        systemMessageRouter.userAction(describeCrashRecovery(result), 'success');
      } else if (result.refusal === 'apply-failed') {
        systemMessageRouter.userAction('[Recovery] The saved session could not be restored. The saved copy is still on disk and will be offered again at the next launch.', 'error');
      } else if (result.refusal === 'unusable-snapshot') {
        systemMessageRouter.userAction('[Recovery] The saved session was damaged and held no conversation, so it was discarded. Nothing was changed in this session.', 'warning');
      } else {
        systemMessageRouter.userAction('[Recovery] Failed to restore saved data. The saved copy, if any, was left on disk.', 'error');
      }
      render();
      return { handled: true, pendingPermission: null, recoveryPending: null };
    }

    // Only Esc on an empty composer discards. A lone Esc byte is the key; a
    // longer escape sequence is a focus or mouse report, an arrow or a paste.
    if (data === '\x1b' && (options.composerEmpty ?? true)) {
      systemMessageRouter.userAction('[Recovery] Discarded recovery data.');
      removeRecoveryPoint();
      render();
      return { handled: true, pendingPermission: null, recoveryPending: null };
    }

    // Reports the terminal sends on its own (focus, mouse) and navigation keys
    // are not an answer: they reach the composer and the offer stays open.
    if (data.startsWith('\x1b')) return { handled: false, pendingPermission: null, recoveryPending };

    // Typing means "not now": the offer closes for this launch and the snapshot
    // stays on disk, so the next launch offers it again.
    systemMessageRouter.userAction('[Recovery] Left the unsaved session on disk; it is offered again at the next launch.');
    render();
    return { handled: false, pendingPermission: null, recoveryPending: null };
  }

  // The first-start workspace question and the daemon repair question are
  // selection modals (shell/workspace-registration-question.ts,
  // shell/daemon-repair-prompt.ts): they receive only the keys aimed at them,
  // so nothing here waits on a question the screen does not show.
  return { handled: false, pendingPermission, recoveryPending };
}
