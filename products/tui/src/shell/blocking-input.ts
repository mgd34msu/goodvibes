import { handleSimplePermissionInput, routeCardInput } from '@goodvibes-jev/engine/terminal-shell/blocking-permission-input';
import type { PermissionRequest, RememberTier } from '@goodvibes-jev/engine/platform/platform/permissions';
import { applyHunkKey, hunkSelectionAnswer, type HunkSelectionState } from '../permissions/hunk-selection.ts';
import { offersNoRemembering, permissionButtons } from '../permissions/prompt-card.ts';

export type PendingPermissionState = PermissionRequest & {
  resolve: (
    approved: boolean,
    remember?: boolean,
    modifiedArgs?: Record<string, unknown>,
    extras?: { rememberTier?: RememberTier; reason?: string; selectedHunks?: readonly number[] },
  ) => void;
  /** Present only when isHunkSelectable(request) was true when the prompt was opened. */
  hunkState?: HunkSelectionState;
  /** True once the user pressed `d` to expand a condensed low-risk card. (2b.) */
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
  /** The chosen button (index into permissionButtons); arrows move it, Enter presses it. */
  choice?: number;
  /** The "Allow for session ▸" remember-tier submenu is open, and which tier is highlighted. */
  submenuOpen?: boolean;
  submenuIndex?: number;
  /** First card-body row shown when the card is taller than the screen. */
  scroll?: number;
};

const KEY_LEFT = '\x1b[D';
const KEY_RIGHT = '\x1b[C';
const KEY_UP = '\x1b[A';
const KEY_DOWN = '\x1b[B';
const KEY_PAGE_UP = '\x1b[5~';
const KEY_PAGE_DOWN = '\x1b[6~';

