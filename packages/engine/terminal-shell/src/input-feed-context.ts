/** The feed owns one context for its lifetime; callbacks keep product ports typed. */
import type { SelectionResult } from './selection-modal.js';
export interface FeedContextMutableInit {
  prompt: string;
  cursorPos: number;
  inputScrollTop: number;
  commandMode: boolean;
  indicatorFocused: boolean;
  helpOverlayActive: boolean;
  helpScrollOffset: number;
  shortcutsOverlayActive: boolean;
  shortcutsScrollOffset: number;
  nextPasteId: number;
  nextImageId: number;
  mouseDownRow: number;
  mouseDownCol: number;
  contentWidth: number;
  selectionCallback: ((result: SelectionResult | null) => void) | null;
}
export type FeedContextStableKeys =
  | 'selection'
  | 'pasteRegistry'
  | 'imageRegistry'
  | 'projectRoot'
  | 'selectionModal'
  | 'bookmarkModal'
  | 'settingsModal'
  | 'mcpWorkspace'
  | 'sessionPickerModal'
  | 'profilePickerModal'
  | 'historySearch'
  | 'commandRegistry'
  | 'commandContext'
  | 'autocomplete'
  | 'filePicker'
  | 'modelPicker'
  | 'contextInspectorModal'
  | 'overlayFilters'
  | 'blockActionsMenu'
  | 'surfaceModals'
  | 'searchManager'
  | 'modalStack'
  | 'inputHistory'
  | 'conversationManager'
  | 'keybindingsManager'
  | 'focusTracker'
  | 'getHistory'
  | 'getViewportHeight'
  | 'getScrollTop'
  | 'scroll'
  | 'exitApp';
export type FeedContextClosureKeys =
  | 'modalOpened'
  | 'getSessionView'
  | 'handleEscape'
  | 'submitConcealedInput'
  | 'handleCopy'
  | 'handleCtrlC'
  | 'handleBlockCopy'
  | 'handleBookmark'
  | 'handleBlockSave'
  | 'handleUndo'
  | 'handleRedo'
  | 'handlePaste'
  | 'saveUndoState'
  | 'ensureInputCursorVisible'
  | 'registerPaste'
  | 'executeBlockAction'
  | 'getWrappedPromptInfo'
  | 'moveCursorVertical'
  | 'handlePathCompletion'
  | 'bodyTopRow'
  | 'handleBlockToggle'
  | 'findMarkerAtPos'
  | 'cleanupMarkerRegistry'
  | 'expandPrompt'
  | 'openModelPickerWithTarget'
  | 'openProviderModelPickerWithTarget'
  | 'onModelPickerCommit';
/** Allocate only once. Per-feed rendering swaps and restores requestRender separately. */
export function buildInitialFeedContext<Mutable extends FeedContextMutableInit, Stable extends object, Closures extends object>(
  mutable: Mutable,
  stable: Stable,
  closures: Closures,
) {
  return { ...mutable, requestRender: (): void => {}, ...stable, ...closures };
}
export function syncFeedContextMutableFields(fields: FeedContextMutableInit, ctx: FeedContextMutableInit): void {
  ctx.prompt = fields.prompt;
  ctx.cursorPos = fields.cursorPos;
  ctx.inputScrollTop = fields.inputScrollTop;
  ctx.commandMode = fields.commandMode;
  ctx.indicatorFocused = fields.indicatorFocused;
  ctx.helpOverlayActive = fields.helpOverlayActive;
  ctx.helpScrollOffset = fields.helpScrollOffset;
  ctx.shortcutsOverlayActive = fields.shortcutsOverlayActive;
  ctx.shortcutsScrollOffset = fields.shortcutsScrollOffset;
  ctx.selectionCallback = fields.selectionCallback;
  ctx.nextPasteId = fields.nextPasteId;
  ctx.nextImageId = fields.nextImageId;
  ctx.mouseDownRow = fields.mouseDownRow;
  ctx.mouseDownCol = fields.mouseDownCol;
  ctx.contentWidth = fields.contentWidth;
}

/** Capture all mutable slots before writing any target slot; host setters cannot interleave a new snapshot. */
export function syncFeedContextFromHost(host: FeedContextMutableInit, target: FeedContextMutableInit): void {
  const snapshot: FeedContextMutableInit = {
    prompt: host.prompt,
    cursorPos: host.cursorPos,
    inputScrollTop: host.inputScrollTop,
    commandMode: host.commandMode,
    indicatorFocused: host.indicatorFocused,
    helpOverlayActive: host.helpOverlayActive,
    helpScrollOffset: host.helpScrollOffset,
    shortcutsOverlayActive: host.shortcutsOverlayActive,
    shortcutsScrollOffset: host.shortcutsScrollOffset,
    selectionCallback: host.selectionCallback,
    nextPasteId: host.nextPasteId,
    nextImageId: host.nextImageId,
    mouseDownRow: host.mouseDownRow,
    mouseDownCol: host.mouseDownCol,
    contentWidth: host.contentWidth,
  };
  syncFeedContextMutableFields(snapshot, target);
}
