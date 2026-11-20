import { TerminalSystemMessageRouter } from '@goodvibes/engine/terminal-shell/system-message-router';
import {
  defaultSystemMessageTarget,
  type SystemMessageKind,
  type SystemMessageTarget,
} from '@goodvibes/engine/platform/platform/runtime/shell';
import { declaredNoticeLevel, type SystemMessageActivityFeed } from '@goodvibes/engine/terminal-shell/system-message-router';
import type { NoiseGateDeps } from './system-message-noise.ts';
import type { ConversationManager } from './conversation.ts';
import { publishNotice } from './notices.ts';
import { getSharedNotificationFeed } from './notifications-feed.ts';
export type {
  SystemMessageKind,
  SystemMessageTarget,
  SystemMessagePriority,
} from '@goodvibes/engine/terminal-shell/system-message-router';

/**
 * The panel is the Notifications history, as in the terminal app: a line whose
 * target is `panel` is recorded (and toasted) there and kept out of the
 * transcript. Every transcript notice is already recorded there by the
 * conversation's notice sink, so it is not pushed twice. A high-priority line,
 * one the person must see or act on, also lands on the main screen unless the
 * person chose `panel` themselves (`targetChosen`); errors and warnings land
 * there even then.
 */
const notificationsPanel: SystemMessageActivityFeed = {
  push(message, priority) {
    void publishNotice(getSharedNotificationFeed(), message, { notice: { level: declaredNoticeLevel(message), priority } });
  },
};

export class SystemMessageRouter extends TerminalSystemMessageRouter {
  constructor(
    conversation: ConversationManager,
    target: (kind: SystemMessageKind) => SystemMessageTarget = defaultSystemMessageTarget,
    noise: NoiseGateDeps = {},
    targetChosen?: (kind: SystemMessageKind) => boolean,
  ) {
    super(conversation, null, target, noise, {
      typedConversation: false,
      forceConversationPrefixes: [],
      suppressCapturedOutput: true,
      targetPanel: notificationsPanel,
      conversationFeedsPanel: true,
      targetChosen,
    });
  }
}
export function createSystemMessageRouter(
  conversation: ConversationManager,
  target: (kind: SystemMessageKind) => SystemMessageTarget = defaultSystemMessageTarget,
  noise: NoiseGateDeps = {},
  targetChosen?: (kind: SystemMessageKind) => boolean,
): SystemMessageRouter {
  return new SystemMessageRouter(conversation, target, noise, targetChosen);
}
