/**
 * work-board.ts, the "Your agents" panel of both terminal programs (Ctrl+O,
 * /agents): the work board reading (contracts/src/work-board.ts) drawn as a
 * kit modal.
 *
 *   ✦ Your agents  1 running · nothing waiting for you                 esc
 *
 *    ● Helper agent   Writing docs/usage.md              15s  2 files read
 *      no finished agents this session
 *
 *   Scheduled
 *      Morning summary to Telegram      daily 8:00 · last: delivered
 *
 *   Background services  4 healthy ›
 *
 *   ⏎ open   s stop   n new agent   b background services
 *
 * One row per agent, on one line: a long title is cut with … before the time
 * and progress, never wrapped. Waiting rows come first; finished rows follow
 * the running ones; the platform's own services sit behind one line and are
 * listed by themselves only when one is unhealthy. Wide screens add the
 * selected row's detail on the right. The other levels are an opened agent's
 * full view (a transcript, with its composer line for steering) and a picker
 * (a new agent, a winner to pick).
 */

import type { BoardRow } from '@goodvibes-jev/engine/contracts';
import type { Line } from '@goodvibes-jev/engine/platform/platform/types';
import { getDisplayWidth } from '@goodvibes-jev/engine/platform/platform/utils/terminal-width';
import { activeTokens } from './theme.js';
import { beginModal, clipText, finishModal, scrollCountText, searchRow, wrapLines, type KitHint, type ModalFrame, type SurfaceCanvas, type SurfaceLayer } from './surface-kit.js';
import { drawList, rememberedStart, rememberStart, type KitRow } from './surface-kit-list.js';
import { inset, type KitInset } from './surface-kit-parts.js';
import { drawTextBlock, splitListDetail } from './surface-kit-extra.js';

export type PanelTone = 'text' | 'muted' | 'faint' | 'brand' | 'success' | 'warning' | 'error';

/** A line of plain text in a tone. */
export interface PanelText {
  readonly text: string;
  readonly tone: PanelTone;
  readonly bold?: boolean | undefined;
  /** A marker drawn in front (→ ← ◐ …). */
  readonly glyph?: string | undefined;
}

/** Content for the detail inset or the full view: text, or prebuilt lines. */
export type PanelBlock =
  | { readonly kind: 'text'; readonly lines: readonly PanelText[] }
  | { readonly kind: 'lines'; readonly build: (width: number) => readonly Line[] };

export interface PanelDetail {
  readonly title: string;
  readonly meta: string;
  /** Drawn from the top. */
  readonly blocks: readonly PanelBlock[];
  /** The live tail, drawn from the bottom up (newest last). */
  readonly tail: readonly PanelText[];
}

/** One option in a picker (new agent, pick a winner). */
export interface PanelOption {
  readonly label: string;
  readonly detail: string;
  readonly selected: boolean;
}

/** One board row as the list draws it. */
export interface WorkBoardEntry {
  /** Stable selection key: `<ref type>:<id>`. */
  readonly key: string;
  readonly row: BoardRow;
  /** Sub-agent depth under a parent in the same group. */
  readonly depth: number;
  readonly selected: boolean;
  /** Overrides the row's tone for the dot (a stop in flight). */
  readonly stopping?: boolean | undefined;
  readonly onClick?: (() => void) | undefined;
}

/** The list level: the board's groups as the panel draws them. */
export interface WorkBoardListView {
  readonly waiting: readonly WorkBoardEntry[];
  /** Running rows, then finished rows. */
  readonly agents: readonly WorkBoardEntry[];
  /** Nothing finished this session (the note under the running rows). */
  readonly finishedEmpty: boolean;
  /** Nothing waiting, running or finished. */
  readonly empty: boolean;
  readonly scheduled: readonly WorkBoardEntry[];
  /** "1 event today ›" under Scheduled, opening the calendar's events; null when none. */
  readonly eventsToday: WorkBoardEntry | null;
  readonly services: {
    readonly healthy: number;
    readonly unhealthy: readonly WorkBoardEntry[];
    readonly open: boolean;
    /** Every healthy service with its state word, listed while open. */
    readonly rows: readonly { readonly label: string; readonly state: string }[];
  };
  /** The fleet could not be read: the sentence why. */
  readonly error: string | null;
  /** The filter row, while filtering or a query is set. */
  readonly filter: { readonly query: string; readonly active: boolean; readonly count: string } | null;
  /** Archive view: the archived rows replace the groups. */
  readonly archive: boolean;
}

