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
const MUTABLE_KEYS = [
  'prompt',
  'cursorPos',
  'inputScrollTop',
  'commandMode',
  'indicatorFocused',
  'helpOverlayActive',
  'helpScrollOffset',
  'shortcutsOverlayActive',
  'shortcutsScrollOffset',
  'nextPasteId',
  'nextImageId',
  'mouseDownRow',
  'mouseDownCol',
  'contentWidth',
  'selectionCallback',
] as const satisfies readonly (keyof FeedContextMutableInit)[];

function bindOwnerField<Key extends keyof FeedContextMutableInit>(context: object, owner: FeedContextMutableInit, key: Key): void {
  Object.defineProperty(context, key, {
    enumerable: true,
    get: (): FeedContextMutableInit[Key] => owner[key],
    set: (value: FeedContextMutableInit[Key]) => {
      owner[key] = value;
    },
  });
}

/** Allocate only once. The composer's text, cursor, mode, overlay flags and
 * counters stay on their owner (the input handler): the context reads and
 * writes them there, so a closure that edits the handler during a keystroke
 * is seen by every route and nothing copies them back afterwards. Per-feed
 * rendering swaps and restores requestRender separately. */
export function buildInitialFeedContext<Mutable extends FeedContextMutableInit, Stable extends object, Closures extends object>(
  owner: Mutable,
  stable: Stable,
  closures: Closures,
): FeedContextMutableInit & { requestRender: () => void } & Stable & Closures {
  const context = { requestRender: (): void => {}, ...stable, ...closures };
  for (const key of MUTABLE_KEYS) bindOwnerField(context, owner, key);
  return context as FeedContextMutableInit & typeof context;
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
    isConcealedInput?(): boolean;
    readonly concealedInput?: unknown;
    cancelConcealedInput(): boolean;
    handleEscape(): void;
    handleCtrlC(): void;
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
    isConcealedInput: (): boolean => host.isConcealedInput?.() ?? (host.concealedInput ?? null) !== null,
    handleEscape: () => {
      if (!host.cancelConcealedInput()) host.handleEscape();
    },
    handleCtrlC: () => host.handleCtrlC(),
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
