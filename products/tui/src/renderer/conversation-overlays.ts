import {
  applyConversationPopupRows,
  isCommonConversationModalOpen,
  composeConversationLayers,
  type ModalEntry,
} from '@goodvibes/engine/terminal-shell/renderer/conversation-overlays';
import type { Line } from '@goodvibes/engine/platform/platform/types';
import type { ConversationManager } from '../core/conversation';
import type { CommandRegistry } from '../input/command-registry.ts';
import type { InputHandler } from '../input/handler.ts';
import type { KeybindingsManager } from '../input/keybindings.ts';
import { renderFilePickerOverlay } from './file-picker-overlay.ts';
import { renderModelWorkspace } from './model-workspace.ts';
import { renderSelectionModalOverlay } from './selection-modal-overlay.ts';
import { renderSearchOverlay } from './search-overlay.ts';
import { renderHistorySearchOverlay } from '@goodvibes/engine/terminal-shell/history-search-overlay';
import { renderContextInspector } from './context-inspector.ts';
import { renderConfigModal } from './config-modal.ts';
import { renderMcpWorkspace } from './mcp-workspace.ts';
import { renderSessionPickerModal } from './session-picker-modal.ts';
import { renderProfilePickerModal } from './profile-picker-modal.ts';
import { renderBookmarkModal } from './bookmark-modal.ts';
import { renderBlockActionsMenu } from './block-actions-overlay.ts';
import { renderAutocompleteOverlay } from './autocomplete-overlay.ts';
import { renderOnboardingWizard } from './onboarding/onboarding-wizard.ts';
import { replaceViewportWithOverlay } from './conversation-layout.ts';
import type { SurfaceLayer } from './surface-kit.ts';
import { layerToLines } from './surface-kit-extra.ts';

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
function modalOpen(input: InputHandler): boolean {
  return isCommonConversationModalOpen(input) || input.configModal.active;
}

/**
 * The setup form opened from something already open (a place's "set it up"): it is drawn as a layer in the stack's
 * order, above what opened it, instead of as the screen beneath every modal.
 */
function onboardingAboveAModal(input: InputHandler): boolean {
  return input.onboardingWizard.active && input.surfaceModals.modals().indexOf(input.modals.onboarding) > 0;
}

/**
 * The parts of the conversation area that are rows rather than modals:
 * onboarding (which owns the whole viewport), the @ and slash popups anchored
 * to the composer (never dimmed: you are still typing), and the search bars.
 * Every modal is a layer instead, see buildConversationLayers.
 */
export function applyConversationOverlays(viewport: Line[], context: ConversationOverlayContext): Line[] {
  const { input, conversationWidth: width, viewportHeight: height } = context;
  return applyConversationPopupRows(viewport, input, {
    width,
    height,
    covered: modalOpen(input),
    mutateSearchRows: true,
    replaceViewport: input.onboardingWizard.active && !onboardingAboveAModal(input)
      ? () =>
          replaceViewportWithOverlay(
            layerToLines(renderOnboardingWizard(input.onboardingWizard, width, height), width, height),
            width,
            height,
          )
      : undefined,
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
}

/**
 * Modal surfaces drawn with the surface kit, as layers the compositor stamps
 * over the dimmed screen (surface-compose.ts). Normally one modal is open;
 * when one opens another (settings opening the model picker or a theme
 * picker), both are drawn in the order they were opened (the input layer's
 * modal stack, kit modals such as the command palette included), the newer
 * on top, each dimming what is under it. The permission dialog sits above
 * all of them.
 */
export function buildConversationLayers(context: ConversationLayerContext): SurfaceLayer[] {
  const { input, screenWidth: w, screenHeight: h } = context;
  // Onboarding owns the screen; only the pickers it launches draw over it.
  const onboarding = input.onboardingWizard.active;
  const entries: ModalEntry[] = [
    ['onboarding', onboardingAboveAModal(input), () => renderOnboardingWizard(input.onboardingWizard, w, h)],
    ['modelPicker', input.modelPicker.active, () => renderModelWorkspace(input.modelPicker, w, h)],
    ['mcpWorkspace', input.mcpWorkspace.active, () => renderMcpWorkspace(input.mcpWorkspace, w, h)],
    ['config', !onboarding && input.configModal.active, () => renderConfigModal(input.configModal, w, h)],
    ['sessionPicker', !onboarding && input.sessionPickerModal.active, () => renderSessionPickerModal(input.sessionPickerModal, w, h)],
    ['profilePicker', !onboarding && input.profilePickerModal.active, () => renderProfilePickerModal(input.profilePickerModal, w, h)],
    ['bookmark', !onboarding && input.bookmarkModal.active, () => renderBookmarkModal(input.bookmarkModal, w, h)],
    ['blockActions', !onboarding && input.blockActionsMenu.active, () => renderBlockActionsMenu(input.blockActionsMenu, w, h)],
    [
      'contextInspector',
      !onboarding && input.contextInspectorModal.active,
      () => renderContextInspector(context.conversation, w, h, context.contextWindow, input.contextInspectorModal, context.providerInputTokens ?? 0),
    ],
    ['selection', input.selectionModal.active, () => renderSelectionModalOverlay(input.selectionModal, w, h)],
  ];
  return composeConversationLayers({
    entries,
    modals: input.surfaceModals.modals(),
    width: w,
    height: h,
    permission: context.permission,
  });
}
