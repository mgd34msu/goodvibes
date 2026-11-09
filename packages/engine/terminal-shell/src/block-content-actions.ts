import { copyToClipboard } from './clipboard.js';
import type { InfiniteBuffer } from './conversation-history.js';
import type { TerminalConversationManager, BlockMeta } from './terminal-conversation.js';
import type { SelectionManager } from './text-selection.js';
import type { BookmarkManager } from '@goodvibes-jev/engine/platform/platform/bookmarks';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { activeTokens } from './renderer/theme.js';
import { describeBlockForReceipt } from './block-description.js';
export function createBlockContentActions(policy: {
  readonly copyReceipt: boolean;
  readonly allowSave: boolean;
  readonly requireNearestForToggle: boolean;
  readonly saveDisabled: string;
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
    copyToClipboard(selection.getSelectedText(getHistory()));
    onCopied();
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
    if (!policy.copyReceipt) {
      const lineIndex = getAnchorLine();
      const content = conversationManager.getBlockContentAtLine(lineIndex);
      if (!content) return;
      copyToClipboard(content);
      onCopied();
      const nearest = conversationManager.findNearestBlock(lineIndex);
      if (nearest) policy.noteTouch(conversationManager, nearest.collapseKey);
      requestRender();
      setTimeout(() => requestRender(), 2005);
      return;
    }
    const lineIndex = getAnchorLine();
    const nearest = conversationManager.findNearestBlock(lineIndex);
    if (!nearest) {
      conversationManager.log('[Ctrl+Y: No block found nearby]', { fg: activeTokens().textFaint });
      requestRender();
      return;
    }
    copyToClipboard(nearest.rawContent);
    onCopied();
    // An explicit action on this block permanently exempts it from the
    // search-close auto-re-collapse (see TerminalConversationManager.noteUserTouch),
    // copying content the user just had search reveal is a deliberate choice
    // to keep it visible, not an accident of typing a query.
    policy.noteTouch(conversationManager, nearest.collapseKey);
    conversationManager.log(`[Copied ${describeBlockForReceipt(nearest)}]`, { fg: activeTokens().success });
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
    const label = `${nearest.type}: ${nearest.rawContent.slice(0, 40).replace(/\n/g, ' ')}`;
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
    if (!policy.allowSave) {
      const content = conversationManager.getBlockContentAtLine(getAnchorLine());
      if (!content) {
        conversationManager.log('[Ctrl+S: No block found nearby]', { fg: activeTokens().textFaint });
        requestRender();
        return;
      }
      conversationManager.log(policy.saveDisabled, { fg: activeTokens().warning });
      requestRender();
      return;
    }
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
      const filePath = bookmarkManager.saveToFile(nearest.rawContent, nearest.type);
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
    const nearest = policy.requireNearestForToggle ? conversationManager.findNearestBlock(lineIndex) : null;
    if (policy.requireNearestForToggle && !nearest) return;
    const blockIdx = conversationManager.toggleCollapseAtLine(lineIndex);
    if (blockIdx >= 0) {
      requestRender();
    }
  }
  return { handleCopy, handleBlockCopy, handleBookmark, handleBlockSave, handleBlockToggle };
}
