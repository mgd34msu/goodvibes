/**
 * The failure row of a turn in the transcript, drawn from its reading
 * (platform core/turn-failure.ts), the same in both terminal programs:
 *
 *   ✕ The model didn't answer.
 *     OpenAI returned an error (500) three times. Nothing was changed.
 *
 *     alt+r try again   alt+o use another model   alt+i details
 *
 *     Tip: name a backup model once and GoodVibes switches by itself:
 *     /model fallback
 *
 * The keys and the tip are drawn only on the newest failure that no prompt
 * followed; the first two rows stay. Details (alt+i) go under the cause. Every
 * row wraps to the width; nothing is cut.
 */
import type { Cell, Line } from '@goodvibes-jev/engine/platform/platform/types';
import type { TurnFailureAction, TurnFailureReading } from '@goodvibes-jev/engine/platform/platform/core';
import { createEmptyLine, createStyledCell } from '@goodvibes-jev/engine/platform/platform/types/grid';
import { getDisplayWidth } from '@goodvibes-jev/engine/platform/platform/utils/terminal-width';
import { LAYOUT } from './layout.js';
import { activeTokens } from './theme.js';

/** The terminal key of each next step; a step without one is drawn as its words (a command to run). */
export const TURN_FAILURE_KEYS: Readonly<Partial<Record<TurnFailureAction, string>>> = {
  retry: 'alt+r',
  'other-model': 'alt+o',
  'choose-model': 'alt+o',
  details: 'alt+i',
  'sign-in': 'alt+s',
};

export interface TurnFailureRowState {
  /** The newest failure, with no prompt after it: its keys and tip are live. */
  readonly keys: boolean;
  /** Its details are open (alt+i). */
  readonly details: boolean;
  /** The program has /changes, named after a turn that changed files. */
  readonly changesCommand: boolean;
}

type Style = Partial<Omit<Cell, 'char'>>;
interface Segment { readonly text: string; readonly style: Style; readonly chip?: boolean }

/** The marker's column (where a notice's ▌ sits); the row's text starts two after it. */
const MARK_COL = LAYOUT.LEFT_MARGIN - 1;
const TEXT_COL = MARK_COL + 2;

function put(line: Line, col: number, text: string, style: Style): number {
  let x = col;
  for (const ch of text) {
    const w = getDisplayWidth(ch);
    if (w <= 0) continue;
    if (x + w > line.length) break;
    line[x] = createStyledCell(ch, style);
    if (w > 1 && x + 1 < line.length) line[x + 1] = createStyledCell('', style);
    x += w;
  }
  return x;
}

/** A blank row whose margin is chrome, like every transcript row. */
function blank(width: number): Line {
  const line = createEmptyLine(width);
  for (let x = 0; x < Math.min(TEXT_COL, width); x++) line[x] = { ...line[x]!, chrome: true };
  return line;
}

/**
 * Lay segments out from TEXT_COL, breaking at spaces; a chip (a key) and the
 * words after it stay together where they fit. A word longer than the room is
 * broken across rows, never cut.
 */
function flow(segments: readonly Segment[], width: number, hang = 0): Line[] {
  const end = Math.max(TEXT_COL + 1, width - LAYOUT.RIGHT_MARGIN);
  // A continued row starts under the first row's text after `hang` columns (a detail's value under its value).
  const start = Math.min(TEXT_COL + hang, end - 1);
  const lines: Line[] = [];
  let line = blank(width);
  let x = TEXT_COL;
  let rowStart = TEXT_COL;
  const newline = (): void => { lines.push(line); line = blank(width); x = start; rowStart = start; };
  for (const segment of segments) {
    if (segment.chip) {
      const chip = ` ${segment.text} `;
      const need = getDisplayWidth(chip);
      if (x > rowStart && x + need > end) newline();
      x = put(line, x, chip, segment.style);
      continue;
    }
    // Words keep their following space; a leading space at a row start is dropped.
    const words = segment.text.split(/(?<= )/);
    for (const word of words) {
      const w = getDisplayWidth(word.trimEnd());
      if (x > rowStart && x + w > end) {
        newline();
        if (word.trim().length === 0) continue;
      }
      let rest = x === rowStart ? word.replace(/^ +/, '') : word;
      while (getDisplayWidth(rest.trimEnd()) > end - x && x === rowStart) {
        // One word wider than the row: break it.
        let cut = 0, used = 0;
        for (const ch of rest) { const cw = getDisplayWidth(ch); if (used + cw > end - x) break; used += cw; cut += ch.length; }
        put(line, x, rest.slice(0, cut), segment.style);
        rest = rest.slice(cut);
        newline();
      }
      x = put(line, x, rest, segment.style);
    }
  }
  lines.push(line);
  return lines;
}

/** The rows of one failed turn. */
export function renderTurnFailureRow(reading: TurnFailureReading, width: number, state: TurnFailureRowState): Line[] {
  const t = activeTokens();
  const dim: Style = { fg: t.textMuted };
  const faint: Style = { fg: t.textFaint };
  const command: Style = { fg: t.info };
  const lines: Line[] = [];

  // 1: ✕ The model didn't answer.
  const head = flow([{ text: reading.headline, style: { fg: t.text, bold: true } }], width);
  head[0]![MARK_COL] = createStyledCell('✕', { fg: t.error, bold: true, chrome: true });
  lines.push(...head);

  // 2: the cause and what changed, dim.
  const cause: Segment[] = [{ text: [reading.cause, reading.changed.text].filter((part) => part.length > 0).join(' '), style: dim }];
  if (state.changesCommand && reading.changed.files.length > 0) cause.push({ text: ' ', style: dim }, { text: '/changes', style: command });
  lines.push(...flow(cause, width));

  // Details, under the cause: one row each, the label dim.
  if (state.details && reading.details.length > 0) {
    const labelWidth = Math.max(...reading.details.map((row) => getDisplayWidth(row.label)));
    for (const row of reading.details) {
      lines.push(...flow([
        { text: `${row.label.padEnd(labelWidth)}  `, style: faint },
        { text: row.value.replace(/\s*\n\s*/g, ' '), style: dim },
      ], width, labelWidth + 2));
    }
  }
  if (!state.keys) return lines;

  // The next steps, each on its key.
  const steps: Segment[] = [];
  for (const [index, step] of reading.next.entries()) {
    if (index > 0) steps.push({ text: '   ', style: dim });
    const key = TURN_FAILURE_KEYS[step.action];
    if (key) {
      steps.push({ text: key, style: { fg: t.text, bg: t.border, bold: true }, chip: true });
      steps.push({ text: ` ${step.label}`, style: dim });
    } else {
      steps.push({ text: step.label, style: command });
    }
  }
  if (reading.also) steps.push({ text: `   ${reading.also}`, style: faint });
  if (steps.length > 0) {
    lines.push(blank(width));
    lines.push(...flow(steps, width));
  }

  // The tip, only while no fallback order is set.
  if (reading.tip) {
    lines.push(blank(width));
    lines.push(...flow([{ text: reading.tip.text, style: dim }], width));
    lines.push(...flow([{ text: reading.tip.command, style: command }], width));
  }
  return lines;
}
