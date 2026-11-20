/**
 * First run's two screens, drawn with the surface kit (both terminal apps):
 *
 *   Welcome to GoodVibes                                         1 of 3
 *
 *   Which model should answer you?
 *
 *    ChatGPT subscription      sign in with your browser
 *     Anthropic                 paste an API key
 *     OpenRouter                paste an API key · has a free model
 *     A model on this computer  found Ollama with 3 models
 *     Another provider…         38 more
 *
 *   Found in your environment: ANTHROPIC_API_KEY · press  a  to use it and skip this step
 *
 *    ↑↓  move    ⏎  choose    esc  set up later
 *
 * and step 2, "Sign in to <name>", in one of three forms (browser, key,
 * a model on this computer), with one error line when something failed.
 * Pure drawing: the flow (first-run/first-run-flow.ts) holds the state.
 */
import { getDisplayWidth } from '@goodvibes-jev/engine/platform/platform/utils/terminal-width';
import { beginModal, finishModal, standardModalWidth, NARROW_MODAL_BREAKPOINT, wrapLines, type KitHint, type KitStyle, type ModalFrame, type SurfaceCanvas, type SurfaceLayer } from './surface-kit.js';
import { activeTokens } from './theme.js';
import type { FirstRunOffers } from '../first-run/offers.js';

/** One styled run of text; `chip` draws it as a key chip (` a `). */
export interface StyledSegment {
  readonly text: string;
  readonly tone?: 'text' | 'dim' | 'faint' | 'good' | 'bad' | 'cyan' | undefined;
  readonly bold?: boolean | undefined;
  readonly chip?: boolean | undefined;
}

export function segmentStyle(segment: StyledSegment): KitStyle {
  const t = activeTokens();
  if (segment.chip) return { fg: t.text, bg: t.border, bold: true };
  const fg = segment.tone === 'dim' ? t.textMuted
    : segment.tone === 'faint' ? t.textFaint
      : segment.tone === 'good' ? t.success
        : segment.tone === 'bad' ? t.error
          : segment.tone === 'cyan' ? t.brand
            : t.text;
  return { fg, ...(segment.bold ? { bold: true } : {}) };
}

/** The display text of a segment (a chip carries a space each side). */
function shown(segment: StyledSegment): string {
  return segment.chip ? ` ${segment.text} ` : segment.text;
}

/**
 * Wrap styled segments into rows no wider than `width`, breaking only at
 * spaces (a chip is never split). Never cuts a word unless a single word is
 * wider than the row.
 */
export function wrapSegments(segments: readonly StyledSegment[], width: number): StyledSegment[][] {
  const room = Math.max(1, width);
  // Split every plain segment into words with their trailing spaces kept.
  const pieces: StyledSegment[] = [];
  for (const segment of segments) {
    if (segment.chip) { pieces.push(segment); continue; }
    for (const part of segment.text.match(/\S+\s*|\s+/g) ?? []) pieces.push({ ...segment, text: part });
  }
  const rows: StyledSegment[][] = [];
  let row: StyledSegment[] = [];
  let used = 0;
  for (const piece of pieces) {
    const text = shown(piece);
    const bare = piece.chip ? text : text.trimEnd();
    if (used > 0 && used + getDisplayWidth(bare) > room) {
      rows.push(trimRow(row));
      row = [];
      used = 0;
      if (!piece.chip && text.trim() === '') continue;
    }
    const lead = used === 0 && !piece.chip ? { ...piece, text: piece.text.replace(/^\s+/, '') } : piece;
    if (shown(lead) === '') continue;
    row.push(lead);
    used += getDisplayWidth(shown(lead));
  }
  if (row.length > 0) rows.push(trimRow(row));
  return rows.length > 0 ? rows : [[]];
}

function trimRow(row: StyledSegment[]): StyledSegment[] {
  const last = row[row.length - 1];
  if (last && !last.chip) row[row.length - 1] = { ...last, text: last.text.trimEnd() };
  return row;
}

