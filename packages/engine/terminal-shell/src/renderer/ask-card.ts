/**
 * ask-card.ts, the approval card both terminal programs draw (design ux.md
 * A2.1, A2.2): the ask's own words (permissions/ask-presentation.ts) and
 * nothing else.
 *
 *   ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄ (amber cap) ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
 *
 *     ▲ Run this command?                         in ~/projects/sample-app
 *
 *       $ bun test
 *
 *     Runs your tests. Changes no files outside this folder.
 *
 *      Yes, once    Yes, and don't ask again…    No
 *
 *      y  yes    a  don't ask again    n  no    d  details    or type why not
 *
 * One question in a sentence, what it will do (red only for what cannot be
 * undone, and only when the program has that fact), the choices with their
 * keys, and everything else behind `d`. A write or edit also shows the change
 * itself; a multi-edit edit shows each hunk with its checkbox. The card
 * scrolls when it is taller than the screen; the buttons, the remember
 * choices and the keys stay in view.
 *
 * Pure rendering; the keys live in ask-card-input.ts, which reads the same
 * buttons and default from this file so the two never disagree.
 */
import type { AskChoice, AskPresentation, PermissionPromptRequest } from '@goodvibes-jev/engine/platform/platform/permissions';
import { decodeBase64, resolveEditText } from '@goodvibes-jev/engine/platform/platform/control-plane/approval-hunk-apply';
import { getDisplayWidth } from '@goodvibes-jev/engine/platform/platform/utils/terminal-width';
import { enterAnswer } from '../blocking-permission-input.js';
import type { HunkSelectionState } from '../hunk-selection.js';
import { activeTokens } from './theme.js';
import {
  beginModal,
  finishModal,
  layoutHintRows,
  MODAL_PAD_X,
  modalInnerWidth,
  scrollCountText,
  standardModalWidth,
  wrapLines,
  type KitHint,
  type SurfaceCanvas,
  type SurfaceLayer,
} from './surface-kit.js';
import { paintKeycapHints } from './surface-kit-parts.js';
import { drawRow, measureRow, type KitRow, type KitSpan } from './surface-kit-list.js';

/** What the card shows beyond the ask itself. Both programs' pending-card slots carry these fields. */
export interface AskCardState {
  /** The chosen button (index into askCardButtons). */
  readonly choice?: number | undefined;
  /** The "don't ask again" choices are open, and which is highlighted. */
  readonly submenuOpen?: boolean | undefined;
  readonly submenuIndex?: number | undefined;
  readonly detailsExpanded?: boolean | undefined;
  /** A reason to refuse being typed, or the answer to a command's prompt. */
  readonly replyMode?: 'deny-reason' | 'exec-answer' | undefined;
  readonly replyBuffer?: string | undefined;
  readonly hunkState?: HunkSelectionState | undefined;
  /** First body row shown when the card is taller than the screen. */
  readonly scroll?: number | undefined;
  /** OTHER asks waiting behind this one. */
  readonly queueCount?: number | undefined;
  /** The composer holds a draft and the card was not addressed: every key but Tab and Ctrl+C types into the draft. */
  readonly awaitingTab?: boolean | undefined;
}

/** Columns from the question's glyph to its text: the body, buttons and keys line up with the text. */
const BODY_INDENT = 2;

/** Diff lines drawn for one change before a trailer counts the rest; every change is drawn. */
const MAX_CHANGE_LINES = 10;

/** True when the ask is the answer to a command's prompt: the card is a masked field. */
export function isCommandPromptAsk(request: Pick<PermissionPromptRequest, 'attribution'>): boolean {
  return request.attribution?.kind === 'exec-prompt';
}

/** The card's buttons, in order: the ask's own choices (none while a command's prompt is answered). */
export function askCardButtons(presentation: AskPresentation, request: Pick<PermissionPromptRequest, 'attribution'>): readonly AskChoice[] {
  if (isCommandPromptAsk(request)) return [];
  return presentation.choices;
}

/**
 * The button the card opens on, which Enter presses: the ask's default
 * (`Yes, once`, or `No` for what cannot be undone). A call the gate holds for
 * the owner because it cannot be taken back (money, a message sent as the
 * owner, an irreversible operator act) also opens on `No`, so Enter never
 * allows it, and Enter never remembers anything.
 */
