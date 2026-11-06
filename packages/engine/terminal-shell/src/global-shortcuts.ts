import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import type { SearchManager, SearchConversation } from './transcript-search.js';
import type { KeybindingsManager } from './keybindings.js';
import type { HistorySearch } from './input-history.js';
import { wordBoundaryBack, wordBoundaryForward, type KillRing } from './kill-ring.js';

/** Delegated edits must be copied back before the feed publishes its route snapshot. */
export type PromptEdit = { readonly prompt: string; readonly cursorPos: number };
export interface GlobalShortcutState {
  keybindingsManager: Pick<KeybindingsManager<string>, 'lookup'>;
  prompt: string;
  cursorPos: number;
  commandMode: boolean;
  autocomplete: { reset(): void } | null;
  historySearch: Pick<HistorySearch, 'open'>;
  searchManager: SearchManager;
  conversationManager: (SearchConversation & { nextErrorLine(scrollTop: number): number }) | null;
  commandContext?: { clearScreen?: (() => void) | undefined } | undefined;
  contentWidth: number;
  getScrollTop(): number;
  getWrappedPromptInfo(width: number): {
    wrappedLines: string[];
    segments: { rawStart: number; length: number }[];
    cursorWrappedLine: number;
  };
  saveUndoState(): void;
  requestRender(): void;
  scroll(delta: number): void;
  ensureInputCursorVisible(): void;
  handleCopy(): void;
  handleCtrlC(): void;
  handleBlockCopy(): void;
  handleBookmark(): void;
  handleBlockSave(): void;
  handleUndo(): PromptEdit | void;
  handleRedo(): PromptEdit | void;
  handlePaste(): PromptEdit | void;
  handleEscape(): void;
}
export interface GlobalShortcutPolicy<State extends GlobalShortcutState> {
  readonly modifiedPageScroll: boolean;
  readonly rawKey?: ((state: State, token: Extract<InputToken, { type: 'key' }>) => boolean | undefined) | undefined;
  readonly action?: ((state: State, action: string | null) => boolean | undefined) | undefined;
  readonly killRing?: ((state: State) => KillRing) | undefined;
  readonly applyDiff?: ((state: State) => boolean) | undefined;
}
function applyPromptEdit(state: GlobalShortcutState, edit: PromptEdit | void): void {
  if (!edit) return;
  state.prompt = edit.prompt;
  state.cursorPos = edit.cursorPos;
}

export function handleGlobalShortcutToken<State extends GlobalShortcutState>(
  state: State,
  token: InputToken,
  viewportHeight: number,
  policy: GlobalShortcutPolicy<State>,
): boolean {
  if (token.type !== 'key') return false;

  // Fast-path: bare pageup/pagedown have no keybinding entry.
  if (token.logicalName === 'pageup' && (policy.modifiedPageScroll || !token.ctrl)) {
    state.scroll(-Math.max(1, viewportHeight - 2));
    return true;
  }
  if (token.logicalName === 'pagedown' && (policy.modifiedPageScroll || !token.ctrl)) {
    state.scroll(Math.max(1, viewportHeight - 2));
    return true;
  }
  // Bare escape is also not in the keybinding table.
  if (token.logicalName === 'escape') {
    state.handleEscape();
    return true;
  }

  const rawResult = policy.rawKey?.(state, token);
  if (rawResult !== undefined) return rawResult;

  // O(1) lookup via inverted map.
  const kb = state.keybindingsManager;
  const action = kb.lookup(token);

  switch (action) {
    case 'copy-selection':
      state.handleCopy();
      return true;

    case 'screen-clear':
      state.commandContext?.clearScreen?.();
      return true;

    case 'history-search':
      state.historySearch.open(state.prompt);
      state.requestRender();
      return true;

    case 'search':
      if (state.searchManager.active) state.searchManager.close(state.conversationManager);
      else state.searchManager.open();
      state.requestRender();
      return true;

    case 'block-copy':
      if (!state.commandMode) {
        state.handleBlockCopy();
        return true;
      }
      return false;

    case 'bookmark':
      if (!state.commandMode) {
        state.handleBookmark();
        return true;
      }
      return false;

    case 'block-save':
      if (!state.commandMode) {
        state.handleBlockSave();
        return true;
      }
      return false;

    case 'delete-word': {
      state.saveUndoState();
      let pos = state.cursorPos;
      while (pos > 0 && state.prompt[pos - 1] === ' ') pos--;
      while (pos > 0 && state.prompt[pos - 1] !== ' ') pos--;
      const killed = state.prompt.slice(pos, state.cursorPos);
      const ring = policy.killRing?.(state);
      if (killed && ring) {
        ring.push(killed);
        ring.clearYankState();
      }
      state.prompt = state.prompt.slice(0, pos) + state.prompt.slice(state.cursorPos);
      state.cursorPos = pos;
      state.ensureInputCursorVisible();
      return true;
    }

    case 'apply-diff-line-start':
    case 'line-start': {
      if (action === 'apply-diff-line-start' && !state.commandMode && policy.applyDiff?.(state)) return true;
      const info = state.getWrappedPromptInfo(state.contentWidth);
      state.cursorPos = info.wrappedLines.length > 1 ? (info.segments[info.cursorWrappedLine]?.rawStart ?? 0) : 0;
      state.ensureInputCursorVisible();
      return true;
    }

    case 'next-error-line-end': {
      if (state.prompt === '' && !state.commandMode) {
        const nextLine = state.conversationManager?.nextErrorLine(state.getScrollTop()) ?? -1;
        if (nextLine >= 0) {
          state.scroll(nextLine - state.getScrollTop());
          state.requestRender();
          return true;
        }
      }
      const info = state.getWrappedPromptInfo(state.contentWidth);
      const segment = info.segments[info.cursorWrappedLine];
      state.cursorPos = info.wrappedLines.length > 1 && segment ? segment.rawStart + segment.length : state.prompt.length;
      state.ensureInputCursorVisible();
      return true;
    }

    case 'kill-line': {
      const killed = state.prompt.slice(state.cursorPos);
      state.saveUndoState();
      const ring = policy.killRing?.(state);
      if (ring) {
        ring.push(killed);
        ring.clearYankState();
      }
      state.prompt = state.prompt.slice(0, state.cursorPos);
      state.ensureInputCursorVisible();
      return true;
    }

    case 'clear-prompt':
      state.saveUndoState();
      state.prompt = '';
      state.cursorPos = 0;
      if (state.commandMode) {
        state.commandMode = false;
        state.autocomplete?.reset();
      }
      return true;

    case 'undo':
      applyPromptEdit(state, state.handleUndo());
      return true;

    case 'redo':
      applyPromptEdit(state, state.handleRedo());
      return true;

    case 'paste':
      applyPromptEdit(state, state.handlePaste());
      return true;

    default:
      return policy.action?.(state, action) ?? false;
  }
}

