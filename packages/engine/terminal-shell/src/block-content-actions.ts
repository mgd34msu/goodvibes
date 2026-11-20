import { copyToClipboard } from './clipboard.js';
import type { InfiniteBuffer } from './conversation-history.js';
import type { TerminalConversationManager, BlockMeta } from './terminal-conversation.js';
import type { SelectionManager } from './text-selection.js';
import type { BookmarkManager } from '@goodvibes/engine/platform/platform/bookmarks';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { activeTokens } from './renderer/theme.js';
import { describeBlockForReceipt } from './block-description.js';
export function createBlockContentActions(policy: {
  readonly noteTouch: (conversation: TerminalConversationManager, key: string) => void;
  readonly bookmarkTarget: (block: BlockMeta) => string;
}) {
  function handleCopy(
    selection: SelectionManager,
    getHistory: () => InfiniteBuffer,
    requestRender: () => void,
    onCopied: () => void,
  ): void {
    if (!selection.hasSelection()) return;
    if (copyToClipboard(selection.getSelectedText(getHistory()))) onCopied();
    requestRender();
    setTimeout(() => requestRender(), 2005);
  }
  function handleBlockCopy(
    conversationManager: TerminalConversationManager | null,
    getAnchorLine: () => number,
    requestRender: () => void,
    onCopied: () => void,
  ): void {
    if (!conversationManager) return;
    const lineIndex = getAnchorLine();
    const nearest = conversationManager.findNearestBlock(lineIndex);
    if (!nearest) {
      conversationManager.log('[Ctrl+Y: No block found nearby]', { fg: activeTokens().textFaint });
      requestRender();
      return;
    }
    const sent = copyToClipboard(nearest.rawContent);
    if (sent) onCopied();
    // An explicit action on this block permanently exempts it from the
    // search-close auto-re-collapse (see TerminalConversationManager.noteUserTouch),
    // copying content the user just had search reveal is a deliberate choice
    // to keep it visible, not an accident of typing a query.
    policy.noteTouch(conversationManager, nearest.collapseKey);
    if (sent) conversationManager.log(`[Copied ${describeBlockForReceipt(nearest)}]`, { fg: activeTokens().success });
    else conversationManager.log('[Copy failed: nothing was sent to the terminal clipboard]', { fg: activeTokens().error });
    requestRender();
    setTimeout(() => requestRender(), 2005);
  }
  function handleBookmark(
    conversationManager: TerminalConversationManager | null,
    getAnchorLine: () => number,
    requestRender: () => void,
    bookmarkManager: BookmarkManager,
  ): void {
    if (!conversationManager) return;
    const lineIndex = getAnchorLine();
    const nearest = conversationManager.findNearestBlock(lineIndex);
    if (!nearest) {
      conversationManager.log('[Ctrl+B: No block found nearby]', { fg: activeTokens().textFaint });
      requestRender();
      return;
    }
    const label = nearest.title ?? `${nearest.type}: ${nearest.rawContent.slice(0, 40).replace(/\n/g, ' ')}`;
    const added = bookmarkManager.toggle(nearest.collapseKey, label);
    // See handleBlockCopy's note, bookmarking is an explicit block action too.
    policy.noteTouch(conversationManager, nearest.collapseKey);
    const target = policy.bookmarkTarget(nearest);
    const msg = added ? `[Bookmarked: ${target}]` : `[Bookmark removed: ${target}]`;
    conversationManager.log(msg, { fg: added ? activeTokens().success : activeTokens().textMuted });
    requestRender();
  }
  function handleBlockSave(
    conversationManager: TerminalConversationManager | null,
    getAnchorLine: () => number,
    requestRender: () => void,
    bookmarkManager: BookmarkManager,
  ): void {
    if (!conversationManager) return;
    const lineIndex = getAnchorLine();
    const nearest = conversationManager.findNearestBlock(lineIndex);
    if (!nearest) {
      conversationManager.log('[Ctrl+S: No block found nearby]', { fg: activeTokens().textFaint });
      requestRender();
      return;
    }
    // See handleBlockCopy's note, saving to a file is an explicit block action too.
    policy.noteTouch(conversationManager, nearest.collapseKey);
    const target = describeBlockForReceipt(nearest);
    try {
      // Keyed by the block, as its bookmark is: opening the bookmark opens this exact file.
      const filePath = bookmarkManager.saveToFile(nearest.rawContent, nearest.type, nearest.collapseKey);
      const homePath = process.env.HOME || process.env.USERPROFILE || '';
      const displayPath = homePath ? filePath.replace(homePath, '~') : filePath;
      conversationManager.log(`[Saved ${target} to: ${displayPath}]`, { fg: activeTokens().success });
    } catch (err) {
      const msg = summarizeError(err);
      conversationManager.log(`[Save failed (${target}): ${msg}]`, { fg: activeTokens().error });
    }
    requestRender();
  }
  function handleBlockToggle(
    conversationManager: TerminalConversationManager | null,
    getAnchorLine: () => number,
    requestRender: () => void,
  ): void {
    if (!conversationManager) return;
    const lineIndex = getAnchorLine();
    if (!conversationManager.findNearestBlock(lineIndex)) return;
    const blockIdx = conversationManager.toggleCollapseAtLine(lineIndex);
    if (blockIdx >= 0) {
      requestRender();
    }
  }
  return { handleCopy, handleBlockCopy, handleBookmark, handleBlockSave, handleBlockToggle };
}
