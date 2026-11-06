import { describeBlockForReceipt } from '@goodvibes-jev/engine/terminal-shell/block-description';
export { describeBlockForReceipt } from '@goodvibes-jev/engine/terminal-shell/block-description';
export * from '@goodvibes-jev/engine/terminal-shell/input-content';
import { activeTokens } from '../renderer/theme.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { copyToClipboard } from '../utils/clipboard.ts';
import type { InfiniteBuffer } from '@goodvibes-jev/engine/terminal-shell';
import type { ConversationManager } from '../core/conversation';
import type { PermissionCategory } from '@goodvibes-jev/engine/sdk/platform/permissions';

import type { CommandContext } from './command-registry.ts';
import type { BookmarkManager } from '@goodvibes-jev/engine/sdk/platform/bookmarks';
import { resolveAndValidatePath } from '@goodvibes-jev/engine/sdk/platform/utils';
import { analyzePermissionRequest } from '@goodvibes-jev/engine/sdk/platform/permissions';

import type { SelectionManager } from '@goodvibes-jev/engine/terminal-shell';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';

/** Expand folded text before either Main submission or an agent steer. */

/**
 * describeBlockForReceipt - Honest, human-readable name for a block, used by
 * every anchor-based action's receipt (Ctrl+Y/B/S/A, Tab, block-actions menu)
 * so the transcript always says exactly what was acted on, never just an
 * internal collapseKey or a bare "done".
 */


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

/**
 * handleBlockCopy - Ctrl+Y: copy the content of the block the user is
 * actually looking at. `getAnchorLine` resolves to the viewport's
 * bottom-most visible line (see getViewportBottomLine in
 * conversation-layout.ts), not the raw scroll position, the top of the
 * viewport is off-screen-above once the transcript is longer than one page.
 */
export function handleBlockCopy(
  conversationManager: ConversationManager | null,
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
  copyToClipboard(nearest.rawContent);
  onCopied();
  // An explicit action on this block permanently exempts it from the
  // search-close auto-re-collapse (see ConversationManager.noteUserTouch),
  // copying content the user just had search reveal is a deliberate choice
  // to keep it visible, not an accident of typing a query.
  conversationManager.searchExpansion.noteUserTouch(nearest.collapseKey);
  conversationManager.log(`[Copied ${describeBlockForReceipt(nearest)}]`, { fg: activeTokens().success });
  requestRender();
  setTimeout(() => requestRender(), 2005);
}

export function handleBookmark(
  conversationManager: ConversationManager | null,
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
  conversationManager.searchExpansion.noteUserTouch(nearest.collapseKey);
  const target = describeBlockForReceipt(nearest);
  const msg = added
    ? `[Bookmarked: ${target}]`
    : `[Bookmark removed: ${target}]`;
  conversationManager.log(msg, { fg: added ? activeTokens().success : activeTokens().textMuted });
  requestRender();
}

export function handleBlockSave(
  conversationManager: ConversationManager | null,
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
  conversationManager.searchExpansion.noteUserTouch(nearest.collapseKey);
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

export function handleBlockToggle(
  conversationManager: ConversationManager | null,
  getAnchorLine: () => number,
  requestRender: () => void,
): void {
  if (!conversationManager) return;
  const lineIndex = getAnchorLine();
  const nearest = conversationManager.findNearestBlock(lineIndex);
  if (!nearest) return;
  const blockIdx = conversationManager.toggleCollapseAtLine(lineIndex);
  if (blockIdx >= 0) {
    requestRender();
  }
}

export function handleDiffApply(
  conversationManager: ConversationManager | null,
  getAnchorLine: () => number,
  commandContext: CommandContext | undefined,
  requestRender: () => void,
  getCallId: () => string,
  category: PermissionCategory,
): boolean {
  if (!conversationManager) return false;
  const lineIndex = getAnchorLine();
  const diff = conversationManager.getDiffAtLine(lineIndex);
  if (!diff || !diff.filePath) return false;
  const projectRoot = commandContext?.workspace.shellPaths?.workingDirectory
    ?? commandContext?.platform.configManager.getWorkingDirectory();

  commandContext?.requestPermission?.({
    callId: getCallId(),
    tool: 'edit',
    args: { path: diff.filePath, original: diff.original, updated: diff.updated },
    category,
    analysis: analyzePermissionRequest(
      'edit',
      { path: diff.filePath, original: diff.original, updated: diff.updated },
      category,
    ),
  }).then(({ approved }) => {
    if (!approved) return;
    if (!projectRoot) {
      conversationManager.log('[Diff apply failed: missing working directory]', { fg: activeTokens().error });
      return;
    }
    let resolvedPath: string;
    try {
      resolvedPath = resolveAndValidatePath(diff.filePath!, projectRoot);
    } catch (err) {
      conversationManager.log(`[Diff apply failed: ${err instanceof Error ? err.message : err}]`, { fg: activeTokens().error });
      return;
    }
    try {
      const content = readFileSync(resolvedPath, 'utf-8');
      if (diff.original && content.includes(diff.original)) {
        const occurrenceCount = content.split(diff.original).length - 1;
        if (occurrenceCount > 1) {
          conversationManager.log(`[Diff apply failed: pattern found ${occurrenceCount} times in ${diff.filePath} - ambiguous]`, { fg: activeTokens().error });
        } else {
          const newContent = content.replace(diff.original, diff.updated);
          writeFileSync(resolvedPath, newContent, 'utf-8');
          conversationManager.log(`[Applied diff to ${diff.filePath}]`, { fg: activeTokens().success });
        }
      } else {
        conversationManager.log(`[Diff apply failed: original text not found in ${diff.filePath}]`, { fg: activeTokens().error });
      }
    } catch (err) {
      const msg = summarizeError(err);
      conversationManager.log(`[Diff apply error: ${msg}]`, { fg: activeTokens().error });
    }
    requestRender();
  }).catch((err) => {
    conversationManager.log(`[Diff apply error: ${summarizeError(err)}]`, { fg: activeTokens().error });
    requestRender();
  });
  return true;
}
