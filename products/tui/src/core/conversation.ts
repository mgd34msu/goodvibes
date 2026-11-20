import { TerminalConversationManager } from '@goodvibes-jev/engine/terminal-shell/terminal-conversation';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import * as renderer from './conversation-rendering.ts';
import { installTurnFailureRows, noteTurnFailurePromptSent } from '@goodvibes-jev/engine/terminal-shell/turn-failure-actions';
import type { ContentPart } from '@goodvibes-jev/engine/platform/platform/providers';
export * from '@goodvibes-jev/engine/terminal-shell/terminal-conversation';
export class ConversationManager extends TerminalConversationManager {
  constructor(getWidth: () => number = () => process.stdout.columns || 80, configManager?: ConfigManager) {
    super(getWidth, configManager, { renderer, paragraphSpacing: true, streamThrottleMs: 16, stickySplash: true });
    // A failed turn is a row in this transcript (turn-failure-actions.ts).
    installTurnFailureRows(this, { changesCommand: true });
  }
  override addUserMessage(content: string | ContentPart[]): void {
    super.addUserMessage(content);
    noteTurnFailurePromptSent();
  }
}