/** Readline editing is enabled only for products that provide a kill ring. */
export function handleKillRingShortcut(state: GlobalShortcutState & { killRing: KillRing }, action: string | null): boolean | undefined {
  switch (action) {
    case 'kill-to-start': {
      // Kill from start of buffer to cursor, push to ring.
      const killed = state.prompt.slice(0, state.cursorPos);
      state.saveUndoState();
      state.killRing.push(killed);
      state.killRing.clearYankState();
      state.prompt = state.prompt.slice(state.cursorPos);
      state.cursorPos = 0;
      state.ensureInputCursorVisible();
      return true;
    }

    case 'kill-word-forward': {
      // Kill from cursor to end of next word, push to ring.
      const end = wordBoundaryForward(state.prompt, state.cursorPos);
      const killed = state.prompt.slice(state.cursorPos, end);
      if (killed) {
        state.saveUndoState();
        state.killRing.push(killed);
        state.killRing.clearYankState();
        state.prompt = state.prompt.slice(0, state.cursorPos) + state.prompt.slice(end);
        state.ensureInputCursorVisible();
      }
      return true;
    }

    case 'word-back': {
      const newPos = wordBoundaryBack(state.prompt, state.cursorPos);
      if (newPos !== state.cursorPos) {
        state.killRing.clearYankState();
        state.cursorPos = newPos;
        state.ensureInputCursorVisible();
      }
      return true;
    }

    case 'word-forward': {
      const newPos = wordBoundaryForward(state.prompt, state.cursorPos);
      if (newPos !== state.cursorPos) {
        state.killRing.clearYankState();
        state.cursorPos = newPos;
        state.ensureInputCursorVisible();
      }
      return true;
    }

    case 'yank': {
      const text = state.killRing.yank();
      if (text) {
        state.saveUndoState();
        state.prompt = state.prompt.slice(0, state.cursorPos) + text + state.prompt.slice(state.cursorPos);
        state.cursorPos += text.length;
        state.ensureInputCursorVisible();
      }
      return true;
    }

    case 'yank-pop': {
      // Only valid immediately after a yank or yank-pop.
      if (!state.killRing.lastActionWasYank) return false;
      // Undo the previous yank by restoring: we store the pre-yank snapshot on
      // the undo stack so a single undo covers the whole yank sequence.
      // For yank-pop: replace the last yanked text with the next ring entry.
      // We rely on the undo stack having the pre-yank state at the top.
      applyPromptEdit(state, state.handleUndo());
      const text = state.killRing.yankPop();
      if (text) {
        state.saveUndoState();
        state.prompt = state.prompt.slice(0, state.cursorPos) + text + state.prompt.slice(state.cursorPos);
        state.cursorPos += text.length;
        state.ensureInputCursorVisible();
      }
      return true;
    }

    default:
      return undefined;
  }
}
