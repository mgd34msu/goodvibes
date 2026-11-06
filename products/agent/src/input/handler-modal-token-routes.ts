import { createModalTokenPipeline } from '@goodvibes-jev/engine/terminal-shell/modal-token-pipeline';
import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import type { InfiniteBuffer } from '@goodvibes-jev/engine/terminal-shell';
import type { ConversationManager } from '../core/conversation.ts';
import type { SelectionResult, SelectionModal } from './selection-modal.ts';
import type { BookmarkModal } from './bookmark-modal.ts';
import type { SettingsModal } from './settings-modal.ts';
import type { SessionPickerModal } from './session-picker-modal.ts';
import type { ProfilePickerModal } from './profile-picker-modal.ts';
import type { HistorySearch } from './input-history.ts';
import type { ModelPickerModal } from './model-picker.ts';
import { handleAgentWorkspaceToken, type AgentWorkspace } from './agent-workspace.ts';
import { handleMcpWorkspaceToken, type McpWorkspace } from './mcp-workspace.ts';
import type { CommandContext } from './command-registry.ts';
import type { LiveTailModal } from '../renderer/live-tail-modal.ts';
import type { ProcessModal } from '../renderer/process-modal.ts';
import type { ContextInspectorModal } from '../renderer/context-inspector.ts';
import type { OverlayFilters } from './overlay-filter.ts';
import type { FilePickerModal } from './file-picker.ts';
import type { BlockActionsMenu, BlockActionId } from '../renderer/block-actions.ts';
import type { SearchManager } from './search.ts';
import { handleHistorySearchToken, handleOverlayToken, handleSearchModeToken } from './handler-ui-state.ts';
import {
  handleBookmarkModalToken,
  handleProfilePickerToken,
  handleSelectionModalToken,
  handleSessionPickerToken,
  handleSettingsModalToken,
} from './handler-modal-routes.ts';
import {
  handleBlockActionsToken,
  handleEscapeOnlyModalToken,
  handleFilePickerToken,
  handleLiveTailToken,
  handleModelPickerToken,
  handleProcessModalToken,
} from './handler-picker-routes.ts';

export type ModalTokenRouteState = {
  history: InfiniteBuffer;
  searchShortcutMatch: boolean;
  selectionModal: SelectionModal;
  selectionCallback: ((result: SelectionResult | null) => void) | null;
  getSelectionCallback?: () => ((result: SelectionResult | null) => void) | null;
  setSelectionCallback?: (callback: ((result: SelectionResult | null) => void) | null) => void;
  bookmarkModal: BookmarkModal;
  settingsModal: SettingsModal;
  mcpWorkspace: McpWorkspace;
  agentWorkspace: AgentWorkspace;
  sessionPickerModal: SessionPickerModal;
  profilePickerModal: ProfilePickerModal;
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
  liveTailModal: LiveTailModal;
  processModal: ProcessModal;
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
  /** Lets in-transcript search look INTO collapsed blocks and folded
   *  tool-result groups (see search.ts) instead of only scanning the rendered
   *  buffer. Null before the manager is late-wired. */
  conversationManager: ConversationManager | null;
  scroll: (delta: number) => void;
  getScrollTop: () => number;
  /** Callback to open the model picker with a specific target (helper or tool). Optional, only wired when available. */
  openModelPickerWithTarget?: (target: import('./model-picker.ts').ModelPickerTarget, source?: 'settings') => boolean;
  openProviderModelPickerWithTarget?: (target: import('./model-picker.ts').ModelPickerTarget, source?: 'settings') => boolean;
  onModelPickerCommit?: () => boolean;
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
      'handleModelPickerToken',
      'handleSettingsModalToken',
      'handleMcpWorkspaceToken',
      'agent-workspace',
      'handleSessionPickerToken',
      'handleProfilePickerToken',
      'handleOverlayToken',
      'handleHistorySearchToken',
      'live-tail',
      'handleEscapeOnlyModalToken',
      'process',
      'handleFilePickerToken',
      'handleBlockActionsToken',
    ],
    additional: {
      'agent-workspace': (state, token) => handleAgentWorkspaceToken(state.agentWorkspace, token, state.handleEscape, state.requestRender),
      'live-tail': (state, token) =>
        handleLiveTailToken(
          {
            liveTailModal: state.liveTailModal,
            processModal: state.processModal,
            requestRender: state.requestRender,
            handleEscape: state.handleEscape,
          },
          token,
        ),
      process: (state, token) =>
        handleProcessModalToken(
          {
            processModal: state.processModal,
            liveTailModal: state.liveTailModal,
            modalOpened: state.modalOpened,
            requestRender: state.requestRender,
            handleEscape: state.handleEscape,
            openProcessView: (id) => state.commandContext?.openSessionView?.({ kind: 'process', id }) ?? false,
          },
          token,
        ),
    },
  },
);
