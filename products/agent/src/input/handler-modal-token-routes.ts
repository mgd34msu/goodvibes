import { createModalTokenPipeline } from '@goodvibes/engine/terminal-shell/modal-token-pipeline';
import type { InfiniteBuffer } from '@goodvibes/engine/terminal-shell';
import type { ConversationManager } from '../core/conversation.ts';
import type { SelectionResult, SelectionModal } from './selection-modal.ts';
import type { BookmarkModal } from './bookmark-modal.ts';
import type { SessionPickerModal } from './session-picker-modal.ts';
import type { ProfilePickerModal } from './profile-picker-modal.ts';
import type { HistorySearch } from './input-history.ts';
import type { ModelPickerModal } from './model-picker.ts';
import { handleMcpWorkspaceToken, type McpWorkspace } from './mcp-workspace.ts';
import type { CommandContext } from './command-registry.ts';
import type { LiveTailModal } from '../renderer/live-tail-modal.ts';
import type { ProcessModal } from '../renderer/process-modal.ts';
import type { ContextInspectorModal } from '../renderer/context-inspector.ts';
import type { FilePickerModal } from './file-picker.ts';
import type { BlockActionsMenu, BlockActionId } from '../renderer/block-actions.ts';
import type { SearchManager } from './search.ts';
import type { SurfaceModalHost } from '@goodvibes/engine/terminal-shell/surface-modal-host';
import { handleHistorySearchToken, handleSearchModeToken } from './handler-ui-state.ts';
import {
  handleBookmarkModalToken,
  handleProfilePickerToken,
  handleSelectionModalToken,
  handleSessionPickerToken,
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
  mcpWorkspace: McpWorkspace;
  sessionPickerModal: SessionPickerModal;
  profilePickerModal: ProfilePickerModal;
  historySearch: HistorySearch;
  prompt: string;
  cursorPos: number;
  modelPicker: ModelPickerModal;
  /** The modal stack: its top modal takes the key. */
  surfaceModals?: SurfaceModalHost;
  commandContext?: CommandContext;
  getViewportHeight: () => number;
  requestRender: () => void;
  handleEscape: () => void;
  liveTailModal: LiveTailModal;
  processModal: ProcessModal;
  contextInspectorModal: ContextInspectorModal;
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
    handleMcpWorkspaceToken,
    handleSessionPickerToken,
    handleProfilePickerToken,
    handleHistorySearchToken,
    handleModelPickerToken,
    handleEscapeOnlyModalToken,
    handleFilePickerToken,
    handleBlockActionsToken,
  },
  {
    additional: {
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
            requestRender: state.requestRender,
            handleEscape: state.handleEscape,
            openProcessView: (id) => state.commandContext?.openSessionView?.({ kind: 'process', id }) ?? false,
          },
          token,
        ),
    },
  },
);
