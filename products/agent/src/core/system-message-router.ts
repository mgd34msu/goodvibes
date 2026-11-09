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
export class SystemMessageRouter extends TerminalSystemMessageRouter<ActivityFeed> {
  constructor(
    conversation: ConversationManager,
    feed: ActivityFeed | null,
    target: (kind: SystemMessageKind) => SystemMessageTarget = defaultSystemMessageTarget,
    noise: NoiseGateDeps = {},
  ) {
    super(conversation, feed, target, noise, { typedConversation: false, forceConversationPrefixes: [], suppressCapturedOutput: true });
  }
}
export function createSystemMessageRouter(
  conversation: ConversationManager,
  feed: ActivityFeed | null = null,
  target: (kind: SystemMessageKind) => SystemMessageTarget = defaultSystemMessageTarget,
  noise: NoiseGateDeps = {},
): SystemMessageRouter {
  return new SystemMessageRouter(conversation, feed, target, noise);
}
