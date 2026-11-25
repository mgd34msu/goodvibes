/**
 * surface-kit-parts.ts, the smaller pieces of the modal surface kit:
 *
 *   - element insets (a lighter fill inside a modal: 2 columns of side padding,
 *     a padding row above and below)
 *   - tabs (the active tab carries the gradient)
 *   - button chips (arrows pick, Enter confirms; the danger chip is red)
 *   - meters (▰▱)
 *   - composer popups (the slash and @ lists: anchored to the composer, no dim,
 *     ┃ bar, surface fill, selected row gradient, no frame and no hint rows)
 *
 * Colors come only from the active theme's tokens.
 */

import type { Line } from '@goodvibes/engine/platform/platform/types';
import { getDisplayWidth } from '@goodvibes/engine/platform/platform/utils/terminal-width';
import { activeTokens } from './theme.js';
import {
  NARROW_MODAL_BREAKPOINT,
  SurfaceCanvas,
  clipText,
  type KitHint,
  wrapLines,
  type KitStyle,
  type SurfaceLayer,
} from './surface-kit.js';
import { drawList, drawRow, drawScrollingList, measureList, measureRow, type KitListResult, type KitRow, type KitRowSource } from './surface-kit-list.js';

// ---------------------------------------------------------------------------
// Element insets
// ---------------------------------------------------------------------------

/** Side padding inside an inset. */
const INSET_PAD_X = 2;

export interface KitInset {
  /** Inset fill rectangle (canvas coordinates). */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Text area: columns l..r, rows top..bottom (inclusive). */
  readonly l: number;
  readonly r: number;
  readonly top: number;
  readonly bottom: number;
  readonly bg: string;
}

/** Fill a lighter element inset and return its text area. */
export function inset(canvas: SurfaceCanvas, x: number, y: number, w: number, h: number, bg = activeTokens().backgroundElement): KitInset {
  canvas.fill(x, y, w, h, bg);
  return {
    x, y, w, h, bg,
    l: x + INSET_PAD_X,
    r: x + w - 1 - INSET_PAD_X,
    top: y + 1,
    bottom: y + h - 2,
  };
}

/** Put text inside an inset (keeps the inset bg). Returns the column after it. */
export function insetPut(canvas: SurfaceCanvas, p: KitInset, x: number, y: number, text: string, style: KitStyle = {}): number {
  if (y < p.top || y > p.bottom) return x;
  return canvas.put(x, y, clipText(text, p.r - x + 1), { ...style, bg: p.bg });
}

/** Wrapped text inside an inset from row y; returns the row after the last line drawn. */
export function insetWrap(canvas: SurfaceCanvas, p: KitInset, x: number, y: number, text: string, style: KitStyle = {}): number {
  let yy = y;
  for (const line of wrapLines(text, p.r - x + 1)) {
    if (yy > p.bottom) break;
    canvas.put(x, yy, line, { ...style, bg: p.bg });
    yy++;
  }
  return yy;
}

/** One line of inset text. */
export interface InsetLine { readonly text: string; readonly style: KitStyle }

/**
 * Wrap and draw paragraphs inside an inset from row y. When they do not all
 * fit, the last visible row says how many lines are hidden instead of the text
 * stopping silently. Returns the row after the last one drawn.
 */
export function insetLines(canvas: SurfaceCanvas, p: KitInset, x: number, y: number, paragraphs: readonly InsetLine[]): number {
  const t = activeTokens();
  const lines: InsetLine[] = [];
  for (const para of paragraphs) {
    if (para.text === '') lines.push(para);
    else for (const text of wrapLines(para.text, p.r - x + 1)) lines.push({ text, style: para.style });
  }
  const room = Math.max(0, p.bottom - y + 1);
  const overflow = lines.length > room;
  const shown = overflow ? lines.slice(0, Math.max(0, room - 1)) : lines;
  let yy = y;
  for (const line of shown) canvas.put(x, yy++, line.text, { ...line.style, bg: p.bg });
  if (overflow && room > 0) canvas.put(x, yy++, `${lines.length - shown.length} more lines`, { fg: t.textFaint, bg: p.bg });
  return yy;
}

// ---------------------------------------------------------------------------
// Keycap hints in a plain row (bars and status rows outside a modal)
// ---------------------------------------------------------------------------

/** Display width of a row of keycap hints (3 columns between hints). */
export function keycapHintsWidth(hints: readonly KitHint[]): number {
  return hints.reduce((sum, [key, action], i) => sum + (i > 0 ? 3 : 0) + getDisplayWidth(key) + 3 + getDisplayWidth(action), 0);
}

/**
 * Paint keycap hints into a Line from column x (each key a bold chip on the
 * keycap fill, its action in `actionStyle`), the same look as a modal's hint
 * row. Hints that do not fit before `endX` are left out whole, never cut.
 * Returns the column after the last hint drawn.
 */
