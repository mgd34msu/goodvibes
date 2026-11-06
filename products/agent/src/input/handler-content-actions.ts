export * from '@goodvibes-jev/engine/terminal-shell/input-content';
import { expandPrompt as expand } from '@goodvibes-jev/engine/terminal-shell/input-content';
export const expandPrompt = (...args: Parameters<typeof expand>) => expand(args[0], args[1], args[2], args[3], true);

import { copyToClipboard } from '../utils/clipboard.ts';
import type { InfiniteBuffer } from '@goodvibes-jev/engine/terminal-shell';
import type { ConversationManager } from '../core/conversation';

import type { BookmarkManager } from '@goodvibes-jev/engine/sdk/platform/bookmarks';

import type { SelectionManager } from '@goodvibes-jev/engine/terminal-shell';

import { activeTokens } from '../renderer/theme.ts';

export function handleCopy(
  selection: SelectionManager,
  getHistory: () => InfiniteBuffer,
  requestRender: () => void,
  onCopied: () => void,
): void {
  if (!selection.hasSelection()) return;
  copyToClipboard(selection.getSelectedText(getHistory()));
  onCopied();
  requestRender();
  setTimeout(() => requestRender(), 2005);
}

export function handleBlockCopy(
  conversationManager: ConversationManager | null,
  getScrollTop: () => number,
  requestRender: () => void,
  onCopied: () => void,
): void {
  if (!conversationManager) return;
  const lineIndex = getScrollTop();
  const content = conversationManager.getBlockContentAtLine(lineIndex);
  if (!content) return;
  copyToClipboard(content);
  onCopied();
  // An explicit action on this block permanently exempts it from the
  // search-close auto-re-collapse (see ConversationManager.noteUserTouch),
  // copying content the user just had search reveal is a deliberate choice
  // to keep it visible, not an accident of typing a query.
  const nearest = conversationManager.findNearestBlock(lineIndex);
  if (nearest) conversationManager.noteUserTouch(nearest.collapseKey);
  requestRender();
  setTimeout(() => requestRender(), 2005);
}

export function handleBookmark(
  conversationManager: ConversationManager | null,
  getScrollTop: () => number,
  requestRender: () => void,
  bookmarkManager: BookmarkManager,
): void {
  if (!conversationManager) return;
  const lineIndex = getScrollTop();
  const nearest = conversationManager.findNearestBlock(lineIndex);
  if (!nearest) {
    conversationManager.log('[Ctrl+B: No block found nearby]', { fg: activeTokens().textFaint });
    requestRender();
    return;
  }
  const label = `${nearest.type}: ${nearest.rawContent.slice(0, 40).replace(/\n/g, ' ')}`;
  const added = bookmarkManager.toggle(nearest.collapseKey, label);
  // See handleBlockCopy's note, bookmarking is an explicit block action too.
  conversationManager.noteUserTouch(nearest.collapseKey);
  const msg = added
    ? `[Bookmarked: ${nearest.collapseKey}]`
    : `[Bookmark removed: ${nearest.collapseKey}]`;
  conversationManager.log(msg, { fg: added ? activeTokens().success : activeTokens().textMuted });
  requestRender();
}

export function handleBlockSave(
  conversationManager: ConversationManager | null,
  getScrollTop: () => number,
  requestRender: () => void,
  bookmarkManager: BookmarkManager,
): void {
  void bookmarkManager;
  if (!conversationManager) return;
  const lineIndex = getScrollTop();
  const content = conversationManager.getBlockContentAtLine(lineIndex);
  if (!content) {
    conversationManager.log('[Ctrl+S: No block found nearby]', { fg: activeTokens().textFaint });
    requestRender();
    return;
  }
  // No noteUserTouch() here, unlike handleBlockCopy/handleBookmark, the
  // save itself is disabled below (a no-op receipt only), so there is no
  // real content action to exempt from search's close-time re-collapse.
  conversationManager.log('[Block file save is disabled in GoodVibes Agent: copy the block explicitly or use /export markdown <path> --yes for the conversation.]', { fg: activeTokens().warning });
  requestRender();
}

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

export function handleBlockToggle(
  conversationManager: ConversationManager | null,
  getScrollTop: () => number,
  requestRender: () => void,
): void {
  if (!conversationManager) return;
  const lineIndex = getScrollTop();
  const blockIdx = conversationManager.toggleCollapseAtLine(lineIndex);
  if (blockIdx >= 0) {
    requestRender();
  }
}