export function askCardDefaultChoice(presentation: AskPresentation, request: Pick<PermissionPromptRequest, 'attribution' | 'ownerOnly'>): number {
  const buttons = askCardButtons(presentation, request);
  const no = buttons.findIndex((choice) => choice.id === 'no');
  if (enterAnswer(request) === 'deny' && no >= 0) return no;
  const marked = buttons.findIndex((choice) => choice.default === true);
  return marked >= 0 ? marked : Math.max(0, no);
}

/** The chosen button's index, clamped. */
export function askCardChoice(presentation: AskPresentation, request: Pick<PermissionPromptRequest, 'attribution' | 'ownerOnly'>, state: Pick<AskCardState, 'choice'>): number {
  const count = askCardButtons(presentation, request).length;
  return Math.max(0, Math.min(state.choice ?? askCardDefaultChoice(presentation, request), Math.max(0, count - 1)));
}

// ---------------------------------------------------------------------------
// Body rows
// ---------------------------------------------------------------------------

interface CardRow {
  readonly spans: readonly KitSpan[];
  /** Drawn as part of an element inset (bg), with this tint instead when set. */
  readonly inset?: boolean | undefined;
  readonly tint?: string | undefined;
  /** The hunk cursor row (drawn as the selected row). */
  readonly cursor?: boolean | undefined;
  /** A row of the cursor's hunk: the card keeps all of it in view. */
  readonly cursorBlock?: boolean | undefined;
}

const BLANK: CardRow = { spans: [] };

function wrapCode(line: string, width: number): string[] {
  const indent = /^\s*/.exec(line)?.[0] ?? '';
  const room = Math.max(4, width - indent.length);
  return wrapLines(line.slice(indent.length), room).map((part) => `${indent}${part}`);
}

function textRows(text: string, width: number, span: Omit<KitSpan, 'text'>, indent = ''): CardRow[] {
  return text.split('\n').flatMap((para) => wrapLines(para, Math.max(1, width - indent.length)))
    .map((line) => ({ spans: [{ ...span, text: `${indent}${line}` }] }));
}

function insetRows(rows: CardRow[]): CardRow[] {
  const blank: CardRow = { spans: [], inset: true };
  return [blank, ...rows.map((r) => ({ ...r, inset: true })), blank];
}

const LABEL_PAD = 12;

function labelled(label: string, value: string, width: number, fg: string): CardRow[] {
  const t = activeTokens();
  const lines = value.split('\n').flatMap((para) => wrapLines(para, Math.max(8, width - LABEL_PAD)));
  return lines.map((line, i) => ({
    spans: i === 0
      ? [{ text: label.padEnd(LABEL_PAD), fg: t.textFaint }, { text: line, fg }]
      : [{ text: `${' '.repeat(LABEL_PAD)}${line}`, fg }],
  }));
}

function diffRows(lines: readonly string[], width: number): CardRow[] {
  const t = activeTokens();
  const rows: CardRow[] = [];
  for (const raw of lines) {
    const sign = raw.startsWith('+') ? '+' : raw.startsWith('-') ? '-' : raw.startsWith('@@') ? '@' : ' ';
    const body = sign === '@' || sign === ' ' ? raw : raw.slice(1);
    const tint = sign === '+' ? t.diffAddedBg : sign === '-' ? t.diffRemovedBg : undefined;
    const fg = sign === '@' ? t.info : sign === ' ' ? t.textFaint : t.text;
    const signFg = sign === '+' ? t.success : sign === '-' ? t.error : t.textFaint;
    wrapCode(body, Math.max(4, width - 2)).forEach((part, i) => {
      rows.push({
        spans: sign === '@' || sign === ' ' ? [{ text: part, fg }] : [{ text: i === 0 ? `${sign} ` : '  ', fg: signFg }, { text: part, fg }],
        inset: true,
        ...(tint ? { tint } : {}),
      });
    });
  }
  return rows;
}

function cappedChange(lines: readonly string[]): string[] {
  if (lines.length <= MAX_CHANGE_LINES) return [...lines];
  return [...lines.slice(0, MAX_CHANGE_LINES), ` … +${lines.length - MAX_CHANGE_LINES} more lines`];
}

function textLines(text: string): string[] {
  return text === '' ? [] : text.replace(/\n$/, '').split('\n');
}