/** What the renderer reads from the panel. */
export interface WorkBoardPanelView {
  readonly level: 'list' | 'full' | 'picker';
  readonly crumbs: readonly string[];
  readonly sub: string;
  readonly hints: readonly KitHint[];
  readonly status: PanelText | null;
  /** An inline input being typed (steer, say), or null. */
  readonly input: { readonly label: string; readonly draft: string } | null;
  readonly list: WorkBoardListView | null;
  readonly detail: PanelDetail | null;
  readonly full: {
    readonly meta: string;
    readonly header: readonly PanelText[];
    /** The transcript viewport for a body of this width and height. */
    readonly body: (width: number, height: number) => readonly Line[];
    /** Read after body layout, from the view's own viewport. */
    readonly scroll?: (() => { readonly above: number; readonly below: number }) | undefined;
  } | null;
  readonly picker: { readonly intro: string; readonly options: readonly PanelOption[]; readonly side: readonly PanelText[] } | null;
  readonly scrollOwner: object;
}

export const WORK_BOARD_TITLE = 'Your agents';

function toneColor(tone: PanelTone): string {
  const t = activeTokens();
  switch (tone) {
    case 'text': return t.text;
    case 'muted': return t.textMuted;
    case 'faint': return t.textFaint;
    case 'brand': return t.brand;
    case 'success': return t.success;
    case 'warning': return t.warning;
    case 'error': return t.error;
  }
}

/** Copy prebuilt cells onto the canvas; cells on the terminal's own background take `bg`. */
function blitLine(canvas: SurfaceCanvas, x: number, y: number, line: Line, width: number, bg: string): void {
  const row = canvas.lines[y];
  if (!row) return;
  for (let q = 0; q < width && q < line.length; q++) {
    const cell = line[q]!;
    const cx = x + q;
    if (cx < 0 || cx >= canvas.width) continue;
    // Never leave half of a wide glyph at the right edge.
    if (q === width - 1 && cell.char && line[q + 1]?.char === '') {
      row[cx] = { ...cell, char: ' ', bg: cell.bg || bg };
      continue;
    }
    row[cx] = { ...cell, bg: cell.bg || bg };
  }
}

/** Width the prebuilt detail lines are built at before they are wrapped to the inset. */
const DETAIL_BUILD_WIDTH = 400;

/**
 * Wrap one prebuilt cell row to `width`: trailing blanks dropped, breaks at
 * the last space that fits, continuation rows indented two past the row's own
 * leading spaces, a wide glyph never split. Nothing is cut off.
 */
function wrapCellLine(line: Line, width: number): Line[] {
  let end = line.length;
  while (end > 0 && line[end - 1]!.char === ' ') end--;
  const cells = line.slice(0, end);
  if (cells.length <= width) return [cells];
  let lead = 0;
  while (lead < cells.length && cells[lead]!.char === ' ') lead++;
  const indent = Math.min(lead + 2, Math.floor(width / 3));
  const blank = { ...cells[0]!, char: ' ' };
  const rows: Line[] = [];
  let start = 0;
  let first = true;
  while (start < cells.length) {
    const avail = first ? width : width - indent;
    const prefix: Line = first ? [] : Array.from({ length: indent }, () => ({ ...blank }));
    if (cells.length - start <= avail) {
      rows.push([...prefix, ...cells.slice(start)]);
      break;
    }
    let cut = start + avail;
    let space = -1;
    for (let q = cut; q > start; q--) if (cells[q]?.char === ' ') { space = q; break; }
    if (space > start) cut = space;
    else if (cells[cut]?.char === '') cut--;
    rows.push([...prefix, ...cells.slice(start, cut)]);
    start = cut;
    while (start < cells.length && cells[start]!.char === ' ') start++;
    first = false;
  }
  return rows;
}