/** Draw one row of segments from column x; returns the column after it. */
export function drawSegments(canvas: SurfaceCanvas, x: number, y: number, segments: readonly StyledSegment[]): number {
  let cx = x;
  for (const segment of segments) cx = canvas.put(cx, y, shown(segment), segmentStyle(segment));
  return cx;
}

const NAME_COLUMN = 26;

/** The modal's width: 76 on a wide screen, the kit's full width on a narrow one. */
function firstRunWidth(screenW: number): number {
  return screenW < NARROW_MODAL_BREAKPOINT ? standardModalWidth(screenW) : Math.min(76, standardModalWidth(screenW));
}

function frame(screenW: number, screenH: number, title: string, step: string, contentRows: number, hints: readonly KitHint[]): ModalFrame {
  const t = activeTokens();
  const f = beginModal(screenW, screenH, {
    title,
    titleGlyph: { char: '', fg: t.text },
    escKey: false,
    hints,
    width: firstRunWidth(screenW),
    height: contentRows + 6,
    center: true,
  });
  f.canvas.right(f.r, f.t, step, { fg: t.textMuted });
  return f;
}

export interface ChooseStepView {
  readonly offers: FirstRunOffers | null;
  /** The focused row: 0..rows.length-1, or rows.length for "Another provider…". */
  readonly selected: number;
}

/** One provider row's cells: the name, then `how · extra` (extra on its own dim row when it does not fit). */
function offerRowLines(how: string, extra: FirstRunOffers['rows'][number]['extra'], room: number): StyledSegment[][] {
  const extraSeg: StyledSegment | null = extra ? { text: extra.text, tone: extra.tone === 'good' ? 'good' : extra.tone === 'faint' ? 'faint' : 'text' } : null;
  if (!how) return [extraSeg ? [extraSeg] : []];
  const first: StyledSegment[] = [{ text: how }];
  if (!extraSeg) return [first];
  const together = getDisplayWidth(how) + 3 + getDisplayWidth(extraSeg.text);
  if (together <= room) return [[...first, { text: ' · ', tone: 'dim' }, extraSeg]];
  return [first, ...wrapLines(extraSeg.text, room).map((line) => [{ ...extraSeg, text: line, tone: extraSeg.tone === 'good' ? 'good' as const : 'dim' as const }])];
}

/** Rows step 1 takes inside the frame (the frame adds the title, the blanks and the hints). */
function chooseLayout(view: ChooseStepView, inner: number): { readonly rows: number; readonly foundRows: StyledSegment[][] } {
  const offers = view.offers;
  if (!offers) return { rows: 3, foundRows: [] };
  const room = inner - 3 - NAME_COLUMN;
  const offerLines = offers.rows.reduce((sum, row) => sum + offerRowLines(row.how, row.extra, room).length, 0);
  const foundRows = offers.foundKey
    ? wrapSegments([
      { text: 'Found in your environment:', tone: 'dim' },
      { text: ` ${offers.foundKey.variable}`, tone: 'good' },
      { text: ' · press', tone: 'dim' },
      { text: ' ' },
      { text: 'a', chip: true },
      { text: ' to use it and skip this step', tone: 'dim' },
    ], inner)
    : [];
  return { rows: 2 + offerLines + 1 + (foundRows.length > 0 ? 1 + foundRows.length : 0), foundRows };
}

