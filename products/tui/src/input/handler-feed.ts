import {
  createCommandModeFeedRoute,
  createWorkTreeFeedRoute,
  captureModalFeedState,
  captureIndicatorFeedState,
  capturePromptTextState,
  capturePromptKeyState,
  captureMouseFeedState,
  captureShortcutFeedState,
  refreshCommandAutocomplete,
} from '@goodvibes/engine/terminal-shell/input-feed-adapters';
import { createFeedInputTokens } from '@goodvibes/engine/terminal-shell/input-feed-pipeline';
import type { InputToken } from '@goodvibes/engine/platform/platform/core';
import type { InfiniteBuffer } from '@goodvibes/engine/terminal-shell';
import type { CommandContext, CommandRegistry } from './command-registry.ts';
import type { SurfaceModalHost } from '@goodvibes/engine/terminal-shell/surface-modal-host';
import { AutocompleteEngine } from './autocomplete.ts';
import { FilePickerModal } from './file-picker.ts';
import { ModelPickerModal } from './model-picker.ts';
import { SelectionModal } from './selection-modal.ts';
import type { SelectionResult } from './selection-modal.ts';
import { SearchManager } from './search.ts';
import type { InputHistory, HistorySearch } from './input-history.ts';
import type { ConversationManager } from '../core/conversation';
import { BlockActionsMenu } from '../renderer/block-actions.ts';
import { ContextInspectorModal } from '../renderer/context-inspector.ts';
import { BookmarkModal } from './bookmark-modal.ts';
import { SettingsModal } from './settings-modal.ts';
import type { McpWorkspace } from './mcp-workspace.ts';
import { SessionPickerModal } from './session-picker-modal.ts';
import type { ConfigModal } from './config-modal.ts';
import { ProfilePickerModal } from '@goodvibes/engine/terminal-shell/profile-picker-state';
import type { OnboardingWizardController } from './onboarding/onboarding-wizard.ts';
import type { OnboardingWizardAction } from './onboarding/onboarding-wizard.ts';
import { handleIndicatorFocusToken, handleMouseToken, handlePromptKeyToken, handlePromptTextToken } from './handler-feed-routes.ts';
import type { WrappedPromptInfo } from './handler-prompt-buffer.ts';
import { getViewportBottomLine } from '../renderer/conversation-layout.ts';
import { handleWorkTreeToken } from './handler-work-tree-route.ts';