function contentChange(path: string, text: string): string[] {
  if (/[\u0000�]/.test(text)) return [`@@ ${path}: binary content, not shown @@`];
  const lines = textLines(text);
  return [`@@ ${path}${lines.length === 0 ? ' (empty file)' : ''} @@`, ...cappedChange(lines.map((line) => `+${line}`))];
}

/** An edit entry's find and replace text, read through the platform's one rule. */
function editText(entry: Record<string, unknown>): { readonly find: string; readonly replace: string } | null {
  const fields = {
    ...(typeof entry['find'] === 'string' ? { find: entry['find'] } : {}),
    ...(typeof entry['replace'] === 'string' ? { replace: entry['replace'] } : {}),
    ...(typeof entry['find_base64'] === 'string' ? { find_base64: entry['find_base64'] } : {}),
    ...(typeof entry['replace_base64'] === 'string' ? { replace_base64: entry['replace_base64'] } : {}),
  };
  if (!('find' in fields || 'find_base64' in fields) || !('replace' in fields || 'replace_base64' in fields)) return null;
  const text = resolveEditText(fields as Parameters<typeof resolveEditText>[0]);
  return 'error' in text ? null : { find: text.find, replace: text.replace };
}

function editChangeLines(text: { readonly find: string; readonly replace: string }): string[] {
  return [...text.find.split('\n').map((l) => `-${l}`), ...(text.replace === '' ? [] : text.replace.split('\n').map((l) => `+${l}`))];
}

/**
 * The change a write or edit makes, as unified-diff lines read from the
 * arguments the ask carries (no file is read). Every file and every edit gets
 * its header and first lines; a longer change ends in a trailer counting the
 * rest. Null for any other ask, or in hunk mode (the hunks draw themselves).
 */
export function askChangeLines(request: Pick<PermissionPromptRequest, 'tool' | 'args'>, hunkState: HunkSelectionState | undefined): string[] | null {
  if (hunkState || (request.tool !== 'write' && request.tool !== 'edit')) return null;
  const args = request.args ?? {};
  const target = typeof args['path'] === 'string' ? args['path'] : typeof args['file'] === 'string' ? args['file'] : '';
  const out: string[] = [];
  if (Array.isArray(args['files'])) {
    for (const file of args['files']) {
      if (!file || typeof file !== 'object') continue;
      const entry = file as Record<string, unknown>;
      const path = typeof entry['path'] === 'string' ? entry['path'] : '(no path)';
      const text = typeof entry['content_base64'] === 'string' ? decodeBase64(entry['content_base64'])
        : typeof entry['content'] === 'string' ? entry['content'] : null;
      if (text !== null) out.push(...contentChange(path, text));
    }
  }
  if (typeof args['content'] === 'string') out.push(...contentChange(target || '(new content)', args['content']));
  if (Array.isArray(args['edits'])) {
    for (const edit of args['edits']) {
      if (!edit || typeof edit !== 'object') continue;
      const entry = edit as Record<string, unknown>;
      const text = editText(entry);
      if (!text) continue;
      out.push(`@@ ${typeof entry['path'] === 'string' ? entry['path'] : target} @@`);
      out.push(...cappedChange(editChangeLines(text)));
    }
  }
  return out.length > 0 ? out : null;
}

function hunkRows(hunkState: HunkSelectionState, width: number): CardRow[] {
  const t = activeTokens();
  const rows: CardRow[] = [];
  const { hunks, cursor, selected } = hunkState;
  rows.push(...textRows(`${selected.size} of ${hunks.length} changes selected`, width + 4, { fg: t.textMuted }));
  hunks.forEach((hunk, i) => {
    const on = selected.has(i);
    const atCursor = i === cursor;
    wrapLines(`${i + 1}. ${hunk.path}`, Math.max(4, width)).forEach((part, k) => rows.push({
      spans: [{ text: k === 0 ? (on ? '[x] ' : '[ ] ') : '    ', fg: on ? t.success : t.textFaint, bold: true }, { text: part, fg: on ? t.text : t.textMuted }],
      cursor: atCursor,
      cursorBlock: atCursor,
    }));
    const diff = insetRows(diffRows(cappedChange(editChangeLines(hunk)), width));
    rows.push(...(atCursor ? diff.map((row) => ({ ...row, cursorBlock: true })) : diff));
  });
  return rows;
}

