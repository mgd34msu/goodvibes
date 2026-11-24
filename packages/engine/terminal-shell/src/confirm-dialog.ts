/**
 * confirm-dialog.ts, a small centered yes/no dialog on the kit surface.
 *
 * The safe choice sits on the left and is chosen by default for destructive
 * and warning dialogs; the confirming button carries its tone (a red chip for
 * destructive actions). Arrows or tab move between the buttons, Enter presses
 * the chosen one, y and n answer directly, Esc cancels. An optional confirm
 * chord (the chord that opened the dialog) pressed again also confirms.
 */

import type { InputToken } from '@goodvibes/engine/platform/platform/core';
import type { SurfaceModal, SurfaceModalCloseReason, SurfaceModalHost } from './surface-modal-host.js';
import type { SurfaceLayer } from './renderer/surface-kit.js';
import { renderConfirmDialog } from './renderer/confirm-dialog.js';
import type { ConfirmOptions, ConfirmView } from './confirm-dialog-types.js';
export type { ConfirmOptions, ConfirmTone } from './confirm-dialog-types.js';

export class ConfirmDialog implements SurfaceModal, ConfirmView {
  readonly name = 'confirm';
  /** 0 = cancel (left), 1 = confirm (right). */
  chosen: 0 | 1;
  /** First body line shown; a body taller than the screen scrolls with up/down and page up/down. */
  scroll = 0;
  /** The whole body has been on screen at least once; confirming is refused until then. */
  seenToEnd = false;
  private body = { total: 0, visible: 0 };
  private answered = false;
  get waitingForOwner(): boolean { return !this.answered; }

  constructor(
    readonly options: ConfirmOptions,
    private readonly onResult: (confirmed: boolean) => void,
  ) {
    this.chosen = options.tone === 'danger' || options.tone === 'warning' ? 0 : 1;
  }

  noteBody(total: number, visible: number): void {
    this.body = { total, visible };
    this.scroll = Math.max(0, Math.min(this.scroll, total - visible));
    if (this.scroll + visible >= total) this.seenToEnd = true;
  }

  private scrollBy(lines: number): void {
    this.scroll = Math.max(0, Math.min(this.scroll + lines, this.body.total - this.body.visible));
    if (this.scroll + this.body.visible >= this.body.total) this.seenToEnd = true;
  }

  /** What is typed in the field (options.field), when there is one. */
  fieldValue = '';

  /** Confirming what was not all shown is refused: the body moves on a page instead. A field must hold a good value. */
  private confirm(host: SurfaceModalHost): void {
    if (!this.seenToEnd) { this.scrollBy(Math.max(1, this.body.visible - 1)); return; }
    const field = this.options.field;
    if (field) {
      if (field.check(this.fieldValue) !== null) return;
      field.onValue(this.fieldValue);
    }
    this.answer(host, true);
  }

  private answer(host: SurfaceModalHost, confirmed: boolean): void {
    this.answered = true;
    host.close(this, 'done');
    this.onResult(confirmed);
  }

  handleToken(token: InputToken, host: SurfaceModalHost): void {
    // With a field, typing goes into it; the buttons, Enter and Esc answer.
    if (this.options.field) {
      if (token.type === 'text') { this.fieldValue += token.value.replace(/[\x00-\x1f\x7f]/g, ''); return; }
      if (token.type === 'key' && (token.logicalName === 'backspace' || token.logicalName === 'delete')) { this.fieldValue = this.fieldValue.slice(0, -1); return; }
      if (token.type === 'key' && token.logicalName === 'space') { this.fieldValue += ' '; return; }
      if (token.type === 'key' && !token.ctrl && !token.meta && (token.logicalName ?? '').length === 1) {
        this.fieldValue += token.shift ? token.logicalName.toUpperCase() : token.logicalName;
        return;
      }
    }
    if (token.type === 'text') {
      const ch = token.value.toLowerCase();
      if (ch === 'y') this.confirm(host);
      else if (ch === 'n') this.answer(host, false);
      return;
    }
    if (token.type !== 'key') return;
    const key = token.logicalName ?? '';
    const chord = this.options.confirmChord;
    if (chord && key === chord.key && Boolean(token.ctrl) === Boolean(chord.ctrl)) { this.confirm(host); return; }
    if (key === 'left' || key === 'right' || key === 'tab') this.chosen = this.chosen === 0 ? 1 : 0;
    else if (key === 'up') this.scrollBy(-1);
    else if (key === 'down') this.scrollBy(1);
    else if (key === 'pageup') this.scrollBy(-Math.max(1, this.body.visible - 1));
    else if (key === 'pagedown') this.scrollBy(Math.max(1, this.body.visible - 1));
    else if (key === 'enter') { if (this.chosen === 1) this.confirm(host); else this.answer(host, false); }
    else if (key === 'y') this.confirm(host);
    else if (key === 'n') this.answer(host, false);
  }

  onClose(_reason: SurfaceModalCloseReason): void {
    // Esc or a cleared stack is a "no": the safe answer to an unanswered question.
    if (!this.answered) {
      this.answered = true;
      this.onResult(false);
    }
  }

  render(screenWidth: number, screenHeight: number): SurfaceLayer {
    return renderConfirmDialog(this, screenWidth, screenHeight);
  }
}

/** Ask through a host; resolves true only when the confirming button was pressed. */
export function confirmThrough(host: SurfaceModalHost, options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => host.push(new ConfirmDialog(options, resolve)));
}