export function paintKeycapHints(line: Line, x: number, endX: number, hints: readonly KitHint[], actionStyle: { readonly fg: string; readonly bg?: (string) | undefined }): number {
  const t = activeTokens();
  let cx = x;
  const put = (text: string, style: { fg: string; bg?: (string) | undefined; bold?: (boolean) | undefined }): void => {
    for (const ch of text) {
      const w = getDisplayWidth(ch);
      if (cx + w > endX || cx >= line.length) return;
      const prev = line[cx]!;
      line[cx] = { ...prev, char: ch, fg: style.fg, bg: style.bg ?? prev.bg, bold: style.bold ?? false, dim: false, underline: false, italic: false, strikethrough: false };
      if (w === 2 && cx + 1 < line.length) line[cx + 1] = { ...line[cx]!, char: '' };
      cx += w;
    }
  };
  hints.forEach(([key, action], i) => {
    const need = (i > 0 ? 3 : 0) + getDisplayWidth(key) + 3 + getDisplayWidth(action);
    if (cx + need > endX) return;
    if (i > 0) cx += 3;
    put(` ${key} `, { fg: t.text, bg: t.border, bold: true });
    cx += 1;
    put(action, { fg: actionStyle.fg, bg: actionStyle.bg });
  });
  return cx;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/** Tabs across a row; the active one carries the gradient with dark bold text. Returns the column after the last tab. */
export function tabs(canvas: SurfaceCanvas, x: number, y: number, labels: readonly string[], active: number, maxX: number, onSelect?: ((index: number) => void) | undefined): number {
  const t = activeTokens();
  let cx = x;
  const widthOf = (from: number, to: number): number => labels.slice(from, to + 1).reduce((sum, label) => sum + getDisplayWidth(label) + 4, -4);
  const allFit = labels.length === 0 || x + widthOf(0, labels.length - 1) <= maxX;
  // When the row is too narrow for every tab, the first tabs give way so the active one is always drawn, and each
  // cut side says how many tabs are hidden there ("‹ 2", "3 ›"), so no tab is out of sight unsaid.
  const MARK = 6;
  let first = 0;
  while (!allFit && first < active && x + (first > 0 ? MARK : 0) + widthOf(first, active) > maxX - MARK) first++;
  if (!allFit && first > 0) {
    const mark = `‹ ${first}`;
    if (onSelect) canvas.hitTargets.push({ id: 'tab:before', x: cx, y, width: getDisplayWidth(mark), height: 1, onClick: () => onSelect(first - 1) });
    canvas.put(cx, y, mark, { fg: t.textFaint });
    cx += MARK;
  }
  const limit = allFit ? maxX : maxX - MARK;
  // Tabs keep their order: once one does not fit, none after it is drawn (a shorter later tab never jumps the queue).
  let full = false;
  let last = first - 1;
  labels.forEach((label, k) => {
    if (k < first || full) return;
    const w = getDisplayWidth(label);
    // The open tab is always drawn, even past the room kept for the mark.
    if (cx + w > (k === active ? maxX : limit)) { full = true; return; }
    last = k;
    if (onSelect) canvas.hitTargets.push({ id: `tab:${k}:${label}`, x: cx - 1, y, width: w + 2, height: 1, onClick: () => onSelect(k) });
    if (k === active) {
      canvas.grad(cx - 1, y, w + 2, t.brand, t.brandEnd);
      canvas.put(cx, y, label, { fg: t.selectedListItemText, bold: true });
    } else {
      canvas.put(cx, y, label, { fg: t.textMuted });
    }
    cx += w + 4;
  });
  const after = labels.length - 1 - last;
  if (after > 0) {
    const mark = `${after} ›`;
    const mx = Math.min(cx, maxX - getDisplayWidth(mark) + 1);
    if (onSelect) canvas.hitTargets.push({ id: 'tab:after', x: mx, y, width: getDisplayWidth(mark), height: 1, onClick: () => onSelect(last + 1) });
    canvas.put(mx, y, mark, { fg: t.textFaint });
    cx = mx + getDisplayWidth(mark);
  }
  return cx;
}

// ---------------------------------------------------------------------------
// Buttons, chips and meters
// ---------------------------------------------------------------------------

export type ButtonTone = 'primary' | 'warning' | 'danger';

/** A button chip. The chosen one is filled in its tone with dark bold text; the rest are quiet chips (the keycap fill). */
export function button(canvas: SurfaceCanvas, x: number, y: number, label: string, chosen: boolean, tone: ButtonTone = 'primary'): number {
  const t = activeTokens();
  const toneBg = tone === 'danger' ? t.error : tone === 'warning' ? t.warning : t.brand;
  const style: KitStyle = chosen
    ? { fg: t.selectedListItemText, bg: toneBg, bold: true }
    : { fg: t.text, bg: t.border };
  return canvas.put(x, y, ` ${label} `, style);
}

/** Width of a button chip. */
export function buttonWidth(label: string): number {
  return getDisplayWidth(label) + 2;
}

/** A small colored chip (e.g. a risk level). */
export function chip(canvas: SurfaceCanvas, x: number, y: number, label: string, bg: string): number {
  const t = activeTokens();
  return canvas.put(x, y, ` ${label} `, { fg: t.selectedListItemText, bg, bold: true });
}

/** A 10-step meter (▰ filled, ▱ empty) in `color`. Returns the column after it. */
export function meter(canvas: SurfaceCanvas, x: number, y: number, fraction: number, color: string, bg?: (string) | undefined): number {
  const t = activeTokens();
  const n = Math.max(0, Math.min(10, Math.round(fraction * 10)));
  let cx = x;
  for (let q = 0; q < 10; q++) cx = canvas.put(cx, y, q < n ? '▰' : '▱', { fg: q < n ? color : t.border, bg });
  return cx;
}

// ---------------------------------------------------------------------------
// Composer popups (slash commands, @ files)
// ---------------------------------------------------------------------------

/** Column of the popup's ┃ bar (the composer's own left edge). */
export const POPUP_BAR_X = 2;

export interface PopupOptions {
  /** Width of the lines to produce (the conversation width). */
  readonly width: number;
  /** The rows; a long list passes a `lazyRows` source and `activeIndex`, so only the rows shown are built. */
  readonly rows: KitRowSource;
  /** The selected row's index (otherwise found by its `selected` mark). */
  readonly activeIndex?: number | undefined;
  /** A row pinned above the list (it never scrolls away), e.g. the typed query. */
  readonly header?: (KitRow) | undefined;
  /** Maximum rows the content may use (padding rows excluded). */
  readonly maxRows: number;
  /** Remembers the list's scroll position between renders (the picker's state object). */
  readonly scrollOwner?: (object) | undefined;
}

export interface PopupResult {
  readonly lines: Line[];
  readonly list: KitListResult;
}

/**
 * A composer popup: the ┃ bar at column 2 in the faint color, a surface fill
 * from column 3 to width-3 with a padding row above and below, text from
 * column 5 and right-aligned text ending 2 columns inside the fill. Returns
 * full-width lines (cells left of the bar and right of the fill are empty)
 * for docking right above the composer. A list longer than the popup keeps
 * the selected row in view and says what is hidden on its last row.
 */
export function renderPopup(options: PopupOptions): PopupResult {
  const t = activeTokens();
  const { width } = options;
  const fillX = POPUP_BAR_X + 1;
  const fillW = Math.max(6, width - fillX - 2);
  const x0 = fillX + 2;
  const x1 = fillX + fillW - 3;
  const headerRows = options.header ? measureRow(options.header, x0, x1) : 0;
  const listMax = Math.max(1, options.maxRows - headerRows);
  const scrollKey = options.scrollOwner ? { owner: options.scrollOwner, name: 'popup' } : undefined;
  // How many rows the list really needs, measured without drawing it.
  const compact = width < NARROW_MODAL_BREAKPOINT;
  const fit = measureList(compact, { rows: options.rows, activeIndex: options.activeIndex, top: 0, bottom: listMax - 1, x0, x1, scrollKey });
  const overflow = fit.scrolls;
  const listUsed = overflow ? listMax : Math.max(1, fit.used);
  const used = headerRows + listUsed;
  const canvas = new SurfaceCanvas(width, used + 2);
  canvas.compact = compact;
  canvas.fill(fillX, 0, fillW, used + 2, t.backgroundPanel);
  if (options.header) drawRow(canvas, 1, options.header, x0, x1);
  const listOptions = { rows: options.rows, activeIndex: options.activeIndex, top: 1 + headerRows, bottom: used, x0, x1, scrollKey };
  // Content-sized popups retain the help height measured at their full budget.
  // Recomputing its percentage after shrinking would move options on focus.
  const context = { height: fit.contextHeight };
  const list = overflow ? drawScrollingList(canvas, { ...listOptions, context }) : drawList(canvas, { ...listOptions, context });
  for (let r = 0; r < used + 2; r++) canvas.put(POPUP_BAR_X, r, '┃', { fg: t.textFaint });
  return { lines: canvas.lines, list };
}

// Both product vocabularies name the same platform geometry and painting.
export { inset as panel, insetPut as panelPut, insetWrap as panelWrap, insetLines as panelLines };
export type KitPanel = KitInset;
export type PanelLine = InsetLine;
