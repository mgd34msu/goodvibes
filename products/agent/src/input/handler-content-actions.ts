import { createBlockContentActions } from '@goodvibes-jev/engine/terminal-shell/block-content-actions';
export * from '@goodvibes-jev/engine/terminal-shell/input-content';
import { expandPrompt as expand } from '@goodvibes-jev/engine/terminal-shell/input-content';
export const expandPrompt = (...args: Parameters<typeof expand>) => expand(args[0], args[1], args[2], args[3], true);

import '../utils/clipboard.ts';

import type { ConversationManager } from '../core/conversation';





import { activeTokens } from '../renderer/theme.ts';

export function handleBlockRerun(
  conversationManager: ConversationManager | null,
  getScrollTop: () => number,
  requestRender: () => void,
): void {
  if (!conversationManager) return;
  const lineIndex = getScrollTop();
  const nearest = conversationManager.findNearestBlock(lineIndex, 'tool');
  if (!nearest) {
    conversationManager.log('[Re-run: No tool block found nearby]', { fg: activeTokens().textFaint });
    requestRender();
    return;
  }
  requestRender();
}

export const { handleCopy, handleBlockCopy, handleBookmark, handleBlockSave, handleBlockToggle } = createBlockContentActions({
  copyReceipt: false,
  allowSave: false,
  requireNearestForToggle: false,
  saveDisabled:
    '[Block file save is disabled in GoodVibes Agent: copy the block explicitly or use /export markdown <path> --yes for the conversation.]',
  noteTouch: (conversation, key) => conversation.noteUserTouch(key),
  bookmarkTarget: (block) => block.collapseKey,
});
