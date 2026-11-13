/**
 * Every modal the input handler can stack, in the order they take the screen
 * when more than one is active (first active wins, see getActiveModalName).
 * The single source of truth: the stack, the close switch, the reopen switch
 * and the active-flag ladder are all derived from or checked against it.
 */
export const MODAL_NAMES = [
    'help',
    'shortcuts',
    'bookmark',
    'liveTail',
    'settings',
    'mcpWorkspace',
    'agentWorkspace',
    'sessionPicker',
    'profilePicker',
    'config',
    'contextInspector',
    'process',
    'modelPicker',
    'filePicker',
    'blockActions',
    'selection',
    'onboarding',
    'command',
] as const;
export type ModalName = (typeof MODAL_NAMES)[number];
export function isModalName(value: unknown): value is ModalName {
    return typeof value === 'string' && (MODAL_NAMES as readonly string[]).includes(value);
}
export type ActiveModalState = {
    helpOverlayActive: boolean;
    shortcutsOverlayActive: boolean;
    bookmarkModal: {
        active: boolean;
        close: () => void;
    };
    settingsModal: {
        active: boolean;
        close: () => void;
    };
    mcpWorkspace?: {
        active: boolean;
        close: () => void;
        reopen: () => void;
    } | undefined;
    sessionPickerModal: {
        active: boolean;
        close: () => void;
    };
    profilePickerModal: {
        active: boolean;
        close: () => void;
    };
    configModal?: {
        active: boolean;
        close: () => void;
    } | undefined;
    contextInspectorModal: {
        active: boolean;
        close: () => void;
    };
    modelPicker: {
        active: boolean;
        close: () => void;
    };
    filePicker: {
        active: boolean;
        close: () => void;
    };
    blockActionsMenu: {
        active: boolean;
        close: () => void;
    };
    selectionModal: {
        active: boolean;
        close: () => void;
    };
    onboardingWizard?: {
        active: boolean;
        close(): void;
        reopen(): void;
    } | undefined;
    liveTailModal?: {
        active: boolean;
        close(): void;
    } | undefined;
    processModal?: {
        active: boolean;
        close(): void;
    } | undefined;
    agentWorkspace?: {
        active: boolean;
        close(): void;
        reopen(): void;
    } | undefined;
    commandMode: boolean;
};
/** Whether one modal's own `active` flag (or overlay/mode flag) is set. Exhaustive over {@link ModalName}. */
export function isModalActive(state: ActiveModalState, name: ModalName): boolean {
    switch (name) {
        case 'help':
            return state.helpOverlayActive;
        case 'shortcuts':
            return state.shortcutsOverlayActive;
        case 'bookmark':
            return state.bookmarkModal.active;
        case 'liveTail':
            return state.liveTailModal?.active === true;
        case 'settings':
            return state.settingsModal.active;
        case 'mcpWorkspace':
            return state.mcpWorkspace?.active === true;
        case 'agentWorkspace':
            return state.agentWorkspace?.active === true;
        case 'sessionPicker':
            return state.sessionPickerModal.active;
        case 'profilePicker':
            return state.profilePickerModal.active;
        case 'config':
            return state.configModal?.active === true;
        case 'contextInspector':
            return state.contextInspectorModal.active;
        case 'process':
            return state.processModal?.active === true;
        case 'modelPicker':
            return state.modelPicker.active;
        case 'filePicker':
            return state.filePicker.active;
        case 'blockActions':
            return state.blockActionsMenu.active;
        case 'selection':
            return state.selectionModal.active;
        case 'onboarding':
            return state.onboardingWizard?.active === true;
        case 'command':
            return state.commandMode;
        default:
            return assertNever(name);
    }
}
function assertNever(name: never): never {
    throw new Error(`Unhandled modal name: ${String(name)}`);
}
export function getActiveModalName(state: ActiveModalState): ModalName | null {
    return MODAL_NAMES.find((name) => isModalActive(state, name)) ?? null;
}
export type ModalCloseOps = {
    resetHelp: () => void;
    resetShortcuts: () => void;
    closeBookmark: () => void;
    closeSettings: () => void;
    closeMcpWorkspace: () => void;
    closeSessionPicker: () => void;
    closeProfilePicker: () => void;
    closeConfigModal?: (() => void) | undefined;
    closeLiveTail?: (() => void) | undefined;
    closeProcess?: (() => void) | undefined;
    closeAgentWorkspace?: (() => void) | undefined;
    closeContextInspector: () => void;
    closeModelPicker: () => void;
    closeFilePicker: () => void;
    closeBlockActions: () => void;
    closeSelection: () => void;
    closeOnboarding?: (() => void) | undefined;
    closeCommandMode: () => void;
};
export function closeModalByName(name: ModalName, ops: ModalCloseOps): void {
    switch (name) {
        case 'help':
            ops.resetHelp();
            break;
        case 'shortcuts':
            ops.resetShortcuts();
            break;
        case 'bookmark':
            ops.closeBookmark();
            break;
        case 'liveTail':
            ops.closeLiveTail?.();
            break;
        case 'process':
            ops.closeProcess?.();
            break;
        case 'agentWorkspace':
            ops.closeAgentWorkspace?.();
            break;
        case 'settings':
            ops.closeSettings();
            break;
        case 'mcpWorkspace':
            ops.closeMcpWorkspace();
            break;
        case 'sessionPicker':
            ops.closeSessionPicker();
            break;
        case 'profilePicker':
            ops.closeProfilePicker();
            break;
        case 'config':
            ops.closeConfigModal?.();
            break;
        case 'contextInspector':
            ops.closeContextInspector();
            break;
        case 'modelPicker':
            ops.closeModelPicker();
            break;
        case 'filePicker':
            ops.closeFilePicker();
            break;
        case 'blockActions':
            ops.closeBlockActions();
            break;
        case 'selection':
            ops.closeSelection();
            break;
        case 'onboarding':
            ops.closeOnboarding?.();
            break;
        case 'command':
            ops.closeCommandMode();
            break;
        default:
            assertNever(name);
    }
}
export type ModalOpenOps = {
    openHelp: () => void;
    openShortcuts: () => void;
    openBookmark: () => void;
    openContextInspector: () => void;
    openMcpWorkspace?: (() => void) | undefined;
    openOnboarding?: (() => void) | undefined;
    openConfigModal?: (() => void) | undefined;
    openProcess?: (() => void) | undefined;
    openAgentWorkspace?: (() => void) | undefined;
    openCommandMode: () => void;
};
/**
 * Bring a modal back after the one stacked above it closed. Returns true when
 * it was reopened and false when it cannot be: the caller then drops it from
 * the stack (or keeps it when it is still on screen) instead of leaving a
 * stack entry that does nothing.
 *
 * help, shortcuts, bookmark, contextInspector, mcpWorkspace, process,
 * agentWorkspace, config, onboarding and command reopen from their own
 * state. The rest cannot: closing settings, sessionPicker, profilePicker,
 * modelPicker, filePicker, blockActions, selection or liveTail discards what
 * they were showing (a selection's callback, a file picker's insert position,
 * the process a live tail followed, the block a menu acted on), and nothing
 * but their opener can rebuild it. Exhaustive over {@link ModalName}.
 */
export function reopenModalByName(name: ModalName, ops: ModalOpenOps): boolean {
    switch (name) {
        case 'help':
            ops.openHelp();
            return true;
        case 'shortcuts':
            ops.openShortcuts();
            return true;
        case 'bookmark':
            ops.openBookmark();
            return true;
        case 'contextInspector':
            ops.openContextInspector();
            return true;
        case 'mcpWorkspace':
            if (!ops.openMcpWorkspace) return false;
            ops.openMcpWorkspace();
            return true;
        case 'process':
            if (!ops.openProcess) return false;
            ops.openProcess();
            return true;
        case 'agentWorkspace':
            if (!ops.openAgentWorkspace) return false;
            ops.openAgentWorkspace();
            return true;
        case 'config':
            if (!ops.openConfigModal) return false;
            ops.openConfigModal();
            return true;
        case 'onboarding':
            if (!ops.openOnboarding) return false;
            ops.openOnboarding();
            return true;
        case 'command':
            ops.openCommandMode();
            return true;
        case 'settings':
        case 'sessionPicker':
        case 'profilePicker':
        case 'modelPicker':
        case 'filePicker':
        case 'blockActions':
        case 'selection':
        case 'liveTail':
            return false;
        default:
            return assertNever(name);
    }
}
