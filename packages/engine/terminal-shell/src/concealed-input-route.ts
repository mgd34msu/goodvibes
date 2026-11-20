/**
 * concealed-input-route.ts, the composer's whole input route while a concealed
 * value (a password, a card number, a secret) is being typed.
 *
 * The typed text is held here, in its own state keyed by the request that
 * asked for it, never in the composer's prompt: the prompt holds a bullet per
 * character, so the cursor and the wrapping stay right and nothing that reads
 * the prompt (undo, the kill ring, history search, a copied block, a saved
 * draft) can see the value. While the request is open this route takes every
 * key and text token before any shortcut, so undo, redo, the kill ring,
 * history search, the command line and the other editor shortcuts are not
 * offered: only typing, a terminal paste, the clipboard paste key, cursor
 * movement, deletion, Enter (deliver) and Escape or Ctrl+C (cancel). The value
 * leaves only through the request's own `onSubmit`, once.
 *
 * Cost: none outside a concealed prompt; within one, a string splice per key.
 */
import type { InputToken } from '@goodvibes-jev/engine/platform/platform/core';
import type { ConcealedInputRequest } from './concealed-input.js';

type KeyToken = InputToken & { type: 'key' };

/** What the route reads and edits on the composer that owns the request. */
export interface ConcealedRouteContext {
  prompt: string;
  cursorPos: number;
  /** The open concealed request, or null. */
  readonly concealedRequest?: (() => ConcealedInputRequest | null) | undefined;
  /** Delivers the value to the request (`submitConcealedInputFor`). */
  readonly submitConcealedInput?: ((value: string) => boolean) | undefined;
  /** Cancels the open request. */
  readonly handleEscape: () => void;
  /** The clipboard's text, for the paste key; null when it holds none. */
  readonly readClipboardText?: (() => string | null) | undefined;
  readonly keybindingsManager: {
    matches(action: 'clear-cancel', token: KeyToken): boolean;
    lookup?(token: KeyToken): string | null | undefined;
  };
  requestRender(): void;
}

/** The value typed so far for each open request; dropped with the request. */
const typed = new WeakMap<ConcealedInputRequest, { text: string }>();

const BULLET = '•';

/** Show `text` as bullets in the prompt, the cursor at `cursor`. */
function show(context: Pick<ConcealedRouteContext, 'prompt' | 'cursorPos' | 'requestRender'>, text: string, cursor: number): void {
  context.prompt = BULLET.repeat(text.length);
  context.cursorPos = Math.max(0, Math.min(cursor, text.length));
  context.requestRender();
}

/**
 * Put clipboard text into an open concealed request's own state (the paste
 * key, or a paste started from elsewhere while the prompt is concealed).
 * Returns the number of characters inserted.
 */
export function pasteIntoConcealed(
  context: Pick<ConcealedRouteContext, 'prompt' | 'cursorPos' | 'requestRender'>,
  request: ConcealedInputRequest,
  text: string,
): number {
  const clean = text.replace(/\r\n?/g, '\n');
  let state = typed.get(request);
  if (!state) { state = { text: '' }; typed.set(request, state); }
  const cursor = Math.max(0, Math.min(context.cursorPos, state.text.length));
  state.text = state.text.slice(0, cursor) + clean + state.text.slice(cursor);
  show(context, state.text, cursor + clean.length);
  return clean.length;
}

/**
 * Route one token while a concealed request is open. Returns false when none
 * is open (the ordinary routes run); true when the token was taken, whether or
 * not it changed anything.
 */
export function routeConcealedToken(context: ConcealedRouteContext, token: InputToken): boolean {
  const request = context.concealedRequest?.() ?? null;
  if (!request) return false;
  let state = typed.get(request);
  if (!state) {
    state = { text: '' };
    typed.set(request, state);
    // A prompt opened over existing text starts empty, as beginConcealedInputFor leaves it.
    context.prompt = '';
    context.cursorPos = 0;
  }
  const cursor = Math.max(0, Math.min(context.cursorPos, state.text.length));
  const insert = (text: string): void => {
    state.text = state.text.slice(0, cursor) + text + state.text.slice(cursor);
    show(context, state.text, cursor + text.length);
  };
  if (token.type === 'text') {
    insert(token.value.replace(/\r\n?/g, '\n'));
    return true;
  }
  if (token.type !== 'key') return true;
  if (token.logicalName === 'escape' || context.keybindingsManager.matches('clear-cancel', token)) {
    typed.delete(request);
    context.handleEscape();
    context.requestRender();
    return true;
  }
  if (token.logicalName === 'enter' || token.logicalName === 'return') {
    const value = state.text;
    typed.delete(request);
    context.prompt = '';
    context.cursorPos = 0;
    context.submitConcealedInput?.(value);
    context.requestRender();
    return true;
  }
  if (context.keybindingsManager.lookup?.(token) === 'paste') {
    const text = context.readClipboardText?.() ?? null;
    if (text) pasteIntoConcealed(context, request, text);
    return true;
  }
  switch (token.logicalName) {
    case 'backspace':
      if (cursor > 0) {
        state.text = state.text.slice(0, cursor - 1) + state.text.slice(cursor);
        show(context, state.text, cursor - 1);
      }
      return true;
    case 'delete':
      if (cursor < state.text.length) {
        state.text = state.text.slice(0, cursor) + state.text.slice(cursor + 1);
        show(context, state.text, cursor);
      }
      return true;
    case 'left': show(context, state.text, cursor - 1); return true;
    case 'right': show(context, state.text, cursor + 1); return true;
    case 'home': show(context, state.text, 0); return true;
    case 'end': show(context, state.text, state.text.length); return true;
    default:
      // Every other key (undo, redo, the kill ring, history search, the
      // command line, block actions) is not offered while a secret is typed.
      return true;
  }
}