/** Draw text lines (wrapped) from row y; returns the row after them. */
function drawTexts(canvas: SurfaceCanvas, x: number, y: number, width: number, lines: readonly PanelText[], maxY: number, bg?: string): number {
  let yy = y;
  for (const line of lines) {
    const indent = line.glyph ? 2 : 0;
    const parts = wrapLines(line.text, Math.max(1, width - indent));
    for (let k = 0; k < parts.length; k++) {
      if (yy > maxY) return yy;
      if (k === 0 && line.glyph) canvas.put(x, yy, line.glyph, { fg: toneColor(line.tone), bg });
      canvas.put(x + indent, yy, parts[k]!, { fg: toneColor(line.tone), bold: line.bold, bg });
      yy++;
    }
  }
  return yy;
}

function textRows(lines: readonly PanelText[], width: number): number {
  return lines.reduce((n, line) => n + wrapLines(line.text, Math.max(1, width - (line.glyph ? 2 : 0))).length, 0);
}

function drawDetail(canvas: SurfaceCanvas, p: KitInset, detail: PanelDetail): void {
  const t = activeTokens();
  const width = p.r - p.l + 1;
  let y = p.top;
  y = drawTexts(canvas, p.l, y, width, [{ text: detail.title, tone: 'text', bold: true }], p.bottom, p.bg);
  if (detail.meta) y = drawTexts(canvas, p.l, y, width, [{ text: detail.meta, tone: 'faint' }], p.bottom, p.bg);
  y++;
  const tailRows = Math.min(textRows(detail.tail, width), Math.max(0, p.bottom - y + 1 - 2));
  const detailBottom = detail.tail.length > 0 ? p.bottom - tailRows - 1 : p.bottom;
  for (const block of detail.blocks) {
    if (y > detailBottom) break;
    if (block.kind === 'text') y = drawTexts(canvas, p.l, y, width, block.lines, detailBottom, p.bg);
    else for (const built of block.build(DETAIL_BUILD_WIDTH)) {
      for (const line of wrapCellLine(built, width)) {
        if (y > detailBottom) break;
        blitLine(canvas, p.l, y, line, width, p.bg);
        y++;
      }
    }
  }
  if (detail.tail.length === 0 || tailRows <= 0) return;
  const wrapped: PanelText[] = [];
  for (const line of detail.tail) {
    const parts = wrapLines(line.text, Math.max(1, width - (line.glyph ? 2 : 0)));
    parts.forEach((part, k) => wrapped.push({ text: part, tone: line.tone, bold: line.bold, glyph: k === 0 ? line.glyph : line.glyph ? ' ' : undefined }));
  }
  const shown = wrapped.slice(-tailRows);
  let ty = p.bottom - shown.length + 1;
  for (const line of shown) {
    if (line.glyph && line.glyph !== ' ') canvas.put(p.l, ty, line.glyph, { fg: toneColor(line.tone), bg: p.bg });
    canvas.put(p.l + (line.glyph ? 2 : 0), ty, line.text, { fg: toneColor(line.tone), bold: line.bold, bg: p.bg });
    ty++;
  }
}

/** The inline input and the status line, at the bottom of the body. Returns the rows they take. */
function bottomRows(view: WorkBoardPanelView, width: number): number {
  let rows = 0;
  if (view.input) rows += wrapLines(`${view.input.label}${view.input.draft}`, width).length;
  if (view.status) rows += wrapLines(view.status.text, width).length;
  return rows > 0 ? rows + 1 : 0;
}

function drawBottom(f: ModalFrame, view: WorkBoardPanelView): void {
  const t = activeTokens();
  const width = f.r - f.l + 1;
  const rows = bottomRows(view, width);
  if (rows === 0) return;
  let y = f.bottom - rows + 2;
  if (view.input) {
    const parts = wrapLines(`${view.input.label}${view.input.draft}`, width);
    parts.forEach((part, k) => {
      const end = f.canvas.put(f.l, y, part, { fg: t.text });
      if (k === parts.length - 1) f.canvas.put(end, y, '▏', { fg: t.brand });
      y++;
    });
  }
  if (view.status) drawTexts(f.canvas, f.l, y, width, [view.status], f.bottom);
}

