import type { SelectionResult } from './selection-modal.js';
import type { SurfaceModalHost, TrackedModal } from './surface-modal-host.js';

export interface OwnModal {
    readonly active: boolean;
    close(): void;
}
/**
 * What the modals both terminal apps share need of the input handler. Each
 * modal reads the handler's live fields when it is asked, never a copy.
 */
export interface HandlerModalOwner {
    prompt: string;
    cursorPos: number;
    commandMode: boolean;
    selectionCallback: ((result: SelectionResult | null) => void) | null;
    readonly autocomplete: {
        reset(): void;
    } | null;
    readonly mcpWorkspace: OwnModal & {
        reopen(): void;
    };
    readonly sessionPickerModal: OwnModal;
    readonly profilePickerModal: OwnModal;
    readonly bookmarkModal: OwnModal & {
        open(): void;
    };
    readonly contextInspectorModal: OwnModal & {
        open(): void;
    };
    readonly modelPicker: OwnModal;
    readonly filePicker: OwnModal;
    readonly blockActionsMenu: OwnModal;
    readonly selectionModal: OwnModal;
}
/** A tracked modal over one of the handler's modal objects, closed the way that object closes itself. */
export function ownModal(name: string, modal: () => OwnModal, reopen?: () => void): TrackedModal {
    const tracked: TrackedModal = { ownsOpenFlag: true, name, isOpen: () => modal().active, close: () => modal().close() };
    return reopen ? { ...tracked, reopen } : tracked;
}
/**
 * The handler's own modals that both apps have, each as one object on the
 * modal stack (surface-modal-host.ts). Register them with
 * `surfaceModals.track(...)`; a product adds its own (the Agent's
 * process monitor and live tail; the TUI's config surfaces and onboarding).
 *
 * Help, shortcuts, bookmarks, the context inspector and the MCP workspace come
 * back when the modal stacked above them closes. The rest cannot: closing them
 * discards what they showed (a selection's callback, a file picker's insert
 * position, the block a menu acted on). Command mode does not come back
 * either: it ends when its command runs, and the command's own screen (Settings
 * from /settings) closing must leave an empty composer, not a fresh '/'.
 */
export function createHandlerModals(owner: HandlerModalOwner, options: {
    /** Esc on command mode also clears what was typed after the slash; otherwise only a bare '/' goes. */
    readonly clearCommandText: boolean;
    /** Runs after Esc closes the model picker (the TUI puts back the onboarding answers it opened over). */
    readonly afterModelPickerClose?: (() => void) | undefined;
}) {
    return {
        command: {
            ownsOpenFlag: true,
            name: 'command',
            isOpen: () => owner.commandMode,
            close: () => {
                owner.commandMode = false;
                owner.autocomplete?.reset();
                // A bare '/' with nothing typed after it IS the palette, so Esc
                // clears it along with the slash. Once a command name is typed
                // past the slash, Esc only dismisses the suggestions; the typed
                // text is composer content and stays.
                if (options.clearCommandText || owner.prompt === '/') {
                    owner.prompt = '';
                    owner.cursorPos = 0;
                }
            },
        },
        // The settings screen is a kit modal of its own (settings-screen/screen.ts), pushed by the places.
        mcpWorkspace: ownModal('mcpWorkspace', () => owner.mcpWorkspace, () => owner.mcpWorkspace.reopen()),
        sessionPicker: ownModal('sessionPicker', () => owner.sessionPickerModal),
        profilePicker: ownModal('profilePicker', () => owner.profilePickerModal),
        bookmark: ownModal('bookmark', () => owner.bookmarkModal, () => owner.bookmarkModal.open()),
        contextInspector: ownModal('contextInspector', () => owner.contextInspectorModal, () => owner.contextInspectorModal.open()),
        modelPicker: {
            ...ownModal('modelPicker', () => owner.modelPicker),
            close: () => {
                owner.modelPicker.close();
                options.afterModelPickerClose?.();
            },
        },
        filePicker: ownModal('filePicker', () => owner.filePicker),
        blockActions: ownModal('blockActions', () => owner.blockActionsMenu),
        selection: {
            ownsOpenFlag: true,
            name: 'selection',
            isOpen: () => owner.selectionModal.active,
            // Esc is a cancel: the waiting caller hears null.
            close: () => {
                const callback = owner.selectionCallback;
                owner.selectionCallback = null;
                owner.selectionModal.close();
                callback?.(null);
            },
        },
    } satisfies Record<string, TrackedModal>;
}
export type HandlerModals = ReturnType<typeof createHandlerModals>;
/** What handleEscape needs of the main transcript's scroll. */
export interface TranscriptScrollControls {
    /** The main transcript is scrolled away from its live bottom. */
    scrolledBack(): boolean;
    /** Return to the live bottom and follow it again. */
    toBottom(): void;
}
/** What Esc reads and changes on the input handler. */
export interface EscapeHost {
    prompt: string;
    cursorPos: number;
    indicatorFocused: boolean;
    /** Where focus goes when the last modal closes (recorded when the first one opened). */
    modalReturnFocus: 'prompt' | 'indicator';
    readonly surfaceModals: Pick<SurfaceModalHost, 'escape' | 'active'>;
    /**
     * An agent or process view (core/session-focus.ts). With no modal open and
     * the composer empty, Esc there goes back up one level (closing the
     * process view's search first) and never reaches cancelGeneration: leaving
     * a view never stops the agent, the process or main.
     */
    readonly sessionView?: {
        readonly active: boolean;
        escape(): void;
    } | null | undefined;
    /**
     * The main transcript's scroll. While it is scrolled away from the live
     * bottom (and no modal, composer text or view took the Esc first), Esc
     * returns to the bottom and re-locks there; it never reaches
     * cancelGeneration then. At the bottom the next Esc interrupts as before.
     */
    readonly transcriptScroll?: TranscriptScrollControls | null | undefined;
    requestRender(): void;
    saveUndoState(): void;
}
/**
 * One Esc, one step: the top modal's own level or the top modal (the modal
 * stack decides which, surface-modal-host.ts), else the composer's text, else
 * the view, else the scroll position, else the running turn.
 */
export function handleEscape(host: EscapeHost, cancelGeneration?: (() => void) | undefined): void {
    if (host.surfaceModals.escape()) {
        if (!host.surfaceModals.active) {
            host.indicatorFocused = host.modalReturnFocus === 'indicator';
            host.modalReturnFocus = 'prompt';
        }
        host.requestRender();
        return;
    }
    if (host.prompt.length > 0) {
        host.saveUndoState();
        host.prompt = '';
        host.cursorPos = 0;
        return;
    }
    // Inside an agent or process view Esc goes up one level and stops here:
    // interrupting belongs to main alone.
    if (host.sessionView?.active) {
        host.sessionView.escape();
        host.requestRender();
        return;
    }
    // Scrolled back: Esc returns to the live output and never interrupts the turn.
    if (host.transcriptScroll?.scrolledBack()) {
        host.transcriptScroll.toBottom();
        host.requestRender();
        return;
    }
    cancelGeneration?.();
}
