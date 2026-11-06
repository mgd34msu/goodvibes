import { TerminalSystemMessageRouter } from '@goodvibes-jev/engine/terminal-shell/system-message-router';
import {
  defaultSystemMessageTarget,
  type SystemMessageKind,
  type SystemMessageTarget,
} from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import type { NoiseGateDeps } from './system-message-noise.ts';
import type { ConversationManager } from './conversation.ts';
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