// ---------------------------------------------------------------------------
// The list level
// ---------------------------------------------------------------------------

/** One drawn row of the list body. */
type BodyLine =
  | { readonly kind: 'blank' }
  | { readonly kind: 'label'; readonly text: string; readonly right?: string | undefined; readonly tone?: PanelTone | undefined }
  | { readonly kind: 'note'; readonly text: string; readonly tone?: PanelTone | undefined; readonly indent?: number | undefined }
  | { readonly kind: 'entry'; readonly entry: WorkBoardEntry; readonly layout: 'agent' | 'scheduled' }
  | { readonly kind: 'service'; readonly label: string; readonly state: string };

/** The dot and its colour: green while working, amber when it needs you or went quiet, red when failed. */
function dotOf(entry: WorkBoardEntry): { readonly glyph: string; readonly fg: string } {
  const t = activeTokens();
  if (entry.stopping) return { glyph: '●', fg: t.warning };
  const row = entry.row;
  if (row.group === 'finished') {
    if (row.tone === 'done') return { glyph: '✓', fg: t.success };
    if (row.tone === 'failed') return { glyph: '●', fg: t.error };
    return { glyph: '○', fg: t.textFaint };
  }
  switch (row.tone) {
    case 'working': return { glyph: '●', fg: t.success };
    case 'needs-you': return { glyph: '●', fg: t.warning };
    case 'quiet': return { glyph: '●', fg: t.warning };
    case 'failed': return { glyph: '●', fg: t.error };
    case 'done': return { glyph: '✓', fg: t.success };
  }
}

/** Cut text to `width` cells with a trailing … when it does not fit. */
function cutText(text: string, width: number): string {
  if (width <= 0) return '';
  if (getDisplayWidth(text) <= width) return text;
  if (width === 1) return '…';
  return `${clipText(text, width - 1)}…`;
}

/** The right-hand block of an agent-layout row: "15s  2 files read" running, the meta otherwise. */
function rightBlock(row: BoardRow): string {
  if (row.group === 'running') return [row.right, row.meta.short].filter((part) => part !== undefined && part !== '').join('  ');
  return row.meta.short;
}

/** Whether the title already names who does it ("Helper agent is waiting for you"). */
function showsWho(row: BoardRow): boolean {
  return row.who !== undefined && row.who !== '' && !row.title.startsWith(row.who);
}

interface ColumnPlan {
  /** Columns the who column takes (name + 3), 0 when no row has one. */
  readonly whoW: number;
  /** Where the scheduled meta starts, relative to the title's column. */
  readonly scheduledTitleW: number;
  /** Where a background service's state word starts, relative to its name's column. */
  readonly serviceW: number;
}

function planColumns(lines: readonly BodyLine[], inner: number): ColumnPlan {
  let who = 0;
  let title = 0;
  let meta = 0;
  let service = 0;
  for (const line of lines) {
    if (line.kind === 'service') service = Math.max(service, getDisplayWidth(line.label));
    if (line.kind !== 'entry') continue;
    if (line.layout === 'agent' && showsWho(line.entry.row)) who = Math.max(who, getDisplayWidth(line.entry.row.who!) + line.entry.depth * 2);
    if (line.layout === 'scheduled') {
      title = Math.max(title, getDisplayWidth(line.entry.row.title));
      meta = Math.max(meta, getDisplayWidth(line.entry.row.meta.short));
    }
  }
  // The who column never takes more than a third of the row.
  const whoW = who > 0 ? Math.min(who + 3, Math.floor(inner / 3)) : 0;
  // Scheduled titles line up with six columns before their words, three when that is what makes the words fit.
  const scheduledTitleW = Math.min(title + 6, Math.max(title + 3, inner - 5 - meta), Math.floor(inner * 0.6));
  return { whoW, scheduledTitleW, serviceW: Math.min(service + 3, Math.floor(inner * 0.6)) };
}

