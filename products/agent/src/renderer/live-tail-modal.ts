/**
 * The live tail of one background process (Enter in the process monitor),
 * drawn with the modal surface kit: the process's status in the crumb under
 * "Runtime activity", the command, then the output in an element panel with
 * every shown line wrapped in full, following the newest output unless
 * scrolled back. Standard error follows standard output under its own
 * heading (the manager keeps the two streams apart). Esc goes back to the
 * process monitor; a running process keeps running (x then y stops it).
 */

import type { ProcessManager } from '@goodvibes-jev/engine/platform/platform/tools';
import type { ProcessEntry } from './process-modal.ts';
import { activeTokens } from './theme.ts';
import { beginModal, finishModal, scrollCountText, wrapLines, type KitHint, type SurfaceLayer } from './surface-kit.ts';
import { panel } from './surface-kit-parts.ts';

const LIVE_TAIL_EMPTY_OUTPUT = '(no output yet)';
const LIVE_TAIL_NO_OUTPUT = '(no output)';
const LIVE_TAIL_PRUNED = '(output no longer kept)';
const LIVE_TAIL_STDERR_HEADING = '── stderr ──';
const LIVE_TAIL_HINTS: readonly KitHint[] = [['↑↓ j k', 'scroll'], ['x', 'stop, then y to confirm'], ['esc', 'back, the process keeps running']];
/** Shown once x or Delete asked to stop the process: only y stops it. */
const LIVE_TAIL_CONFIRM_HINTS: readonly KitHint[] = [['y', 'stop it'], ['any other key', 'keep it running']];

/** The static strings this surface can show (checked by package verification). */
export function renderLiveTailModalPackageText(): string {
  return [
    'Runtime activity',
    'Live output',
    '$ <process>',
    LIVE_TAIL_EMPTY_OUTPUT,
    LIVE_TAIL_NO_OUTPUT,
    LIVE_TAIL_PRUNED,
    LIVE_TAIL_STDERR_HEADING,
    '<n> more ↑',
    '<n> more ↓',
    ...LIVE_TAIL_HINTS.map(([, action]) => action),
    ...LIVE_TAIL_CONFIRM_HINTS.map(([, action]) => action),
  ].join('\n');
}

export interface LiveTailModalDeps {
  readonly processManager: Pick<ProcessManager, 'stop' | 'getOutput'> & Partial<Pick<ProcessManager, 'list'>>;
}

export class LiveTailModal {
  public active = false;
  public entry: ProcessEntry | null = null;
  public scrollOffset = 0;
  /** x or Delete asked to stop the open process; the next key decides (only y stops it). */
  public stopRequested = false;

  constructor(private readonly deps: LiveTailModalDeps) {}

  open(entry: ProcessEntry): void {
    this.entry = entry;
    this.scrollOffset = 0;
    this.stopRequested = false;
    this.active = true;
  }

  close(): void {
    this.active = false;
    this.entry = null;
    this.scrollOffset = 0;
    this.stopRequested = false;
  }

  scrollUp(): void {
    this.scrollOffset += 1;
  }

  scrollDown(): void {
    this.scrollOffset = Math.max(0, this.scrollOffset - 1);
  }

  stopProcess(): boolean {
    if (!this.entry) return false;
    return this.deps.processManager.stop(this.entry.id);
  }

  getOutput(): string {
    if (!this.entry) return '';
    const output = this.deps.processManager.getOutput(this.entry.id);
    if (!output) return LIVE_TAIL_PRUNED;
    const stdout = output.stdout.replace(/\s+$/, '');
    const stderr = output.stderr.replace(/\s+$/, '');
    const combined = stderr ? [stdout, LIVE_TAIL_STDERR_HEADING, stderr].filter(Boolean).join('\n') : stdout;
    if (combined) return combined;
    return this.status() === 'running' ? LIVE_TAIL_EMPTY_OUTPUT : LIVE_TAIL_NO_OUTPUT;
  }

  /** The manager's current status text for the open process (it may have finished since it was opened). */
  status(): string {
    if (!this.entry) return '';
    const listed = this.deps.processManager.list?.().find((process) => process.id === this.entry!.id);
    return listed?.status ?? this.entry.status;
  }
}

/** Render the live tail as a SurfaceLayer in screen coordinates (null when no process is open). */
export function renderLiveTailModal(
  modal: LiveTailModal,
  screenWidth: number,
  screenHeight = 24,
): SurfaceLayer | null {
  const entry = modal.entry;
  if (!entry) return null;
  const t = activeTokens();
  const status = modal.status();
  const f = beginModal(screenWidth, screenHeight, {
    title: 'Runtime activity',
    crumbs: [status === 'running' ? 'Live output' : `Output · ${status}`],
    hints: modal.stopRequested ? LIVE_TAIL_CONFIRM_HINTS : LIVE_TAIL_HINTS,
    // Esc is a hint of its own here: it goes back to the process list.
    escKey: false,
  });
  // The command leads the body, wrapped in full (a title row would have to cut it).
  const command = wrapLines(`$ ${entry.label}`, f.r - f.l + 1);
  command.forEach((line, k) => f.canvas.put(f.l, f.top + k, line, { fg: t.text, bold: true }));
  const panelTop = f.top + command.length + 1;
  const p = panel(f.canvas, f.l - 2, panelTop, f.r - f.l + 5, Math.max(3, f.bottom - panelTop + 1));
  const textW = p.r - p.l + 1;
  const capacity = Math.max(1, p.bottom - p.top + 1);
  // Only the source lines that reach the window are wrapped: walk back from the
  // newest line until the window and the scroll offset are filled.
  const source = (modal.getOutput() || LIVE_TAIL_EMPTY_OUTPUT).split('\n');
  const rows: string[] = [];
  let firstSource = source.length;
  while (firstSource > 0 && rows.length < capacity + modal.scrollOffset) {
    firstSource -= 1;
    rows.unshift(...wrapLines(source[firstSource]!, textW));
  }
  modal.scrollOffset = Math.min(modal.scrollOffset, Math.max(0, rows.length - capacity));
  const end = rows.length - modal.scrollOffset;
  const start = Math.max(0, end - capacity);
  const faint = new Set([LIVE_TAIL_EMPTY_OUTPUT, LIVE_TAIL_NO_OUTPUT, LIVE_TAIL_PRUNED, LIVE_TAIL_STDERR_HEADING]);
  rows.slice(start, end).forEach((line, k) => {
    f.canvas.put(p.l, p.top + k, line, { fg: faint.has(line) ? t.textFaint : t.text, bg: p.bg });
  });
  // Above: the wrapped rows over the window plus the source lines not wrapped at all.
  f.hintRight = scrollCountText(start + firstSource, rows.length - end);
  return finishModal(f);
}
