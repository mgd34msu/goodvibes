/**
 * surface-modal-host.ts, the one stack of open modals in a terminal app.
 *
 * Two kinds of modal share the stack:
 *
 *   - A SurfaceModal (kit modal) owns its keys, its own sub-levels and its
 *     rendering (drawn with the surface kit). It is pushed by its opener.
 *   - A TrackedModal is one of the input handler's own modals (settings, the
 *     pickers, help, the composer's command mode, ...). It keeps its own open
 *     flag; the host takes it on top of the stack when that flag turns on and
 *     forgets it when the flag turns off (see sync), so an opener never has to
 *     report an open or a close. Its keys go through the handler's route for
 *     it (modal-token-pipeline.ts) and the product renderer draws it.
 *
 * The rules, the same for both kinds:
 *
 *   - Keys go to the top modal only.
 *   - Esc pops exactly one level: the top modal's own sub-level first
 *     (escape() returns true), otherwise the top modal closes, and a tracked
 *     modal underneath that closed when the top one opened comes back. The
 *     next Esc reaches the modal underneath, then the rest of the Esc chain
 *     (modal-stack.ts: clear composer, leave a view, cancel turn).
 *   - The renderer draws the stack bottom to top; each modal dims what is
 *     underneath it.
 */

import type { InputToken } from '@goodvibes/engine/platform/platform/core';
import type { SurfaceLayer } from './renderer/surface-kit.js';

export type SurfaceModalCloseReason = 'escape' | 'done' | 'cleared';

export interface SurfaceModal {
  /** A short identifier (tests, diagnostics, the `ui` event stream). */
  readonly name: string;
  readonly waitingForOwner?: boolean;
  /** Handle a key or text token while this modal is on top. */
  handleToken(token: InputToken, host: SurfaceModalHost): void;
  /** Esc: pop one of this modal's own sub-levels and return true, or return false to close the modal. */
  escape?(): boolean;
  /** Draw the modal for a screen of the given size. */
  render(screenWidth: number, screenHeight: number): SurfaceLayer;
  /** Called once when the modal leaves the stack. */
  onClose?(reason: SurfaceModalCloseReason): void;
}

/** One of the input handler's modals, which keeps its own open flag. */
export interface TrackedModal {
  /** Tells a tracked modal from a kit modal in the stack. */
  readonly ownsOpenFlag: true;
  /** The panel name: the key route, the renderer entry and the `ui` event stream use it. */
  readonly name: string;
  /** The modal's own flag: true while it is on screen. */
  isOpen(): boolean;
  /** Esc: pop one of this modal's own sub-levels and return true, or return false to close the modal. */
  escape?(): boolean;
  /** Close it the way Esc closes it. */
  close(): void;
  /**
   * Bring it back after the modal stacked above it closed. Absent when
   * closing discards what the modal showed (a selection's callback, a file
   * picker's insert position) and only its opener can rebuild it.
   */
  reopen?(): void;
}

export type StackedModal = SurfaceModal | TrackedModal;

export function isTrackedModal(modal: StackedModal): modal is TrackedModal {
  return (modal as Partial<TrackedModal>).ownsOpenFlag === true;
}

function onScreen(modal: StackedModal): boolean {
  return !isTrackedModal(modal) || modal.isOpen();
}

export class SurfaceModalHost {
  private readonly stack: StackedModal[] = [];
  private readonly tracked: TrackedModal[] = [];
  private syncing = false;

  /** Called after the stack changes (wired to the render request). */
  onChange: (() => void) | null = null;
  /**
   * Called when a modal enters the stack; `fromEmpty` is true when nothing
   * was on screen before it (the handler records where focus returns to).
   */
  onOpen: ((modal: StackedModal, fromEmpty: boolean) => void) | null = null;

  /**
   * Register the handler's modals. Two that open in the same tick stack in
   * the order given here, so a modal that opens another comes first.
   */
  track(...modals: TrackedModal[]): void {
    for (const modal of modals) if (!this.tracked.includes(modal)) this.tracked.push(modal);
  }

