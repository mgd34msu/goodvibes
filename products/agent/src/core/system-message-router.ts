import { TerminalSystemMessageRouter } from '@goodvibes-jev/engine/terminal-shell/system-message-router';
import {
  defaultSystemMessageTarget,
  type SystemMessageKind,
  type SystemMessageTarget,
} from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import type { NoiseGateDeps } from './system-message-noise.ts';
import type { ConversationManager } from './conversation.ts';
export type {
  SystemMessageKind,
  SystemMessageTarget,
  SystemMessagePriority,
} from '@goodvibes-jev/engine/terminal-shell/system-message-router';
import type { ActivityFeed } from './activity-feed.ts';
/**
 * The Activity view is this product's panel, and the default target sends
 * system lines there. A high-priority line is one the person must see or act
 * on, so it also lands on the main screen unless the person chose `panel`
 * themselves (`targetChosen`); errors and warnings land there even then.
 */
export class SystemMessageRouter extends TerminalSystemMessageRouter<ActivityFeed> {
  constructor(
    conversation: ConversationManager,
    feed: ActivityFeed | null,
    target: (kind: SystemMessageKind) => SystemMessageTarget = defaultSystemMessageTarget,
    noise: NoiseGateDeps = {},
    targetChosen?: (kind: SystemMessageKind) => boolean,
  ) {
    super(conversation, feed, target, noise, { typedConversation: false, forceConversationPrefixes: [], suppressCapturedOutput: true, targetChosen });
  }
}
export function createSystemMessageRouter(
  conversation: ConversationManager,
  feed: ActivityFeed | null = null,
  target: (kind: SystemMessageKind) => SystemMessageTarget = defaultSystemMessageTarget,
  noise: NoiseGateDeps = {},
  targetChosen?: (kind: SystemMessageKind) => boolean,
): SystemMessageRouter {
  return new SystemMessageRouter(conversation, feed, target, noise, targetChosen);
}
