import type { InputToken } from '@goodvibes-jev/engine/platform/platform/core';
import type { ContentPart } from '@goodvibes-jev/engine/platform/platform/providers';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { BlockMeta, TerminalConversationManager } from './terminal-conversation.js';
import type { InputHistory } from './input-history.js';
import type { TerminalCommandRegistry, TerminalSlashCommand } from './command-registry.js';
import type { AutocompleteEngine } from './autocomplete.js';
import type { SelectionManager } from './text-selection.js';
import type { WrappedPromptInfo } from './prompt-buffer.js';
import {
  ensureInputCursorVisible as computeInputScrollTop,
  getWrappedPromptInfo as computeWrappedPromptInfo,
  moveCursorVertical as computeCursorVerticalMove,
} from './prompt-buffer.js';
import { captureNativeConversationInput } from './native/native-conversation-input.js';
import { commandHistoryLine } from './command-registry.js';
import { formatRefusal, readRefusal } from '@goodvibes-jev/engine/errors';
import { splitSlashCommand } from './slash-command-parser.js';
import type { NativeConversationInput } from './native/native-conversation-input.js';
export interface FeedCommandContext {
  readonly print: (message: string) => void;
  readonly openSelection?: unknown | undefined;
  readonly executeCommand?: ((name: string, args: string[]) => Promise<boolean>) | undefined;
  readonly submitInput?:
    | ((
        text: string,
        content?: ContentPart[] | undefined,
        context?:
          | {
              source: NativeConversationInput;
            }
          | undefined,
      ) => unknown)
    | undefined;
  /** Pending command readings; a refused command line revokes them like any new submission. */
  readonly commandReadings?:
    | {
        cancelAll(): unknown;
      }
    | undefined;
}
export type IndicatorFocusRouteState = {
  indicatorFocused: boolean;
  modalOpened: (name: string) => void;
  /** The footer process indicator's [Enter] opens the Agents modal (F2 also opens it). */
  requestRender: () => void;
};
export type TextRouteState<Context extends FeedCommandContext> = {
  prompt: string;
  cursorPos: number;
  commandMode: boolean;
  nextPasteId: number;
  nextImageId: number;
  pasteRegistry: Map<string, string>;
  imageRegistry: Map<
    string,
    {
      data: string;
      mediaType: string;
    }
  >;
  inputHistory: InputHistory | null;
  commandRegistry: TerminalCommandRegistry<Context> | null;
  commandContext: Context | undefined;
  autocomplete: AutocompleteEngine<TerminalSlashCommand<Context>> | null;
  filePicker: {
    open: (insertPos: number, injectMode?: boolean | undefined) => void;
  };
  modalOpened: (name: string) => void;
  saveUndoState: () => void;
  /** Coalescing undo snapshot for plain text insertions. */
  saveUndoStateForText?: (() => void) | undefined;
  ensureInputCursorVisible: () => void;
  registerPaste: (content: string) => string;
  /** True while the composer is collecting a concealed value: typed text is data, never a shortcut or paste marker. */
  isConcealedInput?: (() => boolean) | undefined;
  requestRender: () => void;
  killRing?:
    | {
        clearYankState(): void;
      }
    | undefined;
};
export type KeyRouteState<Context extends FeedCommandContext> = {
  prompt: string;
  cursorPos: number;
  inputScrollTop: number;
  commandMode: boolean;
  contentWidth: number;
  maxInputRows: number;
  inputHistory: InputHistory | null;
  /** Collapsed pastes by id; Enter sends the pasted text, not its marker. */
  pasteRegistry?: ReadonlyMap<string, string> | undefined;
  indicatorFocused: boolean;
  conversationManager: TerminalConversationManager | null;
  commandContext: Context | undefined;
  /**
   * Deliver a concealed submission. When it returns true, concealed mode was
   * active and consumed the value, the plaintext went straight to the
   * requester, bypassing input history and the transcript. Optional so bare
   * test callers omit it.
   */
  submitConcealedInput?: ((value: string) => boolean) | undefined;
  /** True while the composer is collecting a concealed value; history recall must not write into the masked field. */
  isConcealedInput?: (() => boolean) | undefined;
  /**
   * Used by Enter for a line that starts with '/' while command mode is off: a
   * pasted command line, or a '/' typed while the registry was detached. When
   * absent the line is sent as chat.
   */
  commandRegistry?: (TerminalCommandRegistry<Context> | null) | undefined;
  autocomplete: AutocompleteEngine<TerminalSlashCommand<Context>> | null;
  blockActionsMenu: {
    open: (block: BlockMeta) => void;
  };
  /** The absolute history line of the bottom-most visible block, the block
   *  the user is actually looking at (see getViewportBottomLine's doc).
   *  Anchors Enter-on-empty-composer's block-actions menu to that block
   *  instead of an arbitrary fixed line. */
  getBlockAnchorLine?: (() => number) | undefined;
  /** F2 opens the Agents modal. */
  modalOpened: (name: string) => void;
  saveUndoState: () => void;
  /** Break the undo coalescing group (call on cursor moves). */
  breakUndoCoalesce?: (() => void) | undefined;
  ensureInputCursorVisible: (contentWidth?: number | undefined) => void;
  getWrappedPromptInfo: (contentWidth: number) => WrappedPromptInfo;
  moveCursorVertical: (direction: -1 | 1) => boolean;
  handlePathCompletion: () => boolean;
  handleBlockToggle: () => void;
  findMarkerAtPos: (pos: number) => {
    start: number;
    end: number;
  } | null;
  cleanupMarkerRegistry: (markerText: string) => void;
  expandPrompt: (text: string) => string | ContentPart[];
  scroll: (delta: number) => void;
  exitApp: () => void;
  requestRender: () => void;
  killRing?:
    | {
        clearYankState(): void;
      }
    | undefined;
};
export type MouseRouteState<FooterTarget extends string = string> = {
  openSessionView?: ((target: { kind: 'agent' | 'process'; id: string }) => boolean) | undefined;
  conversationManager: TerminalConversationManager | null;
  selection: SelectionManager;
  mouseDownRow: number;
  mouseDownCol: number;
  scrollTop: number;
  viewportHeight: number;
  lineCount: number;
  scroll: (delta: number) => void;
  requestRender: () => void;
  handlePaste: () => void;
  handleCopy: () => void;
  /** The view a footer screen row opens on a click (the usage rows open Usage). */
  footerTargetAt?: ((row: number, col?: number | undefined) => FooterTarget | undefined) | undefined;
  openFooterTarget?: ((target: FooterTarget) => void) | undefined;
  /** Screen rows above the transcript (the header, the chips, the gap under them); 2 when not given. */
  bodyTopRow?: (() => number) | undefined;
};
export function createFeedTokenRoutes<
  Context extends FeedCommandContext,
  IndicatorState extends IndicatorFocusRouteState,
  TextState extends TextRouteState<Context>,
  KeyState extends KeyRouteState<Context>,
  FooterTarget extends string,
  MouseState extends MouseRouteState<FooterTarget>,