  /**
   * Bring the stack in line with the tracked modals' own flags: a tracked
   * modal that opened goes on top; one that closed and cannot come back
   * leaves; closed ones at the top leave too. A closed modal that can come
   * back stays while something opened above it in the same tick (a monitor
   * that closed to open its live tail), so Esc on that one brings it back.
   * Every read of the stack syncs first; it reads one flag per tracked modal.
   */
  sync(): void {
    if (this.syncing) return;
    this.syncing = true;
    const opened: Array<readonly [StackedModal, boolean]> = [];
    try {
      let anyOnScreen = this.stack.some(onScreen);
      for (const modal of this.tracked) {
        if (!modal.isOpen() || this.stack.includes(modal)) continue;
        this.stack.push(modal);
        opened.push([modal, !anyOnScreen]);
        anyOnScreen = true;
      }
      for (let index = this.stack.length - 1; index >= 0; index--) {
        const modal = this.stack[index]!;
        if (isTrackedModal(modal) && !modal.reopen && !modal.isOpen()) this.stack.splice(index, 1);
      }
      for (let top = this.stack[this.stack.length - 1]; top && !onScreen(top); top = this.stack[this.stack.length - 1]) {
        this.stack.pop();
      }
    } finally {
      this.syncing = false;
    }
    for (const [modal, fromEmpty] of opened) this.onOpen?.(modal, fromEmpty);
  }

  /** Something is open (a kit modal or a tracked one). */
  get active(): boolean {
    this.sync();
    return this.stack.length > 0;
  }

  /** The top of the stack is a kit modal, which takes the keys itself. */
  get kitModalOnTop(): boolean {
    const top = this.top();
    return top !== undefined && !isTrackedModal(top);
  }

  get waitingForOwner(): boolean {
    return this.stack.some((modal) => !isTrackedModal(modal) && modal.waitingForOwner === true);
  }

  get depth(): number {
    this.sync();
    return this.stack.length;
  }

  top(): StackedModal | undefined {
    this.sync();
    return this.stack[this.stack.length - 1];
  }

  /** The open modals, bottom first. */
  modals(): readonly StackedModal[] {
    this.sync();
    return this.stack;
  }

  /** Open a kit modal on top of whatever is open. Opening one already in the stack moves it to the top. */
  push(modal: SurfaceModal): void {
    this.sync();
    const existing = this.stack.indexOf(modal);
    const fromEmpty = this.stack.length === 0;
    if (existing >= 0) this.stack.splice(existing, 1);
    this.stack.push(modal);
    this.onChange?.();
    if (existing < 0) this.onOpen?.(modal, fromEmpty);
  }

  /** Remove a modal (usually the top one closing itself after acting); a tracked modal still open is closed. */
  close(modal: StackedModal, reason: SurfaceModalCloseReason = 'done'): void {
    if (!this.remove(modal, reason)) return;
    this.onChange?.();
  }

  private remove(modal: StackedModal, reason: SurfaceModalCloseReason): boolean {
    const index = this.stack.indexOf(modal);
    if (index >= 0) this.stack.splice(index, 1);
    if (isTrackedModal(modal)) {
      if (modal.isOpen()) modal.close();
      return index >= 0;
    }
    if (index < 0) return false;
    modal.onClose?.(reason);
    return true;
  }

  /** Esc: one level. Returns false when nothing was open. */
  escape(): boolean {
    const top = this.top();
    if (!top) return false;
    if (top.escape?.() === true) {
      this.onChange?.();
      return true;
    }
    this.remove(top, 'escape');
    // Back to the modal below: a tracked one that closed when the top one
    // opened comes back; one that cannot come back and is gone is dropped.
    for (let below = this.stack[this.stack.length - 1]; below && !onScreen(below); below = this.stack[this.stack.length - 1]) {
      if (isTrackedModal(below) && below.reopen) {
        below.reopen();
        break;
      }
      this.stack.pop();
    }
    this.onChange?.();
    return true;
  }

  /** Route a token to the top kit modal. Returns false when the top is not a kit modal (or nothing is open). */
  handleToken(token: InputToken): boolean {
    const top = this.top();
    if (!top || isTrackedModal(top)) return false;
    top.handleToken(token, this);
    return true;
  }

  /** Close everything. */
  clear(): void {
    while (this.stack.length > 0) {
      const modal = this.stack.pop()!;
      if (isTrackedModal(modal)) {
        if (modal.isOpen()) modal.close();
      } else modal.onClose?.('cleared');
    }
    this.onChange?.();
  }

  /** Layers of the open kit modals, bottom first (tracked modals are drawn by the product renderer). */
  render(screenWidth: number, screenHeight: number): SurfaceLayer[] {
    const layers: SurfaceLayer[] = [];
    for (const modal of this.modals()) if (!isTrackedModal(modal)) layers.push(modal.render(screenWidth, screenHeight));
    return layers;
  }
}
