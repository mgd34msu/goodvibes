import { type Line, type Cell, createStyledCell } from '@goodvibes/engine/platform/platform/types';
import { UIFactory } from './ui-factory.ts';
import { expandTabs, getDisplayWidth } from '../utils/terminal-width.ts';
import { activeTokens } from './theme.ts';
import { diffRowTints } from './diff-tint.ts';

/** Columns between the diff's fill edges and its text. */
const DIFF_PAD = 2;
/** Width of the line-number label after the gutter character. */
const LINE_LABEL_WIDTH = 5;

/**
 * renderDiffView - Render a unified diff string as styled Line[].
 * Colours come from the active theme's diff tokens (diffAdded/diffRemoved/
 * diffHunkHeader, the matching backgrounds and the line-number tokens); the
 * row tints are kept visibly apart from the diff's own fill (diff-tint.ts).
 * A line wider than the block continues on the rows below it, so nothing is
 * cut at the right edge. A hunk header without positions (`@@ path @@`) marks
 * a hunk whose line numbers are not known, and its rows carry none.
 */
export function renderDiffView(diffText: string, width: number, filename?: string): Line[] {
  const lines: Line[] = [];
  const p = activeTokens();
  const BG = p.diffContextBg;
  const tints = diffRowTints(BG);

  // Filename header
  if (filename) {
    const header = `  ≡ ${filename} `;
    lines.push(UIFactory.stringToLine(header.padEnd(width), width, { fg: p.selectedListItemText, bg: p.diffHunkHeader, bold: true }));
  }

  const diffLines = diffText.split('\n');
  let oldLineNo = 0;
  let newLineNo = 0;
  let numbered = true;
  const label = (n: number): string => (numbered ? `${String(n).padStart(LINE_LABEL_WIDTH - 1)} ` : ' ');
  // The diff is one filled block: an empty row above and below, and text two
  // columns in from both edges (the Measurements padding rule).
  lines.push(makeFilledLine(width, BG));

  for (const raw of diffLines) {
    if (raw === '') {
      lines.push(makeFilledLine(width, BG));
      continue;
    }

    // Hunk header: @@ -old,count +new,count @@
    if (raw.startsWith('@@')) {
      const hunkMatch = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      numbered = hunkMatch !== null;
      if (hunkMatch) {
        oldLineNo = parseInt(hunkMatch[1]!, 10) - 1;
        newLineNo = parseInt(hunkMatch[2]!, 10) - 1;
      }
      lines.push(...makeStyledLines(raw, width, p.diffHunkHeader, BG, false));
      continue;
    }

    // File headers: --- and +++
    if (raw.startsWith('--- ') || raw.startsWith('+++ ')) {
      lines.push(...makeStyledLines(raw, width, p.textMuted, BG, false));
      continue;
    }

    // Added line
    if (raw.startsWith('+')) {
      newLineNo++;
      lines.push(...makeGutterLines('+', label(newLineNo), raw.slice(1), width, p.diffAdded, tints.addedRow, tints.addedGutter));
      continue;
    }

    // Removed line
    if (raw.startsWith('-')) {
      oldLineNo++;
      lines.push(...makeGutterLines('-', label(oldLineNo), raw.slice(1), width, p.diffRemoved, tints.removedRow, tints.removedGutter));
      continue;
    }

    // Context line
    if (raw.startsWith(' ') || (!raw.startsWith('\\') && raw.length > 0)) {
      oldLineNo++;
      newLineNo++;
      const content = raw.startsWith(' ') ? raw.slice(1) : raw;
      lines.push(...makeGutterLines(' ', label(oldLineNo), content, width, p.diffContext, BG, BG));
    }
  }

  lines.push(makeFilledLine(width, BG));
  return lines;
}

/**
 * Cut `text` into pieces no wider than `room` display columns. Control
 * characters are dropped and tabs expanded, so the drawn width is the
 * measured width.
 */
function wrapToWidth(text: string, room: number): string[] {
  const clean = expandTabs(text).replace(/[\u0000-\u001f\u007f]/g, '');
  if (room <= 0) return [''];
  const pieces: string[] = [];
  let piece = '';
  let used = 0;
  for (const ch of clean) {
    const cw = Math.max(1, getDisplayWidth(ch));
    if (used + cw > room && piece !== '') {
      pieces.push(piece);
      piece = '';
      used = 0;
    }
    piece += ch;
    used += cw;
  }
  pieces.push(piece);
  return pieces;
}

/** Draw `text` on `line` from column `x` up to (not including) `end`. */
function drawText(line: Line, x: number, end: number, text: string, style: { fg: string; bg: string; bold?: boolean }): void {
  let cx = x;
  for (const ch of text) {
    const cw = Math.max(1, getDisplayWidth(ch));
    if (cx + cw > end) break;
    line[cx] = createStyledCell(ch, style);
    if (cw === 2) line[cx + 1] = { ...line[cx]!, char: '' };
    cx += cw;
  }
}

/**
 * A diff line with its gutter indicator and line number, wrapped onto as many
 * rows as its content needs. Continuation rows keep the row tint and leave the
 * gutter and number blank.
 */
function makeGutterLines(
  gutter: string,
  lineLabel: string,
  content: string,
  width: number,
  fg: string,
  bg: string,
  lineNumBg: string,
): Line[] {
  const end = width - DIFF_PAD;
  const textX = DIFF_PAD + 1 + lineLabel.length;
  return wrapToWidth(content, end - textX).map((piece, index) => {
    const line = makeFilledLine(width, bg);
    if (index === 0) {
      if (DIFF_PAD < width) line[DIFF_PAD] = createStyledCell(gutter, { fg, bg, bold: gutter !== ' ' });
      drawText(line, DIFF_PAD + 1, Math.min(width, textX), lineLabel, { fg: activeTokens().diffLineNumber, bg: lineNumBg });
    } else {
      drawText(line, DIFF_PAD + 1, Math.min(width, textX), ' '.repeat(lineLabel.length), { fg: activeTokens().diffLineNumber, bg: lineNumBg });
    }
    drawText(line, textX, end, piece, { fg, bg });
    return line;
  });
}

/** A plain styled line (hunk or file header), wrapped onto as many rows as it needs. */
function makeStyledLines(text: string, width: number, fg: string, bg: string, bold: boolean): Line[] {
  const end = width - DIFF_PAD;
  return wrapToWidth(text, end - DIFF_PAD).map((piece) => {
    const line = makeFilledLine(width, bg);
    drawText(line, DIFF_PAD, end, piece, { fg, bg, bold });
    return line;
  });
}

/** Create a line filled with bg color. */
function makeFilledLine(width: number, bg: string): Cell[] {
  return Array.from({ length: width }, () => createStyledCell(' ', { bg }));
}
