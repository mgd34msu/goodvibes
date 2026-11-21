import {
  createCommandModeFeedRoute,
  createWorkTreeFeedRoute,
  captureModalFeedState,
  captureIndicatorFeedState,
  capturePromptTextState,
  capturePromptKeyState,
  captureMouseFeedState,
  captureShortcutFeedState,
} from '@goodvibes/engine/terminal-shell/input-feed-adapters';
import { createFeedInputTokens } from '@goodvibes/engine/terminal-shell/input-feed-pipeline';
import type { InputToken } from '@goodvibes/engine/platform/platform/core';
import type { InfiniteBuffer } from '@goodvibes/engine/terminal-shell';
import type { CommandContext, CommandRegistry } from './command-registry.ts';
import { AutocompleteEngine } from './autocomplete.ts';
import { FilePickerModal } from './file-picker.ts';
import { ModelPickerModal } from './model-picker.ts';
import { SelectionModal } from './selection-modal.ts';
import type { SelectionResult } from './selection-modal.ts';
import { SearchManager } from './search.ts';
import type { InputHistory, HistorySearch } from './input-history.ts';
import type { ConversationManager } from '../core/conversation';
import { ProcessModal } from '../renderer/process-modal.ts';
import { LiveTailModal } from '../renderer/live-tail-modal.ts';
import { BlockActionsMenu } from '../renderer/block-actions.ts';
import { ContextInspectorModal } from '../renderer/context-inspector.ts';
import type { SurfaceModalHost } from '@goodvibes/engine/terminal-shell/surface-modal-host';
import { BookmarkModal } from './bookmark-modal.ts';
import { SettingsModal } from './settings-modal.ts';
import type { McpWorkspace } from './mcp-workspace.ts';
import type { AgentWorkspace } from './agent-workspace.ts';
import { SessionPickerModal } from './session-picker-modal.ts';
import { ProfilePickerModal } from './profile-picker-modal.ts';
import { handleIndicatorFocusToken, handleMouseToken, handlePromptKeyToken, handlePromptTextToken } from './handler-feed-routes.ts';
import type { WrappedPromptInfo } from './handler-prompt-buffer.ts';
import { handleWorkTreeToken } from './handler-work-tree-route.ts';

import { handleModalTokenRoutes } from './handler-modal-token-routes.ts';
import { handleCommandModeToken } from './handler-command-route.ts';
import { handleGlobalShortcutToken } from './handler-shortcuts.ts';
import type { PromptEdit } from './handler-shortcuts.ts';
import { SelectionManager } from '@goodvibes/engine/terminal-shell';
import type { KeybindingsManager } from './keybindings.ts';
import type { ModelPickerTarget } from './model-picker.ts';
import { guardCommandPaste, type PasteBurstGuardState } from './paste-flood-guard.ts';
import type { FocusTracker } from '@/runtime/index.ts';

