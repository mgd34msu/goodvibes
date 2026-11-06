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
export function getActiveModalName(state: ActiveModalState): string | null {
    if (state.helpOverlayActive)
        return 'help';
    if (state.shortcutsOverlayActive)
        return 'shortcuts';
    if (state.bookmarkModal.active)
        return 'bookmark';
    if (state.liveTailModal?.active)
        return 'liveTail';
    if (state.settingsModal.active)
        return 'settings';
    if (state.mcpWorkspace?.active)
        return 'mcpWorkspace';
    if (state.agentWorkspace?.active)
        return 'agentWorkspace';
    if (state.sessionPickerModal.active)
        return 'sessionPicker';
    if (state.profilePickerModal.active)
        return 'profilePicker';
    if (state.configModal?.active)
        return 'config';
    if (state.contextInspectorModal.active)
        return 'contextInspector';
    if (state.processModal?.active)
        return 'process';
    if (state.modelPicker.active)
        return 'modelPicker';
    if (state.filePicker.active)
        return 'filePicker';
    if (state.blockActionsMenu.active)
        return 'blockActions';
    if (state.selectionModal.active)
        return 'selection';
    if (state.onboardingWizard?.active)
        return 'onboarding';
    if (state.commandMode)
        return 'command';
    return null;
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
export function closeModalByName(name: string, ops: ModalCloseOps): void {
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
export function reopenModalByName(name: string, ops: ModalOpenOps): void {
    switch (name) {
        case 'help':
            ops.openHelp();
            break;
        case 'shortcuts':
            ops.openShortcuts();
            break;
        case 'bookmark':
            ops.openBookmark();
            break;
        case 'contextInspector':
            ops.openContextInspector();
            break;
        case 'mcpWorkspace':
            ops.openMcpWorkspace?.();
            break;
        case 'process':
            ops.openProcess?.();
            break;
        case 'agentWorkspace':
            ops.openAgentWorkspace?.();
            break;
        case 'config':
            ops.openConfigModal?.();
            break;
        case 'onboarding':
            ops.openOnboarding?.();
            break;
        case 'command':
            ops.openCommandMode();
            break;
    }
}
