import { createModalTokenPipeline } from '@goodvibes-jev/engine/terminal-shell/modal-token-pipeline';
import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import type { InfiniteBuffer } from '@goodvibes-jev/engine/terminal-shell';
import type { ConversationManager } from '../core/conversation';
import type { SelectionResult, SelectionModal } from './selection-modal.ts';
import type { BookmarkModal } from './bookmark-modal.ts';
import type { SettingsModal } from './settings-modal.ts';
import type { SessionPickerModal } from './session-picker-modal.ts';
import type { ProfilePickerModal } from './profile-picker-modal.ts';
import type { ConfigModal } from './config-modal.ts';
import type { HistorySearch } from './input-history.ts';
import type { ModelPickerModal } from './model-picker.ts';
import { handleMcpWorkspaceToken, type McpWorkspace } from './mcp-workspace.ts';
import type { CommandContext } from './command-registry.ts';
import type { ContextInspectorModal } from '../renderer/context-inspector.ts';
import type { OverlayFilters } from './overlay-filter.ts';
import type { FilePickerModal } from './file-picker.ts';
import type { BlockActionsMenu, BlockActionId } from '../renderer/block-actions.ts';
import type { SearchManager } from './search.ts';
import type { OnboardingWizardAction, OnboardingWizardController } from './onboarding/onboarding-wizard.ts';
import { handleHistorySearchToken, handleOverlayToken, handleSearchModeToken } from './handler-ui-state.ts';
import { handleOnboardingWizardToken } from './onboarding/handler-onboarding-routes.ts';
import {
  handleBookmarkModalToken,
  handleConfigModalToken,
  handleProfilePickerToken,
  handleSelectionModalToken,
  handleSessionPickerToken,
  handleSettingsModalToken,
} from './handler-modal-routes.ts';
import {
  handleBlockActionsToken,
  handleEscapeOnlyModalToken,
  handleFilePickerToken,
  handleModelPickerToken,
} from './handler-picker-routes.ts';

export type ModalTokenRouteState = {
  history: InfiniteBuffer;
  /** Threaded into SearchManager.search() so a matching but currently-
   *  collapsed block gets auto-expanded before the buffer is scanned. */
  conversationManager?: ConversationManager | null;
  searchShortcutMatch: boolean;
  selectionModal: SelectionModal;
  selectionCallback: ((result: SelectionResult | null) => void) | null;
  getSelectionCallback?: () => ((result: SelectionResult | null) => void) | null;
  setSelectionCallback?: (callback: ((result: SelectionResult | null) => void) | null) => void;
  bookmarkModal: BookmarkModal;
  settingsModal: SettingsModal;
  mcpWorkspace: McpWorkspace;
  sessionPickerModal: SessionPickerModal;
  profilePickerModal: ProfilePickerModal;
  configModal: ConfigModal;
  onboardingWizard: OnboardingWizardController;
  helpOverlayActive: boolean;
  helpScrollOffset: number;
  shortcutsOverlayActive: boolean;
  shortcutsScrollOffset: number;
  historySearch: HistorySearch;
  prompt: string;
  cursorPos: number;
  modelPicker: ModelPickerModal;
  modalStack: string[];
  commandContext?: CommandContext;
  getViewportHeight: () => number;
  requestRender: () => void;
  handleEscape: () => void;
  contextInspectorModal: ContextInspectorModal;
  overlayFilters?: OverlayFilters;
  modalOpened: (name: string) => void;
  filePicker: FilePickerModal;
  imageRegistry: Map<string, { data: string; mediaType: string }>;
  nextImageId: number;
  saveUndoState: () => void;
  ensureInputCursorVisible: () => void;
  formatFileSize: (bytes: number) => string;
  mediaTypeFromExt: (ext: string) => string;
  imageExtensions: string[];
  blockActionsMenu: BlockActionsMenu;
  executeBlockAction: (actionId: BlockActionId) => void;
  searchManager: SearchManager;
  scroll: (delta: number) => void;
  getScrollTop: () => number;
  /** Callback to open the model picker with a specific target (helper or tool). Optional, only wired when available. */
  openModelPickerWithTarget?: (target: import('./model-picker.ts').ModelPickerTarget, source?: 'settings' | 'onboarding') => boolean;
  openProviderModelPickerWithTarget?: (
    target: import('./model-picker.ts').ModelPickerTarget,
    source?: 'settings' | 'onboarding',
  ) => boolean;
  clearOnboardingModelPickerCancelState?: () => void;
  restoreOnboardingModelPickerCancelState?: () => void;
  onModelPickerCommit?: () => boolean;
  onOnboardingAction?: (action: OnboardingWizardAction) => void;
  /** Called after any wizard step navigation so the handler can persist progress. */
  onStepChange?: () => void;
};

export const handleModalTokenRoutes = createModalTokenPipeline<ModalTokenRouteState>(
  {
    handleSearchModeToken,
    handleSelectionModalToken,
    handleBookmarkModalToken,
    handleSettingsModalToken,
    handleMcpWorkspaceToken,
    handleSessionPickerToken,
    handleProfilePickerToken,
    handleOverlayToken,
    handleHistorySearchToken,
    handleModelPickerToken,
    handleEscapeOnlyModalToken,
    handleFilePickerToken,
    handleBlockActionsToken,
  },
  {
    order: [
      'handleSearchModeToken',
      'handleSelectionModalToken',
      'handleBookmarkModalToken',
      'handleSettingsModalToken',
      'handleMcpWorkspaceToken',
      'handleSessionPickerToken',
      'handleProfilePickerToken',
      'config',
      'handleOverlayToken',
      'handleHistorySearchToken',
      'handleModelPickerToken',
      'onboarding',
      'handleEscapeOnlyModalToken',
      'handleFilePickerToken',
      'handleBlockActionsToken',
    ],
    additional: {
      config: (state, token) =>
        handleConfigModalToken(
          {
            configModal: state.configModal,
            commandContext: state.commandContext,
            requestRender: state.requestRender,
            handleEscape: state.handleEscape,
          },
          token,
        ),
      onboarding: (state, token) =>
        handleOnboardingWizardToken(
          {
            onboardingWizard: state.onboardingWizard,
            getViewportHeight: state.getViewportHeight,
            requestRender: state.requestRender,
            handleEscape: state.handleEscape,
            openModelPickerWithTarget: state.openModelPickerWithTarget,
            onAction: state.onOnboardingAction,
            onStepChange: state.onStepChange,
          },
          token,
        ),
    },
  },
);
