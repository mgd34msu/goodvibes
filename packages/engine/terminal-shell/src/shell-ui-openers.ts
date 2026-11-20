import type { OpenSelection } from './selection-modal.js';
import type { SettingsTargetOutcome } from './settings-navigation.js';
interface CommonModal {
  open(): unknown;
}
interface CommonUiInput<Context> {
  openSelection: OpenSelection;
  readonly contextInspectorModal: CommonModal;
  readonly bookmarkModal: CommonModal;
  readonly profilePickerModal: CommonModal;
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
    openProfilePicker: () => open(input.profilePickerModal),
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

/**
 * Opens the settings workspace and says where it landed: on a category, on a
 * setting, on a search for text that names neither (`not-found`), or nowhere in
 * particular (`none`, no target given; `unreported` when the product's modal does
 * not say what its selection did).
 */
export function createSettingsWorkspaceOpener(options: {
  readonly configure: () => void;
  readonly selectTarget: (target?: string) => SettingsTargetOutcome | void;
  readonly render: () => void;
}): (target?: string) => SettingsTargetOutcome | 'unreported' {
  return (target) => {
    options.configure();
    const outcome = options.selectTarget(target);
    options.render();
    return outcome ?? (target?.trim() ? 'unreported' : 'none');
  };
}
