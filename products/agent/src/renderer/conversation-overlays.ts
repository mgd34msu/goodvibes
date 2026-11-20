import {
  applyConversationPopupRows,
  isCommonConversationModalOpen,
  composeConversationLayers,
  type ModalEntry,
} from '@goodvibes-jev/engine/terminal-shell/renderer/conversation-overlays';
import type { Line } from '@goodvibes-jev/engine/platform/platform/types';
import type { ConversationManager } from '../core/conversation';
import type { CommandRegistry } from '../input/command-registry.ts';
import type { InputHandler } from '../input/handler.ts';
import type { KeybindingsManager } from '../input/keybindings.ts';
import { renderFilePickerOverlay } from './file-picker-overlay.ts';
import { renderModelWorkspace } from './model-workspace.ts';
import { renderSelectionModalOverlay } from './selection-modal-overlay.ts';
import { renderSearchOverlay } from './search-overlay.ts';
import { renderHistorySearchOverlay } from '@goodvibes-jev/engine/terminal-shell/history-search-overlay';
import { renderProcessModal } from './process-modal.ts';
import { renderLiveTailModal } from './live-tail-modal.ts';
import { renderContextInspector } from './context-inspector.ts';
import { renderSettingsModal } from './settings-modal.ts';
import { renderMcpWorkspace } from './mcp-workspace.ts';
import { renderSessionPickerModal } from './session-picker-modal.ts';
import { renderProfilePickerModal } from './profile-picker-modal.ts';
import { renderBookmarkModal } from './bookmark-modal.ts';
import { renderAutocompleteOverlay } from './autocomplete-overlay.ts';
import { renderAgentWorkspace } from './agent-workspace.ts';
import { renderBlockActionsMenu } from './block-actions-overlay.ts';
import type { SurfaceLayer } from './surface-kit.ts';
import { getSharedToastCenter } from './toast-center.ts';
import { firstRunOwnsScreen } from '@goodvibes-jev/engine/terminal-shell/first-run';

export interface ConversationOverlayContext {
  readonly input: InputHandler;
  readonly conversation: ConversationManager;
  readonly commandRegistry: CommandRegistry;
  readonly keybindingsManager: KeybindingsManager;
  readonly conversationWidth: number;
  readonly viewportHeight: number;
  readonly contextWindow?: number;
}

/** True while a modal covers the screen, so the composer-anchored popups stay hidden. */
export function modalOpen(input: InputHandler): boolean {
  return isCommonConversationModalOpen(input) || input.agentWorkspace.active || input.processModal.active || input.liveTailModal.active;
}

/**
 * The parts of the conversation area that are rows rather than modals: the
 * @ and slash popups anchored to the composer (never dimmed: you are still
 * typing) and the search bars. Every modal is a layer instead, see
 * buildConversationLayers.
 */
export function applyConversationOverlays(viewport: Line[], context: ConversationOverlayContext): Line[] {
  const { input, conversationWidth: width, viewportHeight: height } = context;
  return applyConversationPopupRows(viewport, input, {
    width,
    height,
    covered: modalOpen(input),
    mutateSearchRows: false,
  }, {
    filePicker: renderFilePickerOverlay,
    search: renderSearchOverlay,
    historySearch: renderHistorySearchOverlay,
    autocomplete: renderAutocompleteOverlay,
  });
}

export interface ConversationLayerContext {
  readonly input: InputHandler;
  readonly conversation: ConversationManager;
  readonly commandRegistry: CommandRegistry;
  readonly keybindingsManager: KeybindingsManager;
  /** Full terminal size: modals are sized against the whole screen. */
  readonly screenWidth: number;
  readonly screenHeight: number;
  readonly contextWindow?: number;
  /**
   * The provider's own input-token count of the last request (system prompt,
   * tools and messages): the figure the status-line meter shows. The context
   * inspector uses it as its total and shows the part the messages do not
   * account for as one row. 0 before the first reply.
   */
  readonly providerInputTokens?: number;
  /** The permission dialog, when a request is waiting (drawn above the other modals). */
  readonly permission?: SurfaceLayer | null;
  /** Rows at the top of the screen held by the header (and the session chips row); toasts start below them. */
  readonly headerRows?: number;
  /** Rows at the bottom of the screen held by the footer (the throbber and its empty row while main works, the composer, the status line); toasts stay above them. */
  readonly footerRows?: number;
}

/** The Agent workspace as it is painted on screen. */
export function renderAgentWorkspaceLayer(workspace: InputHandler['agentWorkspace'], width: number, height: number): SurfaceLayer {
  return renderAgentWorkspace(workspace, width, height);
}

/**
 * Modal surfaces drawn with the surface kit, as layers the compositor stamps
 * over the dimmed screen (surface-compose.ts). When one modal opens another
 * (the Agent workspace opening settings or the model picker, the process
 * monitor opening a live tail), both are drawn in the order they were opened
 * (the input layer's modal stack, kit modals such as the activity modal
 * included), the newer on top, each dimming what is under it. The permission
 * dialog sits above all of them.
 */
export function buildConversationLayers(context: ConversationLayerContext): SurfaceLayer[] {
  const { input, screenWidth: w, screenHeight: h } = context;
  const entries: ModalEntry[] = [
    ['agentWorkspace', input.agentWorkspace.active, () => renderAgentWorkspaceLayer(input.agentWorkspace, w, h)],
    ['modelPicker', input.modelPicker.active, () => renderModelWorkspace(input.modelPicker, w, h)],
    ['settings', input.settingsModal.active, () => renderSettingsModal(input.settingsModal, w, h)],
    ['mcpWorkspace', input.mcpWorkspace.active, () => renderMcpWorkspace(input.mcpWorkspace, w, h)],
    ['sessionPicker', input.sessionPickerModal.active, () => renderSessionPickerModal(input.sessionPickerModal, w, h)],
    ['profilePicker', input.profilePickerModal.active, () => renderProfilePickerModal(input.profilePickerModal, w, h)],
    ['bookmark', input.bookmarkModal.active, () => renderBookmarkModal(input.bookmarkModal, w, h)],
    [
      'contextInspector',
      input.contextInspectorModal.active,
      () => renderContextInspector(context.conversation, w, h, context.contextWindow, input.contextInspectorModal, context.providerInputTokens ?? 0),
    ],
    ['process', input.processModal.active, () => renderProcessModal(input.processModal, w, h)],
    ['liveTail', input.liveTailModal.active, () => renderLiveTailModal(input.liveTailModal, w, h)],
    ['blockActions', input.blockActionsMenu.active, () => renderBlockActionsMenu(input.blockActionsMenu, w, h)],
    ['selection', input.selectionModal.active, () => renderSelectionModalOverlay(input.selectionModal, w, h)],
  ];
  return composeConversationLayers({
    entries,
    modals: input.surfaceModals.modals(),
    width: w,
    height: h,
    permission: context.permission,
    headerRows: context.headerRows,
    footerRows: context.footerRows,
    toasts: getSharedToastCenter(),
    // First run's screens and the splash own the screen: notices go only to the count.
    screenOwned: firstRunOwnsScreen() || context.conversation.isSplashShowing(),
  });
}
