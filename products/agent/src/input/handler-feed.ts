import { createFeedInputTokens } from '@goodvibes-jev/engine/terminal-shell/input-feed-pipeline';
import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import type { InfiniteBuffer } from '@goodvibes-jev/engine/terminal-shell';
import type { CommandContext, CommandRegistry } from './command-registry.ts';
import { AutocompleteEngine } from './autocomplete.ts';
import { FilePickerModal } from './file-picker.ts';
import { ModelPickerModal } from './model-picker.ts';
import { SelectionModal } from './selection-modal.ts';
import type { SelectionResult } from './selection-modal.ts';
import { SearchManager } from './search.ts';
import type { InputHistory, HistorySearch } from './input-history.ts';
import type { BlockMeta, ConversationManager } from '../core/conversation';
import { ProcessModal } from '../renderer/process-modal.ts';
import { LiveTailModal } from '../renderer/live-tail-modal.ts';
import { BlockActionsMenu } from '../renderer/block-actions.ts';
import { ContextInspectorModal } from '../renderer/context-inspector.ts';
import type { OverlayFilters } from './overlay-filter.ts';
import type { SurfaceModalHost } from './surface-modal-host.ts';
import { BookmarkModal } from './bookmark-modal.ts';
import { SettingsModal } from './settings-modal.ts';
import type { McpWorkspace } from './mcp-workspace.ts';
import type { AgentWorkspace } from './agent-workspace.ts';
import { SessionPickerModal } from './session-picker-modal.ts';
import { ProfilePickerModal } from './profile-picker-modal.ts';
import { IMAGE_EXTENSIONS, formatFileSize, mediaTypeFromExt } from './handler-content-actions.ts';
import { handleIndicatorFocusToken, handleMouseToken, handlePromptKeyToken, handlePromptTextToken } from './handler-feed-routes.ts';
import type { WrappedPromptInfo } from './handler-prompt-buffer.ts';
import { getViewportBottomLine } from '../renderer/conversation-layout.ts';
import { handleWorkTreeToken } from './handler-work-tree-route.ts';

import { handleModalTokenRoutes } from './handler-modal-token-routes.ts';
import { handleCommandModeToken } from './handler-command-route.ts';
import { handleGlobalShortcutToken } from './handler-shortcuts.ts';
import type { PromptEdit } from './handler-shortcuts.ts';
import { SelectionManager } from '@goodvibes-jev/engine/terminal-shell';
import type { KeybindingsManager } from './keybindings.ts';
import type { ModelPickerTarget } from './model-picker.ts';
import { guardCommandPaste, type PasteBurstGuardState } from './paste-flood-guard.ts';
import type { FocusTracker } from '@/runtime/index.ts';

