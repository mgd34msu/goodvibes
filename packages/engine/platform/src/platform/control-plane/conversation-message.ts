/**
 * conversation-message.ts
 *
 * The envelope for conversation messages flowing through the control-plane
 * gateway is declared once, in the contracts package, which both the platform
 * and the daemon routes depend on. These names keep the platform's existing
 * imports.
 */
export type {
  ConversationMessageAttachment,
  ConversationMessageEnvelope,
  ConversationMessageSource as MessageSource,
} from '@goodvibes/engine/contracts/conversation-message';
