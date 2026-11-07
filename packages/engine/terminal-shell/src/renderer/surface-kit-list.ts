/**
 * surface-kit-list.ts, list rows and group headers for the modal surface kit.
 *
 *   ✦ group header         lowercase, accent (violet), bold; a blank row above
 *                          every group except the first (dropped when a
 *                          narrow or short list does not fit)
 *   selected-item explanation (a separate area above the options)
 *
 *   ● Label  compact metadata        right metadata
 *     wrapped continuation of a long label or field value
 *
 * The selected row is the one loud element: a brand → brandEnd gradient inset 2
 * columns from each side of the fill, with dark bold text
 * (selectedListItemText). Long labels and field values wrap onto continuation
 * rows; nothing is clipped. When the list does not fit, group spacing collapses
 * first (always when that makes it fit; on a narrow screen or a short list
 * area in every case), then the list scrolls around the selected row and reports how many
 * rows are hidden above and below (drawn as a muted "12 more ↓" count).
 */

import { getDisplayWidth } from '@goodvibes-jev/engine/sdk/platform/utils';
import { activeTokens } from './theme.js';
import { MODAL_MARK_INSET, SurfaceCanvas, scrollCountText, wrapLines, type KitStyle } from './surface-kit.js';

/** A run of text with one style (used for custom labels such as fuzzy-match highlights). */
export interface KitSpan {
  readonly text: string;
  readonly fg?: (string) | undefined;
  readonly bold?: (boolean) | undefined;
  readonly italic?: (boolean) | undefined;
  readonly strikethrough?: (boolean) | undefined;
}

/** One list row: a group header when `header` is set, an item otherwise. */
export interface KitRow {
  readonly selectable?: (boolean) | undefined;
  readonly onClick?: (() => void) | undefined;
  readonly header?: (string) | undefined;
  readonly headerRight?: (string) | undefined;
  readonly label?: (string) | undefined;
  /** Custom label spans; replaces `label` when set. */
  readonly spans?: (readonly KitSpan[]) | undefined;
  /** Compact row metadata or an editable field value (wraps with the label). */
  readonly desc?: (string) | undefined;
  /** Explanatory text, shown above the list when this item is selected. */
  readonly detail?: string | undefined;
  /** Muted metadata right-aligned on the row's first line. */
  readonly right?: (string) | undefined;
  readonly rightFg?: (string) | undefined;
  /** A marker 2 columns in from the fill edge (● ✓ ◐ ✕ …). */
  readonly mark?: (string) | undefined;
  readonly markFg?: (string) | undefined;
  readonly selected?: (boolean) | undefined;
  /** The active choice: label in the brand color when not selected. */
  readonly current?: (boolean) | undefined;
  /** A destructive / armed row: label in the error color; a red fill instead of the gradient when selected. */
  readonly danger?: (boolean) | undefined;
  readonly labelFg?: (string) | undefined;
  readonly bold?: (boolean) | undefined;
  /** Rows shown dimmer (unavailable entries). */
  readonly muted?: (boolean) | undefined;
}

export function isHeader(row: KitRow): boolean {
  return row.header !== undefined;
}

// ---------------------------------------------------------------------------
// Wrapping styled spans
// ---------------------------------------------------------------------------

interface Piece { text: string; style: KitStyle }

