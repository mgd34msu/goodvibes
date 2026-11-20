import type { ConversationRenderContext as Context } from '@goodvibes/engine/terminal-shell/conversation-render-context';
import type { SystemMessageKind } from '@goodvibes/engine/platform/platform/runtime/shell';
export * from '@goodvibes/engine/terminal-shell/conversation-render-context';
export interface ConversationRenderContext extends Context { readonly messageKindRegistry: ReadonlyMap<number, SystemMessageKind> }