function drawEntry(canvas: SurfaceCanvas, y: number, x0: number, x1: number, line: Extract<BodyLine, { kind: 'entry' }>, plan: ColumnPlan): void {
  const t = activeTokens();
  const { entry, layout } = line;
  const row = entry.row;
  const sel = entry.selected;
  const ink = t.selectedListItemText;
  if (sel) canvas.grad(x0, y, x1 - x0 + 1, t.brand, t.brandEnd);
  const indent = entry.depth * 2;
  const dot = layout === 'agent' ? dotOf(entry) : null;
  if (dot) canvas.put(x0 + 1 + indent, y, dot.glyph, { fg: sel ? ink : dot.fg, bold: sel });
  const textX = x0 + 3;
  const end = x1 - 1; // a blank cell inside the bar on the right
  if (layout === 'scheduled') {
    const metaX = textX + plan.scheduledTitleW;
    const titleW = Math.max(1, Math.min(plan.scheduledTitleW - 2, end - textX + 1));
    canvas.put(textX, y, cutText(row.title, titleW), { fg: sel ? ink : t.text, bold: sel });
    if (row.meta.short && metaX <= end) canvas.put(metaX, y, cutText(row.meta.short, end - metaX + 1), { fg: sel ? ink : t.textMuted, bold: sel });
    return;
  }
  let x = textX + indent;
  const titleX = showsWho(row) && plan.whoW > 0 ? textX + plan.whoW
    : plan.whoW > 0 && row.group !== 'waiting' && row.ref.type === 'agent' ? textX + plan.whoW : x;
  // The right block keeps its place and the title gives way to it, down to a
  // readable minimum; past that the right block drops its last parts
  // ("finished 2 min ago · 2 files read" → "finished 2 min ago").
  const minTitle = Math.min(getDisplayWidth(row.title), 24);
  let right = rightBlock(row);
  while (right.includes(' · ') && end - getDisplayWidth(right) + 1 - 2 - titleX < minTitle) right = right.slice(0, right.lastIndexOf(' · '));
  const rightW = getDisplayWidth(right);
  const rightX = right ? end - rightW + 1 : end + 1;
  if (showsWho(row) && plan.whoW > 0) {
    const whoRoom = Math.max(1, plan.whoW - indent - 3);
    canvas.put(x, y, cutText(row.who!, whoRoom), { fg: sel ? ink : t.text, bold: sel });
    x = textX + plan.whoW;
  } else if (plan.whoW > 0 && row.group !== 'waiting' && row.ref.type === 'agent') {
    x = textX + plan.whoW;
  }
  const titleRoom = rightX - 2 - x;
  if (titleRoom > 0) canvas.put(x, y, cutText(row.title, titleRoom), { fg: sel ? ink : row.tone === 'failed' ? t.error : t.text, bold: sel });
  if (right && rightX > x) canvas.put(rightX, y, right, { fg: sel ? ink : t.textMuted, bold: sel });
  if (entry.onClick) canvas.hitTargets.push({ id: `board:${entry.key}`, x: x0, y, width: x1 - x0 + 1, height: 1, onClick: entry.onClick });
}