import { expandTextPastes } from './handler-content-actions.ts';
import { handleModalTokenRoutes } from './handler-modal-token-routes.ts';
import { handleCommandModeToken } from './handler-command-route.ts';
import { handleGlobalShortcutToken, runShortcutAction } from './handler-shortcuts.ts';
import { LeaderKeyState, leaderMayArm } from '@goodvibes/engine/terminal-shell/leader-key';
import { SelectionManager } from '@goodvibes/engine/terminal-shell';
import type { KeybindingsManager } from './keybindings.ts';
import type { ModelPickerTarget } from './model-picker.ts';
import type { KillRing } from './kill-ring.ts';
import type { FocusTracker } from '@goodvibes/engine/platform/platform/runtime/operations';
import { guardCommandPaste, type PasteBurstGuardState } from '@goodvibes/engine/terminal-shell/paste-flood-guard';

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
 *   - `selectionModal`, `bookmarkModal`, `settingsModal`, `sessionPickerModal`,
 *     `profilePickerModal`, modal objects constructed once in InputHandler constructor
 *   - `filePicker`, `modelPicker`, `onboardingWizard`,
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
  handleHostPairingToken?: (token: InputToken) => boolean;
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
  readonly projectRoot: string;
  readonly selection: SelectionManager;
  readonly selectionModal: SelectionModal;
  selectionCallback: ((result: SelectionResult | null) => void) | null;
  readonly bookmarkModal: BookmarkModal;
  readonly settingsModal: SettingsModal;
  readonly mcpWorkspace: McpWorkspace;
  readonly sessionPickerModal: SessionPickerModal;
  readonly profilePickerModal: ProfilePickerModal;
  readonly configModal: ConfigModal;
  readonly historySearch: HistorySearch;
  commandRegistry: CommandRegistry | null;
  commandContext: CommandContext | undefined;
  autocomplete: AutocompleteEngine | null;
  readonly filePicker: FilePickerModal;
  readonly modelPicker: ModelPickerModal;
  readonly onboardingWizard: OnboardingWizardController;
  readonly contextInspectorModal: ContextInspectorModal;
  readonly blockActionsMenu: BlockActionsMenu;
  /** The modal stack: a kit modal on top (command palette, confirm dialog, ...) takes every key itself. */
  readonly surfaceModals?: SurfaceModalHost;
  readonly searchManager: SearchManager;
  readonly keybindingsManager: KeybindingsManager;
  inputHistory: InputHistory | null;
  conversationManager: ConversationManager | null;
  readonly killRing: KillRing;
  /** Terminal focus tracker, updated here from 'focus' tokens, read by the unfocused-alert notifiers in core/. */
  readonly focusTracker: FocusTracker;
  readonly getHistory: () => InfiniteBuffer;
  readonly getViewportHeight: () => number;
  readonly getScrollTop: () => number;
  readonly scroll: (delta: number) => void;
  requestRender: () => void;
  /** The agent or process view controls (null before the shell wires them). */
  readonly getSessionView: () => import('./handler-session-view-route.ts').SessionViewControls | null;
  readonly handleEscape: () => void;
  /** Deliver a concealed submission; returns true when concealed mode consumed it. */
  readonly submitConcealedInput: (value: string) => boolean;
  readonly handleCopy: () => void;
  readonly handleCtrlC: () => void;
  readonly handleBlockCopy: () => void;
  readonly handleBookmark: () => void;
  readonly handleBlockSave: () => void;
  readonly handleUndo: () => void;
  readonly handleRedo: () => void;
  readonly handlePaste: () => void;
  readonly saveUndoState: () => void;
  /** Coalescing variant: consecutive text insertions within UNDO_COALESCE_MS merge into one group. */
  readonly saveUndoStateForText: () => void;
  /** Break the current coalescing group (cursor moves call this). */
  readonly breakUndoCoalesce: () => void;
  readonly ensureInputCursorVisible: (contentWidth?: number) => void;
  readonly registerPaste: (content: string) => string;
  readonly executeBlockAction: (id: string) => void;
  readonly getWrappedPromptInfo: (contentWidth: number) => WrappedPromptInfo;
  readonly moveCursorVertical: (direction: -1 | 1) => boolean;
  readonly handlePathCompletion: () => boolean;
  readonly footerTargetAt: (row: number, col?: number) => import('../renderer/footer-targets.ts').FooterTarget | undefined;
  readonly openFooterTarget: (target: import('../renderer/footer-targets.ts').FooterTarget) => void;
  readonly bodyTopRow: () => number;
  readonly handleBlockToggle: () => void;
  readonly findMarkerAtPos: (pos: number) => { start: number; end: number } | null;
  readonly cleanupMarkerRegistry: (text: string) => void;
  readonly expandPrompt: (text: string) => string | import('@goodvibes/engine/platform/platform/providers').ContentPart[];
  readonly restoreRecalledInput: (message: import('@goodvibes/engine/terminal-shell/input-content').ComposerMessage) => string;
  readonly openModelPickerWithTarget: (target: ModelPickerTarget, source?: 'settings' | 'onboarding') => boolean;
  readonly openProviderModelPickerWithTarget: (target: ModelPickerTarget, source?: 'settings' | 'onboarding') => boolean;
  readonly onModelPickerCommit: () => boolean;
  readonly onOnboardingAction: (action: OnboardingWizardAction) => void;
  readonly exitApp: () => void;
}

