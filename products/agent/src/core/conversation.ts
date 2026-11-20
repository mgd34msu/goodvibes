import { TerminalConversationManager } from '@goodvibes/engine/terminal-shell/terminal-conversation';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import * as renderer from './conversation-rendering.ts';
import { installTurnFailureRows, noteTurnFailurePromptSent } from '@goodvibes/engine/terminal-shell/turn-failure-actions';
import type { ContentPart } from '@goodvibes/engine/platform/platform/providers';
export * from '@goodvibes/engine/terminal-shell/terminal-conversation';
export class ConversationManager extends TerminalConversationManager {
  constructor(getWidth: () => number = () => process.stdout.columns || 80, configManager?: ConfigManager) {
    super(getWidth, configManager, { renderer, paragraphSpacing: false, streamThrottleMs: 0, stickySplash: false });
    // A failed turn is a row in this transcript (turn-failure-actions.ts).
    installTurnFailureRows(this, { changesCommand: false });
  }
  override addUserMessage(content: string | ContentPart[]): void {
    super.addUserMessage(content);
    noteTurnFailurePromptSent();
  }
}
