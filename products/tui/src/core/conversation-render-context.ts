import { collectToolCallOutcomes as collect, type ConversationRenderContext as Context } from '@goodvibes-jev/engine/terminal-shell/conversation-render-context';
import type { ConversationMessageSnapshot } from '@goodvibes-jev/engine/platform/platform/core';
import type { SystemMessageKind } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
export * from '@goodvibes-jev/engine/terminal-shell/conversation-render-context';
export interface ConversationRenderContext extends Context { readonly messageKindRegistry: ReadonlyMap<number, SystemMessageKind> }
export const collectToolCallOutcomes = (messages: readonly ConversationMessageSnapshot[]) => collect(messages, true);
