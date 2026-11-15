import type { ConversationRenderContext as Context } from '@goodvibes-jev/engine/terminal-shell/conversation-render-context';
import type { SystemMessageKind } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
export * from '@goodvibes-jev/engine/terminal-shell/conversation-render-context';
export interface ConversationRenderContext extends Context { readonly messageKindRegistry: ReadonlyMap<number, SystemMessageKind> }