export function renderChooseStep(screenW: number, screenH: number, view: ChooseStepView): SurfaceLayer {
  const t = activeTokens();
  const width = firstRunWidth(screenW);
  // Text starts under the title (the kit puts the title one column in).
  const inner = width - 8 - 1;
  const layout = chooseLayout(view, inner);
  const f = frame(screenW, screenH, 'Welcome to GoodVibes', '1 of 3', layout.rows, [['↑↓', 'move'], ['⏎', 'choose'], ['esc', 'set up later']]);
  const x0 = f.l + 1;
  let y = f.top;
  f.canvas.put(x0, y, 'Which model should answer you?', { fg: t.text });
  y += 2;
  const offers = view.offers;
  if (!offers) return finishModal(f);
  // Rows sit three columns in; the selection bar starts one column before the name.
  const nameX = x0 + 3;
  const howX = nameX + NAME_COLUMN;
  const room = f.r - howX + 1;
  const barX = nameX - 1;
  const barW = f.r - barX + 1;
  const drawRow = (index: number, name: string, lines: StyledSegment[][]): void => {
    const selected = index === view.selected;
    lines.forEach((segments, k) => {
      if (y > f.bottom) return;
      if (selected && k === 0) {
        f.canvas.grad(barX, y, barW, t.brand, t.brandEnd);
        f.canvas.put(nameX, y, name, { fg: t.selectedListItemText, bold: true });
        let x = howX;
        for (const segment of segments) x = f.canvas.put(x, y, shown(segment), { fg: t.selectedListItemText, bold: true });
      } else {
        if (k === 0) f.canvas.put(nameX, y, name, { fg: t.text });
        drawSegments(f.canvas, howX, y, segments);
      }
      y += 1;
    });
  };
  offers.rows.forEach((row, index) => drawRow(index, row.name, offerRowLines(row.how, row.extra, room)));
  drawRow(offers.rows.length, 'Another provider…', [offers.more > 0 ? [{ text: `${offers.more} more`, tone: 'dim' }] : []]);
  if (layout.foundRows.length > 0) {
    y += 1;
    for (const segments of layout.foundRows) {
      if (y > f.bottom) break;
      drawSegments(f.canvas, x0, y, segments);
      y += 1;
    }
  }
  return finishModal(f);
}

export type SignInStepView =
  | {
    readonly kind: 'browser';
    readonly name: string;
    /** The browser was opened (false: the address must be opened by hand). */
    readonly opened: boolean;
    /** Null while the sign-in address is being prepared. */
    readonly url: string | null;
    /** The flow needs the code the page shows pasted here. */
    readonly needsCode: boolean;
    /** Waiting for the browser to come back by itself. */
    readonly waiting: boolean;
    readonly code: string;
    readonly busy: boolean;
    readonly error?: string | undefined;
    /** The throbber frame. */
    readonly frame: number;
  }
  | {
    readonly kind: 'api-key';
    readonly name: string;
    readonly typed: number;
    /** "secure storage" | "the settings file". */
    readonly storedIn: string;
    readonly busy: boolean;
    readonly error?: string | undefined;
  }
  | {
    readonly kind: 'local';
    readonly name: string;
    readonly models: readonly { readonly label: string; readonly detail: string }[];
    readonly selected: number;
    /** No model server answered on this computer. */
    readonly none: boolean;
    readonly scanning: boolean;
    readonly error?: string | undefined;
  };

