import { TerminalConversationManager } from '@goodvibes-jev/engine/terminal-shell/terminal-conversation';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import * as renderer from './conversation-rendering.ts';
export * from '@goodvibes-jev/engine/terminal-shell/terminal-conversation';
export class ConversationManager extends TerminalConversationManager {
  constructor(getWidth: () => number = () => process.stdout.columns || 80, configManager?: ConfigManager) {
    super(getWidth, configManager, { renderer, paragraphSpacing: false, streamThrottleMs: 0, stickySplash: false });
  }
}
