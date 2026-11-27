/**
 * The rows drawn under the splash on an empty conversation (both terminal
 * apps). The splash itself (logo, its lines, the hint and version) is drawn
 * and centred exactly as before; these rows go into the free rows below its
 * last row and never take part in that centring, so they cannot move it.
 *
 *   a  You're set.  Answering with rt-1 · signed in       3 of 3
 *   b  The terminal app on this computer has settings.  ⏎  brings them over, ... (later: /setup import-settings)
 *   c  GoodVibes asks before ...  shift+tab  changes when GoodVibes asks. ...
 *   d  Ask me is in force: no decision model can answer yet ... To choose who decides: System, Setup, Who decides.
 *   r  [Recovery] "<title>" stopped before it was saved (...): Ctrl+R restores it, ... (while that offer stands)
 *
 * All are drawn only on first run (b only when the app was given an import
 * command: the Agent's first launch where the terminal app has settings). The blocks are packed with no blank row
 * between them, and the sentence of block c wraps to the screen's width so it
 * takes as few rows as its words need. Both are drawn when their rows fit
 * between the splash's last row and the composer; when they do not, the
 * sentence (c) is left out first, whole. Rows left over become blank rows:
 * first one under the splash, then one above the composer, then between blocks.
 */
import type { Line } from '@goodvibes/engine/platform/platform/types';
import { getDisplayWidth } from '@goodvibes/engine/platform/platform/utils/terminal-width';
import { SurfaceCanvas } from './surface-kit.js';
import { activeTokens } from './theme.js';
import { drawSegments, wrapSegments, type StyledSegment } from './first-run.js';
import { noteSplashImportShown, readSplashAdditions, requestSplashRender, takeDroppedLineFlash, takeSetFlash } from '../first-run/splash-state.js';
import { getSharedModeFlash } from '../session-permission-mode.js';

const isBlank = (line: Line): boolean => line.every((cell) => cell.char === ' ' || cell.char === '');

interface Block {
  readonly kind: 'a' | 'b' | 'c' | 'd' | 'r' | 's';
  readonly rows: readonly { readonly segments: readonly StyledSegment[]; readonly right?: string | undefined }[];
}

/**
 * Draw the additions into a viewport whose splash is already centred.
 * `modeKey` is the bound key that changes the mode ("shift+tab").
 */