/**
 * InputFeedContext, The single long-lived context object passed to feedInputTokens
 * on every keystroke. Allocated once at InputHandler construction; mutated in place
 * per-feed to avoid per-keystroke GC pressure from ~80-field object allocation.
 *
 * **Mutable per-feed** (read and written on the handler itself, so an action closure's
 * edit is seen by every route at once):
 *   - `prompt`, `cursorPos`, current text buffer state
 *   - `commandMode`, `indicatorFocused`, focus-mode flags
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
 *     bookkeeping (not part of the shared guard) for the honest resolution
 *     notice, see feedInputTokens below.
 *   - `focusTracker` (the platform's FocusTracker), tracks OS-level
 *     terminal focus from `\x1b[I`/`\x1b[O` tokens (DECSET ?1004h, enabled in
 *     main.ts). Shared instance from RuntimeServices, threaded via
 *     uiServices.platform.focusTracker (mirrors the TUI's own wiring).
 *   - `selectionModal`, `bookmarkModal`, `settingsModal`, `sessionPickerModal`,
 *     `profilePickerModal`, modal objects constructed once in InputHandler constructor
 *   - `filePicker`, `modelPicker`, `processModal`, `liveTailModal`,
 *     `contextInspectorModal`, `blockActionsMenu`, `searchManager`, `historySearch`,
 *     service objects constructed once
 *   - `keybindingsManager`, from uiServices, stable for app lifetime
 *   - `getHistory`, `getViewportHeight`, `getScrollTop`, `scroll`, `exitApp`, stable
 *     callbacks bound in the InputHandler constructor
 *   - All method closures (`handleEscape`, etc.), bound once at init
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
  nextPasteId: number;
  nextImageId: number;
  mouseDownRow: number;
  mouseDownCol: number;
  contentWidth: number;
  readonly pasteRegistry: Map<string, string>;
  readonly imageRegistry: Map<string, { data: string; mediaType: string }>;
  /** State for the shared unbracketed-paste-flood guard (terminal-shell), mutated in place, never reallocated. */
  readonly burstGuard: PasteBurstGuardState;
  /** Wiring-layer bookkeeping (not part of the shared guard) for the honest suppressed-count notice. */
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
  /** The modal stack: a kit modal on top (the activity modal, ...) takes every key itself. */
  readonly surfaceModals?: SurfaceModalHost;
  readonly blockActionsMenu: BlockActionsMenu;
  readonly searchManager: SearchManager;
  readonly keybindingsManager: KeybindingsManager;
  inputHistory: InputHistory | null;
  conversationManager: ConversationManager | null;
  readonly getHistory: () => InfiniteBuffer;
  readonly getViewportHeight: () => number;
  readonly getScrollTop: () => number;
  readonly scroll: (delta: number) => void;
  requestRender: () => void;
  /** What a status bar segment at this screen cell opens on a click (footer-targets.ts). */
  readonly footerTargetAt: (row: number, col?: number) => import('../renderer/footer-targets.ts').FooterTarget | undefined;
  readonly openFooterTarget: (target: import('../renderer/footer-targets.ts').FooterTarget) => void;
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
  readonly expandPrompt: (text: string) => string | import('@goodvibes/engine/platform/platform/providers').ContentPart[];
  readonly openModelPickerWithTarget: (target: ModelPickerTarget, source?: 'settings') => boolean;
  readonly openProviderModelPickerWithTarget: (target: ModelPickerTarget, source?: 'settings') => boolean;
  readonly onModelPickerCommit: () => boolean;
  readonly exitApp: () => void;
}

export const feedInputTokens = createFeedInputTokens<InputFeedContext>({
  // Every token goes to an open kit modal, mouse included: the modals ignore a mouse
  // token, so a click or wheel over one never reaches the transcript underneath.
  surfaceModalTokens: 'all',
  pairing: (context, token) => context.handleSetupPairingToken?.(token) ?? false,
  modal: (context, token, { history }) => handleModalTokenRoutes(
    {
      ...captureModalFeedState(context, token, history),
      surfaceModals: context.surfaceModals,
      agentWorkspace: context.agentWorkspace,
      liveTailModal: context.liveTailModal,
      processModal: context.processModal,
    },
    token,
  ),
  workTree: createWorkTreeFeedRoute<InputFeedContext>(handleWorkTreeToken),
  indicator: (context, token) => handleIndicatorFocusToken(
    {
      ...captureIndicatorFeedState(context),
      openAgentsView: () => { context.commandContext?.openAgents?.(); },
      syncModals: () => context.surfaceModals?.sync(),
    },
    token,
  ),
  text: (context, token) => handlePromptTextToken(capturePromptTextState(context), token),
  key: (context, token) => handlePromptKeyToken(
    {
      ...capturePromptKeyState(context),
      commandRegistry: context.commandRegistry,
      openAgentsView: () => { context.commandContext?.openAgents?.(); },
      syncModals: () => context.surfaceModals?.sync(),
    },
    token,
  ),
  mouse: (context, token, environment) => handleMouseToken({
    ...captureMouseFeedState(context, environment),
    footerTargetAt: context.footerTargetAt,
    openFooterTarget: context.openFooterTarget,
  }, token),
  shortcut: (context, token, { viewportHeight }) => {
    const shortcutState = {
      ...captureShortcutFeedState(context),
      cycleAgentWorkspaceCategory: context.cycleAgentWorkspaceCategory,
      dismissAgentWorkspace: context.dismissAgentWorkspace,
    };
    const handled = handleGlobalShortcutToken(shortcutState, token, viewportHeight);
    return { ...shortcutState, handled };
  },
  command: createCommandModeFeedRoute<InputFeedContext>(handleCommandModeToken),
  beforeComposer: (context, token, { now }) => guardCommandPaste(context, token, now),
});