/**
 * InputFeedContext, The single long-lived context object passed to feedInputTokens
 * on every keystroke. Allocated once at InputHandler construction; mutated in place
 * per-feed to avoid per-keystroke GC pressure from ~80-field object allocation.
 *
 * **Mutable per-feed** (synced from handler at the top of every feed() call, and
 * updated inside action closures via syncFeedContextMutableFields):
 *   - `prompt`, `cursorPos`, current text buffer state
 *   - `commandMode`, `indicatorFocused`, focus-mode flags
 *   - `helpOverlayActive`, `helpScrollOffset`, help overlay visibility and scroll
 *   - `shortcutsOverlayActive`, `shortcutsScrollOffset`, shortcuts overlay state
 *   - `nextPasteId`, `nextImageId`, monotonically increasing ID counters
 *   - `mouseDownRow`, `mouseDownCol`, drag-tracking coordinates
 *   - `contentWidth`, reflow width (semi-stable; synced at feed() entry only)
 *   - `selectionCallback`, current in-flight selection modal callback (nullable)
 *   - `requestRender`, swapped per-feed to a buffered version, restored after
 *
 * **Stable service handles** (set once at construction, never reallocated):
 *   - `commandRegistry`, `commandContext`, wired via setCommandRegistry() after
 *     construction; synced at feed() entry (not per-action) since no action changes them
 *   - `autocomplete`, wired after construction; synced at feed() entry
 *   - `inputHistory`, `conversationManager`, late-wired service handles; synced at
 *     feed() entry only since no in-feed action rewires them
 *   - `pasteRegistry`, `imageRegistry`, owned Maps, never replaced
 *   - `burstGuard` (see paste-flood-guard.ts), the
 *     unbracketed-paste-flood guard's sliding-window state, mutated in place
 *     across tokens by trackPasteFloodGuard (see paste-flood-guard.ts).
 *     Never reallocated. `burstSuppressedCount` is this wiring layer's own
 *     bookkeeping (not part of the ported module) for the honest resolution
 *     notice, see feedInputTokens below.
 *   - `focusTracker` (the SDK's FocusTracker), tracks OS-level
 *     terminal focus from `\x1b[I`/`\x1b[O` tokens (DECSET ?1004h, enabled in
 *     main.ts). Shared instance from RuntimeServices, threaded via
 *     uiServices.platform.focusTracker (mirrors the TUI's own wiring).
 *   - `selectionModal`, `bookmarkModal`, `settingsModal`, `sessionPickerModal`,
 *     `profilePickerModal`, modal objects constructed once in InputHandler constructor
 *   - `filePicker`, `modelPicker`, `processModal`, `liveTailModal`,
 *     `contextInspectorModal`, `blockActionsMenu`, `searchManager`, `historySearch`,
 *     service objects constructed once
 *   - `keybindingsManager`, from uiServices, stable for app lifetime
 *   - `modalStack`, reference to the handler's shared array (mutated in place)
 *   - `getHistory`, `getViewportHeight`, `getScrollTop`, `scroll`, `exitApp`, stable
 *     callbacks bound in the InputHandler constructor
 *   - All method closures (`modalOpened`, `handleEscape`, etc.), bound once at init
 *
 * **Rationale:** per-feed mutation avoids per-keystroke allocation cost; stable
 * references are service handles whose identity never changes after construction.
 */
