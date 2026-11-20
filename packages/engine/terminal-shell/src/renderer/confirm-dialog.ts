/**
 * renderConfirmDialog, a small centered dialog on the kit surface:
 *
 *   ✦ Delete session?                                     esc
 *
 *   This removes "test" and its 3 messages from this project.
 *   It cannot be undone.
 *
 *                                        Cancel    Delete
 *
 * Content-sized and centered, over the dimmed screen. The confirming button
 * carries the dialog's tone (red for destructive actions); the safe choice is
 * on the left. The chosen button is filled, the other sits on the element fill.
 */

import type { ConfirmView } from '../confirm-dialog-types.js';
import { activeTokens } from './theme.js';
import { beginModal, finishModal, modalInnerWidth, standardModalWidth, wrapLines, type SurfaceLayer } from './surface-kit.js';
import { buttonWidth } from './surface-kit-parts.js';

/** Preferred width of a confirm dialog. */
const CONFIRM_WIDTH = 64;

export function renderConfirmDialog(dialog: ConfirmView, screenWidth: number, screenHeight: number): SurfaceLayer {
  const t = activeTokens();
  const { title, body, confirmLabel, tone } = dialog.options;
  const cancelLabel = dialog.options.cancelLabel ?? 'Cancel';
  const width = Math.min(CONFIRM_WIDTH, standardModalWidth(screenWidth));
  const lines = body.split('\n').flatMap((para) => (para.trim() === '' ? [''] : wrapLines(para, modalInnerWidth(width))));
  // Fill rows: padding, title, blank, body, blank, buttons, empty last row.
  const f = beginModal(screenWidth, screenHeight, { title, width, height: lines.length + 6, center: true });
  // Body rows run from the top to two rows above the buttons. A body taller than
  // that scrolls, and its last row says how much is still below (or above).
  const capacity = Math.max(1, f.bottom - 1 - f.top);
  const overflow = lines.length > capacity;
  const visible = overflow ? Math.max(1, capacity - 1) : lines.length;
  dialog.noteBody?.(lines.length, visible);
  const start = Math.max(0, Math.min(dialog.scroll ?? 0, lines.length - visible));
  let y = f.top;
  for (const line of lines.slice(start, start + visible)) f.canvas.put(f.l, y++, line, { fg: t.textMuted });
  if (overflow) {
    const below = lines.length - (start + visible);
    f.canvas.put(f.l, y, below > 0
      ? `↓ ${below} more line${below === 1 ? '' : 's'} (down or page down to read them)`
      : `↑ ${start} line${start === 1 ? '' : 's'} above · end shown`, { fg: t.textMuted, bold: below > 0 });
  }
  // Confirming is possible only once the whole body has been on screen.
  const ready = dialog.seenToEnd ?? !overflow;
  const toneBg = tone === 'danger' ? t.error : tone === 'warning' ? t.warning : t.brand;
  const confirmW = buttonWidth(confirmLabel);
  const cancelW = buttonWidth(cancelLabel);
  const by = f.bottom;
  // Kept inside the dialog on a narrow screen.
  const confirmX = Math.max(f.l + cancelW + 2, f.r - confirmW + 1);
  const cancelX = Math.max(f.l, confirmX - 2 - cancelW);
  f.canvas.put(cancelX, by, ` ${cancelLabel} `, dialog.chosen === 0
    ? { fg: t.selectedListItemText, bg: t.textMuted, bold: true }
    : { fg: t.textMuted, bg: t.border });
  f.canvas.put(confirmX, by, ` ${confirmLabel} `, !ready
    ? { fg: t.textMuted, bg: t.border }
    : dialog.chosen === 1
      ? { fg: t.selectedListItemText, bg: toneBg, bold: true }
      : { fg: toneBg, bg: t.border, bold: true });
  f.canvas.hitTargets.push({ id: 'cancel', x: cancelX, y: by, width: cancelW, height: 1, keys: ['n'] });
  if (ready) f.canvas.hitTargets.push({ id: 'confirm', x: confirmX, y: by, width: confirmW, height: 1, keys: ['y'] });
  return finishModal(f);
}
