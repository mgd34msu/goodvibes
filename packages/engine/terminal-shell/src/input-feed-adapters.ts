function captureFields<Source, Key extends keyof Source>(source: Source, keys: readonly Key[]): { -readonly [Name in Key]: Source[Name] } {
  const result = {} as { -readonly [Name in Key]: Source[Name] };
  for (const key of keys) result[key] = source[key];
  return result;
}
import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import { getViewportBottomLine } from './renderer/conversation-layout.js';
import type { WorkTreeConversation, WorkTreeRouteState } from './work-tree-input.js';
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