export interface InputFeedContext {
  handleSetupPairingToken?: (token: InputToken) => boolean;
  prompt: string;
  cursorPos: number;
  inputScrollTop: number;
  commandMode: boolean;
  indicatorFocused: boolean;
  helpOverlayActive: boolean;
  helpScrollOffset: number;
  shortcutsOverlayActive: boolean;
  shortcutsScrollOffset: number;
  nextPasteId: number;
  nextImageId: number;
  mouseDownRow: number;
  mouseDownCol: number;
  contentWidth: number;
  readonly pasteRegistry: Map<string, string>;
  readonly imageRegistry: Map<string, { data: string; mediaType: string }>;
  /** Ported from goodvibes-tui's paste-flood guard, mutated in place, never reallocated. */
  readonly burstGuard: PasteBurstGuardState;
  /** Wiring-layer bookkeeping (not part of the ported module) for the honest suppressed-count notice. */
  burstSuppressedCount: number;
  /** OS-level terminal focus, fed from the 'focus' tokens below. */
  readonly focusTracker: FocusTracker;
  readonly projectRoot: string;
  readonly selection: SelectionManager;
  readonly selectionModal: SelectionModal;
  selectionCallback: ((result: SelectionResult | null) => void) | null;
  readonly bookmarkModal: BookmarkModal;
  readonly settingsModal: SettingsModal;
  readonly mcpWorkspace: McpWorkspace;
  readonly agentWorkspace: AgentWorkspace;
  readonly sessionPickerModal: SessionPickerModal;
  readonly profilePickerModal: ProfilePickerModal;
  readonly historySearch: HistorySearch;
  commandRegistry: CommandRegistry | null;
  commandContext: CommandContext | undefined;
  autocomplete: AutocompleteEngine | null;
  readonly filePicker: FilePickerModal;
  readonly modelPicker: ModelPickerModal;
  readonly processModal: ProcessModal;
  readonly liveTailModal: LiveTailModal;
  readonly contextInspectorModal: ContextInspectorModal;
  readonly overlayFilters: OverlayFilters;
  /** Kit modals (the activity modal, ...): they take every key while open. */
  readonly surfaceModals?: SurfaceModalHost;
  readonly blockActionsMenu: BlockActionsMenu;
  readonly searchManager: SearchManager;
  readonly keybindingsManager: KeybindingsManager;
  readonly modalStack: string[];
  inputHistory: InputHistory | null;
  conversationManager: ConversationManager | null;
  readonly getHistory: () => InfiniteBuffer;
  readonly getViewportHeight: () => number;
  readonly getScrollTop: () => number;
  readonly scroll: (delta: number) => void;
  requestRender: () => void;
  readonly modalOpened: (name: string) => void;
  /** The agent or process view controls (null before the shell wires them). */
  readonly getSessionView: () => import('./handler-session-view-route.ts').SessionViewControls | null;
  readonly handleEscape: () => void;
  /**
   * Deliver an Enter submission to a pending composer line prompt (masked card
   * field, or plain address field). True means it was consumed and the normal
   * submit path, including input history, must not run. See
   * input/concealed-input.ts and input/plain-line-input.ts.
   */
  readonly submitConcealedInput: (value: string) => boolean;
  readonly handleCopy: () => void;
  readonly handleCtrlC: () => void;
  readonly handleBlockCopy: () => void;
  readonly handleBookmark: () => void;
  readonly handleBlockSave: () => void;
  // Report where the prompt landed; the shortcut route copies it forward.
  readonly handleUndo: () => PromptEdit | void;
  readonly handleRedo: () => PromptEdit | void;
  readonly handlePaste: () => PromptEdit | void;
  readonly saveUndoState: () => void;
  readonly ensureInputCursorVisible: (contentWidth?: number) => void;
  readonly registerPaste: (content: string) => string;
  readonly executeBlockAction: (id: string) => void;
  readonly cycleAgentWorkspaceCategory: (direction: 'next' | 'prev') => void;
  readonly dismissAgentWorkspace: () => boolean;
  readonly getWrappedPromptInfo: (contentWidth: number) => WrappedPromptInfo;
  readonly moveCursorVertical: (direction: -1 | 1) => boolean;
  readonly handlePathCompletion: () => boolean;
  readonly bodyTopRow: () => number;
  readonly handleBlockToggle: () => void;
  readonly findMarkerAtPos: (pos: number) => { start: number; end: number } | null;
  readonly cleanupMarkerRegistry: (text: string) => void;
  readonly expandPrompt: (text: string) => string | import('@goodvibes-jev/engine/sdk/platform/providers').ContentPart[];
  readonly openModelPickerWithTarget: (target: ModelPickerTarget, source?: 'settings') => boolean;
  readonly openProviderModelPickerWithTarget: (target: ModelPickerTarget, source?: 'settings') => boolean;
  readonly onModelPickerCommit: () => boolean;
  readonly exitApp: () => void;
}