export function drawSplashAdditions(viewport: readonly Line[], height: number, width: number, options: { readonly modeKey?: string | undefined }): Line[] {
  const out = [...viewport];
  const view = readSplashAdditions();
  const first = out.findIndex((line) => !isBlank(line));
  if (!view || first < 0) { noteSplashImportShown(false); return out; }
  let last = out.length - 1;
  while (last > first && isBlank(out[last]!)) last--;
  // The blocks line up with the splash's own left edge (its top rule), inside the screen.
  const top = out[first]!;
  const leftEdge = top.findIndex((cell) => cell.char !== ' ' && cell.char !== '');
  let rightEdge = top.length - 1;
  while (rightEdge > leftEdge && (top[rightEdge]!.char === ' ' || top[rightEdge]!.char === '')) rightEdge--;
  const left = Math.max(2, leftEdge);
  const right = Math.min(width - 3, rightEdge);
  const blockWidth = Math.max(10, right - left + 1);
  // The asks sentence runs to the screen's right margin, not the splash's: as few rows as its words need.
  const sentenceWidth = Math.max(blockWidth, width - 3 - left);

  const blocks: Block[] = [];
  const firstRun = view.firstRun;
  // The crash-recovery offer, first: the one line naming the key that restores the last conversation.
  if (view.recoveryLine) blocks.push({ kind: 'r', rows: wrapSegments([{ text: view.recoveryLine }], sentenceWidth).map((segments) => ({ segments })) });
  // What the program said as it started (the daemon started or missing, the repair, the workspace, what was restored).
  for (const line of view.startLines) blocks.push({ kind: 's', rows: wrapSegments([{ text: line, tone: 'dim' }], sentenceWidth).map((segments) => ({ segments })) });
  if (firstRun?.kind === 'set' && firstRun.using) {
    // Taken without asking: the one line that says which provider and model, and from where; no step count.
    const rows = wrapSegments([{ text: firstRun.using }], sentenceWidth);
    blocks.push({ kind: 'a', rows: rows.map((segments) => ({ segments })) });
  } else if (firstRun?.kind === 'set') {
    const rows = wrapSegments([
      { text: 'You\'re set.', bold: true },
      { text: '  Answering with', tone: 'dim' },
      { text: ` ${firstRun.model}` },
      { text: ' · ', tone: 'dim' },
      { text: firstRun.signIn, tone: 'good' },
    ], blockWidth - 8);
    const steps = firstRun.steps ?? 3;
    blocks.push({ kind: 'a', rows: rows.map((segments, k) => ({ segments, ...(k === 0 ? { right: `${steps} of ${steps}` } : {}) })) });
  } else if (firstRun?.kind === 'not-ready') {
    const rows = wrapSegments([
      { text: 'Not set up yet.', bold: true },
      { text: `  Choose a model with /model, or set up the rest in ${view.setupWhere}.`, tone: 'dim' },
    ], blockWidth);
    blocks.push({ kind: 'a', rows: rows.map((segments) => ({ segments })) });
  }
  // The mode in force and where "Who decides" is chosen: first run never asks it over the composer.
  const decides = firstRun?.kind === 'decides' || firstRun?.kind === 'set' ? firstRun.decides : undefined;
  if (decides) blocks.push({ kind: 'd', rows: wrapSegments([{ text: decides }], sentenceWidth).map((segments) => ({ segments })) });
  if (view.importWhere && firstRun?.kind !== 'pending') {
    // One key where it is offered: Enter on the empty composer; where the control is is named for later.
    const rows = wrapSegments(view.importOnEnter ? [
      { text: 'The terminal app on this computer has settings.', tone: 'dim' },
      { text: ' ' },
      { text: '⏎', chip: true },
      { text: ` brings them over and says what changed (later: ${view.importWhere}).`, tone: 'dim' },
    ] : [
      { text: 'The terminal app on this computer has settings.', tone: 'dim' },
      { text: ' ' },
      { text: view.importWhere, chip: true },
      { text: ' brings them over and says what changed.', tone: 'dim' },
    ], sentenceWidth);
    blocks.push({ kind: 'b', rows: rows.map((segments) => ({ segments })) });
  }
  if (firstRun?.kind === 'set' && view.asksBefore) {
    const rows = wrapSegments([
      { text: view.asksBefore, tone: 'dim' },
      // The key that changes the mode, as bound; with none bound, the clause about it is left out.
      ...(options.modeKey ? [{ text: ' ' }, { text: options.modeKey, chip: true }, { text: ' changes when GoodVibes asks.', tone: 'dim' as const }] : []),
      { text: '   Web UI, phone, channels and everything else:', tone: 'dim' },
      { text: ' ' },
      { text: view.setupWhere, chip: true },
      { text: ' whenever you want them.', tone: 'dim' },
    ], sentenceWidth);
    blocks.push({ kind: 'c', rows: rows.map((segments) => ({ segments })) });
  }

  // Free rows: every row under the splash's last row (the composer is below the viewport).
  const free = height - 1 - last;
  const rowsOf = (list: readonly Block[]): number => list.reduce((sum, block) => sum + block.rows.length, 0);
  // Too short for every block: the sentence goes first, then the import line, then block a, then the mode line (d);
  // the recovery offer's line (r) goes last.
  let shown: Block[] = blocks;
  for (const drop of ['c', 'b', 'a', 's', 'd', 'r'] as const) {
    if (rowsOf(shown) <= free) break;
    if (drop === 's') {
      // The start lines go one at a time, the oldest first: as many as there is room for stay.
      while (rowsOf(shown) > free && shown.some((block) => block.kind === 's')) {
        const at = shown.findIndex((block) => block.kind === 's');
        shown = shown.filter((_, index) => index !== at);
      }
      continue;
    }
    shown = shown.filter((block) => block.kind !== drop);
  }
  // The import offer acts on Enter only while its line is on screen (splash-state.ts takeSplashEnterAction).
  noteSplashImportShown(shown.some((block) => block.kind === 'b'));
  if (firstRun?.kind === 'set' && !shown.some((block) => block.kind === 'a')) {
    // "You're set" left out: the status bar says it once instead (the mode segment's flash).
    const message = takeSetFlash();
    if (message) { getSharedModeFlash().start(message); requestSplashRender(); }
  }
  // The recovery offer's line, or else the mode line, left out (a short screen): the status bar says it once instead,
  // in words short enough for its mode segment (the whole line is in System, Notices, or on the Setup list).
  const dropped = view.recoveryLine && !shown.some((block) => block.kind === 'r') ? 'Not saved before it stopped: Ctrl+R restores it'
    : decides && !shown.some((block) => block.kind === 'd') ? `${decides.split(/[,:(]/)[0]!.trim()} · who decides: System, Setup` : undefined;
  if (dropped) {
    const message = takeDroppedLineFlash(dropped);
    if (message) { getSharedModeFlash().start(message); requestSplashRender(); }
  }
  // Rows to spare become blank rows: under the splash, then above the composer, then between blocks.
  let spare = free - rowsOf(shown);
  const take = (): number => (spare > 0 ? (spare -= 1, 1) : 0);
  const underSplash = shown.length > 0 ? take() : 0;
  take(); // the blank row kept above the composer
  const between = shown.map((_, index) => (index > 0 ? take() : 0));
  let y = last + 1 + underSplash;
  const t = activeTokens();
  for (const [index, block] of shown.entries()) {
    y += between[index] ?? 0;
    for (const row of block.rows) {
      const canvas = new SurfaceCanvas(width, 1);
      const end = drawSegments(canvas, left, 0, row.segments);
      if (row.right && right - getDisplayWidth(row.right) > end) canvas.right(right, 0, row.right, { fg: t.textMuted });
      while (out.length <= y) out.push(canvas.lines[0]!.map((cell) => ({ ...cell, char: ' ' })));
      out[y] = canvas.lines[0]!;
      y += 1;
    }
  }
  return out;
}
