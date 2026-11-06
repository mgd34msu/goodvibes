import type { OpenSelection } from './selection-modal.js';
interface CommonModal {
  open(): unknown;
}
interface CommonUiInput<Context> {
  openSelection: OpenSelection;
  modalOpened(name: 'contextInspector' | 'bookmark' | 'shortcuts' | 'help' | 'profilePicker' | 'sessionPicker'): unknown;
  readonly contextInspectorModal: CommonModal;
  readonly bookmarkModal: CommonModal;
  readonly profilePickerModal: CommonModal;
  readonly sessionPickerModal: CommonModal;
  helpOverlayActive: boolean;
  helpScrollOffset: number;
  shortcutsOverlayActive: boolean;
  shortcutsScrollOffset: number;
  readonly overlayFilters: { readonly help: { clear(): void }; readonly shortcuts: { clear(): void } };
  indicatorFocused: boolean;
  openMcpWorkspace(context: Context): unknown;
}
/** Wire shared modal transitions; product-only openers and authority remain in product composition. */
export function createCommonShellUiOpeners<Context>(options: {
  readonly input: CommonUiInput<Context>;
  readonly commandContext: Context;
  readonly render: () => void;
  readonly renderHelpToggle: boolean;
}) {
  const { input, render, commandContext } = options;
  const open = (name: 'contextInspector' | 'bookmark' | 'profilePicker' | 'sessionPicker', modal: CommonModal) => {
    input.modalOpened(name);
    modal.open();
    render();
  };
  return {
    openSelection: ((title, items, opts, callback) => input.openSelection(title, items, opts, callback)) as OpenSelection,
    openContextInspector: () => open('contextInspector', input.contextInspectorModal),
    openBookmarkModal: () => open('bookmark', input.bookmarkModal),
    openProfilePicker: () => open('profilePicker', input.profilePickerModal),
    openSessionPicker: () => open('sessionPicker', input.sessionPickerModal),
    openHelpOverlay: () => {
      if (!input.helpOverlayActive) input.modalOpened('help');
      input.helpOverlayActive = !input.helpOverlayActive;
      input.helpScrollOffset = 0;
      input.overlayFilters.help.clear();
      if (options.renderHelpToggle) render();
    },
    openShortcutsOverlay: () => {
      if (!input.shortcutsOverlayActive) input.modalOpened('shortcuts');
      input.shortcutsOverlayActive = !input.shortcutsOverlayActive;
      input.shortcutsScrollOffset = 0;
      input.overlayFilters.shortcuts.clear();
      render();
    },
    openMcpWorkspace: () => {
      input.openMcpWorkspace(commandContext);
      render();
    },
    focusPrompt: () => {
      input.indicatorFocused = false;
      render();
    },
  };
}

export function createSettingsWorkspaceOpener(options: {
  readonly activate: () => void;
  readonly configure: () => void;
  readonly selectTarget: (target?: string) => void;
  readonly render: () => void;
}): (target?: string) => void {
  return (target) => {
    options.activate();
    options.configure();
    options.selectTarget(target);
    options.render();
  };
}
