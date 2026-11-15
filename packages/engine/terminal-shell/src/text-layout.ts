/**
 * text-layout.ts, column-arithmetic helpers for laying text out in a
 * fixed-width terminal.
 *
 * Both helpers measure in DISPLAY cells, not code units: the platform's
 * `getDisplayWidth` accounts for wide (CJK/emoji) glyphs and zero-width
 * sequences, so a line that fits by `.length` can still overflow the column
 * budget. Everything here goes through it.
 */
import { getDisplayWidth, truncateDisplay, wrapText } from '@goodvibes-jev/engine/platform/platform/utils';

/**
 * Wrap `text` to `width` display columns, prefixing every line after the first
 * with `indent` (a hanging indent). Continuation lines are wrapped to the
 * width that remains after the indent, so an indented line never exceeds the
 * same budget as the first and no text is dropped.
 *
 * `width` floors at 1: a zero or negative budget would make the continuation
 * width negative.
 *
 * @param maxLines - When set, keep at most this many lines (no ellipsis is
 *   appended, the caller decides how to signal the elision).
 */
export function wrapWithHangingIndent(
  text: string,
  width: number,
  indent: string,
  maxLines?: number,
): string[] {
  const safeWidth = Math.max(1, width);
  const indentWidth = getDisplayWidth(indent);
  const contWidth = Math.max(1, safeWidth - indentWidth);
  // The first line is wrapped at the full width; everything after it is
  // re-wrapped at the narrower continuation width so no word is cut off.
  // wrapText drops leading spaces, so slice the remainder from the same
  // space-trimmed text or the first line's length would be off.
  const body = text.replace(/^ +/, '');
  const first = wrapText(body, safeWidth)[0] ?? '';
  const rest = body.slice(first.length).replace(/^[ \n]/, '');
  const lines = [truncateDisplay(first, safeWidth)];
  if (rest.length > 0) {
    for (const line of wrapText(rest, contWidth)) {
      lines.push(`${indent}${truncateDisplay(line, contWidth)}`);
    }
  }
  return typeof maxLines === 'number' ? lines.slice(0, maxLines) : lines;
}

/**
 * Split a total column budget into a label column and a detail column with a
 * two-column gutter between them.
 *
 * The label column is clamped to at least 10 columns (below that a label is
 * unreadable) and at most `totalWidth - 2` (the gutter must survive; the cap
 * wins when the width is under 12), which
 * means the detail column can legitimately collapse to 0 on a very narrow
 * terminal, callers should treat a 0 detail width as "omit the detail".
 */
export function fitLabelDetailColumns(
  label: string,
  detail: string,
  totalWidth: number,
  labelRatio = 0.55,
): { labelWidth: number; detailWidth: number } {
  const safeWidth = Math.max(8, totalWidth);
  // The gutter outranks the ten-column floor on a terminal too narrow for both.
  const labelWidth = Math.max(Math.min(10, safeWidth - 2), Math.min(safeWidth - 2, Math.floor(safeWidth * labelRatio)));
  return {
    labelWidth,
    detailWidth: Math.max(0, safeWidth - labelWidth - 2),
  };
}
