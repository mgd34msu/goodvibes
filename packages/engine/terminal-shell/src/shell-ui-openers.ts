import type { OpenSelection } from './selection-modal.js';
interface CommonModal {
  open(): unknown;
}
interface CommonUiInput<Context> {
  openSelection: OpenSelection;
  readonly contextInspectorModal: CommonModal;
  readonly bookmarkModal: CommonModal;
  readonly sessionPickerModal: CommonModal;
  indicatorFocused: boolean;
  openMcpWorkspace(context: Context): unknown;
}
/** Wire shared modal transitions; product-only openers and authority remain in product composition. */
export function createCommonShellUiOpeners<Context>(options: {
  readonly input: CommonUiInput<Context>;
  readonly commandContext: Context;
  readonly render: () => void;
}) {
  const { input, render, commandContext } = options;
  const open = (modal: CommonModal) => {
    modal.open();
    render();
  };
  return {
    openSelection: ((title, items, opts, callback) => input.openSelection(title, items, opts, callback)) as OpenSelection,
    openContextInspector: () => open(input.contextInspectorModal),
    openBookmarkModal: () => open(input.bookmarkModal),
    openSessionPicker: () => open(input.sessionPickerModal),
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

// The settings screen opens through the places (places/index.ts openSettings, settings-screen/).