const THROBBER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function signInBody(view: SignInStepView, inner: number): { readonly lines: StyledSegment[][]; readonly hints: KitHint[] } {
  const lines: StyledSegment[][] = [];
  const wrap = (segments: StyledSegment[]): void => { lines.push(...wrapSegments(segments, inner)); };
  const blank = (): void => { lines.push([]); };
  const error = view.error ? wrapSegments([{ text: '✕', tone: 'bad' }, { text: ` ${view.error}` }], inner) : [];
  if (view.kind === 'browser') {
    if (view.url === null) {
      wrap([{ text: view.busy ? 'Getting the sign-in page ready…' : 'The sign-in page could not be prepared.', tone: 'dim' }]);
    } else {
      wrap([{ text: view.opened ? 'GoodVibes opened your browser to sign in.' : 'Open this address in your browser to sign in:' }]);
      blank();
      if (view.opened) wrap([{ text: 'If it didn\'t open, go to:', tone: 'dim' }]);
      // The address is drawn whole, broken at the width (never cut).
      for (let i = 0; i < view.url.length; i += inner) lines.push([{ text: view.url.slice(i, i + inner), tone: 'cyan' }]);
      blank();
      if (view.waiting) wrap([{ text: `${THROBBER[view.frame % THROBBER.length]} `, tone: 'cyan' }, { text: 'Waiting for you to finish in the browser…' }]);
      if (view.needsCode) {
        if (view.waiting) blank();
        wrap([{ text: 'Paste the code the page shows:' }]);
        lines.push([{ text: view.code ? view.code : '▏', tone: view.code ? 'cyan' : 'faint' }, ...(view.code ? [{ text: '▏', tone: 'faint' as const }] : [])]);
      }
    }
    if (error.length > 0) { blank(); lines.push(...error); }
    return { lines, hints: [['⏎', 'continue'], ['c', 'copy the address'], ['esc', 'back']] };
  }
  if (view.kind === 'api-key') {
    wrap([{ text: `Paste your ${view.name} API key.` }]);
    blank();
    // Masked whole: no character of the key is ever shown.
    const dots = '•'.repeat(Math.min(view.typed, Math.max(1, inner - 2)));
    lines.push([{ text: dots, tone: 'cyan' }, { text: '▏', tone: 'faint' }]);
    blank();
    wrap([{ text: view.busy ? `Checking the key with ${view.name}…` : `It is stored in ${view.storedIn}, never shown again.`, tone: 'dim' }]);
    if (error.length > 0) { blank(); lines.push(...error); }
    return { lines, hints: [['⏎', 'save'], ['esc', 'back']] };
  }
  if (view.none) {
    wrap([{ text: view.scanning ? 'Looking for models on this computer…' : 'GoodVibes found no model server on this computer.' }]);
    if (!view.scanning) {
      blank();
      wrap([{ text: 'Start one (Ollama, LM Studio or llama.cpp), then press ⏎ to look again.', tone: 'dim' }]);
    }
    if (error.length > 0) { blank(); lines.push(...error); }
    return { lines, hints: [['⏎', 'look again'], ['esc', 'back']] };
  }
  wrap([{ text: 'Which model on this computer?' }]);
  blank();
  view.models.forEach((model, index) => {
    lines.push([{ text: model.label, ...(index === view.selected ? { bold: true } : {}) }, ...(model.detail ? [{ text: `  ${model.detail}`, tone: 'dim' as const }] : [])]);
  });
  if (error.length > 0) { blank(); lines.push(...error); }
  return { lines, hints: [['↑↓', 'move'], ['⏎', 'choose'], ['esc', 'back']] };
}

export function renderSignInStep(screenW: number, screenH: number, view: SignInStepView): SurfaceLayer {
  const t = activeTokens();
  const width = firstRunWidth(screenW);
  const inner = width - 8 - 1;
  const body = signInBody(view, inner);
  const title = view.kind === 'local' ? view.name : `Sign in to ${view.name}`;
  const f = frame(screenW, screenH, title, '2 of 3', body.lines.length, body.hints);
  const x0 = f.l + 1;
  let y = f.top;
  const localStart = view.kind === 'local' && !view.none ? 2 : -1;
  body.lines.forEach((segments, index) => {
    if (y > f.bottom) return;
    const listRow = view.kind === 'local' && localStart >= 0 && index >= localStart && index - localStart < view.models.length;
    if (listRow && index - localStart === view.selected) {
      f.canvas.grad(x0 + 2, y, f.r - x0 - 1, t.brand, t.brandEnd);
      let x = x0 + 3;
      for (const segment of segments) x = f.canvas.put(x, y, shown(segment), { fg: t.selectedListItemText, bold: true });
    } else {
      drawSegments(f.canvas, listRow ? x0 + 3 : x0, y, segments);
    }
    y += 1;
  });
  return finishModal(f);
}
