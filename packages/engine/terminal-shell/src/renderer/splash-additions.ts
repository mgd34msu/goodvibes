/**
 * The rows drawn under the splash on an empty conversation (both terminal
 * apps). The splash itself (logo, its lines, the hint and version) is drawn
 * and centred exactly as before; these rows go into the free rows below its
 * last row and never take part in that centring, so they cannot move it.
 *
 *   a (first run only)  You're set.  Answering with rt-1 · signed in       3 of 3
 *   b (every empty one) Try one of these in ~/projects/sample-app:
 *                          What does this project do, and how do I run its tests?
 *                          ...
 *   c (first run only)  GoodVibes asks before ...  shift+tab  changes how often it asks. ...
 *
 * Each block is drawn only when all of its rows fit between the splash's last
 * row and the composer, one blank row kept above the composer; a block that
 * does not fit is left out whole and the next one is tried.
 */
import type { Line } from '@goodvibes/engine/platform/platform/types';
import { getDisplayWidth } from '@goodvibes/engine/platform/platform/utils/terminal-width';
import { SurfaceCanvas } from './surface-kit.js';
import { activeTokens } from './theme.js';
import { drawSegments, wrapSegments, type StyledSegment } from './first-run.js';
import { readSplashAdditions, recordDrawnPrompts, requestSplashRender, takeSetFlash } from '../first-run/splash-state.js';
import { getSharedModeFlash } from '../session-permission-mode.js';

const isBlank = (line: Line): boolean => line.every((cell) => cell.char === ' ' || cell.char === '');

/** `~` for the home folder. */
function homeShort(folder: string): string {
  const home = process.env['HOME'] ?? '';
  return home && (folder === home || folder.startsWith(`${home}/`)) ? `~${folder.slice(home.length)}` : folder;
}

interface Block {
  readonly rows: readonly { readonly segments: readonly StyledSegment[]; readonly right?: string | undefined; readonly indent?: number | undefined; readonly prompt?: string | undefined }[];
}

function blank(): Block['rows'][number] {
  return { segments: [] };
}

/**
 * Draw the additions into a viewport whose splash is already centred.
 * `modeKey` is the bound key that changes the mode ("shift+tab").
 */
export function drawSplashAdditions(viewport: readonly Line[], height: number, width: number, options: { readonly modeKey?: string | undefined }): Line[] {
  const out = [...viewport];
  const view = readSplashAdditions();
  const first = out.findIndex((line) => !isBlank(line));
  if (!view || first < 0) { recordDrawnPrompts(null); return out; }
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
    blocks.push({ rows: [blank(), ...rows.map((segments, k) => ({ segments, ...(k === 0 ? { right: '3 of 3' } : {}) }))] });
  } else if (firstRun?.kind === 'not-ready') {
    const rows = wrapSegments([
      { text: 'Not set up yet.', bold: true },
      { text: `  Choose a model with /model, or run ${view.setupCommand}.`, tone: 'dim' },
    ], blockWidth);
    blocks.push({ rows: [blank(), ...rows.map((segments) => ({ segments }))] });
  }
  if (view.prompts.length > 0) {
    const title = wrapSegments([{ text: 'Try one of these in ' }, { text: homeShort(view.folder), tone: 'cyan' }, { text: ':' }], blockWidth);
    const prompts = view.prompts.flatMap((prompt) => wrapSegments([{ text: prompt }], blockWidth - 3).map((segments) => ({ segments, indent: 3, prompt })));
    blocks.push({ rows: [blank(), ...title.map((segments) => ({ segments })), ...prompts] });
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
    ], blockWidth);
    blocks.push({ rows: [blank(), ...rows.map((segments) => ({ segments }))] });
  }

  // Free rows: from the row under the splash to the row above the blank row kept over the composer.
  let room = height - 2 - last;
  let y = last + 1;
  const t = activeTokens();
  const drawnPrompts: { row: number; prompt: string }[] = [];
  for (const [index, block] of blocks.entries()) {
    if (block.rows.length > room) {
      // "You're set" left out: the status bar says it once instead (the mode segment's flash).
      if (index === 0 && firstRun?.kind === 'set') {
        const message = takeSetFlash();
        if (message) { getSharedModeFlash().start(message); requestSplashRender(); }
      }
      continue;
    }
    for (const row of block.rows) {
      const canvas = new SurfaceCanvas(width, 1);
      const end = drawSegments(canvas, left + (row.indent ?? 0), 0, row.segments);
      if (row.right && right - getDisplayWidth(row.right) > end) canvas.right(right, 0, row.right, { fg: t.textMuted });
      while (out.length <= y) out.push(canvas.lines[0]!.map((cell) => ({ ...cell, char: ' ' })));
      out[y] = canvas.lines[0]!;
      if (row.prompt) drawnPrompts.push({ row: y, prompt: row.prompt });
      y += 1;
    }
    room -= block.rows.length;
  }
  recordDrawnPrompts(drawnPrompts.length > 0 ? { prompts: view.prompts.filter((prompt) => drawnPrompts.some((entry) => entry.prompt === prompt)), rows: drawnPrompts } : null);
  return out;
}
