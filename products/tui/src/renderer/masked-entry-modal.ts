/**
 * renderMaskedEntryModal, the local-auth password prompt.
 *
 *   ✦ Rotate password  alice                                           esc
 *
 *   The password is typed here and never shown, stored in history, or
 *   written to the transcript.
 *
 *   Password   ●●●●●●●●
 *   Confirm    ●●●●●●●●▏
 *
 *   ⏎ save   esc back
 *
 * The password rows show one dot per character; the characters themselves
 * never reach a cell. The password is typed twice and applied only when both
 * entries match. Adding a user first asks for the username (plain text,
 * usernames are not secret) when none was given.
 */

import { activeTokens } from './theme.ts';
import { beginModal, finishModal, clipText, type KitHint, type SurfaceLayer } from './surface-kit.ts';
import { drawTextBlock, modalHeightFor, modalTextWidth, textBlockHeight } from './surface-kit-extra.ts';

/** What the renderer reads from the modal (never the password itself). */
export interface MaskedEntryView {
  readonly kind: 'add-user' | 'rotate-password';
  /** The username (typed or given). */
  readonly username: string;
  /** Which field is being typed. */
  readonly step: 'username' | 'password' | 'confirm';
  /** Characters typed into the password field (only the count is drawn). */
  readonly passwordLength: number;
  /** Characters typed into the confirmation field (only the count is drawn). */
  readonly confirmLength: number;
  /** An error from the last attempt, or null. */
  readonly error: string | null;
}

const MODAL_WIDTH = 72;

function intro(view: MaskedEntryView): string {
  if (view.step === 'username') return 'Type the username for the new local user, then its password on the next step.';
  if (view.step === 'confirm') return 'Type the same password again to confirm it. Nothing is saved until both entries match.';
  return 'The password is typed here and never shown, kept in history, or written to the transcript.';
}

export function renderMaskedEntryModal(view: MaskedEntryView, screenWidth: number, screenHeight: number): SurfaceLayer {
  const t = activeTokens();
  const hints: KitHint[] = [['⏎', view.step === 'confirm' ? 'save' : 'next'], ['esc', view.step === 'confirm' ? 'back' : 'cancel']];
  const width = modalTextWidth(screenWidth, screenHeight, MODAL_WIDTH);
  const introRows = textBlockHeight([{ text: intro(view) }], width);
  const errorRows = view.error ? textBlockHeight([{ text: view.error }], width) + 1 : 0;
  const fieldRows = view.kind === 'add-user' ? 3 : 2;
  const height = modalHeightFor(screenWidth, screenHeight, { width: MODAL_WIDTH, hints }, introRows + 1 + fieldRows + errorRows);
  const f = beginModal(screenWidth, screenHeight, {
    title: view.kind === 'add-user' ? 'Add local user' : 'Rotate password',
    sub: view.step === 'username' ? undefined : view.username,
    width: MODAL_WIDTH,
    height,
    center: true,
    cap: 'warning',
    hints,
  });
  let y = drawTextBlock(f.canvas, f.l, f.top, width, [{ text: intro(view), style: { fg: t.textMuted } }], f.bottom) + 1;
  const labelW = 11;
  const valueX = f.l + labelW;
  const room = Math.max(1, f.r - valueX);
  if (view.kind === 'add-user' && y <= f.bottom) {
    f.canvas.put(f.l, y, 'Username', { fg: t.textMuted });
    const end = f.canvas.put(valueX, y, clipText(view.username, room), { fg: t.text });
    if (view.step === 'username') f.canvas.put(end, y, '▏', { fg: t.brand });
    y++;
  }
  if (view.step !== 'username' && y <= f.bottom) {
    f.canvas.put(f.l, y, 'Password', { fg: t.textMuted });
    const end = f.canvas.put(valueX, y, '●'.repeat(Math.min(view.passwordLength, room)), { fg: t.text });
    if (view.step === 'password') f.canvas.put(end, y, '▏', { fg: t.brand });
    y++;
  }
  if (view.step === 'confirm' && y <= f.bottom) {
    f.canvas.put(f.l, y, 'Confirm', { fg: t.textMuted });
    const end = f.canvas.put(valueX, y, '●'.repeat(Math.min(view.confirmLength, room)), { fg: t.text });
    f.canvas.put(end, y, '▏', { fg: t.brand });
    y++;
  }
  if (view.error) drawTextBlock(f.canvas, f.l, y + 1, width, [{ text: view.error, style: { fg: t.error } }], f.bottom);
  return finishModal(f);
}
