function captureFields<Source, Key extends keyof Source, Extra extends object = object>(source: Source, keys: readonly Key[], extra?: Extra) {
  // Fill one owned route object; controller handles are borrowed, never cloned.
  const result = (extra ?? {}) as { -readonly [Name in Key]: Source[Name] } & Extra;
  const fields = result as { -readonly [Name in Key]: Source[Name] };
  for (const key of keys) fields[key] = source[key];
  return result;
}
import type { InputToken } from '@goodvibes-jev/engine/platform/platform/core';
import { getViewportBottomLine } from './renderer/conversation-layout.js';
import type { WorkTreeConversation, WorkTreeRouteState } from './work-tree-input.js';
import type { InfiniteBuffer } from './conversation-history.js';
import type { SelectionResult } from './selection-modal.js';
import type { BlockMeta } from './terminal-conversation.js';
import { IMAGE_EXTENSIONS, formatFileSize, mediaTypeFromExt } from './input-content.js';
import type { FeedEnvironment } from './input-feed-pipeline.js';
const COMMAND_FIELDS = [
  'commandMode',
  'prompt',
  'cursorPos',
  'autocomplete',
  'modalStack',
  'commandRegistry',
  'commandContext',
  'conversationManager',
  'requestRender',
  'handleEscape',
  'projectRoot',
  'pasteRegistry',
  'imageRegistry',
  'nextPasteId',
  'nextImageId',
  'saveUndoState',
] as const;
type CommandField = (typeof COMMAND_FIELDS)[number];
type CommandFeedSource = Readonly<Record<CommandField, unknown>> & { ensureInputCursorVisible(): void };
type CommandFeedSnapshot<Source extends CommandFeedSource> = { -readonly [Key in CommandField]: Source[Key] } & {
  ensureInputCursorVisible: () => void;
};
export function createCommandModeFeedRoute<Source extends CommandFeedSource>(
  handle: (state: CommandFeedSnapshot<Source>, token: InputToken) => boolean,
) {
  return (context: Source, token: InputToken) => {
    const selected = captureFields(context, COMMAND_FIELDS);
    const commandState = { ...selected, ensureInputCursorVisible: () => context.ensureInputCursorVisible() };
    const handled = handle(commandState, token);
    return { ...commandState, handled };
  };
}
export interface WorkTreeFeedSource<Conversation extends WorkTreeConversation = WorkTreeConversation> {
  readonly conversationManager: Conversation | null;
  readonly keybindingsManager: { matches(action: 'focus-work-tree', token: Extract<InputToken, { type: 'key' }>): boolean };
  readonly getScrollTop: () => number;
  readonly scroll: (delta: number) => void;
  readonly requestRender: () => void;
  readonly commandContext?:
    | { readonly openSessionView?: ((target: { kind: 'agent' | 'process'; id: string }) => boolean) | undefined }
    | undefined;
}
export function createWorkTreeFeedRoute<Source extends WorkTreeFeedSource>(
  handle: (state: WorkTreeRouteState<NonNullable<Source['conversationManager']>>, token: InputToken) => boolean,
) {
  return (
    context: Source,
    token: InputToken,
    { viewportHeight, scrollTop, lineCount }: { viewportHeight: number; scrollTop: number; lineCount: number },
  ) => {
    const keybindings = context.keybindingsManager;
    return handle(
      {
        conversationManager: context.conversationManager,
        enterMatch: token.type === 'key' && keybindings.matches('focus-work-tree', token),
        anchorLine: getViewportBottomLine(scrollTop, viewportHeight, lineCount),
        scrollTop: context.getScrollTop(),
        viewportHeight,
        scroll: context.scroll,
        requestRender: context.requestRender,
        onCopied: () => {
          /* The block-copy receipt is already in the transcript. */
        },
        openAgent: (id) => context.commandContext?.openSessionView?.({ kind: 'agent', id }) ?? false,
        openProcess: (id) => context.commandContext?.openSessionView?.({ kind: 'process', id }) ?? false,
      },
      token,
    );
  };
}

const TEXT_FIELDS = ['prompt', 'cursorPos', 'commandMode', 'nextPasteId', 'nextImageId', 'pasteRegistry', 'imageRegistry',
  'inputHistory', 'commandRegistry', 'commandContext', 'autocomplete', 'filePicker', 'modalOpened', 'saveUndoState',
  'registerPaste', 'requestRender'] as const;
const KEY_FIELDS = ['prompt', 'cursorPos', 'inputScrollTop', 'commandMode', 'contentWidth', 'inputHistory', 'indicatorFocused',
  'conversationManager', 'commandContext', 'submitConcealedInput', 'autocomplete', 'modalOpened', 'saveUndoState',
  'ensureInputCursorVisible', 'getWrappedPromptInfo', 'moveCursorVertical', 'handlePathCompletion', 'handleBlockToggle',
  'findMarkerAtPos', 'cleanupMarkerRegistry', 'expandPrompt', 'scroll', 'exitApp', 'requestRender'] as const;
