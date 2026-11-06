/** Shared keyboard mechanics over host-owned picker/control ports. */
import { readFileSync } from 'node:fs';
import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import type { SelectionResult, SelectionAction } from './selection-modal.js';
import { isTextBackspace } from './delete-key-policy.js';
import { resolveAndValidatePath, logger } from '@goodvibes-jev/engine/sdk/platform/utils';
interface PickerCommandContext {
    readonly jumpToBookmark?: ((key: string) => void) | undefined;
    readonly workspace: {
        readonly shellPaths?: {
            readonly workingDirectory: string;
        } | null | undefined;
    };
    readonly platform: {
        readonly configManager: {
            getWorkingDirectory(): string;
        };
    };
}
type SelectionRouteState = {
    selectionModal: {
        active: boolean;
        query: string;
        allowSearch: boolean;
        customActions: Map<string, SelectionAction>;
        selectedIndex: number;
        getSelected: () => SelectionResult['item'] | null | undefined;
        setQuery: (query: string) => void;
        moveUp: () => void;
        moveDown: () => void;
        close: () => void;
    };
    selectionCallback: ((result: SelectionResult | null) => void) | null;
    getSelectionCallback?: (() => ((result: SelectionResult | null) => void) | null) | undefined;
    setSelectionCallback?: ((callback: ((result: SelectionResult | null) => void) | null) => void) | undefined;
    modalStack: string[];
    requestRender: () => void;
    handleEscape: () => void;
};
export function handleSelectionModalToken(state: SelectionRouteState, token: InputToken): boolean {
    if (!state.selectionModal.active)
        return false;
    const getPrimaryAction = (selected: NonNullable<ReturnType<typeof state.selectionModal.getSelected>> | null | undefined): SelectionAction | null => {
        if (selected?.primaryAction)
            return selected.primaryAction;
        const enterAction = state.selectionModal.customActions.get('enter');
        return enterAction ?? null;
    };
    const getSpaceAction = (selected: NonNullable<ReturnType<typeof state.selectionModal.getSelected>> | null | undefined): SelectionAction | null => {
        if (selected?.primaryAction === 'toggle')
            return 'toggle';
        const direct = state.selectionModal.customActions.get(' ');
        if (direct)
            return direct;
        const enterAction = getPrimaryAction(selected);
        if (enterAction === 'toggle')
            return enterAction;
        return null;
    };
    const dispatchSelectionAction = (action: SelectionAction, selected: NonNullable<ReturnType<typeof state.selectionModal.getSelected>>, step?: number | undefined): void => {
        if (action === 'toggle' || action === 'increment' || action === 'decrement') {
            state.selectionCallback?.({ item: selected, action, ...(step === undefined ? {} : { step }) });
            return;
        }
        const cb = state.selectionCallback;
        state.selectionCallback = null;
        state.setSelectionCallback?.(null);
        state.selectionModal.close();
        if (state.modalStack.length > 0 && state.modalStack[state.modalStack.length - 1] === 'selection') {
            state.modalStack.pop();
        }
        cb?.({ item: selected, action, ...(step === undefined ? {} : { step }) });
        state.selectionCallback = state.getSelectionCallback?.() ?? state.selectionCallback;
    };
    const getAdjustmentStep = (selected: NonNullable<ReturnType<typeof state.selectionModal.getSelected>> | null | undefined, shift: boolean): number => {
        const baseStep = selected?.adjustStep ?? 1;
        return shift ? baseStep * 10 : baseStep;
    };
    const fireClaimedKey = (key: string): boolean => {
        const action = state.selectionModal.customActions.get(key);
        if (!action)
            return false;
        const selected = state.selectionModal.getSelected();
        if (selected)
            dispatchSelectionAction(action, selected);
        return true;
    };
    const fireSpace = (): void => {
        const selected = state.selectionModal.getSelected();
        const action = getSpaceAction(selected);
        if (action && selected && state.selectionCallback) {
            state.selectionCallback({ item: selected, action });
        }
    };
    // The search row is always live (no search mode): printable text goes into
    // the query, except a key the picker claims (a custom action, or Space for
    // a toggle) which fires while the query is empty. Pickers without search
    // only have their claimed keys.
    if (token.type === 'text') {
        const queryEmpty = state.selectionModal.query.length === 0;
        const single = [...token.value].length === 1;
        if (queryEmpty && single && token.value === ' ' && getSpaceAction(state.selectionModal.getSelected())) {
            fireSpace();
        }
        else if (queryEmpty && single && state.selectionModal.customActions.has(token.value)) {
            fireClaimedKey(token.value);
        }
        else if (state.selectionModal.allowSearch) {
            state.selectionModal.setQuery(state.selectionModal.query + token.value);
        }
        else if (single && token.value === ' ') {
            fireSpace();
        }
    }
    else if (token.type === 'key') {
        if (token.logicalName === 'escape') {
            // ONE Escape always closes the modal, whatever the query holds. Clearing
            // the query is Backspace's job, not Esc's.
            state.handleEscape();
            return true;
        }
        if (token.logicalName === 'enter') {
            const selected = state.selectionModal.getSelected();
            if (selected) {
                dispatchSelectionAction(getPrimaryAction(selected) ?? 'select', selected);
            }
        }
        else if (token.logicalName === 'space') {
            fireSpace();
        }
        else if (token.logicalName === 'up') {
            state.selectionModal.moveUp();
        }
        else if (token.logicalName === 'down') {
            state.selectionModal.moveDown();
        }
        else if (token.logicalName === 'left' || token.logicalName === 'right') {
            const selected = state.selectionModal.getSelected();
            if (selected?.adjustable) {
                dispatchSelectionAction(token.logicalName === 'right' ? 'increment' : 'decrement', selected, getAdjustmentStep(selected, token.shift));
            }
        }
        else if (isTextBackspace(token.logicalName ?? '')) {
            if (state.selectionModal.allowSearch && state.selectionModal.query.length > 0) {
                state.selectionModal.setQuery(state.selectionModal.query.slice(0, -1));
            }
            // 'delete' is intentionally absent here: modal search filters are
            // end-anchored with no cursor, so forward-delete is a no-op per the
            // delete-key policy (src/input/delete-key-policy.ts).
        }
        else if (token.logicalName && [...token.logicalName].length === 1) {
            // A modified letter (a CSI-u chord): fires a claimed action whatever
            // the query holds, it is never typed.
            fireClaimedKey(token.logicalName);
        }
    }
    state.requestRender();
    return true;
}
type BookmarkRouteState = {
    bookmarkModal: {
        active: boolean;
        entries: Array<unknown>;
        query: string;
        setQuery: (query: string) => void;
        moveUp: () => void;
        moveDown: () => void;
        getSelected: () => {
            key: string;
        } | null;
        close: () => void;
        removeSelected: () => void;
        openSelectedFile: () => void;
    };
    commandContext?: Pick<PickerCommandContext, 'jumpToBookmark'> | undefined;
    requestRender: () => void;
    handleEscape: () => void;
};
/**
 * Bookmarks: the search row is always live. `d` (remove) and `o` (open the
 * saved file) fire while the query is empty; otherwise every printable key is
 * typed into the query. Backspace edits it; Esc closes.
 */
