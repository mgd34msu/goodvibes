/**
 * The rows drawn under the splash on an empty conversation (both terminal
 * apps). The splash itself (logo, its lines, the hint and version) is drawn
 * and centred exactly as before; these rows go into the free rows below its
 * last row and never take part in that centring, so they cannot move it.
 *
 *   a  You're set.  Answering with rt-1 · signed in       3 of 3
 *   c  GoodVibes asks before ...  shift+tab  changes how often it asks. ...
 *
 * Both are drawn only on first run. The blocks are packed with no blank row
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
import { readSplashAdditions, requestSplashRender, takeSetFlash } from '../first-run/splash-state.js';
import { getSharedModeFlash } from '../session-permission-mode.js';

const isBlank = (line: Line): boolean => line.every((cell) => cell.char === ' ' || cell.char === '');

interface Block {
  readonly kind: 'a' | 'c';
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
  if (!view || first < 0) return out;
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
  if (firstRun?.kind === 'set') {
    const rows = wrapSegments([
      { text: 'You\'re set.', bold: true },
      { text: '  Answering with', tone: 'dim' },
      { text: ` ${firstRun.model}` },
      { text: ' · ', tone: 'dim' },
      { text: firstRun.signIn, tone: 'good' },
    ], blockWidth - 8);
    blocks.push({ kind: 'a', rows: rows.map((segments, k) => ({ segments, ...(k === 0 ? { right: '3 of 3' } : {}) })) });
  } else if (firstRun?.kind === 'not-ready') {
    const rows = wrapSegments([
      { text: 'Not set up yet.', bold: true },
      { text: `  Choose a model with /model, or run ${view.setupCommand}.`, tone: 'dim' },
    ], blockWidth);
    blocks.push({ kind: 'a', rows: rows.map((segments) => ({ segments })) });
  }
  if (firstRun?.kind === 'set' && view.asksBefore) {
    const rows = wrapSegments([
      { text: view.asksBefore, tone: 'dim' },
      // The key that changes the mode, as bound; with none bound, the clause about it is left out.
      ...(options.modeKey ? [{ text: ' ' }, { text: options.modeKey, chip: true }, { text: ' changes how often it asks.', tone: 'dim' as const }] : []),
      { text: '   Web UI, phone, channels and everything else:', tone: 'dim' },
      { text: ' ' },
      { text: view.setupCommand, chip: true },
      { text: ' whenever you want them.', tone: 'dim' },
    ], sentenceWidth);
    blocks.push({ kind: 'c', rows: rows.map((segments) => ({ segments })) });
  }

  // Free rows: every row under the splash's last row (the composer is below the viewport).
  const free = height - 1 - last;
  const rowsOf = (list: readonly Block[]): number => list.reduce((sum, block) => sum + block.rows.length, 0);
  // Too short for every block: the sentence goes first; block a goes last.
  let shown: Block[] = blocks;
  for (const drop of ['c', 'a'] as const) {
    if (rowsOf(shown) <= free) break;
    shown = shown.filter((block) => block.kind !== drop);
  }
  if (firstRun?.kind === 'set' && !shown.some((block) => block.kind === 'a')) {
    // "You're set" left out: the status bar says it once instead (the mode segment's flash).
    const message = takeSetFlash();
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