/** The body rows of the list level, top to bottom, and which one is selected. */
function bodyLines(list: WorkBoardListView): { lines: BodyLine[]; selectedAt: number } {
  const lines: BodyLine[] = [];
  const push = (line: BodyLine): void => { lines.push(line); };
  if (list.archive) {
    if (list.agents.length === 0) push({ kind: 'note', text: 'Nothing archived.', tone: 'muted' });
    for (const entry of list.agents) push({ kind: 'entry', entry, layout: 'agent' });
  } else if (list.error !== null) {
    push({ kind: 'note', text: `Couldn't read what is running: ${list.error}`, tone: 'error' });
  } else {
    if (list.waiting.length > 0) {
      push({ kind: 'label', text: 'Waiting for you', tone: 'warning' });
      for (const entry of list.waiting) push({ kind: 'entry', entry, layout: 'agent' });
      push({ kind: 'blank' });
    }
    if (list.empty) {
      push({ kind: 'note', text: list.filter?.query ? `Nothing matches "${list.filter.query}".` : 'Ask for something and helper agents show up here.', tone: 'muted' });
    } else if (list.agents.length > 0 || list.waiting.length === 0) {
      for (const entry of list.agents) push({ kind: 'entry', entry, layout: 'agent' });
      if (list.finishedEmpty && list.agents.length > 0) push({ kind: 'note', text: 'no finished agents this session', tone: 'muted', indent: 3 });
    }
    if (list.scheduled.length > 0 || list.eventsToday) {
      if (lines.length > 0 && lines[lines.length - 1]!.kind !== 'blank') push({ kind: 'blank' });
      push({ kind: 'label', text: 'Scheduled' });
      for (const entry of list.scheduled) push({ kind: 'entry', entry, layout: 'scheduled' });
      if (list.eventsToday) push({ kind: 'entry', entry: { ...list.eventsToday, row: { ...list.eventsToday.row, title: `${list.eventsToday.row.title} ›` } }, layout: 'scheduled' });
    }
  }
  if (!list.archive) {
    if (lines.length > 0 && lines[lines.length - 1]!.kind !== 'blank') push({ kind: 'blank' });
    const s = list.services;
    const total = s.healthy + s.unhealthy.length;
    const count = s.unhealthy.length > 0 ? `${s.healthy} healthy · ${s.unhealthy.length} not working` : `${s.healthy} healthy`;
    push({ kind: 'label', text: total === 0 ? 'Background services  none' : `Background services  ${count} ${s.open ? '⌄' : '›'}`, tone: s.unhealthy.length > 0 ? 'warning' : undefined });
    for (const entry of s.unhealthy) push({ kind: 'entry', entry, layout: 'agent' });
    if (s.open) for (const service of s.rows) push({ kind: 'service', label: service.label, state: service.state });
  }
  const selectedAt = lines.findIndex((line) => line.kind === 'entry' && line.entry.selected);
  return { lines, selectedAt };
}

function drawListLevel(f: ModalFrame, view: WorkBoardPanelView): void {
  const t = activeTokens();
  const list = view.list!;
  const width = f.r - f.l + 1;
  let top = f.top;
  if (list.filter) {
    searchRow(f, f.top, list.filter.query, list.filter.active ? '' : 'Type / to filter', list.filter.count);
    top += 2;
  }
  const bottom = f.bottom - bottomRows(view, width);
  // Wide screens put the selected row's detail on the right; 80 columns show rows and hints only.
  const wide = !f.canvas.compact && view.detail !== null;
  const split = wide ? splitListDetail(f.l, f.r, top, bottom, 0.68, 6) : null;
  const x0 = f.l;
  const x1 = split && !split.stacked ? split.x1 : f.r;
  const listBottom = split && !split.stacked ? bottom : bottom;
  const { lines, selectedAt } = bodyLines(list);
  const capacity = Math.max(1, listBottom - top + 1);
  const key = { owner: view.scrollOwner, name: 'board' };
  let start = Math.min(rememberedStart(key) ?? 0, Math.max(0, lines.length - capacity));
  if (selectedAt >= 0) {
    if (selectedAt < start) start = selectedAt;
    if (selectedAt >= start + capacity) start = selectedAt - capacity + 1;
  }
  rememberStart(key, start);
  const plan = planColumns(lines, x1 - x0 + 1);
  for (let k = 0; k < capacity && start + k < lines.length; k++) {
    const line = lines[start + k]!;
    const y = top + k;
    switch (line.kind) {
      case 'blank': break;
      case 'label': f.canvas.put(x0, y, clipText(line.text, x1 - x0 + 1), { fg: line.tone ? toneColor(line.tone) : t.textMuted }); break;
      case 'note': {
        const indent = line.indent ?? 0;
        drawTextBlock(f.canvas, x0 + indent, y, x1 - x0 + 1 - indent, [{ text: line.text, style: { fg: line.tone ? toneColor(line.tone) : t.textMuted } }], y);
        break;
      }
      case 'entry': drawEntry(f.canvas, y, x0, x1, line, plan); break;
      case 'service': {
        const stateX = x0 + 3 + plan.serviceW;
        f.canvas.put(x0 + 3, y, cutText(line.label, Math.max(1, plan.serviceW - 2)), { fg: t.textMuted });
        f.canvas.put(stateX, y, cutText(line.state, Math.max(1, x1 - 1 - stateX + 1)), { fg: t.textFaint });
        break;
      }
    }
  }
  const above = start;
  const below = Math.max(0, lines.length - start - capacity);
  f.hintRight = scrollCountText(above, below);
  if (split && view.detail && split.detailH >= 4) {
    const p = inset(f.canvas, split.detailX, split.detailY, split.detailW, split.detailH);
    drawDetail(f.canvas, p, view.detail);
  }
  drawBottom(f, view);
}