>(policy: {
  readonly openIndicator: (state: IndicatorState) => void;
  readonly openKeyIndicator: (state: KeyState) => void;
  readonly mouseRowOffset: number;
}) {
  function handleIndicatorFocusToken(
    state: IndicatorState,
    token: InputToken,
  ): {
    handled: boolean;
    indicatorFocused: boolean;
  } {
    let indicatorFocused = state.indicatorFocused;
    if (!indicatorFocused) {
      return { handled: false, indicatorFocused };
    }
    if (token.type === 'key') {
      if (token.logicalName === 'up' || token.logicalName === 'escape') {
        indicatorFocused = false;
        state.requestRender();
        return { handled: true, indicatorFocused };
      }
      if (token.logicalName === 'enter') {
        indicatorFocused = false;
        policy.openIndicator(state);
        state.requestRender();
        return { handled: true, indicatorFocused };
      }
      if (token.ctrl || token.logicalName === 'left' || token.logicalName === 'right') {
        indicatorFocused = false;
        return { handled: false, indicatorFocused };
      }
      state.requestRender();
      return { handled: true, indicatorFocused };
    }
    indicatorFocused = false;
    return { handled: false, indicatorFocused };
  }
  function handlePromptTextToken(
    state: TextState,
    token: InputToken,
  ): {
    handled: boolean;
    prompt: string;
    cursorPos: number;
    commandMode: boolean;
  } {
    if (token.type !== 'text') {
      return { handled: false, prompt: state.prompt, cursorPos: state.cursorPos, commandMode: state.commandMode };
    }
    // A concealed value is typed verbatim: no help key, no file picker, no slash
    // command and no paste marker (the submit path does not expand markers).
    const concealed = state.isConcealedInput?.() ?? false;
    if (!concealed && token.value === '?' && state.prompt === '' && !state.commandMode) {
      if (state.commandContext?.openSelection) {
        state.commandRegistry?.execute('help', [], state.commandContext);
      }
      state.requestRender();
      return { handled: true, prompt: state.prompt, cursorPos: state.cursorPos, commandMode: state.commandMode };
    }
    if (state.inputHistory?.isBrowsing) {
      state.inputHistory.resetPosition();
    }
    state.killRing?.clearYankState();
    if (state.saveUndoStateForText) state.saveUndoStateForText();
    else state.saveUndoState();
    const text = concealed ? token.value.replace(/\r\n?/g, '\n') : state.registerPaste(token.value);
    let prompt = state.prompt.slice(0, state.cursorPos) + text + state.prompt.slice(state.cursorPos);
    let cursorPos = state.cursorPos + text.length;
    let commandMode = state.commandMode;
    state.ensureInputCursorVisible();
    if (!concealed && token.value === '@' && !commandMode) {
      const charBefore = cursorPos >= 2 ? prompt[cursorPos - 2] : undefined;
      if (charBefore === '!') {
        state.modalOpened('filePicker');
        state.filePicker.open(cursorPos - 2, true);
      } else if (charBefore === undefined || charBefore === ' ' || charBefore === '\n') {
        state.modalOpened('filePicker');
        state.filePicker.open(cursorPos - 1);
      }
    }
    if (concealed) {
      // Nothing else to arm: the buffer is a secret, not a command.
    } else if (prompt === '/') {
      // Arm commandMode as soon as the prompt becomes a bare '/', regardless of
      // whether commandRegistry has been (re)attached yet, this is a one-shot
      // transition (the only place commandMode ever becomes true), and gating
      // it on commandRegistry meant a transient null during a modal/overlay
      // handoff would permanently miss the window: every following keystroke
      // is then processed as plain chat text with no way to recover. Dispatch
      // (handleCommandModeToken, and the enter-key fallback below) still checks
      // commandRegistry itself before actually running anything.
      commandMode = true;
      state.modalOpened('command');
      state.autocomplete?.update('');
    } else if (commandMode && state.commandRegistry) {
      const query = prompt.startsWith('/') ? prompt.slice(1) : '';
      const spaceIdx = query.indexOf(' ');
      if (spaceIdx === -1) {
        state.autocomplete?.update(query);
      } else {
        state.autocomplete?.reset();
      }
    }
    return { handled: true, prompt, cursorPos, commandMode };
  }
  function handlePromptKeyToken(
    state: KeyState,
    token: InputToken,
  ): {
    handled: boolean;
    prompt: string;
    cursorPos: number;
    inputScrollTop: number;
    commandMode: boolean;
    indicatorFocused: boolean;
  } {
    if (token.type !== 'key') {
      return {
        handled: false,
        prompt: state.prompt,
        cursorPos: state.cursorPos,
        inputScrollTop: state.inputScrollTop,
        commandMode: state.commandMode,
        indicatorFocused: state.indicatorFocused,
      };
    }
    let prompt = state.prompt;
    let cursorPos = state.cursorPos;
    let inputScrollTop = state.inputScrollTop;
    let commandMode = state.commandMode;
    let indicatorFocused = state.indicatorFocused;
    const ensureLocalInputCursorVisible = () => {
      inputScrollTop = computeInputScrollTop(prompt, cursorPos, inputScrollTop, state.contentWidth, state.maxInputRows);
    };
    // `:q` and `:wq` are the editor habit for leaving; the conversation is already saved, so both only quit.
    const runQuitShortcut = () => {
      if (state.commandContext?.executeCommand) {
        void state.commandContext.executeCommand('quit', []).catch((error) => {
          state.commandContext?.print(`[quit] ${summarizeError(error)}`);
        });
        return;
      }
      state.exitApp();
    };
    if (token.logicalName === 'tab' && !commandMode) {
      if (!state.handlePathCompletion()) {
        state.handleBlockToggle();
      }
      return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
    }
    if (token.logicalName === 'enter') {
      if (token.shift) {
        prompt = prompt.slice(0, cursorPos) + '\n' + prompt.slice(cursorPos);
        cursorPos++;
        ensureLocalInputCursorVisible();
        return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
      }
      // Concealed input: the typed line is a secret. Deliver the plaintext (the
      // live feed snapshot, not the possibly-stale handler buffer) to the
      // concealed consumer, never to input history or the transcript, then clear.
      if (state.submitConcealedInput?.(prompt)) {
        prompt = '';
        cursorPos = 0;
        state.requestRender();
        return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
      }
      const originalInput = captureNativeConversationInput(prompt, undefined, undefined, state.pasteRegistry);
      const text = prompt.trim();
      if (!text && !commandMode) {
        // Target the block the user is actually reading, not the conversation's
        // oldest block (a fixed lineIndex 0 would always resolve there).
        const lineIndex = state.getBlockAnchorLine?.() ?? 0;
        const nearest = state.conversationManager?.findNearestBlock(lineIndex);
        if (nearest) {
          state.modalOpened('blockActions');
          state.blockActionsMenu.open(nearest);
          state.requestRender();
          return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
        }
      }
      if (text === ':q' || text === ':wq') {
        prompt = '';
        cursorPos = 0;
        runQuitShortcut();
        state.requestRender();
        return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
      }
      if (text) {
        // A command-shaped line with command mode off: pasted whole (the prompt
        // never equalled a bare '/'), or typed while the registry was detached.
        // handleCommandModeToken never runs in this state, so without this the
        // line would be sent as chat. Intent comes from the literal text.
        if (
          !commandMode &&
          text.startsWith('/') &&
          state.commandRegistry &&
          state.commandContext?.executeCommand
        ) {
          const registry = state.commandRegistry;
          const split = splitSlashCommand(text, (commandName) => registry.get(commandName));
          const name = split.name;
          const args = split.ok ? split.args : undefined;
          prompt = '';
          cursorPos = 0;
          if (!split.ok || !args) {
            state.commandContext.commandReadings?.cancelAll();
            state.commandContext.print(split.ok ? '' : split.reason);
            state.requestRender();
            return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
          }
          if (name) {
            state.conversationManager?.dismissSplash(); // command input retires the splash, same as text input
            state.inputHistory?.add(commandHistoryLine(text, name, args, state.commandRegistry.get(name)?.secretArgs));
            const executeCommand = state.commandContext.executeCommand;
            // Only the actual terminal fallback may carry the exact owner source.
            // Keep other fallback commands on their existing generic route.
            const command =
              ['workstream', 'project-plan', 'planning'].includes(name) && state.commandRegistry.get(name)
                ? state.commandRegistry.executeFromOwner(name, args, state.commandContext, originalInput.text)
                : executeCommand(name, args);
            void command.then((handled) => {
              if (!handled) {
                state.commandContext?.submitInput?.(text, undefined, { source: originalInput });
              }
              state.requestRender();
            });
          }
          return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
        }
        let expanded: ReturnType<typeof state.expandPrompt>;
        try {
          expanded = state.expandPrompt(text);
        } catch (error) {
          // A typed reference that cannot be read refuses the send; the draft stays as typed.
          const refused = readRefusal(error);
          if (!refused) throw error;
          state.commandContext?.print(formatRefusal(refused));
          state.requestRender();
          return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
        }
        const historyRecallText =
          typeof expanded === 'string'
            ? expanded
            : expanded
                .filter(
                  (
                    p,
                  ): p is {
                    type: 'text';
                    text: string;
                  } => p.type === 'text',
                )
                .map((p) => p.text)
                .join('');
        state.inputHistory?.add(text, { recallText: historyRecallText });
        prompt = '';
        cursorPos = 0;
        if (typeof expanded === 'string') {
          state.commandContext?.submitInput?.(expanded, undefined, { source: originalInput });
        } else {
          const textOnly = expanded
            .filter(
              (
                p,
              ): p is {
                type: 'text';
                text: string;
              } => p.type === 'text',
            )
            .map((p) => p.text)
            .join('');
          state.commandContext?.submitInput?.(textOnly, expanded, { source: originalInput });
        }
      }
      return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
    }
    if (token.logicalName === 'backspace') {
      if (cursorPos > 0) {
        state.killRing?.clearYankState();
        state.saveUndoState();
        let marker = state.findMarkerAtPos(cursorPos);
        if (!marker) {
          const ahead = state.findMarkerAtPos(cursorPos + 1);
          if (ahead && ahead.start === cursorPos) {
            marker = ahead;
          }
        }
        if (marker) {
          const markerText = prompt.slice(marker.start, marker.end);
          state.cleanupMarkerRegistry(markerText);
          prompt = prompt.slice(0, marker.start) + prompt.slice(marker.end);
          cursorPos = marker.start;
        } else {
          prompt = prompt.slice(0, cursorPos - 1) + prompt.slice(cursorPos);
          cursorPos--;
        }
        ensureLocalInputCursorVisible();
      }
      return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
    }
    if (token.logicalName === 'delete') {
      if (cursorPos < prompt.length) {
        state.killRing?.clearYankState();
        state.saveUndoState();
        const marker = state.findMarkerAtPos(cursorPos + 1);
        if (marker) {
          const markerText = prompt.slice(marker.start, marker.end);
          state.cleanupMarkerRegistry(markerText);
          prompt = prompt.slice(0, marker.start) + prompt.slice(marker.end);
        } else {
          prompt = prompt.slice(0, cursorPos) + prompt.slice(cursorPos + 1);
        }
        ensureLocalInputCursorVisible();
      }
      state.requestRender();
      return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
    }
    if (token.logicalName === 'left') {
      if (cursorPos > 0) {
        const marker = state.findMarkerAtPos(cursorPos);
        cursorPos = marker ? marker.start : cursorPos - 1;
        ensureLocalInputCursorVisible();
      }
      state.killRing?.clearYankState();
      state.breakUndoCoalesce?.();
      state.requestRender();
      return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
    }
    if (token.logicalName === 'right') {
      if (cursorPos < prompt.length) {
        const marker = state.findMarkerAtPos(cursorPos + 1);
        cursorPos = marker ? marker.end : cursorPos + 1;
        ensureLocalInputCursorVisible();
      }
      state.killRing?.clearYankState();
      state.breakUndoCoalesce?.();
      state.requestRender();
      return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
    }
    if (token.logicalName === 'home') {
      cursorPos = 0;
      state.killRing?.clearYankState();
      state.breakUndoCoalesce?.();
      ensureLocalInputCursorVisible();
      return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
    }
    if (token.logicalName === 'end') {
      cursorPos = prompt.length;
      state.killRing?.clearYankState();
      state.breakUndoCoalesce?.();
      ensureLocalInputCursorVisible();
      return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
    }
    if (token.logicalName === 'up') {
      const move = computeCursorVerticalMove(prompt, cursorPos, inputScrollTop, state.contentWidth, state.maxInputRows, -1);
      if (move.moved) {
        cursorPos = move.cursorPos;
        inputScrollTop = move.inputScrollTop;
      } else {
        const info = computeWrappedPromptInfo(prompt, cursorPos, inputScrollTop, state.contentWidth, state.maxInputRows);
        if (info.cursorWrappedLine === 0) {
          if (state.inputHistory && !state.isConcealedInput?.()) {
            const recalled = state.inputHistory.up(prompt);
            if (recalled !== null) {
              prompt = recalled;
              cursorPos = recalled.length;
              ensureLocalInputCursorVisible();
            } else {
              state.scroll(-3);
            }
          } else {
            state.scroll(-3);
          }
        }
      }
      return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
    }
    if (token.logicalName === 'down') {
      const move = computeCursorVerticalMove(prompt, cursorPos, inputScrollTop, state.contentWidth, state.maxInputRows, 1);
      if (move.moved) {
        cursorPos = move.cursorPos;
        inputScrollTop = move.inputScrollTop;
      } else {
        const info = computeWrappedPromptInfo(prompt, cursorPos, inputScrollTop, state.contentWidth, state.maxInputRows);
        const atBottom = info.cursorWrappedLine >= info.wrappedLines.length - 1;
        if (atBottom && state.inputHistory?.isBrowsing) {
          const recalled = state.inputHistory.down();
          if (recalled !== null) {
            prompt = recalled;
            cursorPos = recalled.length;
            ensureLocalInputCursorVisible();
          } else {
            indicatorFocused = true;
          }
        } else {
          indicatorFocused = true;
        }
      }
      return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
    }
    // F2 is handled globally (handler-shortcuts.ts) before it reaches this
    // route; this branch keeps the route correct when it is driven directly.
    if (token.logicalName === 'f2') {
      indicatorFocused = false;
      policy.openKeyIndicator(state);
      return { handled: true, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
    }
    return { handled: false, prompt, cursorPos, inputScrollTop, commandMode, indicatorFocused };
  }
  function handleMouseToken(
    state: MouseState,
    token: InputToken,
  ): {
    handled: boolean;
    mouseDownRow: number;
    mouseDownCol: number;
  } {
    let mouseDownRow = state.mouseDownRow;
    let mouseDownCol = state.mouseDownCol;
    if (token.type !== 'mouse') {
      return { handled: false, mouseDownRow, mouseDownCol };
    }
    // InputTokenizer already converts terminal coordinates to zero-based rows.
    const viewportRow = token.row - policy.mouseRowOffset - (state.bodyTopRow?.() ?? 2);
    if (token.button === 64) {
      state.scroll(-3);
      return { handled: true, mouseDownRow, mouseDownCol };
    }
    if (token.button === 65) {
      state.scroll(3);
      return { handled: true, mouseDownRow, mouseDownCol };
    }
    if (token.button === 1 && token.action === 'press') {
      state.handlePaste();
      return { handled: true, mouseDownRow, mouseDownCol };
    }
    // A click on a clickable footer row (press and release on the same row)
    // opens its view; it never starts a text selection.
    const footerTarget = state.footerTargetAt?.(token.row, token.col);
    if (footerTarget && token.button === 0 && token.action === 'press') {
      return { handled: true, mouseDownRow: token.row, mouseDownCol: token.col };
    }
    if (
      footerTarget &&
      token.button === 0 &&
      token.action === 'release' &&
      mouseDownRow === token.row &&
      Math.abs(token.col - mouseDownCol) <= 2 &&
      state.footerTargetAt?.(mouseDownRow, mouseDownCol) === footerTarget
    ) {
      state.openFooterTarget?.(footerTarget);
      return { handled: true, mouseDownRow: -1, mouseDownCol: -1 };
    }
    // A selection starts and extends only inside the transcript.
    if (viewportRow < 0 || viewportRow >= state.viewportHeight) {
      state.selection.endSelection();
      return { handled: true, mouseDownRow: -1, mouseDownCol: -1 };
    }
    if (token.button === 0 && token.action === 'press') {
      mouseDownRow = token.row;
      mouseDownCol = token.col;
      state.selection.startSelection(token.col, viewportRow, state.scrollTop, state.viewportHeight, state.lineCount);
      return { handled: true, mouseDownRow, mouseDownCol };
    }
    if (token.button === 32) {
      state.selection.extendSelection(token.col, viewportRow, state.scrollTop, state.viewportHeight, state.lineCount);
      return { handled: true, mouseDownRow, mouseDownCol };
    }
    if (token.action === 'release') {
      const moved = Math.abs(token.row - mouseDownRow) + Math.abs(token.col - mouseDownCol);
      if (moved <= 2 && state.conversationManager) {
        const offset = Math.max(0, state.viewportHeight - state.lineCount);
        const absoluteLine = state.scrollTop + (viewportRow - offset);
        if (absoluteLine >= 0) {
          const block = state.conversationManager.getBlockRegistry().find((b) => b.startLine === absoluteLine);
          const wt = block?.workTree;
          const target =
            wt?.kind === 'lane' && wt.agentId
              ? { kind: 'agent' as const, id: wt.agentId }
              : wt?.processId
                ? { kind: 'process' as const, id: wt.processId }
                : null;
          if (target && state.openSessionView?.(target)) {
            state.conversationManager.workTree.leave();
            state.selection.clearSelection();
            state.requestRender();
            return { handled: true, mouseDownRow: -1, mouseDownCol: -1 };
          }
          const blockIdx = block ? state.conversationManager.toggleCollapseAtLine(absoluteLine) : -1;
          if (blockIdx >= 0) {
            state.selection.clearSelection();
            state.requestRender();
            return { handled: true, mouseDownRow: -1, mouseDownCol: -1 };
          }
        }
      }
      state.handleCopy();
      state.selection.endSelection();
      return { handled: true, mouseDownRow: -1, mouseDownCol: -1 };
    }
    return { handled: false, mouseDownRow, mouseDownCol };
  }
  return { handleIndicatorFocusToken, handlePromptTextToken, handlePromptKeyToken, handleMouseToken };
}
