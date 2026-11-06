import {
  applyConversationOverlayRows,
  composeConversationLayers,
  type ModalEntry,
} from '@goodvibes-jev/engine/terminal-shell/renderer/conversation-overlays';
import type { Line } from '@goodvibes-jev/engine/sdk/platform/types';
import type { ConversationManager } from '../core/conversation';
import type { CommandRegistry } from '../input/command-registry.ts';
import type { InputHandler } from '../input/handler.ts';
import type { KeybindingsManager } from '../input/keybindings.ts';
import { renderFilePickerOverlay } from './file-picker-overlay.ts';
import { renderModelWorkspace } from './model-workspace.ts';
import { renderSelectionModalOverlay } from './selection-modal-overlay.ts';
import { renderSearchOverlay } from './search-overlay.ts';
import { renderHistorySearchOverlay } from './history-search-overlay.ts';
import { renderProcessModal } from './process-modal.ts';
import { renderLiveTailModal } from './live-tail-modal.ts';
import { renderContextInspector } from './context-inspector.ts';
import { renderSettingsModal } from './settings-modal.ts';
import { renderMcpWorkspace } from './mcp-workspace.ts';
import { renderSessionPickerModal } from './session-picker-modal.ts';
import { renderProfilePickerModal } from './profile-picker-modal.ts';
import { renderBookmarkModal } from './bookmark-modal.ts';
import { renderHelpOverlay, renderShortcutsOverlay } from './help-overlay.ts';
import { renderAutocompleteOverlay } from './autocomplete-overlay.ts';
import { renderAgentWorkspace } from './agent-workspace.ts';
import { renderBlockActionsMenu } from './block-actions-overlay.ts';
import './conversation-layout.ts';
import type { SurfaceLayer } from './surface-kit.ts';
import './surface-kit-parts.ts';
import { getSharedToastCenter } from './toast-center.ts';

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
  return (
    input.modelPicker.active ||
    input.settingsModal.active ||
    input.mcpWorkspace.active ||
    input.agentWorkspace.active ||
    input.sessionPickerModal.active ||
    input.profilePickerModal.active ||
    input.bookmarkModal.active ||
    input.selectionModal.active ||
    input.contextInspectorModal.active ||
    input.processModal.active ||
    input.liveTailModal.active ||
    input.blockActionsMenu.active ||
    input.helpOverlayActive ||
    input.shortcutsOverlayActive ||
    input.surfaceModals.active
  );
}

/**
 * The parts of the conversation area that are rows rather than modals: the
 * @ and slash popups anchored to the composer (never dimmed: you are still
 * typing) and the search bars. Every modal is a layer instead, see
 * buildConversationLayers.
 */
export function applyConversationOverlays(viewport: Line[], context: ConversationOverlayContext): Line[] {
  const { input, conversationWidth: width, viewportHeight: height } = context;
  return applyConversationOverlayRows(viewport, {
    width,
    height,
    covered: modalOpen(input),
    mutateSearchRows: false,

    filePicker: input.filePicker.active ? () => renderFilePickerOverlay(input.filePicker, width, height) : undefined,
    search: input.searchManager.active ? () => renderSearchOverlay(input.searchManager, width) : undefined,
    historySearch: input.historySearch.active ? () => renderHistorySearchOverlay(input.historySearch, width) : undefined,
    autocomplete:
      input.commandMode && input.autocomplete?.isActive ? () => renderAutocompleteOverlay(input.autocomplete!, width, height) : undefined,
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
  /** The permission dialog, when a request is waiting (drawn above the other modals). */
  readonly permission?: SurfaceLayer | null;
  /** Rows at the top of the screen held by the header (and the session chips row); toasts start below them. */
  readonly headerRows?: number;
  /** Rows at the bottom of the screen held by the footer (the throbber and its empty row while main works, the composer, the status line); toasts stay above them. */
  readonly footerRows?: number;
}

/**
 * The Agent workspace as it is painted on screen. Disk state (memory count,
 * routine start counts) is mirrored on every repaint first, so the counters
 * never show a stale point-in-time snapshot.
 */
export function renderAgentWorkspaceLayer(workspace: InputHandler['agentWorkspace'], width: number, height: number): SurfaceLayer {
  workspace.syncLiveCountersForRender();
  return renderAgentWorkspace(workspace, width, height);
}

/**
 * Modal surfaces drawn with the surface kit, as layers the compositor stamps
 * over the dimmed screen (surface-compose.ts). When one modal opens another
 * (the Agent workspace opening settings or the model picker, the process
 * monitor opening a live tail), both are drawn in the order they were opened
 * (the input layer's modal stack), the newer on top, each dimming what is
 * under it. Kit-host modals and the permission dialog sit above all of them.
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
      () => renderContextInspector(context.conversation, w, h, context.contextWindow, input.contextInspectorModal),
    ],
    ['process', input.processModal.active, () => renderProcessModal(input.processModal, w, h)],
    ['liveTail', input.liveTailModal.active, () => renderLiveTailModal(input.liveTailModal, w, h)],
    ['blockActions', input.blockActionsMenu.active, () => renderBlockActionsMenu(input.blockActionsMenu, w, h)],
    ['selection', input.selectionModal.active, () => renderSelectionModalOverlay(input.selectionModal, w, h)],
    [
      'help',
      input.helpOverlayActive,
      () =>
        renderHelpOverlay(
          w,
          h,
          context.keybindingsManager,
          context.commandRegistry.getVisible(),
          input.helpScrollOffset,
          input.overlayFilters.help,
        ),
    ],
    [
      'shortcuts',
      input.shortcutsOverlayActive,
      () => renderShortcutsOverlay(w, h, context.keybindingsManager, input.shortcutsScrollOffset, input.overlayFilters.shortcuts),
    ],
  ];
  return composeConversationLayers({
    entries,
    modalStack: input.modalStack,
    width: w,
    height: h,
    renderSurfaceModals: () => input.surfaceModals.render(w, h),
    permission: context.permission,
    headerRows: context.headerRows,
    footerRows: context.footerRows,
    toasts: () => getSharedToastCenter().visible(),
  });
}