function drawFullLevel(f: ModalFrame, view: WorkBoardPanelView): void {
  const full = view.full!;
  const width = f.r - f.l + 1;
  let y = f.top;
  if (full.meta) y = drawTexts(f.canvas, f.l, y, width, [{ text: full.meta, tone: 'faint' }], f.bottom);
  if (full.header.length > 0) y = drawTexts(f.canvas, f.l, y, width, full.header, f.bottom);
  y++;
  const bottom = f.bottom - bottomRows(view, width);
  const height = bottom - y + 1;
  if (height > 0) {
    // The transcript is drawn by the conversation renderer at the width of the
    // fill minus 2 columns per side, so its own bars and fills keep their measurements.
    const bodyWidth = width + 4;
    const lines = full.body(bodyWidth, height);
    const start = Math.max(0, lines.length - height);
    for (let k = start; k < lines.length; k++) blitLine(f.canvas, f.l - 2, y + (k - start), lines[k]!, bodyWidth, activeTokens().backgroundPanel);
    if (full.scroll) { const position = full.scroll(); f.hintRight = scrollCountText(position.above, position.below); }
  }
  drawBottom(f, view);
}

function drawPickerLevel(f: ModalFrame, view: WorkBoardPanelView): void {
  const t = activeTokens();
  const picker = view.picker!;
  const width = f.r - f.l + 1;
  const y = drawTextBlock(f.canvas, f.l, f.top, width, [{ text: picker.intro, style: { fg: t.textMuted } }], f.bottom) + 1;
  const bottom = f.bottom - bottomRows(view, width);
  const rows: KitRow[] = picker.options.map((option) => ({ label: option.label, detail: option.detail, selected: option.selected }));
  const split = picker.side.length > 0 ? splitListDetail(f.l, f.r, y, bottom, 0.5, 6) : null;
  const result = drawList(f.canvas, { mouseNavigation: true, rows, top: y, bottom: split ? split.bottom : bottom, x0: f.l, x1: split ? split.x1 : f.r, scrollKey: { owner: view.scrollOwner, name: 'picker' } });
  f.hintRight = scrollCountText(result.above, result.below);
  if (split && split.detailH >= 4) {
    const p = inset(f.canvas, split.detailX, split.detailY, split.detailW, split.detailH);
    drawTexts(f.canvas, p.l, p.top, p.r - p.l + 1, picker.side, p.bottom, p.bg);
  }
  drawBottom(f, view);
}

export function renderWorkBoardPanel(view: WorkBoardPanelView, screenWidth: number, screenHeight: number): SurfaceLayer {
  const f = beginModal(screenWidth, screenHeight, { title: WORK_BOARD_TITLE, crumbs: view.crumbs, sub: view.sub, hints: view.hints });
  if (view.level === 'full' && view.full) drawFullLevel(f, view);
  else if (view.level === 'picker' && view.picker) drawPickerLevel(f, view);
  else if (view.list) drawListLevel(f, view);
  return finishModal(f);
}
