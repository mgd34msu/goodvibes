import { createConversationRewindScope } from '@goodvibes-jev/engine/terminal-shell/conversation-rewind-port';
export { createConversationRewindPort, type ConversationRewindPort } from '@goodvibes-jev/engine/terminal-shell/conversation-rewind-port';
// This runtime owns its registrations; mechanics are shared without merging product state.
import type { ConversationManager } from '../core/conversation.ts';
export const { registerSessionConversation, unregisterSessionConversation, hasSessionConversation, findSessionConversation, createSessionConversationRewindPort } = createConversationRewindScope<ConversationManager>();
