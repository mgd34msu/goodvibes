import { enterAnswer, handleSimplePermissionInput, routeCardInput } from '@goodvibes-jev/engine/terminal-shell/blocking-permission-input';
import type { PermissionRequest } from '@goodvibes-jev/engine/platform/platform/permissions';
import { applyHunkKey, hunkSelectionAnswer, type HunkSelectionState } from '@goodvibes-jev/engine/terminal-shell/hunk-selection';
import { describeCrashRecovery, type CrashRecoveryReport } from '@goodvibes-jev/engine/terminal-shell/session-crash-recovery';
import type { SystemMessageRouter } from '../core/system-message-router.ts';
import { remembersAllow } from '../permissions/prompt.ts';

export type PendingPermissionState = PermissionRequest & {
  /**
   * `modifiedArgs.answer` carries the text typed into a command's terminal prompt (an `exec:prompt` ask);
   * for a multi-edit `edit` with only some hunks applied, `modifiedArgs` holds those edits and
   * `extras.selectedHunks` their indices, which the approval broker applies.
   */
  resolve: (approved: boolean, remember?: boolean, modifiedArgs?: Record<string, unknown>, extras?: { readonly selectedHunks?: readonly number[] | undefined }) => void;
  /** Present when the ask is a multi-edit `edit` (isHunkSelectable): which hunks are applied, and the cursor. */
  hunkState?: HunkSelectionState | undefined;
  /** The answer being typed into a command's terminal prompt; shown masked on the card. */
  replyBuffer?: string | undefined;
  /** When the card was put on screen; keys typed within the settle time or as one burst go to the composer. */
  openedAt?: number;
  /** The last key that was passed to the composer as typing. */
  lastTypedAt?: number | undefined;
  /** The person has addressed the card (a key after a pause, or Tab). */
  addressed?: boolean | undefined;
  /** `a` was pressed: Enter now allows for the session, any other key goes back. */
  rememberArmed?: boolean | undefined;
};

/** An ask to type the answer a running command is waiting for on its terminal. */
export function isExecPromptAsk(request: PermissionRequest): boolean {
  return request.attribution?.kind === 'exec-prompt';
}

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
    // A command waiting on its terminal: every printable key types the answer (a prompt
    // that wants a literal 'y' must not have it taken as a card key). Enter sends it,
    // Esc clears the draft and then declines, Ctrl+C declines and stops the turn.
    if (isExecPromptAsk(req)) {
      const buffer = req.replyBuffer ?? '';
      if (data === '\x03') {
        req.resolve(false, false);
        abortTurn();
        render();
        return { handled: true, pendingPermission: null, recoveryPending };
      }
      if (data === '\r' || data === '\n') {
        req.resolve(true, false, { answer: buffer });
        render();
        return { handled: true, pendingPermission: null, recoveryPending };
      }
      if (data === '\x1b') {
        if (buffer.length > 0) {
          render();
          return { handled: true, pendingPermission: { ...req, replyBuffer: '' }, recoveryPending };
        }
        req.resolve(false, false);
        render();
        return { handled: true, pendingPermission: null, recoveryPending };
      }
      if (data === '\x7f' || data === '\b') {
        render();
        return { handled: true, pendingPermission: { ...req, replyBuffer: [...buffer].slice(0, -1).join('') }, recoveryPending };
      }
      if (data.length >= 1 && !data.startsWith('\x1b') && data >= ' ') {
        render();
        return { handled: true, pendingPermission: { ...req, replyBuffer: buffer + data }, recoveryPending };
      }
      render();
      return { handled: true, pendingPermission: req, recoveryPending };
    }
    // A multi-edit `edit`: each hunk is applied or left out, with the keys the TUI
    // card uses (terminal-shell hunk-selection.ts). A hunk card offers no "for session".
    if (req.hunkState) {
      const { state, commit } = applyHunkKey(req.hunkState, data);
      if (commit === 'apply') {
        const answer = hunkSelectionAnswer(req, state);
        // Every hunk is the request as asked, approved whole; fewer ride as the broker's
        // selection and, for a resolver that forwards only arguments, as reduced edits.
        if (answer.selectedHunks.length === state.hunks.length) req.resolve(true, false);
        else req.resolve(true, false, answer.modifiedArgs, { selectedHunks: answer.selectedHunks });
        render();
        return { handled: true, pendingPermission: null, recoveryPending };
      }
      if (commit === 'cancel') {
        // Deny tells the model the change was refused, as on the plain card; Ctrl+C stops the turn.
        req.resolve(false, false);
        if (data === '\x03') abortTurn();
        render();
        return { handled: true, pendingPermission: null, recoveryPending };
      }
      render();
      return { handled: true, pendingPermission: { ...req, hunkState: state }, recoveryPending };
    }
    // "For session" is not offered for an ask whose answer is not remembered.
    const canRemember = remembersAllow(req);
    if (req.rememberArmed) {
      if (data === '\r' || data === '\n') {
        req.resolve(true, true);
        render();
        return { handled: true, pendingPermission: null, recoveryPending };
      }
      // Back to the card's own choices, which the card shows again.
      render();
      return { handled: true, pendingPermission: { ...req, rememberArmed: undefined }, recoveryPending };
    }
    if (canRemember && data.toLowerCase().trim() === 'a') {
      // Remembering is never one bare key: Enter confirms it. The card shows the armed choice and its keys.
      render();
      return { handled: true, pendingPermission: { ...req, rememberArmed: true }, recoveryPending };
    }
    // A bare Enter is never the broadest answer: it allows this one call, or denies what cannot be undone.
    if (data === '\r' || data === '\n') {
      req.resolve(enterAnswer(req) === 'allow-once', false);
      render();
      return { handled: true, pendingPermission: null, recoveryPending };
    }
    // A denial is the call's answer: the model is told it was refused and the turn goes on (Ctrl+C stops the turn).
    if (data === '\x03') {
      req.resolve(false, false);
      abortTurn();
      render();
      return { handled: true, pendingPermission: null, recoveryPending };
    }
    if (
      handleSimplePermissionInput(data, {
        escapeDenies: true,
        abortOnDeny: false,
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
