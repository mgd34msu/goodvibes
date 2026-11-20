/**
 * user-message.ts, a user message in the transcript.
 *
 *   col 2        ┃ in the bar color on every row, padding rows included
 *   cols 3..w-3  the surface fill, full width
 *   rows         one padding row, the text, one padding row
 *   text         from column 5, wrapped to width-9
 *
 * The composer is drawn the same way (composer.ts), so what you typed and
 * what you sent look alike.
 */

import { createEmptyLine } from '@goodvibes/engine/platform/platform/types/grid';
import type { Line } from '@goodvibes/engine/platform/platform/types';
import { getDisplayWidth, wrapTextRows } from '@goodvibes/engine/platform/platform/utils/terminal-width';

const USER_MESSAGE_BAR_X = 2;
const USER_MESSAGE_FILL_X = 3;
const USER_MESSAGE_TEXT_X = 5;

export interface UserMessageStyle {
  readonly bar: string;
  readonly bg: string;
  readonly text: string;
  readonly strikethrough?: (boolean) | undefined;
}

// Everything left of the text column (margin, bar, fill) is chrome: a copy holds the message only.
function row(width: number, style: UserMessageStyle, join?: string | undefined): Line {
  const line = createEmptyLine(width);
  for (const cell of line) cell.bg = '';
  if (width > USER_MESSAGE_BAR_X) {
    line[USER_MESSAGE_BAR_X] = { char: '┃', fg: style.bar, bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false };
  }
  for (let x = USER_MESSAGE_FILL_X; x <= width - 3; x++) {
    line[x] = { char: ' ', fg: style.text, bg: style.bg, bold: false, dim: false, underline: false, italic: false, strikethrough: false };
  }
  for (let x = 0; x < USER_MESSAGE_TEXT_X && x < width; x++) line[x] = { ...line[x]!, chrome: true };
  if (join !== undefined && width > 0) line[0] = { ...line[0]!, wrapJoin: join };
  return line;
}

/** A padding row above or below the text: all decoration. */
function paddingRow(width: number, style: UserMessageStyle): Line {
  return row(width, style).map((cell) => ({ ...cell, chrome: true }));
}

export function renderUserMessage(text: string, width: number, style: UserMessageStyle): Line[] {
  const textWidth = Math.max(1, width - 9);
  const wrapped = wrapTextRows(text, textWidth);
  const lines: Line[] = [paddingRow(width, style)];
  for (const { text: content, join } of wrapped.length > 0 ? wrapped : [{ text: '' }]) {
    const line = row(width, style, join);
    let x = USER_MESSAGE_TEXT_X;
    for (const ch of content) {
      const w = getDisplayWidth(ch);
      if (w <= 0) continue;
      if (x + w > width - 4) break;
      line[x] = { char: ch, fg: style.text, bg: style.bg, bold: false, dim: false, underline: false, italic: false, strikethrough: style.strikethrough ?? false };
      if (w === 2) line[x + 1] = { ...line[x]!, char: '' };
      x += w;
    }
    lines.push(line);
  }
  lines.push(paddingRow(width, style));
  return lines;
}
