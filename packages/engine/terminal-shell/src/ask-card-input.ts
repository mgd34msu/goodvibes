/**
 * ask-card-input.ts, the keys of the approval card in both terminal programs
 * (design ux.md 3.1, A2.1): one scheme.
 *
 *   y        yes, once
 *   a        "Yes, and don't ask again…": opens the remember choices
 *            (offered only when the ask can be remembered)
 *   n        no
 *   d        details
 *   ←→ tab   choose a button; ⏎ presses it
 *   ↑↓       scroll; inside the remember choices, move (1-9 pick one)
 *   typing   starts "why not", the reason sent with the refusal
 *
 * Enter presses the selected button, which opens on `Yes, once`, or on `No`
 * for what cannot be undone (renderer/ask-card.ts askCardDefaultChoice), so
 * Enter never allows that and never remembers anything. A command waiting on
 * its terminal takes every printable key as its answer. Ctrl+C and the typing
 * rule (a sentence being typed when the card appeared keeps going to the
 * composer) are the products' blocking-input, before this.
 */
import type { PermissionPromptRequest, RememberTier } from '@goodvibes/engine/platform/platform/permissions';
import { applyHunkKey, hunkSelectionAnswer } from './hunk-selection.js';
import { askPresentationFor } from './permission-prompt-facts.js';
import { askCardButtons, askCardChoice, isCommandPromptAsk, type AskCardState } from './renderer/ask-card.js';

/** What a card's answer carries beyond yes or no. */
export interface AskCardResolveExtras {
  readonly rememberTier?: RememberTier | undefined;
  readonly reason?: string | undefined;
  readonly selectedHunks?: readonly number[] | undefined;
}

/** A pending card as both programs hold it: the request, the card's state and its answer. */
export type AskCardPending = PermissionPromptRequest & AskCardState & {
  readonly resolve: (approved: boolean, remember?: boolean, modifiedArgs?: Record<string, unknown>, extras?: AskCardResolveExtras) => void;
};

export interface AskCardKeyResult<T> {
  /** False: not a card key (a mouse report, a bare Esc); the product passes it on. */
  readonly handled: boolean;
  /** The card after the key, or null once it was answered. */
  readonly pending: T | null;
}

const KEY_LEFT = '\x1b[D';
const KEY_RIGHT = '\x1b[C';
const KEY_UP = '\x1b[A';
const KEY_DOWN = '\x1b[B';
const KEY_PAGE_UP = '\x1b[5~';
const KEY_PAGE_DOWN = '\x1b[6~';
const isEnter = (data: string): boolean => data === '\r' || data === '\n';
const isBackspace = (data: string): boolean => data === '\x7f' || data === '\b';
const isPrintable = (data: string): boolean => data.length >= 1 && !data.startsWith('\x1b') && /^[^\x00-\x1f\x7f]+$/.test(data);