/** Greedy word wrap over styled spans; each output row is a list of pieces. */
function wrapSpans(spans: readonly Piece[], width: number): Piece[][] {
  const rows: Piece[][] = [[]];
  let used = 0;
  const pushText = (text: string, style: KitStyle): void => {
    const row = rows[rows.length - 1]!;
    const last = row[row.length - 1];
    if (last && last.style === style) last.text += text;
    else row.push({ text, style });
    used += getDisplayWidth(text);
  };
  const newRow = (): void => { rows.push([]); used = 0; };
  for (const span of spans) {
    // Split into words keeping the separating spaces attached to the front.
    const words = span.text.split(/(?= )/);
    for (const raw of words) {
      let word = raw;
      const w = getDisplayWidth(word);
      if (used > 0 && used + w > width) {
        newRow();
        word = word.replace(/^ +/, '');
      } else if (used === 0) {
        word = word.replace(/^ +/, '');
      }
      // A word longer than the row: hard-split it.
      while (getDisplayWidth(word) > width) {
        let cut = '';
        let cw = 0;
        for (const ch of word) {
          const chw = getDisplayWidth(ch);
          if (used + cw + chw > width) break;
          cut += ch;
          cw += chw;
        }
        if (cut.length === 0) { newRow(); continue; }
        pushText(cut, span.style);
        word = word.slice(cut.length);
        newRow();
      }
      if (word.length > 0) pushText(word, span.style);
    }
  }
  return rows.filter((row, k) => row.length > 0 || k === 0);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface RowLayout {
  readonly lines: Piece[][];
  readonly right?: (string) | undefined;
}

function rowPieces(row: KitRow): Piece[] {
  const t = activeTokens();
  const sel = row.selected === true;
  const ink = t.selectedListItemText;
  const labelFg = sel ? ink
    : row.danger ? t.error
    : row.current ? t.brand
    : row.muted ? t.textFaint
    : row.labelFg ?? t.text;
  const pieces: Piece[] = [];
  if (row.spans) {
    for (const span of row.spans) {
      pieces.push({ text: span.text, style: { fg: sel ? ink : span.fg ?? labelFg, bold: sel || span.bold === true, italic: span.italic, strikethrough: span.strikethrough } });
    }
  } else {
    pieces.push({ text: row.label ?? '', style: { fg: labelFg, bold: sel || row.bold === true } });
  }
  if (row.desc) pieces.push({ text: `  ${row.desc}`, style: { fg: sel ? ink : t.textMuted } });
  return pieces;
}

function layoutRow(row: KitRow, x0: number, x1: number): RowLayout {
  const width = Math.max(1, x1 - x0 + 1);
  if (isHeader(row)) return { lines: [[{ text: row.header!.toLowerCase(), style: {} }]], right: row.headerRight };
  const rightW = row.right ? getDisplayWidth(row.right) + 2 : 0;
  const textW = Math.max(4, width - rightW);
  const lines = wrapSpans(rowPieces(row), textW);
  return { lines, right: row.right };
}

/** Rows a list row takes at the given text span. */
export function measureRow(row: KitRow, x0: number, x1: number): number {
  return layoutRow(row, x0, x1).lines.length;
}

/**
 * Draw one row (header or item) with its text starting at x0 and right
 * metadata ending at x1. Returns the number of canvas rows used.
 */
export function drawRow(canvas: SurfaceCanvas, y: number, row: KitRow, x0: number, x1: number, maxY = Number.POSITIVE_INFINITY): number {
  const t = activeTokens();
  const layout = layoutRow(row, x0, x1);
  if (isHeader(row)) {
    canvas.put(x0 - MODAL_MARK_INSET, y, '✦', { fg: t.brandEnd });
    canvas.put(x0, y, row.header!.toLowerCase(), { fg: t.accent, bold: true });
    if (row.headerRight) canvas.right(x1, y, row.headerRight, { fg: t.textFaint });
    return 1;
  }
  const sel = row.selected === true;
  const ink = t.selectedListItemText;
  const used = Math.min(layout.lines.length, Math.max(1, maxY - y + 1));
  if (row.onClick) canvas.hitTargets.push({ id: `row:${row.label ?? ''}`, x: x0 - MODAL_MARK_INSET, y, width: x1 - x0 + 1 + MODAL_MARK_INSET, height: used, onClick: row.onClick });
  if (sel) {
    // An armed (danger) row is red, not the gradient: it is about to do something destructive.
    const span = x1 - x0 + 1 + 2 * MODAL_MARK_INSET;
    for (let k = 0; k < used; k++) {
      if (row.danger) canvas.tint(x0 - MODAL_MARK_INSET, y + k, span, t.error);
      else canvas.grad(x0 - MODAL_MARK_INSET, y + k, span, t.brand, t.brandEnd);
    }
  }
  if (row.mark) canvas.put(x0 - MODAL_MARK_INSET, y, row.mark, { fg: sel ? ink : row.markFg ?? t.brand, bold: sel });
  for (let k = 0; k < used; k++) {
    let cx = x0;
    for (const piece of layout.lines[k]!) cx = canvas.put(cx, y + k, piece.text, piece.style);
  }
  if (layout.right) canvas.right(x1, y, layout.right, { fg: sel ? ink : row.rightFg ?? t.textFaint, bold: false });
  return used;
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

export interface KitListOptions {
  /** Selected-item help has its own viewport above the uninterrupted list. */
  readonly context?: KitListContext | undefined;
  /** Opt in only when this list uses Up/Down and Enter. */
  readonly mouseNavigation?: (boolean) | undefined;
  readonly rows: readonly KitRow[];
  /** Current option for scrolling/help when focus is in a separate category rail. */
  readonly activeIndex?: number | undefined;
  /** First and last canvas rows the list may use (inclusive). */
  readonly top: number;
  readonly bottom: number;
  readonly x0: number;
  readonly x1: number;
  /** Row index to start from when scrolling (clamped so the selected row stays visible). */
  readonly scrollStart?: (number) | undefined;
  /**
   * Remember this list's scroll position between renders (keyed by an owner
   * object, usually the modal's state, and a list name), so the window only
   * moves when the selection leaves it instead of re-anchoring every frame.
   */
  readonly scrollKey?: ({ readonly owner: object; readonly name: string }) | undefined;
}

export interface KitListContext {
  /** Pre-wrapped help lines. Otherwise the selected row's detail is used. */
  readonly lines?: readonly KitSpan[] | undefined;
  /** Explicit help height. Documentation blocks default to 40% of the area. */
  readonly height?: number | undefined;
  readonly offset?: number | undefined;
  /** Store the clamped offset so paging back works immediately at either end. */
  readonly setOffset?: ((offset: number) => void) | undefined;
  /** Existing documentation pagers can supply their own window and indicators. */
  readonly window?: ((capacity: number) => readonly KitSpan[]) | undefined;
}

function contextLayout(options: KitListOptions): { height: number; lines: readonly KitSpan[] } {
  const width = Math.max(1, options.x1 - options.x0 + 1);
  const details = options.rows.map(row => row.detail ? wrapLines(row.detail, width) : []);
  const lines = options.context?.lines ?? (details[options.activeIndex ?? options.rows.findIndex(row => row.selected)] ?? [])
    .map(text => ({ text, fg: activeTokens().textMuted }));
  const capacity = Math.max(0, options.bottom - options.top + 1);
  // Reserve the same area across selection changes, including items with no
  // help. Changing focus must never move the list or insert prose between rows.
  const desired = options.context?.height ?? (options.context?.lines || options.context?.window
    ? Math.floor(capacity * 0.4)
    : details.reduce((max, detail) => Math.max(max, detail.length), 0));
  const minimumItems = Math.max(1, Math.min(3, options.rows.filter(row => !isHeader(row)).length));
  const height = Math.max(0, Math.min(desired, capacity - minimumItems - 1));
  if (height === 0) return { height, lines: [] };
  if (options.context?.window) return { height, lines: options.context.window(height).slice(0, height) };
  if (lines.length <= height) {
    options.context?.setOffset?.(0);
    return { height, lines };
  }
  const contentRows = Math.max(1, height - 1);
  const offset = Math.max(0, Math.min(options.context?.offset ?? 0, lines.length - contentRows));
  options.context?.setOffset?.(offset);
  const shown: KitSpan[] = lines.slice(offset, offset + contentRows);
  if (height > 1) shown.push({ text: scrollCountText(offset, lines.length - offset - contentRows), fg: activeTokens().textFaint });
  return { height, lines: shown };
}

function listArea(options: KitListOptions, height: number): KitListOptions {
  return { ...options, top: options.top + (height > 0 ? height + 1 : 0) };
}

const scrollMemory = new WeakMap<object, Map<string, number>>();

/** The remembered first row of a list (see KitListOptions.scrollKey). */
export function rememberedStart(key: KitListOptions['scrollKey']): number | undefined {
  return key ? scrollMemory.get(key.owner)?.get(key.name) : undefined;
}

/** Record a list's first row for the next render. */
export function rememberStart(key: KitListOptions['scrollKey'], start: number): void {
  if (!key) return;
  let names = scrollMemory.get(key.owner);
  if (!names) {
    names = new Map();
    scrollMemory.set(key.owner, names);
  }
  names.set(key.name, start);
}

export interface KitListResult {
  /** First option row, after the fixed help area and its separating blank row. */
  readonly listTop: number;
  /** Item rows (headers excluded) hidden above / below the window. */
  readonly above: number;
  readonly below: number;
  /** Index of the first row drawn. */
  readonly start: number;
  /** Canvas row after the last row drawn. */
  readonly endY: number;
}

interface ListPlan {
  readonly capacity: number;
  readonly heights: readonly number[];
  /** Whether the blank row above each group header (but the first) is drawn. */
  readonly gaps: boolean;
  /** True when the rows do not all fit and the list scrolls. */
  readonly scrolls: boolean;
  /** Canvas rows that rows from..to take, spacing included when `gaps` is on. */
  readonly spanOf: (from: number, to: number) => number;
}

/** Heights, group spacing and whether the list scrolls, by the rules drawList documents. */
function planList(canvas: SurfaceCanvas, options: KitListOptions): ListPlan {
  const { rows, top, bottom, x0, x1 } = options;
  const capacity = Math.max(1, bottom - top + 1);
  const heights = rows.map((row) => measureRow(row, x0, x1));
  // Prefix sums keep every span query O(1): catalogs run to thousands of rows.
  const heightPre = [0];
  const headerPre = [0];
  for (let i = 0; i < rows.length; i++) {
    heightPre.push(heightPre[i]! + heights[i]!);
    headerPre.push(headerPre[i]! + (isHeader(rows[i]!) ? 1 : 0));
  }
  const span = (from: number, to: number, withGaps: boolean): number => {
    if (to < from) return 0;
    const base = heightPre[to + 1]! - heightPre[from]!;
    // A blank row above every header after the first row of the span.
    return withGaps ? base + (headerPre[to + 1]! - headerPre[from + 1]!) : base;
  };
  const last = rows.length - 1;
  if (rows.length === 0 || span(0, last, true) <= capacity) {
    return { capacity, heights, gaps: true, scrolls: false, spanOf: (from, to) => span(from, to, true) };
  }
  // Spacing collapses before anything is cut; when the list scrolls anyway it
  // stays on a wide screen with room, and goes on a narrow screen or a short list.
  const scrolls = span(0, last, false) > capacity;
  const gaps = scrolls && !canvas.compact && capacity >= SHORT_LIST_ROWS;
  return { capacity, heights, gaps, scrolls, spanOf: (from, to) => span(from, to, gaps) };
}

/**
 * The furthest first row a list can scroll to and still fill its area: for
 * callers that track their own scroll position (drawList's scrollStart) and
 * need to know where the end is, by the same spacing rules drawList uses.
 */
export function listScrollEnd(canvas: SurfaceCanvas, options: KitListOptions): number {
  const plan = planList(canvas, listArea(options, contextLayout(options).height));
  if (!plan.scrolls) return 0;
  const last = options.rows.length - 1;
  let start = last;
  while (start > 0 && plan.spanOf(start - 1, last) <= plan.capacity) start--;
  return start;
}

/**
 * A list shorter than this many rows drops its group spacing as soon as it
 * scrolls: on a short screen every row of content is worth more than the gap.
 */
const SHORT_LIST_ROWS = 10;

/**
 * Draw a list of rows between `top` and `bottom`, keeping the selected row in
 * view. Group spacing (the blank row above each header but the first) stays
 * while the list scrolls on a wide screen. It collapses before any row is cut
 * when everything would fit without it, and it is dropped whenever the list
 * does not fit on a narrow screen (below 90 columns) or a short list area.
 */
export function drawList(canvas: SurfaceCanvas, options: KitListOptions): KitListResult {
  const context = contextLayout(options);
  context.lines.forEach((line, index) => canvas.put(options.x0, options.top + index, line.text, line));
  return drawListRows(canvas, listArea(options, context.height));
}

function drawListRows(canvas: SurfaceCanvas, options: KitListOptions): KitListResult {
  const { rows, top, bottom, x0, x1 } = options;
  const plan = planList(canvas, options);
  const { gaps, heights } = plan;
  let start = 0;
  const last = rows.length - 1;
  if (plan.scrolls) {
    const { capacity, spanOf } = plan;
    const selected = options.activeIndex ?? rows.findIndex((row) => row.selected === true);
    start = Math.max(0, Math.min(rememberedStart(options.scrollKey) ?? options.scrollStart ?? 0, last));
    if (selected >= 0) {
      if (selected < start) start = selected;
      while (start < selected && spanOf(start, selected) > capacity) start++;
      // Show the selected row's group header when there is room for it.
      if (start > 0 && start === selected && isHeader(rows[start - 1]!) && spanOf(start - 1, selected) <= capacity) start--;
    }
    // Do not leave empty space at the end when scrolled down.
    while (start > 0 && spanOf(start - 1, last) <= capacity) start--;
  }

  rememberStart(options.scrollKey, start);
  let y = top;
  let lastDrawn = start - 1;
  const itemIndexes = rows.map((row, index) => isHeader(row) || row.selectable === false ? -1 : index).filter(index => index >= 0);
  const selectedItem = itemIndexes.findIndex(index => rows[index]!.selected);
  for (let i = start; i < rows.length; i++) {
    const gap = gaps && i > start && isHeader(rows[i]!) ? 1 : 0;
    if (y + gap > bottom) break;
    // A header with no room for an item under it is left for the next page.
    if (isHeader(rows[i]!) && y + gap + 1 > bottom && i < rows.length - 1) break;
    y += gap;
    const used = drawRow(canvas, y, rows[i]!, x0, x1, bottom);
    if (options.mouseNavigation && selectedItem >= 0 && !isHeader(rows[i]!) && rows[i]!.selectable !== false && !rows[i]!.onClick) {
      const delta = itemIndexes.indexOf(i) - selectedItem;
      const keys = delta === 0 ? ['enter'] : Array.from({ length: Math.abs(delta) }, () => delta < 0 ? 'up' : 'down');
      canvas.hitTargets.push({ id: `item:${i}:${rows[i]!.label ?? ''}`, keys, x: x0 - MODAL_MARK_INSET, y, width: x1 - x0 + 1 + MODAL_MARK_INSET, height: used });
    }
    y += used;
    lastDrawn = i;
    if (used < heights[i]!) break;
  }
  const countItems = (from: number, to: number): number => {
    let n = 0;
    for (let i = from; i <= to; i++) if (!isHeader(rows[i]!)) n++;
    return n;
  };
  return {
    listTop: top,
    above: countItems(0, start - 1),
    below: countItems(lastDrawn + 1, last),
    start,
    endY: y,
  };
}

/**
 * drawList for a list that has no hint row of its own: when rows are hidden,
 * the list's last row carries the muted scroll count ("3 more ↑ · 12 more ↓").
 */
export function drawScrollingList(canvas: SurfaceCanvas, options: KitListOptions): KitListResult {
  const context = contextLayout(options);
  context.lines.forEach((line, index) => canvas.put(options.x0, options.top + index, line.text, line));
  const area = listArea(options, context.height);
  const scratch = new SurfaceCanvas(canvas.width, canvas.height);
  scratch.compact = canvas.compact;
  const trial = drawListRows(scratch, area);
  if (trial.above === 0 && trial.below === 0) return drawListRows(canvas, area);
  // On a very short screen the option itself takes precedence over a count.
  if (area.bottom <= area.top) return drawListRows(canvas, area);
  const result = drawListRows(canvas, { ...area, bottom: area.bottom - 1 });
  const text = scrollCountText(result.above, result.below);
  if (text) canvas.right(options.x1, options.bottom, text, { fg: activeTokens().textFaint });
  return result;
}
