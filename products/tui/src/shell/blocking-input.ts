import { routeCardInput } from '@goodvibes-jev/engine/terminal-shell/blocking-permission-input';
import { handleAskCardKey } from '@goodvibes-jev/engine/terminal-shell/ask-card-input';
import type { PermissionRequest, RememberTier } from '@goodvibes-jev/engine/platform/platform/permissions';
import type { HunkSelectionState } from '../permissions/hunk-selection.ts';

export type PendingPermissionState = PermissionRequest & {
  resolve: (
    approved: boolean,
    remember?: boolean,
    modifiedArgs?: Record<string, unknown>,
    extras?: { rememberTier?: RememberTier; reason?: string; selectedHunks?: readonly number[] },
  ) => void;
  /** Present only when isHunkSelectable(request) was true when the prompt was opened. */
  hunkState?: HunkSelectionState;
  /** True once the person pressed `d`: the card shows its details. */
  detailsExpanded?: boolean;
  /**
   * Active typed-reply mode: 'deny-reason' (started by typing while the card
   * is up, Enter denies with the typed reason as feedback) or 'exec-answer'
   * (an exec-prompt ask; Enter approves with the typed answer feeding the
   * running command's stdin). Undefined = plain card keys.
   */
  replyMode?: 'deny-reason' | 'exec-answer';
  /** The reply draft while replyMode is active. */
  replyBuffer?: string;
  /**
   * Epoch ms when the prompt first appeared. Keys typed within the settle time
   * of this, or as part of the same burst of typing, go to the composer and
   * never answer the card (routeCardInput).
   */
  openedAt?: number;
  /** The last key that was passed to the composer as typing. */
  lastTypedAt?: number;
  /** The person has addressed the card (a key after a pause, or Tab); every key is the card's from then on. */
  addressed?: boolean;
  /** Requester attribution ("session abc12345" / a named agent) shown on the prompt; absent when unknown. */
  requestedBy?: string;
  /** The chosen button (index into the card's buttons); arrows move it, Enter presses it. */
  choice?: number;
  /** The "Yes, and don't ask again…" choices are open, and which is highlighted. */
  submenuOpen?: boolean;
  submenuIndex?: number;
  /** First card-body row shown when the card is taller than the screen. */
  scroll?: number;
};

export type BlockingInputHandlerOptions = {
  data: string;
  pendingPermission: PendingPermissionState | null;
  abortTurn: () => void;
  render: () => void;
  /** Injectable clock for the typing-burst rule; defaults to Date.now(). Tests only. */
  now?: number;
  /** False while the composer holds a draft: keys keep going to it until Tab moves to the card. */
  composerEmpty?: boolean;
};

export type BlockingInputHandlerResult = {
  handled: boolean;
  pendingPermission: PendingPermissionState | null;
};

export function handleBlockingShellInput(options: BlockingInputHandlerOptions): BlockingInputHandlerResult {
  const { data, pendingPermission, abortTurn, render } = options;

  if (pendingPermission) {
    const req = pendingPermission;

    // Ctrl+C is ALWAYS the hard abort: deny and kill the turn, in every mode.
    if (data === '\x03') {
      req.resolve(false, false);
      abortTurn();
      render();
      return { handled: true, pendingPermission: null };
    }

    // A sentence being typed when the card appeared keeps going to the composer:
    // only a key after a pause (or Tab) addresses the card.
    const now = options.now ?? Date.now();
    const routed = routeCardInput(
      data,
      // A card with no recorded opening time has no settle time; the burst rule still applies.
      { openedAt: req.openedAt ?? 0, lastTypedAt: req.lastTypedAt, addressed: req.addressed },
      now,
      options.composerEmpty ?? true,
    );
    if (!routed.answer) {
      return { handled: false, pendingPermission: { ...req, lastTypedAt: routed.card.lastTypedAt } };
    }
    if (routed.card.addressed && !req.addressed) return handleBlockingShellInput({ ...options, pendingPermission: { ...req, addressed: true } });

    // The card's own keys (terminal-shell ask-card-input.ts): one scheme in both terminal programs.
    const result = handleAskCardKey(req, data);
    if (result.handled) render();
    return { handled: result.handled, pendingPermission: result.pending };
  }

  return { handled: false, pendingPermission };
}
