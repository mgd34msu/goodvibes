/**
 * renderChangesModal, files, a tinted diff and review actions (replaces the
 * Git, Diff and Review views).
 *
 *   ✦ Changes  main · 2 files · +45 −1 · this session                      esc
 *
 *   ✦ files                      2     ◈ 2 semantic changes  ~ fn withRetry  + const backoff
 *     src/net/retry.ts       +3 −1
 *   ✓ test/retry.test.ts       +42     ┌ element inset ──────────────────────────────┐
 *                                         ⋯ line 9                        hunk 1 of 2
 *   ✦ recent commits                      9    try {
 *     a41c09e init                       13 -    await sleep(opts.baseDelayMs);
 *                                        13 +    if (i === opts.attempts - 1) break;
 *
 *   ] [ next / prev hunk   space stage hunk   c comment   m mark reviewed   o open in editor
 *
 * Changed rows keep their syntax colors; the change shows as a background tint
 * across the row and a separate tint on the line-number gutter (the theme's
 * diff tokens, pushed further from the inset fill when a theme's tint sits too
 * close to it; see diff-tint.ts). Long lines wrap under their own gutter. The semantic summary
 * (tree-sitter) leads the diff side. A preview (a fleet candidate, a rewind or an
 * attempt) can carry a question with its two buttons on the first body row.
 */

import { activeTokens } from './theme.ts';
import { beginModal, finishModal, clipText, scrollCountText, wrapLines, type KitHint, type ModalFrame, type SurfaceLayer } from './surface-kit.ts';
import { drawList, type KitRow } from './surface-kit-list.ts';
import { button, buttonWidth, inset, type KitInset } from './surface-kit-parts.ts';
import { drawTextBlock, splitListDetail } from './surface-kit-extra.ts';
import type { SemanticDiff } from './semantic-diff.ts';
import { getDisplayWidth } from '../utils/terminal-width.ts';
import { type ChangeFile } from '../input/changes-model.ts';

/** A question asked over a preview (pick this candidate? restore this checkpoint?). */
export interface ChangesQuestion {
  readonly text: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly tone: 'danger' | 'warning' | 'primary';
  /** 0 = cancel (left), 1 = confirm (right). */
  readonly chosen: 0 | 1;
}

/** One line of text under the diff (a comment, a status, the comment being typed). */
export interface ChangesFootLine {
  readonly text: string;
  readonly tone: 'muted' | 'faint' | 'text' | 'error' | 'success';
  /** Draw a cursor after the text (an input being typed). */
  readonly cursor?: boolean;
}

/** What the renderer reads from the modal. */
export interface ChangesModalView {
  readonly title: string;
  readonly crumbs: readonly string[];
  readonly sub: string;
  /** The left list: files, then recent commits (built by the modal, selection included). */
  readonly listRows: readonly KitRow[];
  /** Files shown in the diff side (one file, or every file of a commit or preview). */
  readonly diffFiles: readonly ChangeFile[];
  /** Draw a path row above each file's hunks (more than one file in the diff side). */
  readonly fileHeaders: boolean;
  /** The selected hunk, counted across diffFiles. */
  readonly hunkIndex: number;
  /** Lines scrolled from the selected hunk's first row (pgup / pgdn). */
  readonly scrollDelta: number;
  /** The semantic summary for the shown file: undefined while loading, null when there is none. */
  readonly semantic: SemanticDiff | null | undefined;
  /** Shown instead of a diff (a preview that is text, an empty state, an error). */
  readonly message: string | null;
  readonly foot: readonly ChangesFootLine[];
  readonly hints: readonly KitHint[];
  readonly question: ChangesQuestion | null;
  /** Owner for remembered list scroll positions. */
  readonly scrollOwner: object;
}

import { buildDiffRows, drawDiffRow, semanticChips, type DiffRow } from '@goodvibes-jev/engine/terminal-shell/diff-rows';
export { buildDiffRows, drawDiffRow, semanticChips, type DiffRow } from '@goodvibes-jev/engine/terminal-shell/diff-rows';
function buildRows(view: ChangesModalView, codeWidth: number): { rows: DiffRow[]; hunkStarts: number[] } {
  return buildDiffRows(view.diffFiles, codeWidth, view.fileHeaders);
}

function drawSemantic(f: ModalFrame, view: ChangesModalView, x: number, xr: number, y: number): number {
  const t = activeTokens();
  const { canvas } = f;
  if (view.semantic === undefined) {
    canvas.put(x, y, clipText('◈ reading the structure of this file…', xr - x + 1), { fg: t.textFaint });
    return y + 2;
  }
  if (view.semantic === null || view.semantic.totalChanges === 0) return y;
  canvas.put(x, y, '◈', { fg: t.brandEnd });
  const head = `${view.semantic.totalChanges} semantic change${view.semantic.totalChanges === 1 ? '' : 's'}`;
  let cx = canvas.put(x + 2, y, clipText(head, xr - x - 1), { fg: t.text, bold: true }) + 2;
  let yy = y;
  const chips = semanticChips(view.semantic);
  chips.forEach((chip, k) => {
    const w = getDisplayWidth(chip.text);
    const rest = chips.length - k;
    if (cx + w > xr) {
      // Wrap chips onto one more row, then fold the rest into a count.
      if (yy > y) return;
      yy++;
      cx = x + 2;
    }
    if (yy > y && cx + w > xr - 8 && rest > 1) {
      canvas.put(cx, yy, `+${rest} more`, { fg: t.textFaint });
      cx = xr + 1;
      return;
    }
    if (cx + w > xr) return;
    cx = canvas.put(cx, yy, chip.text, { fg: chip.fg }) + 2;
  });
  return yy + 2;
}

