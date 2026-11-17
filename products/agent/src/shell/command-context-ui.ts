/**
 * command-context-ui.ts, the shell actions a command can invoke that do
 * nothing but change what is on screen.
 *
 * `/clear` wipes the viewport and a permission ask parks the prompt until
 * someone answers it (the Activity modal, Ctrl+O, is opened from main.ts). Each is a couple
 * of statements over the shell's own state, and each ends the same way: repaint.
 *
 * They live here rather than inline in main.ts because they are the shell's UI
 * verbs rather than part of its startup sequence, and because main.ts is at its
 * size budget, a file that has to stay readable is not the place to keep three
 * unrelated closures that only share the fact that they were convenient there.
 */

import { allowTerminalWrite } from '@goodvibes-jev/engine/terminal-shell';
import { CLEAR_VIEWPORT_HOME } from '../renderer/terminal-escapes.ts';
import type { PermissionExecutionOptions } from '@goodvibes-jev/engine/platform/platform/permissions';
import type { PendingPermissionState } from './blocking-input.ts';
import { buildHunkSelectionState, isHunkSelectable } from '@goodvibes-jev/engine/terminal-shell/hunk-selection';

/** What a permission ask resolves with once the person answers it. */
export interface PermissionAnswer {
  readonly approved: boolean;
  readonly remember: boolean;
  /** The typed answer to a command's terminal prompt, as `{ answer }`, or the edits of the hunks a multi-edit card applied; absent otherwise. */
  readonly modifiedArgs?: Record<string, unknown>;
  /** The hunks a multi-edit card applied when not all were (indices into the ask's own edits); the approval broker applies them. */
  readonly selectedHunks?: readonly number[];
}

type Settle = (approved: boolean, remember: boolean, modifiedArgs?: Record<string, unknown>, selectedHunks?: readonly number[]) => void;

export interface CommandContextUiOptions {
  readonly compositor: { resetDiff(): void };
  readonly stdout: { write(chunk: string): unknown };
  readonly render: () => void;
  /** Current terminal width, read at the moment the action runs. */
  readonly terminalWidth: () => number;
  /** Null clears the card (an ask decided elsewhere, or cancelled). */
  readonly setPendingPermission: (pending: PendingPermissionState | null) => void;
}

export interface CommandContextUi {
  /** Reset the diff and wipe the viewport, then repaint. */
  clearScreen(): void;
  /**
   * Park a permission ask on screen and resolve once it is answered.
   *
   * The promise is the answer; the repaint is what makes the prompt appear.
   * When `options.signal` aborts first (the ask was decided somewhere else, or
   * the turn was cancelled) the card is taken down if it is still this ask's,
   * the ask leaves the queue if it was waiting, and the promise settles as a
   * denial.
   */
  requestPermission(request: Omit<PendingPermissionState, 'resolve'>, options?: PermissionExecutionOptions): Promise<PermissionAnswer>;
}

export function createCommandContextUi(options: CommandContextUiOptions): CommandContextUi {
  // One card is on screen at a time. The shell keeps a single pending slot, so a
  // second ask written into it would drop the first ask's resolver and leave the
  // tool call behind it waiting forever. A later ask waits its turn instead.
  let active: { readonly callId: string; readonly settle: Settle[] } | null = null;
  const waiting: Array<{ readonly request: Omit<PendingPermissionState, 'resolve'>; readonly settle: Settle }> = [];

  const showNext = (): void => {
    if (active !== null) return;
    const following = waiting.shift();
    if (following) {
      show(following.request, [following.settle]);
      options.render();
    }
  };

  const show = (
    request: Omit<PendingPermissionState, 'resolve'>,
    settle: Settle[],
  ): void => {
    const entry = { callId: request.callId, settle };
    active = entry;
    options.setPendingPermission({
      ...request,
      // A queued card replacing the one just answered starts its own settle time, so a held or repeated key cannot answer it.
      openedAt: Date.now(),
      // A multi-edit `edit` opens with every hunk selected; the owner can leave some out.
      hunkState: isHunkSelectable(request) ? buildHunkSelectionState(request) : undefined,
      resolve: (approved: boolean, remember = false, modifiedArgs?: Record<string, unknown>, extras?: { readonly selectedHunks?: readonly number[] | undefined }) => {
        if (active !== entry) return;
        active = null;
        for (const settleOne of entry.settle) settleOne(approved, remember, modifiedArgs, extras?.selectedHunks);
        // The shell clears its pending slot right after this call returns, so the
        // next card is placed after that, not into the slot about to be emptied.
        queueMicrotask(showNext);
      },
    } as PendingPermissionState);
  };

  return {
    clearScreen: (): void => {
      options.compositor.resetDiff();
      allowTerminalWrite(() => options.stdout.write(CLEAR_VIEWPORT_HOME));
      options.render();
    },
    requestPermission: (request, permissionOptions) => new Promise<PermissionAnswer>((resolve) => {
      const settle: Settle = (approved, remember, modifiedArgs, selectedHunks) => resolve({ approved, remember,
        ...(approved && modifiedArgs ? { modifiedArgs } : {}), ...(approved && selectedHunks ? { selectedHunks } : {}) });
      const signal = permissionOptions?.signal;
      if (signal?.aborted) {
        settle(false, false);
        return;
      }
      signal?.addEventListener('abort', () => {
        if (active !== null && active.callId === request.callId) {
          // Only this ask's own card comes down; a different card is not touched.
          const settling = active.settle;
          active = null;
          options.setPendingPermission(null);
          for (const settleOne of settling) settleOne(false, false);
          showNext();
          options.render();
          return;
        }
        const index = waiting.findIndex((entry) => entry.settle === settle);
        if (index >= 0) waiting.splice(index, 1);
        settle(false, false);
      }, { once: true });
      if (active === null) {
        show(request, [settle]);
        options.render();
      } else if (active.callId === request.callId) {
        // The same ask arriving again replaces its own card; both callers get the one answer.
        show(request, [...active.settle, settle]);
        options.render();
      } else {
        waiting.push({ request, settle });
      }
    }),
  };
}