const MOUSE_FIELDS = ['conversationManager', 'selection', 'mouseDownRow', 'mouseDownCol', 'scroll', 'requestRender',
  'handlePaste', 'handleCopy', 'bodyTopRow'] as const;
const SHORTCUT_FIELDS = ['prompt', 'cursorPos', 'commandMode', 'autocomplete', 'historySearch', 'searchManager',
  'conversationManager', 'commandContext', 'contentWidth', 'getScrollTop', 'getWrappedPromptInfo', 'saveUndoState',
  'requestRender', 'scroll', 'handleCopy', 'handleCtrlC', 'handleBlockCopy', 'handleBookmark', 'handleBlockSave',
  'handleUndo', 'handleRedo', 'handlePaste', 'handleEscape', 'keybindingsManager'] as const;
const MODAL_FIELDS = ['conversationManager', 'selectionModal', 'bookmarkModal', 'settingsModal', 'mcpWorkspace',
  'sessionPickerModal', 'profilePickerModal', 'helpOverlayActive', 'helpScrollOffset', 'shortcutsOverlayActive',
  'shortcutsScrollOffset', 'historySearch', 'prompt', 'cursorPos', 'modelPicker', 'modalStack', 'commandContext',
  'getViewportHeight', 'requestRender', 'handleEscape', 'contextInspectorModal', 'overlayFilters', 'modalOpened',
  'filePicker', 'imageRegistry', 'nextImageId', 'saveUndoState', 'blockActionsMenu', 'executeBlockAction', 'searchManager',
  'scroll', 'getScrollTop', 'openModelPickerWithTarget', 'openProviderModelPickerWithTarget', 'onModelPickerCommit'] as const;
type SourceFields<Fields extends readonly string[]> = Readonly<Record<Fields[number], unknown>>;
interface CursorOwner { ensureInputCursorVisible(contentWidth?: number): void }

/** Scalar fields are a per-route snapshot; maps, controllers and callbacks
 * remain the original services. The shared feed pipeline owns write-back. */
export function capturePromptTextState<Source extends SourceFields<typeof TEXT_FIELDS> & CursorOwner>(source: Source) {
  return captureFields(source, TEXT_FIELDS, { ensureInputCursorVisible: () => source.ensureInputCursorVisible() });
}
export function capturePromptKeyState<Source extends SourceFields<typeof KEY_FIELDS> & {
  blockActionsMenu: { open(block: BlockMeta): void };
}>(source: Source) {
  return captureFields(source, KEY_FIELDS, { maxInputRows: 8,
    blockActionsMenu: { open: (block: BlockMeta) => source.blockActionsMenu.open(block) } });
}
export function captureMouseFeedState<Source extends SourceFields<typeof MOUSE_FIELDS>>(source: Source,
  environment: Pick<FeedEnvironment, 'viewportHeight' | 'scrollTop' | 'lineCount'>) {
  return captureFields(source, MOUSE_FIELDS, { viewportHeight: environment.viewportHeight,
    scrollTop: environment.scrollTop, lineCount: environment.lineCount });
}
export function captureShortcutFeedState<Source extends SourceFields<typeof SHORTCUT_FIELDS> & CursorOwner>(source: Source) {
  return captureFields(source, SHORTCUT_FIELDS, { ensureInputCursorVisible: () => source.ensureInputCursorVisible() });
}
export function captureIndicatorFeedState<Source extends { indicatorFocused: boolean; modalOpened(name: string): void; requestRender(): void }>(source: Source) {
  return { indicatorFocused: source.indicatorFocused, modalOpened: source.modalOpened, requestRender: source.requestRender };
}
export function captureModalFeedState<Source extends SourceFields<typeof MODAL_FIELDS> & CursorOwner & {
  selectionCallback: ((result: SelectionResult | null) => void) | null;
  readonly keybindingsManager: { matches(action: 'search', token: Extract<InputToken, { type: 'key' }>): boolean };
}>(source: Source, token: InputToken, history: InfiniteBuffer) {
  return captureFields(source, MODAL_FIELDS, { history,
    searchShortcutMatch: token.type === 'key' && source.keybindingsManager.matches('search', token),
    selectionCallback: source.selectionCallback,
    // Picker callbacks may replace themselves during this same route. Keep
    // their accessor connected to the live feed owner, not a detached value.
    getSelectionCallback: () => source.selectionCallback,
    setSelectionCallback: (callback: ((result: SelectionResult | null) => void) | null) => { source.selectionCallback = callback; },
    ensureInputCursorVisible: () => source.ensureInputCursorVisible(), formatFileSize, mediaTypeFromExt, imageExtensions: IMAGE_EXTENSIONS });
}

/** Products opt in when their shortcut policy can edit a slash command. */
export function refreshCommandAutocomplete(source: {
  commandMode: boolean;
  readonly prompt: string;
  readonly autocomplete: { reset(): void; update(query: string): void } | null;
}): void {
  if (!source.commandMode) return;
  if (!source.prompt.startsWith('/')) {
    source.commandMode = false; source.autocomplete?.reset(); return;
  }
  const query = source.prompt.slice(1);
  if (query.includes(' ')) source.autocomplete?.reset();
  else source.autocomplete?.update(query);
}
