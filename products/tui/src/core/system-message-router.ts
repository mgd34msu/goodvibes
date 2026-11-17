import { TerminalSystemMessageRouter } from '@goodvibes-jev/engine/terminal-shell/system-message-router';
import {
  defaultSystemMessageTarget,
  type SystemMessageKind,
  type SystemMessageTarget,
} from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { declaredNoticeLevel, type SystemMessageActivityFeed } from '@goodvibes-jev/engine/terminal-shell/system-message-router';
import type { NoiseGateDeps } from './system-message-noise.ts';
import type { ConversationManager } from './conversation.ts';
import { publishNotice } from './notices.ts';
import { getSharedNotificationFeed } from '../views/notifications-feed.ts';

/**
 * The TUI's panel is the Notifications history: a line whose target is `panel`
 * is recorded (and toasted) there and kept out of the transcript. Every
 * transcript notice is already recorded there by the conversation's notice
 * sink, so `both` and `conversation` show the same in this product.
 */
const notificationsPanel: SystemMessageActivityFeed = {
  push(message, priority) {
    publishNotice(getSharedNotificationFeed(), message, { notice: { level: declaredNoticeLevel(message), priority } });
  },
};
export type {
  SystemMessageKind,
  SystemMessageTarget,
  SystemMessagePriority,
} from '@goodvibes-jev/engine/terminal-shell/system-message-router';
export class SystemMessageRouter extends TerminalSystemMessageRouter {
  constructor(
    conversation: ConversationManager,
    target: (kind: SystemMessageKind) => SystemMessageTarget = defaultSystemMessageTarget,
    noise: NoiseGateDeps = {},
  ) {
    super(conversation, null, target, noise, {
      typedConversation: true,
      forceConversationPrefixes: ['[Error]', '[Failover]', '[Routing]', '[Compaction]', '[Context]', '[Rewind]', '[Revert]'],
      targetPanel: notificationsPanel,
      conversationFeedsPanel: true,
    });
  }
}
export function createSystemMessageRouter(
  conversation: ConversationManager,
  target: (kind: SystemMessageKind) => SystemMessageTarget = defaultSystemMessageTarget,
  noise: NoiseGateDeps = {},
): SystemMessageRouter {
  return new SystemMessageRouter(conversation, target, noise);
}
