/**
 * The process monitor (Enter on the process indicator): background
 * shell processes drawn with the modal surface kit. Running processes first,
 * then the finished ones the process manager still keeps (with their output),
 * newest first. One kit row per process (status marker, command, the manager's
 * own status text and the elapsed or run time right-aligned), coloured by how
 * it ended. Enter opens the process full screen with its output (the live
 * tail modal where that view is not wired). j/k move like the arrows; x (or
 * Delete) asks to stop the selected running process and y confirms it, so a
 * navigation key never ends a process. Esc only closes the view: the
 * processes keep running.
 */

import { formatDuration } from './modal-utils.ts';
import type { ProcessManager } from '@goodvibes/engine/platform/platform/tools';
import { activeTokens } from './theme.ts';
import { beginModal, drawWrapped, finishModal, scrollCountText, type KitHint, type SurfaceLayer } from './surface-kit.ts';
import { drawList, type KitRow } from './surface-kit-list.ts';
import { listHeight, modalHeightFor, modalTextWidth } from './surface-kit-extra.ts';

export interface ProcessEntry {
  readonly id: string;
  readonly label: string;
  readonly type: 'exec';
  /** The process manager's own status text: running, done (exit N), timed out ..., killed by .... */
  readonly status: string;
  /** Running time so far, or how long a finished process ran. */
  readonly elapsedMs: number;
  /** How it ended: still running, exited 0, or anything else (non-zero exit, signal, timeout). */
  readonly outcome?: 'running' | 'succeeded' | 'failed';
}

const MAX_LABEL_LENGTH = 200;
const PROCESS_MODAL_TITLE = 'Runtime activity';
const PROCESS_MODAL_EMPTY_MESSAGE = 'No running or recently finished shell processes.';
const PROCESS_MODAL_NOTE = 'Esc closes this view; processes keep running.';
const PROCESS_MODAL_HINTS: readonly KitHint[] = [['↑↓ j k', 'move'], ['⏎', 'output'], ['x', 'stop, then y to confirm']];
const PROCESS_MODAL_CONFIRM_HINTS: readonly KitHint[] = [['y', 'stop it'], ['any other key', 'keep it running']];

export interface ProcessModalDeps {
  readonly processManager: Pick<ProcessManager, 'list' | 'getStatus' | 'stop'>;
}

function truncateCmd(text: string): string {
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  if (firstLine.length > MAX_LABEL_LENGTH) return `${firstLine.slice(0, MAX_LABEL_LENGTH - 1)}…`;
  return firstLine;
}

export class ProcessModal {
  public active = false;
  public selectedIndex = 0;
  public entries: ProcessEntry[] = [];
  /** The running process `x` asked to stop; `y` stops it, any other key clears it. */
  public stopArmedId: string | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private onRefresh: (() => void) | null = null;

  constructor(private readonly deps: ProcessModalDeps) {}

  setOnRefresh(fn: () => void): void {
    this.onRefresh = fn;
  }

  open(): void {
    this.stopArmedId = null;
    this.refresh();
    this.active = true;
    this.selectedIndex = 0;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => {
      this.refresh();
      this.onRefresh?.();
    }, 1000);
  }

  close(): void {
    this.active = false;
    this.stopArmedId = null;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  refresh(): void {
    const now = Date.now();
    // The highlight follows the process, not the row number: entries shift when a
    // process finishes or starts, and an index left in place would point `k` at a
    // different process than the one the user selected.
    const selectedId = this.entries[this.selectedIndex]?.id;
    const running: ProcessEntry[] = [];
    const finished: Array<{ entry: ProcessEntry; completedAt: number }> = [];

    for (const process of this.deps.processManager.list()) {
      const current = this.deps.processManager.getStatus(process.id);
      if (!current) continue;
      const base = { id: process.id, label: truncateCmd(process.cmd), type: 'exec' as const, status: process.status };
      if (!current.done) {
        running.push({ ...base, elapsedMs: now - current.startTime, outcome: 'running' });
        continue;
      }
      const completedAt = current.completedAt ?? now;
      const succeeded = current.exitCode === 0 && !current.signal && current.timedOut !== true;
      finished.push({
        entry: { ...base, elapsedMs: Math.max(0, completedAt - current.startTime), outcome: succeeded ? 'succeeded' : 'failed' },
        completedAt,
      });
    }
    finished.sort((a, b) => b.completedAt - a.completedAt);
    const result = [...running, ...finished.map((item) => item.entry)];

    this.entries = result;
    const followed = selectedId === undefined ? -1 : result.findIndex((entry) => entry.id === selectedId);
    if (followed >= 0) {
      this.selectedIndex = followed;
    } else if (this.selectedIndex >= this.entries.length) {
      this.selectedIndex = Math.max(0, this.entries.length - 1);
    }
    // A request to stop names one running process; it lapses when that process ends.
    if (this.stopArmedId !== null && result.find((entry) => entry.id === this.stopArmedId)?.outcome !== 'running') this.stopArmedId = null;
  }

  moveUp(): void {
    this.stopArmedId = null;
    if (this.entries.length === 0) return;
    this.selectedIndex = (this.selectedIndex - 1 + this.entries.length) % this.entries.length;
  }

  moveDown(): void {
    this.stopArmedId = null;
    if (this.entries.length === 0) return;
    this.selectedIndex = (this.selectedIndex + 1) % this.entries.length;
  }

  getSelected(): ProcessEntry | undefined {
    return this.entries[this.selectedIndex];
  }

  /** Ask to stop the selected process; true when it is running and now waits for `y`. */
  armStop(): boolean {
    const entry = this.getSelected();
    this.stopArmedId = entry && (entry.outcome ?? 'running') === 'running' ? entry.id : null;
    return this.stopArmedId !== null;
  }

  cancelStop(): void {
    this.stopArmedId = null;
  }

  /** Stop the process `x` named, if it is still the selected one. */
  confirmStop(): boolean {
    const armed = this.stopArmedId;
    this.stopArmedId = null;
    const entry = this.getSelected();
    if (!armed || entry?.id !== armed) return false;
    return this.deps.processManager.stop(entry.id);
  }
}