function relativize(path: string, cwd: string | undefined): string {
  if (!cwd || !path.startsWith('/')) return path;
  if (path === cwd) return '.';
  const prefix = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** What the ask acts on: every command in full (wrapped, never cut), every path, address or line. */
function subjectRows(presentation: AskPresentation, request: PermissionPromptRequest, width: number): CardRow[] {
  const t = activeTokens();
  const subject = presentation.subject;
  if (!subject) return [];
  const indent = '';
  const room = Math.max(8, width - 2);
  if (subject.kind === 'command') {
    const [command, ...rest] = subject.lines;
    const rows: CardRow[] = [];
    if (command !== undefined) {
      // Every command the call runs, in full.
      const commands = isCommandPromptAsk(request) ? [command] : subject.lines;
      for (const each of commands) {
        each.split('\n').forEach((para, p) => wrapCode(para, room).forEach((line, i) => rows.push({
          spans: [{ text: indent }, { text: p === 0 && i === 0 ? '$ ' : '  ', fg: t.primary }, { text: line, fg: t.text }],
        })));
      }
    }
    // A command's prompt: what it is asking, in the warning color.
    if (isCommandPromptAsk(request)) for (const prompt of rest) rows.push(...textRows(prompt, width, { fg: t.warning }, indent));
    return rows;
  }
  const values = subject.kind === 'paths' ? subject.lines.map((path) => relativize(path, request.workingDirectory)) : subject.lines;
  return values.flatMap((value) => textRows(value, width, { fg: t.text }, indent));
}

function bodyRows(presentation: AskPresentation, request: PermissionPromptRequest, state: AskCardState, width: number): CardRow[] {
  const t = activeTokens();
  const rows: CardRow[] = [];
  const push = (block: readonly CardRow[]): void => {
    if (block.length === 0) return;
    if (rows.length > 0) rows.push(BLANK);
    rows.push(...block);
  };
  // Who asked, when it was not this conversation's own model.
  const origin = presentation.origin;
  if (origin && origin.by !== 'GoodVibes') {
    push(textRows(`Asked by ${origin.by}${origin.sessionTitle ? ` in "${origin.sessionTitle}"` : ''}`, width, { fg: t.textMuted }));
  }
  push(subjectRows(presentation, request, width));
  if (presentation.body) push(textRows(presentation.body, width, { fg: t.text }));
  const change = askChangeLines(request, state.hunkState);
  if (change) push(insetRows(diffRows(change, width - 4)));
  if (state.hunkState) push(hunkRows(state.hunkState, width - 4));
  const consequence = presentation.consequence;
  if (consequence) push(textRows(consequence.text, width, { fg: consequence.tone === 'cannot-undo' ? t.error : t.textMuted }));
  if (state.detailsExpanded) {
    push([
      ...labelled('Why', presentation.why, width, t.textMuted),
      ...presentation.details.flatMap((detail) => labelled(detail.label, detail.value, width, detail.label === 'Arguments' ? t.textFaint : t.textMuted)),
    ]);
  }
  const replyMode = isCommandPromptAsk(request) ? 'exec-answer' : state.replyMode;
  if (replyMode) {
    // A command's prompt is often a password: one dot per character, never in clear.
    const typed = state.replyBuffer ?? '';
    const shown = replyMode === 'exec-answer' ? '•'.repeat([...typed].length) : typed;
    push(insetRows(labelled(replyMode === 'exec-answer' ? 'Answer' : 'Why not:', `${shown}▏`, width - 4, t.text)));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** The key row, and the dim words after it ("or type why not"). */
function cardKeys(presentation: AskPresentation, request: PermissionPromptRequest, state: AskCardState): { hints: KitHint[]; tail?: string | undefined } {
  if (state.awaitingTab) return { hints: [['tab', 'answer this request (your draft stays)'], ['ctrl+c', 'refuse and stop the turn']] };
  if (isCommandPromptAsk(request)) {
    return { hints: [['⏎', 'send the answer'], ['esc', (state.replyBuffer ?? '').length > 0 ? 'clear' : 'decline'], ['ctrl+c', 'stop the turn']] };
  }
  if (state.replyMode === 'deny-reason') return { hints: [['⏎', 'refuse with this reason'], ['esc', 'back'], ['ctrl+c', 'stop the turn']] };
  if (state.submenuOpen) return { hints: [['↑↓', 'choose'], ['⏎', 'yes, and remember'], ['esc', 'back']] };
  const offered = presentation.remember.offered;
  if (state.hunkState) {
    return { hints: [['↑↓', 'change'], ['space', 'keep or leave out'], ['←→', 'choose'], ['⏎', 'press'], ['n', 'no'], ['d', state.detailsExpanded ? 'hide details' : 'details']] };
  }
  const hints: KitHint[] = [
    ['y', 'yes'],
    ...(offered ? [['a', 'don\'t ask again'] as const] : []),
    ['n', 'no'],
    ['d', state.detailsExpanded ? 'hide details' : 'details'],
  ];
  return { hints, ...(presentation.typeToRefuse ? { tail: 'or type why not' } : {}) };
}

/** Rows the keys take at `width`, the dim tail included. */
function keyRows(keys: { hints: KitHint[]; tail?: string | undefined }, width: number): { rows: KitHint[][]; tailOwnRow: boolean } {
  const rows = layoutHintRows(keys.hints, width);
  if (!keys.tail) return { rows, tailOwnRow: false };
  const last = rows[rows.length - 1] ?? [];
  const used = last.reduce((sum, [key, action], i) => sum + (i > 0 ? 3 : 0) + getDisplayWidth(key) + 3 + getDisplayWidth(action), 0);
  return { rows, tailOwnRow: used + 2 + getDisplayWidth(keys.tail) > width };
}

/** A chosen button: the brand gradient with dark bold text; the rest quiet chips. */
function drawButton(canvas: SurfaceCanvas, x: number, y: number, label: string, chosen: boolean): number {
  const t = activeTokens();
  const text = ` ${label} `;
  if (!chosen) return canvas.put(x, y, text, { fg: t.textMuted, bg: t.border });
  const end = canvas.put(x, y, text, { fg: t.selectedListItemText, bold: true });
  canvas.grad(x, y, end - x, t.brand, t.brandEnd);
  return end;
}

function buttonsWidth(buttons: readonly AskChoice[]): number {
  return buttons.reduce((sum, choice, i) => sum + (i > 0 ? 2 : 0) + getDisplayWidth(choice.label) + 2, 0);
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/** The approval card as a modal layer. */
export function renderAskCard(
  presentation: AskPresentation,
  request: PermissionPromptRequest,
  state: AskCardState,
  screenWidth: number,
  screenHeight: number,
): SurfaceLayer {
  const t = activeTokens();
  const width = standardModalWidth(screenWidth);
  const inner = modalInnerWidth(width);
  // Everything under the question lines up with its text, two columns in from the glyph.
  const body = bodyRows(presentation, request, state, inner - BODY_INDENT);
  const buttons = askCardButtons(presentation, request);
  const keys = cardKeys(presentation, request, state);
  const keyLayout = keyRows(keys, inner - BODY_INDENT);
  const keyHeight = keyLayout.rows.length + (keyLayout.tailOwnRow ? 1 : 0);
  // Buttons wrap only when a narrow screen cannot hold them on one row.
  const buttonRows = buttons.length === 0 ? 0 : buttonsWidth(buttons) <= inner - BODY_INDENT ? 1 : buttons.length;
  const remember = presentation.remember;
  const tiers = state.submenuOpen && remember.offered ? remember.tiers : [];
  const submenuIndex = Math.max(0, Math.min(state.submenuIndex ?? 0, tiers.length - 1));
  const tierX0 = MODAL_PAD_X + BODY_INDENT + 2;
  const tierX1 = width - MODAL_PAD_X - 1;
  const tierRows = tiers.map((tier, i): KitRow => ({ label: `${i + 1}  ${tier.label}`, desc: tier.detail, selected: i === submenuIndex }));
  const tierHeight = tierRows.reduce((sum, row) => sum + measureRow(row, tierX0, tierX1), 0);
  // Under the scrolling body, always in view: blank, buttons, the remember choices, blank, keys.
  const pinned = (buttonRows > 0 ? buttonRows + 1 : 0) + (tierRows.length > 0 ? tierHeight + 1 : 0) + 1 + keyHeight;
  const cannotUndo = presentation.mark === 'cannot-undo';
  const f = beginModal(screenWidth, screenHeight, {
    title: presentation.question,
    titleGlyph: presentation.mark === 'question'
      ? { char: '?', fg: t.primary }
      : { char: '▲', fg: cannotUndo ? t.error : t.warning },
    width,
    // Rows: padding, title, blank, body, pinned, the empty last row.
    height: body.length + pinned + 4,
    center: true,
    cap: cannotUndo ? 'danger' : 'warning',
    escKey: false,
  });

  // Where, and how many more wait behind it, on the title row when it fits beside the question.
  const right = [presentation.place?.full, state.queueCount && state.queueCount > 0 ? `${state.queueCount} more waiting` : undefined]
    .filter((part): part is string => part !== undefined && part !== '').join(' · ');
  if (right && 2 + getDisplayWidth(presentation.question) + 3 + getDisplayWidth(right) <= inner) f.canvas.right(f.r, f.t, right, { fg: t.textFaint });

  const scrollBottom = f.bottom - pinned;
  const capacity = Math.max(1, scrollBottom - f.top + 1);
  const maxScroll = Math.max(0, body.length - capacity);
  let scroll = Math.max(0, Math.min(state.scroll ?? 0, maxScroll));
  // Keep the cursor's whole hunk in view: its header and its change.
  const cursorRow = body.findIndex((r) => r.cursor);
  if (cursorRow >= 0) {
    let blockEnd = cursorRow;
    while (blockEnd + 1 < body.length && body[blockEnd + 1]!.cursorBlock) blockEnd++;
    const lastStart = blockEnd - capacity + 1;
    scroll = lastStart <= cursorRow ? Math.min(cursorRow, Math.max(scroll, lastStart)) : Math.min(lastStart, Math.max(scroll, cursorRow));
    scroll = Math.max(0, Math.min(scroll, maxScroll));
  }
  for (let i = 0; i < capacity && scroll + i < body.length; i++) {
    const row = body[scroll + i]!;
    const y = f.top + i;
    if (row.inset) f.canvas.fill(f.l, y, f.r - f.l + 3, 1, row.tint ?? t.backgroundElement);
    if (row.cursor) {
      drawRow(f.canvas, y, { spans: row.spans.map((s) => ({ ...s, fg: undefined })), selected: true }, f.l + BODY_INDENT, f.r);
      continue;
    }
    let x = f.l + BODY_INDENT;
    for (const span of row.spans) x = f.canvas.put(x, y, span.text, { fg: span.fg ?? t.text, bold: span.bold });
  }
  const hidden = scrollCountText(scroll, Math.max(0, body.length - scroll - capacity));

  let y = scrollBottom + 1;
  if (buttonRows > 0) {
    y++;
    const chosen = askCardChoice(presentation, request, state);
    let bx = f.l + BODY_INDENT;
    buttons.forEach((choice, i) => {
      if (buttonRows > 1 && i > 0) { y++; bx = f.l + BODY_INDENT; }
      bx = drawButton(f.canvas, bx, y, choice.label, i === chosen) + 2;
    });
    // Why nothing is offered to remember, beside the buttons ("always asks · can't be remembered").
    if (!remember.offered && !isCommandPromptAsk(request) && !state.hunkState && buttonRows === 1) {
      const why = remember.why;
      if (bx + getDisplayWidth(why) + 2 <= f.r) f.canvas.right(f.r, y, why, { fg: t.textFaint });
    }
    y++;
  }
  if (tierRows.length > 0) {
    y++;
    for (const row of tierRows) {
      if (y > f.bottom) break;
      y += drawRow(f.canvas, y, row, tierX0, tierX1, f.bottom);
    }
  }

  // The keys, on the last rows, then the dim tail.
  let ky = f.bottom - keyHeight + 1;
  let lastEnd = f.l + BODY_INDENT;
  for (const hintRow of keyLayout.rows) {
    const line = f.canvas.lines[ky];
    if (line) lastEnd = paintKeycapHints(line, f.l + BODY_INDENT, f.r + 1, hintRow, { fg: t.textMuted });
    ky++;
  }
  if (keys.tail) {
    if (keyLayout.tailOwnRow) f.canvas.put(f.l + BODY_INDENT, ky, keys.tail, { fg: t.textFaint });
    else f.canvas.put(lastEnd + 2, ky - 1, keys.tail, { fg: t.textFaint });
  }
  if (hidden) f.canvas.right(f.r, f.bottom - keyHeight, hidden, { fg: t.textFaint });
  return finishModal(f);
}
