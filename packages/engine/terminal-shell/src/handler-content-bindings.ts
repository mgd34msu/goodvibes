import {
  cleanupMarkerRegistry,
  findMarkerAtPos,
  handleClipboardPaste,
  handleCtrlC,
  registerPasteForHost,
  type PasteRegistryState,
  type ClipboardPasteSource,
  type expandPrompt,
} from './input-content.js';
import type { createBlockContentActions } from './block-content-actions.js';
import type { TerminalConversationManager } from './terminal-conversation.js';
import type { InfiniteBuffer } from './conversation-history.js';
import type { SelectionManager } from './text-selection.js';
import type { BookmarkManager } from '@goodvibes-jev/engine/platform/platform/bookmarks';
import { activeTokens } from './renderer/theme.js';
import type { handleEscape } from './modal-stack.js';
export interface HandlerContentHost extends PasteRegistryState {
  prompt: string;
  cursorPos: number;
  lastCopyTime: number;
  lastBlockCopyTime: number;
  lastCtrlCTime: number;
  showExitNotice: boolean;
  lastCtrlCTimeoutId?: ReturnType<typeof setTimeout> | null | undefined;
  readonly imageRegistry: Map<string, { data: string; mediaType: string }>;
  nextImageId: number;
  readonly conversationManager: TerminalConversationManager | null;
  readonly selection: SelectionManager;
  readonly clipboardSource: ClipboardPasteSource;
  readonly getHistory: () => InfiniteBuffer;
  readonly uiServices: {
    readonly environment: { readonly shellPaths: { readonly workingDirectory: string } };
    readonly shell: { readonly bookmarkManager: BookmarkManager };
  };
  readonly commandContext?: { readonly cancelGeneration?: (() => boolean | void) | undefined } | undefined;
  saveUndoState(): void;
  ensureInputCursorVisible(): void;
  requestRender(): void;
  exitApp(): void;
}
/** Bind common composer/content operations once; products choose anchor, receipts and timeout ownership. */
export function createHandlerContentBindings<Host extends HandlerContentHost>(policy: {
  readonly anchor: (host: Host) => () => number;
  readonly actions: ReturnType<typeof createBlockContentActions>;
  readonly expandPrompt: typeof expandPrompt;
  readonly emptyClipboard: () => string;
  readonly ownCtrlCTimeout: boolean;
}) {
  function handlePasteForHandler(host: Host): ReturnType<typeof handleClipboardPaste> {
    const result = handleClipboardPaste(
      {
        prompt: host.prompt,
        cursorPos: host.cursorPos,
        pasteRegistry: host.pasteRegistry,
        nextPasteId: host.nextPasteId,
        imageRegistry: host.imageRegistry,
        nextImageId: host.nextImageId,
        saveUndoState: () => host.saveUndoState(),
        ensureInputCursorVisible: () => host.ensureInputCursorVisible(),
        requestRender: host.requestRender,
      },
      host.uiServices.environment.shellPaths.workingDirectory,
      host.clipboardSource,
    );
    host.prompt = result.prompt;
    host.cursorPos = result.cursorPos;
    host.nextImageId = result.nextImageId;
    host.nextPasteId = result.nextPasteId;
    if (!result.pasted) {
      host.conversationManager?.log(policy.emptyClipboard(), { fg: activeTokens().textFaint });
      host.requestRender();
    }
    return result;
  }
  function registerPasteForHandler(host: Host, content: string): string {
    return registerPasteForHost(host, content, host.uiServices.environment.shellPaths.workingDirectory);
  }
  function expandPromptForHandler(host: Host, text: string): ReturnType<typeof expandPrompt> {
    return policy.expandPrompt(host.pasteRegistry, host.imageRegistry, text, host.uiServices.environment.shellPaths.workingDirectory);
  }
  function getImageAttachmentsForHandler(host: Host) {
    return new Map(host.imageRegistry);
  }
  function cleanupMarkerRegistryForHandler(host: Host, text: string): void {
    cleanupMarkerRegistry(host.imageRegistry, text);
  }
  function findMarkerAtPosForHandler(host: Host, position: number) {
    return findMarkerAtPos(host.prompt, position);
  }
  function handleCopyForHandler(host: Host): void {
    policy.actions.handleCopy(host.selection, host.getHistory, host.requestRender, () => {
      host.lastCopyTime = Date.now();
    });
  }
  function handleBlockCopyForHandler(host: Host): void {
    policy.actions.handleBlockCopy(host.conversationManager, policy.anchor(host), host.requestRender, () => {
      host.lastBlockCopyTime = Date.now();
    });
  }
  function handleBookmarkForHandler(host: Host): void {
    policy.actions.handleBookmark(host.conversationManager, policy.anchor(host), host.requestRender, host.uiServices.shell.bookmarkManager);
  }
  function handleBlockSaveForHandler(host: Host): void {
    policy.actions.handleBlockSave(
      host.conversationManager,
      policy.anchor(host),
      host.requestRender,
      host.uiServices.shell.bookmarkManager,
    );
  }
  function handleBlockToggleForHandler(host: Host): void {
    policy.actions.handleBlockToggle(host.conversationManager, policy.anchor(host), host.requestRender);
  }
  function handleCtrlCForHandler(host: Host): void {
    handleCtrlC(
      host.prompt,
      () => host.saveUndoState(),
      (value) => {
        host.prompt = value;
      },
      (value) => {
        host.cursorPos = value;
      },
      host.commandContext?.cancelGeneration,
      host.exitApp,
      host.requestRender,
      host.lastCtrlCTime,
      (value) => {
        host.lastCtrlCTime = value;
      },
      (value) => {
        host.showExitNotice = value;
      },
      policy.ownCtrlCTimeout ? (host.lastCtrlCTimeoutId ?? null) : null,
      (value) => {
        if (policy.ownCtrlCTimeout) host.lastCtrlCTimeoutId = value;
      },
    );
  }
  return {
    handlePasteForHandler,
    registerPasteForHandler,
    expandPromptForHandler,
    getImageAttachmentsForHandler,
    cleanupMarkerRegistryForHandler,
    findMarkerAtPosForHandler,
    handleCopyForHandler,
    handleBlockCopyForHandler,
    handleBookmarkForHandler,
    handleBlockSaveForHandler,
    handleBlockToggleForHandler,
    handleCtrlCForHandler,
  };
}

type EscapeResult = ReturnType<typeof handleEscape>;
/** Apply the shared modal result to the live host, preserving composer and focus state together. */
export function applyEscapeResult(host: { [Key in keyof EscapeResult]?: EscapeResult[Key] | undefined }, result: EscapeResult): void {
  host.prompt = result.prompt;
  host.cursorPos = result.cursorPos;
  host.commandMode = result.commandMode;
  host.helpOverlayActive = result.helpOverlayActive;
  host.helpScrollOffset = result.helpScrollOffset;
  host.shortcutsOverlayActive = result.shortcutsOverlayActive;
  host.shortcutsScrollOffset = result.shortcutsScrollOffset;
  host.selectionCallback = result.selectionCallback;
  host.indicatorFocused = result.indicatorFocused;
  host.modalReturnFocus = result.modalReturnFocus;
}
