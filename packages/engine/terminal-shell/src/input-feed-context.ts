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
  syncFeedContextMutableFields(captureFeedContextMutable(host), target);
}

export function captureFeedContextMutable(host: FeedContextMutableInit): FeedContextMutableInit {
  return {
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
}

const STABLE_HOST_KEYS = [
  'selection',
  'pasteRegistry',
  'imageRegistry',
  'selectionModal',
  'bookmarkModal',
  'settingsModal',
  'mcpWorkspace',
  'sessionPickerModal',
  'profilePickerModal',
  'historySearch',
  'commandRegistry',
  'commandContext',
  'autocomplete',
  'filePicker',
  'modelPicker',
  'contextInspectorModal',
  'overlayFilters',
  'blockActionsMenu',
  'surfaceModals',
  'searchManager',
  'modalStack',
  'inputHistory',
  'conversationManager',
  'getHistory',
  'getViewportHeight',
  'getScrollTop',
  'scroll',
  'exitApp',
] as const;
export function projectFeedContextStable<
  Host extends { readonly [Key in (typeof STABLE_HOST_KEYS)[number]]: unknown } & {
    readonly uiServices: {
      readonly environment: { readonly shellPaths: { readonly workingDirectory: string } };
      readonly shell: { readonly keybindingsManager: unknown };
      readonly platform: { readonly focusTracker: unknown };
    };
  },
>(host: Host) {
  const fields = {} as { -readonly [Key in (typeof STABLE_HOST_KEYS)[number]]: Host[Key] };
  for (const key of STABLE_HOST_KEYS) fields[key] = host[key];
  return {
    ...fields,
    projectRoot: host.uiServices.environment.shellPaths.workingDirectory,
    keybindingsManager: host.uiServices.shell.keybindingsManager as Host['uiServices']['shell']['keybindingsManager'],
    focusTracker: host.uiServices.platform.focusTracker as Host['uiServices']['platform']['focusTracker'],
  };
}

const FEED_FORWARD_KEYS = [
  'modalOpened',
  'submitConcealedInput',
  'handleCopy',
  'handleBlockCopy',
  'handleBookmark',
  'handleBlockSave',
  'saveUndoState',
  'ensureInputCursorVisible',
  'registerPaste',
  'executeBlockAction',
  'getWrappedPromptInfo',
  'moveCursorVertical',
  'handlePathCompletion',
  'handleBlockToggle',
  'findMarkerAtPos',
  'cleanupMarkerRegistry',
  'expandPrompt',
] as const;
/** Resolve methods at invocation time and preserve the handler as their receiver. */
export function projectFeedContextClosures<
  Host extends { readonly [Key in (typeof FEED_FORWARD_KEYS)[number]]: (...args: never[]) => unknown } & {
    readonly sessionView: unknown;
    readonly bodyTopRow: number;
    cancelConcealedInput(): boolean;
    handleEscape(): void;
    handleCtrlC(): void;
    syncFeedContextMutableFields(): void;
  },
>(host: Host) {
  const forwards = {} as { -readonly [Key in (typeof FEED_FORWARD_KEYS)[number]]: Host[Key] };
  const bind = <Key extends (typeof FEED_FORWARD_KEYS)[number]>(key: Key): Host[Key] =>
    ((...args: Parameters<Host[Key]>) => {
      const result: unknown = Reflect.apply(host[key], host, args);
      return result as ReturnType<Host[Key]>;
    }) as Host[Key];
  for (const key of FEED_FORWARD_KEYS) forwards[key] = bind(key);
  return {
    ...forwards,
    getSessionView: () => host.sessionView as Host['sessionView'],
    handleEscape: () => {
      if (!host.cancelConcealedInput()) host.handleEscape();
      host.syncFeedContextMutableFields();
    },
    handleCtrlC: () => {
      host.handleCtrlC();
      host.syncFeedContextMutableFields();
    },
    bodyTopRow: () => host.bodyTopRow,
  };
}

/** Render requests coalesce only while the feed owns its synchronous edit window. */
export function createFeedRenderBuffer(immediate: () => void) {
  let requested = false;
  let feeding = true;
  return {
    requestRender(): void {
      if (feeding) requested = true;
      else immediate();
    },
    release(): void {
      feeding = false;
    },
    flush(): void {
      if (requested) immediate();
    },
  };
}
export function syncFeedContextLiveReferences<
  Host extends {
    commandRegistry: unknown;
    commandContext: unknown;
    autocomplete: unknown;
    inputHistory: unknown;
    conversationManager: unknown;
  },
>(
  host: Host,
  context: { [Key in 'commandRegistry' | 'commandContext' | 'autocomplete' | 'inputHistory' | 'conversationManager']: Host[Key] },
): void {
  context.commandRegistry = host.commandRegistry;
  context.commandContext = host.commandContext;
  context.autocomplete = host.autocomplete;
  context.inputHistory = host.inputHistory;
  context.conversationManager = host.conversationManager;
}