/** Move the chosen button by delta (wrapping). */
function withChoice(req: PendingPermissionState, delta: number): PendingPermissionState {
  const count = permissionButtons(req, req).length;
  if (count === 0) return req;
  return { ...req, choice: ((req.choice ?? 0) + delta + count) % count };
}

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

    if (req.hunkState) {
      // Buttons (Apply selected / Deny): arrows and tab choose, Enter presses.
      if (data === KEY_LEFT || data === KEY_RIGHT || data === '\t') {
        render();
        return { handled: true, pendingPermission: withChoice(req, data === KEY_LEFT ? -1 : 1) };
      }
      // PageUp/PageDown scroll the body (up and down move between hunks); the card keeps the cursor's hunk in view.
      if (data === KEY_PAGE_UP || data === KEY_PAGE_DOWN) {
        render();
        return { handled: true, pendingPermission: { ...req, scroll: Math.max(0, (req.scroll ?? 0) + (data === KEY_PAGE_UP ? -5 : 5)) } };
      }
      // Deny on a hunk card declines this edit only, exactly as on the plain
      // card: the model gets the declined result and can adapt. Ctrl+C is the
      // one abort.
      if ((data === '\r' || data === '\n') && permissionButtons(req, req)[req.choice ?? 0]?.id === 'deny') {
        req.resolve(false, false);
        render();
        return { handled: true, pendingPermission: null };
      }
      const { state, commit } = applyHunkKey(req.hunkState, data);
      if (commit === 'apply') {
        // The broker applies `selectedHunks` by the platform's one hunk rule; the
        // same selection rides as arguments for a resolver that forwards only those.
        const answer = hunkSelectionAnswer(req, state);
        req.resolve(true, false, answer.modifiedArgs, { selectedHunks: answer.selectedHunks });
        render();
        return { handled: true, pendingPermission: null };
      }
      if (commit === 'cancel') {
        req.resolve(false, false);
        render();
        return { handled: true, pendingPermission: null };
      }
      render();
      return { handled: true, pendingPermission: { ...req, hunkState: state } };
    }

    // Typed-reply mode: deny-with-reason (started by typing on any card) or
    // exec-answer (an exec-prompt ask opens in this mode). Every printable
    // key is text here, nothing is a card command.
    if (req.replyMode) {
      const buffer = req.replyBuffer ?? '';
      if (data === '\r' || data === '\n') {
        if (req.replyMode === 'exec-answer') {
          // The typed answer feeds the running command's stdin via the
          // decision's modifiedArgs (platform exec-prompt wiring contract).
          req.resolve(true, false, { answer: buffer });
        } else {
          // Deny is feedback: the reason rides the structured "user declined"
          // tool result so the model can adapt, the turn is NOT aborted.
          req.resolve(false, false, undefined, { reason: buffer });
        }
        render();
        return { handled: true, pendingPermission: null };
      }
      if (data === '\x1b') {
        if (req.replyMode === 'exec-answer') {
          // Esc on an exec-prompt: clear a draft first; with nothing typed it
          // declines the prompt (the run gets the honest unanswered result).
          if (buffer.length > 0) {
            render();
            return { handled: true, pendingPermission: { ...req, replyBuffer: '' } };
          }
          req.resolve(false, false);
          render();
          return { handled: true, pendingPermission: null };
        }
        // Esc leaves deny-reason mode back to the plain card.
        render();
        return { handled: true, pendingPermission: { ...req, replyMode: undefined, replyBuffer: undefined } };
      }
      if (data === '\x7f' || data === '\b') {
        render();
        return { handled: true, pendingPermission: { ...req, replyBuffer: buffer.slice(0, -1) } };
      }
      if (data.length >= 1 && !data.startsWith('\x1b') && data >= ' ') {
        render();
        return { handled: true, pendingPermission: { ...req, replyBuffer: buffer + data } };
      }
      render();
      return { handled: true, pendingPermission };
    }

    // The remember-tier submenu is a sub-level of the card: arrows pick a
    // tier, Enter approves and remembers at it, Esc closes just the submenu.
    if (req.submenuOpen) {
      const tiers = req.rememberOptions ?? [];
      const index = req.submenuIndex ?? 0;
      if (data === '\x1b') {
        render();
        return { handled: true, pendingPermission: { ...req, submenuOpen: false } };
      }
      if (data === KEY_UP || data === KEY_DOWN) {
        const next = tiers.length === 0 ? 0 : (index + (data === KEY_UP ? -1 : 1) + tiers.length) % tiers.length;
        render();
        return { handled: true, pendingPermission: { ...req, submenuIndex: next } };
      }
      if (data === '\r' || data === '\n') {
        const option = tiers[index];
        if (option) {
          req.resolve(true, option.tier === 'session', undefined, { rememberTier: option.tier });
          render();
          return { handled: true, pendingPermission: null };
        }
      }
    }

    // Button choice and the body scroll are card keys.
    if (data === KEY_LEFT || data === KEY_RIGHT || data === '\t') {
      render();
      return { handled: true, pendingPermission: withChoice(req, data === KEY_LEFT ? -1 : 1) };
    }
    if (data === KEY_UP || data === KEY_DOWN || data === KEY_PAGE_UP || data === KEY_PAGE_DOWN) {
      const step = data === KEY_UP ? -1 : data === KEY_DOWN ? 1 : data === KEY_PAGE_UP ? -5 : 5;
      render();
      return { handled: true, pendingPermission: { ...req, scroll: Math.max(0, (req.scroll ?? 0) + step) } };
    }
    if (data === '\r' || data === '\n') {
      const pressed = permissionButtons(req, req)[req.choice ?? 0];
      if (pressed?.id === 'allow') {
        req.resolve(true, false);
        render();
        return { handled: true, pendingPermission: null };
      }
      if (pressed?.id === 'session') {
        req.resolve(true, true, undefined, { rememberTier: 'session' });
        render();
        return { handled: true, pendingPermission: null };
      }
      if (pressed?.id === 'remember') {
        render();
        return { handled: true, pendingPermission: { ...req, submenuOpen: true, submenuIndex: req.submenuIndex ?? 0 } };
      }
      if (pressed?.id === 'deny') {
        req.resolve(false, false);
        render();
        return { handled: true, pendingPermission: null };
      }
    }

    // Mouse, view-navigation and other escape sequences, plus a bare Esc,
    // are not card answers. Pass them through to the normal input
    // handler so the transcript stays scrollable and Esc only drops focus. The
    // request stays pending (answer it with y/n or a remember tier when ready);
    // Ctrl+C above is still the hard abort, and 'n' still denies.
    if (data.startsWith('\x1b')) {
      return { handled: false, pendingPermission };
    }

    // Text that arrives as one burst (typed fast, or pasted) is a reason being
    // typed, never a key: it starts deny-with-reason with all of it, so
    // nothing typed is lost and no burst can answer the card by itself.
    if (data.length > 1 && /^[^\x00-\x1f\x7f]+$/.test(data)) {
      render();
      return { handled: true, pendingPermission: { ...req, replyMode: 'deny-reason', replyBuffer: data } };
    }

    const key = data.toLowerCase().trim();
    if (
      handleSimplePermissionInput(data, {
        escapeDenies: false,
        abortOnDeny: false,
        resolve: (approved) => req.resolve(approved, false),
        abort: abortTurn,
        render,
      })
    )
      return { handled: true, pendingPermission: null };

    // Remembering is never one bare key: `a` chooses the "for session" button
    // and a digit opens that remember tier ([1]..[N], most specific first) in
    // the submenu; Enter then confirms. A generalizing tier writes a durable
    // user-origin rule; 'session' only caches in memory.
    if (key === 'a') {
      render();
      // An ask whose answer is not remembered offers no remembering: `a` chooses Allow once.
      if (offersNoRemembering(req)) return { handled: true, pendingPermission: { ...req, choice: 0 } };
      const sessionTier = req.rememberOptions?.findIndex((option) => option.tier === 'session') ?? -1;
      if (sessionTier >= 0) return { handled: true, pendingPermission: { ...req, submenuOpen: true, submenuIndex: sessionTier } };
      const session = permissionButtons(req, req).findIndex((button) => button.id === 'session' || button.id === 'remember');
      return { handled: true, pendingPermission: session >= 0 ? { ...req, choice: session } : req };
    }
    if (/^[1-9]$/.test(key) && !offersNoRemembering(req) && req.rememberOptions && req.rememberOptions.length > 0) {
      const index = Number(key) - 1;
      render();
      return {
        handled: true,
        pendingPermission: index < req.rememberOptions.length ? { ...req, submenuOpen: true, submenuIndex: index } : req,
      };
    }

    if (key === 'd') {
      // Toggle the condensed↔full detail view without resolving the request.
      render();
      return {
        handled: true,
        pendingPermission: { ...req, detailsExpanded: !req.detailsExpanded },
      };
    }

    // Any other printable key starts deny-with-reason: what the user types
    // becomes the denial feedback, seeded with this first character.
    if (data.length === 1 && data >= ' ') {
      render();
      return { handled: true, pendingPermission: { ...req, replyMode: 'deny-reason', replyBuffer: data } };
    }

    render();
    return { handled: true, pendingPermission };
  }

  return { handled: false, pendingPermission };
}