/** The static strings this surface can show (checked by package verification). */
export function renderProcessModalPackageText(): string {
  return [
    PROCESS_MODAL_TITLE,
    PROCESS_MODAL_EMPTY_MESSAGE,
    PROCESS_MODAL_NOTE,
    '<n> running',
    '<n> finished',
    'running',
    'done (exit <n>)',
    '<duration>',
    ...PROCESS_MODAL_HINTS.map(([, action]) => action),
    ...PROCESS_MODAL_CONFIRM_HINTS.map(([, action]) => action),
  ].join('\n');
}

function rowFor(entry: ProcessEntry, selected: boolean): KitRow {
  const t = activeTokens();
  const outcome = entry.outcome ?? 'running';
  const running = outcome === 'running';
  const failed = outcome === 'failed';
  return {
    label: entry.label,
    right: `${entry.status} · ${formatDuration(entry.elapsedMs)}`,
    rightFg: failed ? t.error : running ? undefined : t.success,
    mark: running ? '◐' : failed ? '✕' : '✓',
    markFg: running ? t.brand : failed ? t.error : t.success,
    selected,
  };
}

function processCountText(entries: readonly ProcessEntry[]): string {
  const running = entries.filter((entry) => (entry.outcome ?? 'running') === 'running').length;
  const finished = entries.length - running;
  return [running > 0 ? `${running} running` : '', finished > 0 ? `${finished} finished` : ''].filter(Boolean).join(' · ');
}

/** Render the process monitor as a SurfaceLayer in screen coordinates. */
export function renderProcessModal(modal: ProcessModal, screenWidth: number, screenHeight = 24): SurfaceLayer {
  modal.refresh();
  const t = activeTokens();
  const empty = modal.entries.length === 0;
  const hints = empty ? [] : modal.stopArmedId !== null ? PROCESS_MODAL_CONFIRM_HINTS : PROCESS_MODAL_HINTS;
  const rows = modal.entries.map((entry, i) => rowFor(entry, i === modal.selectedIndex));
  const width = modalTextWidth(screenWidth, screenHeight);
  const body = (empty ? 1 : listHeight(rows, 0, width - 1)) + 2;
  const height = modalHeightFor(screenWidth, screenHeight, { hints }, body);
  const f = beginModal(screenWidth, screenHeight, {
    title: PROCESS_MODAL_TITLE,
    sub: empty ? undefined : processCountText(modal.entries),
    hints,
    height,
  });
  const noteRow = f.bottom;
  drawWrapped(f.canvas, f.l, noteRow, f.r - f.l + 1, PROCESS_MODAL_NOTE, { fg: t.textFaint }, f.bottom);
  if (empty) {
    drawWrapped(f.canvas, f.l, f.top, f.r - f.l + 1, PROCESS_MODAL_EMPTY_MESSAGE, { fg: t.textMuted }, noteRow - 2);
    return finishModal(f);
  }
  const res = drawList(f.canvas, { rows, top: f.top, bottom: Math.max(f.top, noteRow - 2), x0: f.l, x1: f.r, scrollKey: { owner: modal, name: 'processes' } });
  f.hintRight = scrollCountText(res.above, res.below);
  return finishModal(f);
}