function drawQuestion(f: ModalFrame, q: ChangesQuestion, y: number): number {
  const t = activeTokens();
  const width = f.r - f.l + 1;
  const buttonsW = buttonWidth(q.cancelLabel) + 2 + buttonWidth(q.confirmLabel);
  const textW = width >= 70 ? width - buttonsW - 3 : width;
  const lines = wrapLines(q.text, textW);
  lines.forEach((line, k) => f.canvas.put(f.l, y + k, line, { fg: t.text, bold: k === 0 }));
  const by = width >= 70 ? y : y + lines.length;
  let bx = f.r - buttonsW + 1;
  bx = button(f.canvas, bx, by, q.cancelLabel, q.chosen === 0) + 2;
  button(f.canvas, bx, by, q.confirmLabel, q.chosen === 1, q.tone);
  return Math.max(y + lines.length, by + 1) + 1;
}

function drawDiffColumn(f: ModalFrame, view: ChangesModalView, x: number, xr: number, top: number, bottom: number): void {
  const t = activeTokens();
  const { canvas } = f;
  let y = top;
  if (view.message !== null) {
    drawTextBlock(canvas, x, y, xr - x + 1, view.message.split('\n').map((text) => ({ text, style: { fg: t.textMuted } })), bottom);
    return;
  }
  y = drawSemantic(f, view, x, xr, y);
  // Foot lines under the diff (comment, status), each wrapped in full.
  const footRows = view.foot.reduce((n, line) => n + wrapLines(line.text, xr - x + 1).length, 0);
  const insetBottom = bottom - (footRows > 0 ? footRows + 1 : 0);
  if (insetBottom - y + 1 >= 3) {
    const p = inset(canvas, x - 2, y, xr - x + 5, insetBottom - y + 1);
    const codeWidth = Math.max(8, p.r - (p.l + GUTTER + 3) + 1);
    const { rows, hunkStarts } = buildRows(view, codeWidth);
    const capacity = p.bottom - p.top + 1;
    const anchor = hunkStarts[Math.max(0, Math.min(view.hunkIndex, hunkStarts.length - 1))] ?? 0;
    const start = Math.max(0, Math.min(anchor + view.scrollDelta, Math.max(0, rows.length - capacity)));
    for (let k = 0; k < capacity && start + k < rows.length; k++) drawDiffRow(canvas, p, p.top + k, rows[start + k]!, view.hunkIndex);
    const hidden = scrollCountText(start, Math.max(0, rows.length - start - capacity)).replace(/more/g, 'lines');
    if (hidden) f.hintRight = hidden;
  }
  let fy = insetBottom + 2;
  for (const line of view.foot) {
    const fg = line.tone === 'error' ? t.error : line.tone === 'success' ? t.success : line.tone === 'faint' ? t.textFaint : line.tone === 'text' ? t.text : t.textMuted;
    const wrapped = wrapLines(line.text, xr - x + 1);
    wrapped.forEach((part, k) => {
      if (fy > bottom) return;
      const end = canvas.put(x, fy, part, { fg });
      if (line.cursor && k === wrapped.length - 1) canvas.put(end, fy, '▏', { fg: t.brand });
      fy++;
    });
  }
}

export function renderChangesModal(view: ChangesModalView, screenWidth: number, screenHeight: number): SurfaceLayer {
  const f = beginModal(screenWidth, screenHeight, {
    title: view.title,
    crumbs: view.crumbs,
    sub: view.sub,
    hints: view.hints,
    cap: view.question ? (view.question.tone === 'danger' ? 'danger' : 'warning') : 'brand',
  });
  let top = f.top;
  if (view.question) top = drawQuestion(f, view.question, top);
  if (view.listRows.length === 0) {
    drawDiffColumn(f, view, f.l, f.r, top, f.bottom);
    return finishModal(f);
  }
  const split = splitListDetail(f.l, f.r, top, f.bottom, 0.3, 4);
  drawList(f.canvas, { rows: view.listRows, top: split.top, bottom: split.bottom, x0: split.x0, x1: split.x1, scrollKey: { owner: view.scrollOwner, name: 'files' } });
  const paneX = split.stacked ? f.l : split.detailX + 2;
  const paneTop = split.stacked ? split.detailY : split.top;
  drawDiffColumn(f, view, paneX, f.r, paneTop, f.bottom);
  return finishModal(f);
}