export const feedInputTokens = createFeedInputTokens<InputFeedContext>({
  surfaceModalTokens: 'text-key',
  guardModalWrites: true,
  pairing: (context, token) => context.handleSetupPairingToken?.(token) ?? false,
  modal: (context, token, { history }) => {
    const keybindings = context.keybindingsManager;
    return handleModalTokenRoutes(
      {
        history,
        searchShortcutMatch: token.type === 'key' && keybindings.matches('search', token),
        selectionModal: context.selectionModal,
        selectionCallback: context.selectionCallback,
        getSelectionCallback: () => context.selectionCallback,
        setSelectionCallback: (callback) => {
          context.selectionCallback = callback;
        },
        bookmarkModal: context.bookmarkModal,
        settingsModal: context.settingsModal,
        mcpWorkspace: context.mcpWorkspace,
        agentWorkspace: context.agentWorkspace,
        sessionPickerModal: context.sessionPickerModal,
        profilePickerModal: context.profilePickerModal,
        helpOverlayActive: context.helpOverlayActive,
        helpScrollOffset: context.helpScrollOffset,
        shortcutsOverlayActive: context.shortcutsOverlayActive,
        shortcutsScrollOffset: context.shortcutsScrollOffset,
        historySearch: context.historySearch,
        prompt: context.prompt,
        cursorPos: context.cursorPos,
        modelPicker: context.modelPicker,
        modalStack: context.modalStack,
        commandContext: context.commandContext,
        getViewportHeight: context.getViewportHeight,
        requestRender: context.requestRender,
        handleEscape: context.handleEscape,
        liveTailModal: context.liveTailModal,
        processModal: context.processModal,
        contextInspectorModal: context.contextInspectorModal,
        overlayFilters: context.overlayFilters,
        modalOpened: context.modalOpened,
        filePicker: context.filePicker,
        imageRegistry: context.imageRegistry,
        nextImageId: context.nextImageId,
        saveUndoState: context.saveUndoState,
        ensureInputCursorVisible: () => context.ensureInputCursorVisible(),
        formatFileSize,
        mediaTypeFromExt,
        imageExtensions: IMAGE_EXTENSIONS,
        blockActionsMenu: context.blockActionsMenu,
        executeBlockAction: context.executeBlockAction,
        searchManager: context.searchManager,
        conversationManager: context.conversationManager,
        scroll: context.scroll,
        getScrollTop: context.getScrollTop,
        openModelPickerWithTarget: context.openModelPickerWithTarget,
        openProviderModelPickerWithTarget: context.openProviderModelPickerWithTarget,
        onModelPickerCommit: context.onModelPickerCommit,
      },
      token,
    );
  },
  workTree: (context, token, { viewportHeight, scrollTop, lineCount }) => {
    const keybindings = context.keybindingsManager;
    return handleWorkTreeToken(
      {
        conversationManager: context.conversationManager,
        enterMatch: token.type === 'key' && keybindings.matches('focus-work-tree', token),
        anchorLine: getViewportBottomLine(scrollTop, viewportHeight, lineCount),
        scrollTop: context.getScrollTop(),
        viewportHeight,
        scroll: context.scroll,
        requestRender: context.requestRender,
        onCopied: () => {
          /* the copy receipt is the transcript line handleBlockCopy logs */
        },
        openAgent: (id) => context.commandContext?.openSessionView?.({ kind: 'agent', id }) ?? false,
        openProcess: (id) => context.commandContext?.openSessionView?.({ kind: 'process', id }) ?? false,
      },
      token,
    );
  },
  indicator: (context, token) => {
    return handleIndicatorFocusToken(
      {
        indicatorFocused: context.indicatorFocused,
        modalOpened: context.modalOpened,
        processModal: context.processModal,
        requestRender: context.requestRender,
      },
      token,
    );
  },
  text: (context, token) => {
    return handlePromptTextToken(
      {
        prompt: context.prompt,
        cursorPos: context.cursorPos,
        commandMode: context.commandMode,
        nextPasteId: context.nextPasteId,
        nextImageId: context.nextImageId,
        pasteRegistry: context.pasteRegistry,
        imageRegistry: context.imageRegistry,
        inputHistory: context.inputHistory,
        commandRegistry: context.commandRegistry,
        commandContext: context.commandContext,
        autocomplete: context.autocomplete,
        filePicker: context.filePicker,
        modalOpened: context.modalOpened,
        saveUndoState: context.saveUndoState,
        ensureInputCursorVisible: () => context.ensureInputCursorVisible(),
        registerPaste: context.registerPaste,
        requestRender: context.requestRender,
      },
      token,
    );
  },
  key: (context, token) => {
    return handlePromptKeyToken(
      {
        prompt: context.prompt,
        cursorPos: context.cursorPos,
        inputScrollTop: context.inputScrollTop,
        commandMode: context.commandMode,
        contentWidth: context.contentWidth,
        maxInputRows: 8,
        inputHistory: context.inputHistory,
        indicatorFocused: context.indicatorFocused,
        conversationManager: context.conversationManager,
        commandContext: context.commandContext,
        autocomplete: context.autocomplete,
        blockActionsMenu: { open: (block: BlockMeta) => context.blockActionsMenu.open(block) },
        processModal: context.processModal,
        modalOpened: context.modalOpened,
        saveUndoState: context.saveUndoState,
        ensureInputCursorVisible: context.ensureInputCursorVisible,
        getWrappedPromptInfo: context.getWrappedPromptInfo,
        moveCursorVertical: context.moveCursorVertical,
        handlePathCompletion: context.handlePathCompletion,
        handleBlockToggle: context.handleBlockToggle,
        findMarkerAtPos: context.findMarkerAtPos,
        cleanupMarkerRegistry: context.cleanupMarkerRegistry,
        expandPrompt: context.expandPrompt,
        submitConcealedInput: context.submitConcealedInput,
        scroll: context.scroll,
        exitApp: context.exitApp,
        requestRender: context.requestRender,
      },
      token,
    );
  },
  mouse: (context, token, { viewportHeight, scrollTop, lineCount }) => {
    return handleMouseToken(
      {
        conversationManager: context.conversationManager,
        selection: context.selection,
        mouseDownRow: context.mouseDownRow,
        mouseDownCol: context.mouseDownCol,
        scrollTop,
        viewportHeight,
        lineCount,
        scroll: context.scroll,
        requestRender: context.requestRender,
        handlePaste: context.handlePaste,
        handleCopy: context.handleCopy,
        bodyTopRow: context.bodyTopRow,
      },
      token,
    );
  },
  shortcut: (context, token, { viewportHeight }) => {
    const shortcutState = {
      prompt: context.prompt,
      cursorPos: context.cursorPos,
      commandMode: context.commandMode,
      autocomplete: context.autocomplete,
      historySearch: context.historySearch,
      searchManager: context.searchManager,
      conversationManager: context.conversationManager,
      commandContext: context.commandContext,
      contentWidth: context.contentWidth,
      getScrollTop: context.getScrollTop,
      getWrappedPromptInfo: context.getWrappedPromptInfo,
      saveUndoState: context.saveUndoState,
      requestRender: context.requestRender,
      scroll: context.scroll,
      ensureInputCursorVisible: () => context.ensureInputCursorVisible(),
      handleCopy: context.handleCopy,
      handleCtrlC: context.handleCtrlC,
      handleBlockCopy: context.handleBlockCopy,
      handleBookmark: context.handleBookmark,
      handleBlockSave: context.handleBlockSave,
      handleUndo: context.handleUndo,
      handleRedo: context.handleRedo,
      handlePaste: context.handlePaste,
      handleEscape: context.handleEscape,
      cycleAgentWorkspaceCategory: context.cycleAgentWorkspaceCategory,
      dismissAgentWorkspace: context.dismissAgentWorkspace,
      keybindingsManager: context.keybindingsManager,
    };
    const handled = handleGlobalShortcutToken(shortcutState, token, viewportHeight);
    return { ...shortcutState, handled };
  },
  command: (context, token) => {
    const commandState = {
      commandMode: context.commandMode,
      prompt: context.prompt,
      cursorPos: context.cursorPos,
      autocomplete: context.autocomplete,
      modalStack: context.modalStack,
      commandRegistry: context.commandRegistry,
      commandContext: context.commandContext,
      conversationManager: context.conversationManager,
      requestRender: context.requestRender,
      handleEscape: context.handleEscape,
      projectRoot: context.projectRoot,
      pasteRegistry: context.pasteRegistry,
      imageRegistry: context.imageRegistry,
      nextPasteId: context.nextPasteId,
      nextImageId: context.nextImageId,
      saveUndoState: context.saveUndoState,
      ensureInputCursorVisible: () => context.ensureInputCursorVisible(),
    };
    const handled = handleCommandModeToken(commandState, token);
    return { ...commandState, handled };
  },
  beforeComposer: (context, token, { now }) => guardCommandPaste(context, token, now),
});