export const feedInputTokens = createFeedInputTokens<InputFeedContext>({
  surfaceModalTokens: 'all',
  pairing: (context, token) => context.handleHostPairingToken?.(token) ?? false,
  modal: (context, token, { history }) => handleModalTokenRoutes(
    {
      ...captureModalFeedState(context, token, history),
      surfaceModals: context.surfaceModals,
      configModal: context.configModal,
      onboardingWizard: context.onboardingWizard,
      onOnboardingAction: context.onOnboardingAction,
    },
    token,
  ),
  workTree: createWorkTreeFeedRoute<InputFeedContext>(handleWorkTreeToken),
  indicator: (context, token) => handleIndicatorFocusToken(
    {
      ...captureIndicatorFeedState(context),
      openAgentsView: () => { context.commandContext?.openAgents?.(); },
    },
    token,
  ),
  text: (context, token) => handlePromptTextToken(
    { ...capturePromptTextState(context), saveUndoStateForText: context.saveUndoStateForText, killRing: context.killRing }, token,
  ),
  key: (context, token, { viewportHeight, scrollTop, lineCount }) => handlePromptKeyToken(
    {
      ...capturePromptKeyState(context),
      commandRegistry: context.commandRegistry,
      getBlockAnchorLine: () => getViewportBottomLine(scrollTop, viewportHeight, lineCount),
      openAgentsView: () => { context.commandContext?.openAgents?.(); },
      breakUndoCoalesce: context.breakUndoCoalesce,
      killRing: context.killRing,
    },
    token,
  ),
  mouse: (context, token, environment) => handleMouseToken({
    ...captureMouseFeedState(context, environment),
    openSessionView: (target) => context.commandContext?.openSessionView?.(target) ?? false,
    footerTargetAt: context.footerTargetAt,
    openFooterTarget: context.openFooterTarget,
  }, token),
  shortcut: (context, token, { viewportHeight }) => {
    const shortcutState = {
      ...captureShortcutFeedState(context),
      killRing: context.killRing,
    };
    const handled = handleGlobalShortcutToken(shortcutState, token, viewportHeight);
    return { ...shortcutState, handled };
  },
  command: createCommandModeFeedRoute<InputFeedContext>(handleCommandModeToken),
  beforeComposer: (context, token, { now }) => guardCommandPaste(context, token, now),
  afterShortcut: refreshCommandAutocomplete,
  expandPastes: (context, text) => expandTextPastes(context.pasteRegistry, text),
  // The leader sequence (terminal-shell/leader-key.ts), read over every screen. A config screen's action
  // letters stay after the leader (handler-modal-routes.ts); every other key completes the table's sequence.
  leader: {
    state: leaderOf,
    canArm: (context) => leaderMayArm(context.surfaceModals),
    screenFollow: (context, follow) => {
      if (!context.configModal.active) return false;
      const name = follow.logicalName ?? '';
      const key = [...name].length === 1 && follow.shift ? name.toUpperCase() : name;
      if ([...key].length !== 1 || !context.configModal.resolveAction(key)) return false;
      // The config screen fires its own action for the letter, as its own leader did.
      const text: InputToken = { type: 'text', value: key };
      context.configModal.armLeader();
      handleModalTokenRoutes({
        ...captureModalFeedState(context, text, context.getHistory()),
        surfaceModals: context.surfaceModals,
        configModal: context.configModal,
        onboardingWizard: context.onboardingWizard,
        onOnboardingAction: context.onOnboardingAction,
      }, text);
      return true;
    },
    // Over a config screen, the strip lists its own letters first (the ones screenFollow takes), then the table's.
    screenKeys: (context) => (context.configModal.active ? context.configModal.leaderKeys() : []),
    run: (context, action) => {
      const shortcutState = {
        ...captureShortcutFeedState(context),
        killRing: context.killRing,
      };
      const handled = runShortcutAction(shortcutState, action);
      return { ...shortcutState, handled };
    },
  },
});

/** One leader state per program, beside its modal stack. */
const leaderStates = new WeakMap<SurfaceModalHost, LeaderKeyState>();
function leaderOf(context: InputFeedContext): LeaderKeyState | undefined {
  const modals = context.surfaceModals;
  if (!modals) return undefined;
  let state = leaderStates.get(modals);
  if (!state) {
    state = new LeaderKeyState(context.keybindingsManager, () => modals);
    leaderStates.set(modals, state);
  }
  return state;
}