export function handleBookmarkModalToken(state: BookmarkRouteState, token: InputToken): boolean {
    if (!state.bookmarkModal.active)
        return false;
    const modal = state.bookmarkModal;
    const act = (key: string): boolean => {
        if (key === 'd') {
            modal.removeSelected();
            if (modal.entries.length === 0)
                modal.close();
            return true;
        }
        if (key === 'o') {
            modal.openSelectedFile();
            return true;
        }
        return false;
    };
    if (token.type === 'key') {
        if (token.logicalName === 'escape') {
            state.handleEscape();
            return true;
        }
        if (token.logicalName === 'up')
            modal.moveUp();
        else if (token.logicalName === 'down')
            modal.moveDown();
        else if (token.logicalName === 'enter') {
            const entry = modal.getSelected();
            if (entry)
                state.commandContext?.jumpToBookmark?.(entry.key);
            modal.close();
        }
        else if (isTextBackspace(token.logicalName ?? '')) {
            if (modal.query.length > 0)
                modal.setQuery(modal.query.slice(0, -1));
        }
        else if (token.logicalName) {
            // Modified letters (CSI-u chords) fire their action whatever the query holds.
            act(token.logicalName);
        }
    }
    else if (token.type === 'text') {
        const claimed = modal.query.length === 0 && (token.value === 'd' || token.value === 'o');
        if (claimed)
            act(token.value);
        else
            modal.setQuery(modal.query + token.value);
    }
    state.requestRender();
    return true;
}
type FilePickerRouteState = {
    filePicker: {
        active: boolean;
        query: string;
        searchFocused: boolean;
        insertPos: number;
        injectMode: boolean;
        close: () => void;
        setQuery: (query: string) => void;
        focusSearch: () => void;
        blurSearch: () => void;
        getSelected: () => string | null;
        selectedIndex: number;
        moveUp: () => void;
        moveDown: () => void;
    };
    prompt: string;
    cursorPos: number;
    commandContext?: PickerCommandContext | undefined;
    imageRegistry: Map<string, {
        data: string;
        mediaType: string;
    }>;
    nextImageId: number;
    requestRender: () => void;
    handleEscape: () => void;
    saveUndoState: () => void;
    ensureInputCursorVisible: () => void;
    formatFileSize: (bytes: number) => string;
    mediaTypeFromExt: (ext: string) => string;
    imageExtensions: string[];
};
export function handleFilePickerToken(state: FilePickerRouteState, token: InputToken): boolean {
    if (!state.filePicker.active)
        return false;
    // The query is always live: typing filters, arrows move, Esc closes.
    if (token.type === 'text') {
        if (token.value === ' ' && state.filePicker.query === '') {
            state.filePicker.close();
        }
        else {
            state.filePicker.focusSearch();
            state.filePicker.setQuery(state.filePicker.query + token.value);
        }
    }
    else if (token.type === 'key') {
        if (token.logicalName === 'escape') {
            state.handleEscape();
            return true;
        }
        else if (token.logicalName === 'enter') {
            const selected = state.filePicker.getSelected();
            if (selected) {
                state.saveUndoState();
                const atPos = state.filePicker.insertPos;
                const injectMode = state.filePicker.injectMode;
                const prefixLen = injectMode ? 2 : 1;
                const queryLen = state.filePicker.query.length + prefixLen;
                const ext = selected.slice(selected.lastIndexOf('.'));
                if (!injectMode && state.imageExtensions.some(e => e === ext.toLowerCase())) {
                    try {
                        const projectRoot = state.commandContext?.workspace.shellPaths?.workingDirectory
                            ?? state.commandContext?.platform.configManager.getWorkingDirectory();
                        if (!projectRoot) {
                            throw new Error('working directory is unavailable');
                        }
                        const resolvedPath = resolveAndValidatePath(selected, projectRoot);
                        const data = readFileSync(resolvedPath);
                        const base64 = data.toString('base64');
                        const mediaType = state.mediaTypeFromExt(ext);
                        const filename = selected.split('/').pop() ?? selected;
                        const id = `img${state.nextImageId++}`;
                        state.imageRegistry.set(id, { data: base64, mediaType });
                        const marker = `[IMAGE: ${id}, ${filename}, ${state.formatFileSize(data.length)}]`;
                        state.prompt = state.prompt.slice(0, atPos) + marker + ' ' + state.prompt.slice(atPos + queryLen);
                        state.cursorPos = atPos + marker.length + 1;
                    }
                    catch (err) {
                        logger.debug('file-picker: could not read image file', { err });
                        state.prompt = state.prompt.slice(0, atPos) + '@' + selected + ' ' + state.prompt.slice(atPos + queryLen);
                        state.cursorPos = atPos + selected.length + 2;
                    }
                }
                else if (injectMode) {
                    const marker = `!@${selected}`;
                    state.prompt = state.prompt.slice(0, atPos) + marker + ' ' + state.prompt.slice(atPos + queryLen);
                    state.cursorPos = atPos + marker.length + 1;
                }
                else {
                    state.prompt = state.prompt.slice(0, atPos) + '@' + selected + ' ' + state.prompt.slice(atPos + queryLen);
                    state.cursorPos = atPos + selected.length + 2;
                }
                state.ensureInputCursorVisible();
            }
            state.filePicker.close();
        }
        else if (token.logicalName === 'up') {
            state.filePicker.moveUp();
        }
        else if (token.logicalName === 'down') {
            state.filePicker.moveDown();
        }
        else if (token.logicalName === 'backspace') {
            if (state.filePicker.query.length > 0) {
                state.filePicker.setQuery(state.filePicker.query.slice(0, -1));
            }
            else {
                const removeCount = state.filePicker.injectMode ? 2 : 1;
                if (state.cursorPos >= removeCount) {
                    state.prompt = state.prompt.slice(0, state.cursorPos - removeCount) + state.prompt.slice(state.cursorPos);
                    state.cursorPos -= removeCount;
                }
                state.filePicker.close();
            }
        }
    }
    state.requestRender();
    return true;
}
type BlockActionsRouteState<Action extends string> = {
    blockActionsMenu: {
        active: boolean;
        moveUp: () => void;
        moveDown: () => void;
        getSelected: () => {
            id: Action;
        } | null;
        close: () => void;
        getActionForKey: (key: string) => {
            id: Action;
        } | null;
    };
    executeBlockAction: (id: Action) => void;
    requestRender: () => void;
    handleEscape: () => void;
};
export function handleBlockActionsToken<Action extends string>(state: BlockActionsRouteState<Action>, token: InputToken): boolean {
    if (!state.blockActionsMenu.active)
        return false;
    if (token.type === 'key') {
        if (token.logicalName === 'escape') {
            state.handleEscape();
            return true;
        }
        if (token.logicalName === 'up')
            state.blockActionsMenu.moveUp();
        else if (token.logicalName === 'down')
            state.blockActionsMenu.moveDown();
        else if (token.logicalName === 'enter') {
            const action = state.blockActionsMenu.getSelected();
            state.blockActionsMenu.close();
            if (action)
                state.executeBlockAction(action.id);
        }
        else if (token.logicalName === 'tab') {
            const action = state.blockActionsMenu.getActionForKey('Tab');
            state.blockActionsMenu.close();
            if (action)
                state.executeBlockAction(action.id);
        }
    }
    else if (token.type === 'text') {
        const action = state.blockActionsMenu.getActionForKey(token.value);
        state.blockActionsMenu.close();
        if (action)
            state.executeBlockAction(action.id);
    }
    state.requestRender();
    return true;
}
export type EscapeOnlyModalRouteState = {
    active: boolean;
    requestRender: () => void;
    handleEscape: () => void;
    /** Optional scrolling for read-only modals: ↑ passes +1 (back), ↓ passes -1. */
    scroll?: ((delta: number) => void) | undefined;
};
export function handleEscapeOnlyModalToken(state: EscapeOnlyModalRouteState, token: InputToken): boolean {
    if (!state.active)
        return false;
    if (token.type === 'key' && token.logicalName === 'escape') {
        state.handleEscape();
        return true;
    }
    if (token.type === 'key' && state.scroll) {
        if (token.logicalName === 'up')
            state.scroll(1);
        else if (token.logicalName === 'down')
            state.scroll(-1);
        else if (token.logicalName === 'pageup')
            state.scroll(10);
        else if (token.logicalName === 'pagedown')
            state.scroll(-10);
    }
    state.requestRender();
    return true;
}
export type ModalTokenSnapshot = {
    selectionCallback: ((result: SelectionResult | null) => void) | null;
    helpOverlayActive: boolean;
    helpScrollOffset: number;
    shortcutsOverlayActive: boolean;
    shortcutsScrollOffset: number;
    prompt: string;
    cursorPos: number;
    nextImageId: number;
};
export function withModalState(state: ModalTokenSnapshot, handled: boolean, overrides: Partial<{
    selectionCallback: ((result: SelectionResult | null) => void) | null;
    helpOverlayActive: boolean;
    helpScrollOffset: number;
    shortcutsOverlayActive: boolean;
    shortcutsScrollOffset: number;
    prompt: string;
    cursorPos: number;
    nextImageId: number;
}> = {}) {
    return {
        handled,
        selectionCallback: overrides.selectionCallback ?? state.selectionCallback,
        helpOverlayActive: overrides.helpOverlayActive ?? state.helpOverlayActive,
        helpScrollOffset: overrides.helpScrollOffset ?? state.helpScrollOffset,
        shortcutsOverlayActive: overrides.shortcutsOverlayActive ?? state.shortcutsOverlayActive,
        shortcutsScrollOffset: overrides.shortcutsScrollOffset ?? state.shortcutsScrollOffset,
        prompt: overrides.prompt ?? state.prompt,
        cursorPos: overrides.cursorPos ?? state.cursorPos,
        nextImageId: overrides.nextImageId ?? state.nextImageId,
    };
}
