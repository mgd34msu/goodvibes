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
  const { title, body, tone } = dialog.options;
  const cancelLabel = dialog.options.cancelLabel ?? 'Cancel';
  const width = Math.min(CONFIRM_WIDTH, standardModalWidth(screenWidth));
  // The confirming button is a short phrase that fits beside Cancel: a longer one keeps its first whole words (its
  // verb), never a phrase cut in the middle of a word.
  const room = modalInnerWidth(width) - buttonWidth(cancelLabel) - 2;
  let confirmLabel = dialog.options.confirmLabel;
  while (buttonWidth(confirmLabel) > room && confirmLabel.includes(' ')) confirmLabel = confirmLabel.slice(0, confirmLabel.lastIndexOf(' ')).replace(/[:;,.]+$/, '');
  const lines = body.split('\n').flatMap((para) => (para.trim() === '' ? [''] : wrapLines(para, modalInnerWidth(width))));
  // A field to type in the same ask: a blank, its help line, the value, and what is wrong with it while it is.
  const field = dialog.options.field;
  const value = dialog.fieldValue ?? '';
  const problem = field && value !== '' ? field.check(value) : null;
  const fieldLines = field ? ['', ...wrapLines(field.help, modalInnerWidth(width)), `${field.label}: ${value}▏`, problem ?? ''] : [];
  // Fill rows: padding, title, blank, body, [field], blank, buttons, empty last row.
  const f = beginModal(screenWidth, screenHeight, { title, width, height: lines.length + fieldLines.length + 6, center: true });
  // Body rows run from the top to two rows above the buttons. A body taller than
  // that scrolls, and its last row says how much is still below (or above).
  const capacity = Math.max(1, f.bottom - 1 - f.top - fieldLines.length);
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
    y++;
  }
  if (field) {
    const helpCount = fieldLines.length - 3;
    fieldLines.forEach((line, k) => {
      if (line === '') return;
      const isValue = k === helpCount + 1;
      const isProblem = k === helpCount + 2;
      f.canvas.put(f.l, y + k, line, isValue ? { fg: t.text, bold: true } : isProblem ? { fg: t.warning } : { fg: t.textMuted });
    });
  }
  // Confirming is possible only once the whole body has been on screen, and a field holds a good value.
  const ready = (dialog.seenToEnd ?? !overflow) && (!field || field.check(value) === null);
  const toneBg = tone === 'danger' ? t.error : tone === 'warning' ? t.warning : t.brand;
  const confirmW = buttonWidth(confirmLabel);
  const cancelW = buttonWidth(cancelLabel);
  const by = f.bottom;
  // Kept inside the dialog on a narrow screen.
  const confirmX = Math.max(f.l + cancelW + 2, f.r - confirmW + 1);
  const cancelX = Math.max(f.l, confirmX - 2 - cancelW);
  f.canvas.put(cancelX, by, ` ${cancelLabel} `, dialog.chosen === 0
    ? { fg: t.selectedListItemText, bg: t.textMuted, bold: true }
    : { fg: t.text, bg: t.border });
  // An unchosen button is text on the border colour (the one pair every theme
  // keeps at 4.5:1); a button that cannot be pressed yet has no fill.
  f.canvas.put(confirmX, by, ` ${confirmLabel} `, !ready
    ? { fg: t.textMuted }
    : dialog.chosen === 1
      ? { fg: t.selectedListItemText, bg: toneBg, bold: true }
      : { fg: t.text, bg: t.border, bold: true });
  f.canvas.hitTargets.push({ id: 'cancel', x: cancelX, y: by, width: cancelW, height: 1, keys: ['n'] });
  if (ready) f.canvas.hitTargets.push({ id: 'confirm', x: confirmX, y: by, width: confirmW, height: 1, keys: ['y'] });
  return finishModal(f);
}