/** One key on an open card. */
export function handleAskCardKey<T extends AskCardPending>(req: T, data: string): AskCardKeyResult<T> {
  const keep = (next: T): AskCardKeyResult<T> => ({ handled: true, pending: next });
  const answered = (approved: boolean, remember = false, modifiedArgs?: Record<string, unknown>, extras?: AskCardResolveExtras): AskCardKeyResult<T> => {
    req.resolve(approved, remember, modifiedArgs, extras);
    return { handled: true, pending: null };
  };

  // A command waiting on its terminal: every printable key is its answer, masked on the card.
  if (isCommandPromptAsk(req)) {
    const buffer = req.replyBuffer ?? '';
    if (isEnter(data)) return answered(true, false, { answer: buffer });
    if (data === '\x1b') return buffer.length > 0 ? keep({ ...req, replyBuffer: '' }) : answered(false);
    if (isBackspace(data)) return keep({ ...req, replyBuffer: [...buffer].slice(0, -1).join('') });
    if (isPrintable(data)) return keep({ ...req, replyBuffer: buffer + data });
    return keep(req);
  }

  // "Why not": every printable key is the reason; Enter refuses with it, Esc goes back.
  if (req.replyMode === 'deny-reason') {
    const buffer = req.replyBuffer ?? '';
    if (isEnter(data)) return answered(false, false, undefined, buffer.trim() ? { reason: buffer } : undefined);
    if (data === '\x1b') return keep({ ...req, replyMode: undefined, replyBuffer: undefined });
    if (isBackspace(data)) return keep({ ...req, replyBuffer: [...buffer].slice(0, -1).join('') });
    if (isPrintable(data)) return keep({ ...req, replyBuffer: buffer + data });
    return keep(req);
  }

  const presentation = askPresentationFor(req);
  const buttons = askCardButtons(presentation, req);
  const chosen = askCardChoice(presentation, req, req);
  const remember = presentation.remember;

  // The remember choices: a sub-level of the card.
  if (req.submenuOpen && remember.offered) {
    const tiers = remember.tiers;
    const index = Math.max(0, Math.min(req.submenuIndex ?? 0, tiers.length - 1));
    if (data === '\x1b') return keep({ ...req, submenuOpen: false });
    if (data === KEY_UP || data === KEY_DOWN) {
      const next = (index + (data === KEY_UP ? -1 : 1) + tiers.length) % tiers.length;
      return keep({ ...req, submenuIndex: next });
    }
    if (/^[1-9]$/.test(data) && Number(data) <= tiers.length) return keep({ ...req, submenuIndex: Number(data) - 1 });
    if (isEnter(data)) {
      const tier = tiers[index];
      if (tier) return answered(true, tier.tier === 'session', undefined, { rememberTier: tier.tier });
    }
    if (data.startsWith('\x1b')) return { handled: false, pending: req };
    return keep(req);
  }

  const openRemember = (): AskCardKeyResult<T> => keep({ ...req, submenuOpen: true, submenuIndex: 0, choice: buttons.findIndex((b) => b.id === 'remember') });
  const press = (id: string | undefined): AskCardKeyResult<T> | null => {
    switch (id) {
      case 'once':
      case 'acknowledge':
        return answered(true);
      case 'apply-selected': {
        if (!req.hunkState) return answered(true);
        // Nothing selected: the card stays open rather than applying an empty edit.
        if (req.hunkState.selected.size === 0) return keep(req);
        const answer = hunkSelectionAnswer(req, req.hunkState);
        // Every change kept is the request as asked; fewer ride as the broker's selection.
        return answer.selectedHunks.length === req.hunkState.hunks.length
          ? answered(true)
          : answered(true, false, answer.modifiedArgs, { selectedHunks: answer.selectedHunks });
      }
      case 'remember':
        return remember.offered ? openRemember() : null;
      case 'no':
      case 'object':
        return answered(false);
      default:
        return null;
    }
  };

  if (data === KEY_LEFT || data === KEY_RIGHT || data === '\t') {
    if (buttons.length === 0) return keep(req);
    return keep({ ...req, choice: (chosen + (data === KEY_LEFT ? -1 : 1) + buttons.length) % buttons.length });
  }
  if (isEnter(data)) return press(buttons[chosen]?.id) ?? keep(req);
  if (data === KEY_PAGE_UP || data === KEY_PAGE_DOWN || (!req.hunkState && (data === KEY_UP || data === KEY_DOWN))) {
    const step = data === KEY_UP ? -1 : data === KEY_DOWN ? 1 : data === KEY_PAGE_UP ? -5 : 5;
    return keep({ ...req, scroll: Math.max(0, (req.scroll ?? 0) + step) });
  }
  const key = data.length === 1 ? data.toLowerCase() : '';
  if (key === 'd') return keep({ ...req, detailsExpanded: !req.detailsExpanded });

  // A multi-edit edit: arrows and j/k move between changes, space keeps or leaves one out.
  if (req.hunkState) {
    if (key === 'y') return press(buttons.find((b) => b.id === 'apply-selected' || b.id === 'once')?.id) ?? keep(req);
    if (key === 'n') return answered(false);
    if (key === 'a' && remember.offered) return openRemember();
    const { state, commit } = applyHunkKey(req.hunkState, data);
    if (commit === 'cancel') return answered(false);
    if (commit === null && state !== req.hunkState) return keep({ ...req, hunkState: state });
    if (data.startsWith('\x1b')) return { handled: false, pending: req };
    return keep(req);
  }

  // Mouse, navigation and other escape sequences, and a bare Esc, are not answers.
  if (data.startsWith('\x1b')) return { handled: false, pending: req };

  // Text that arrives as one burst (typed fast, or pasted) is a reason being typed, never a key.
  if (data.length > 1 && isPrintable(data)) {
    return presentation.typeToRefuse ? keep({ ...req, replyMode: 'deny-reason', replyBuffer: data }) : keep(req);
  }
  if (key === 'y') return answered(true);
  if (key === 'n') return answered(false);
  if (key === 'a' && remember.offered) return openRemember();
  // Any other printable key starts "why not", seeded with it.
  if (isPrintable(data) && presentation.typeToRefuse) return keep({ ...req, replyMode: 'deny-reason', replyBuffer: data });
  return keep(req);
}
