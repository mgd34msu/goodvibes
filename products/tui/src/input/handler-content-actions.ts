import { createBlockContentActions } from '@goodvibes-jev/engine/terminal-shell/block-content-actions';
import { describeBlockForReceipt } from '@goodvibes-jev/engine/terminal-shell/block-description';
export { describeBlockForReceipt } from '@goodvibes-jev/engine/terminal-shell/block-description';
export * from '@goodvibes-jev/engine/terminal-shell/input-content';
import { activeTokens } from '../renderer/theme.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import '../utils/clipboard.ts';

import type { ConversationManager } from '../core/conversation';
import type { PermissionCategory } from '@goodvibes-jev/engine/sdk/platform/permissions';

import type { CommandContext } from './command-registry.ts';

import { resolveAndValidatePath } from '@goodvibes-jev/engine/sdk/platform/utils';
import { analyzePermissionRequest } from '@goodvibes-jev/engine/sdk/platform/permissions';


import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';

/** Expand folded text before either Main submission or an agent steer. */

/**
 * describeBlockForReceipt - Honest, human-readable name for a block, used by
 * every anchor-based action's receipt (Ctrl+Y/B/S/A, Tab, block-actions menu)
 * so the transcript always says exactly what was acted on, never just an
 * internal collapseKey or a bare "done".
 */

/**
 * handleBlockCopy - Ctrl+Y: copy the content of the block the user is
 * actually looking at. `getAnchorLine` resolves to the viewport's
 * bottom-most visible line (see getViewportBottomLine in
 * conversation-layout.ts), not the raw scroll position, the top of the
 * viewport is off-screen-above once the transcript is longer than one page.
 */

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
  const projectRoot =
    commandContext?.workspace.shellPaths?.workingDirectory ?? commandContext?.platform.configManager.getWorkingDirectory();

  commandContext
    ?.requestPermission?.({
      callId: getCallId(),
      tool: 'edit',
      args: { path: diff.filePath, original: diff.original, updated: diff.updated },
      category,
      analysis: analyzePermissionRequest('edit', { path: diff.filePath, original: diff.original, updated: diff.updated }, category),
    })
    .then(({ approved }) => {
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
            conversationManager.log(`[Diff apply failed: pattern found ${occurrenceCount} times in ${diff.filePath} - ambiguous]`, {
              fg: activeTokens().error,
            });
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
    })
    .catch((err) => {
      conversationManager.log(`[Diff apply error: ${summarizeError(err)}]`, { fg: activeTokens().error });
      requestRender();
    });
  return true;
}

export const { handleCopy, handleBlockCopy, handleBookmark, handleBlockSave, handleBlockToggle } = createBlockContentActions({
  copyReceipt: true,
  allowSave: true,
  requireNearestForToggle: true,
  saveDisabled:
    '[Block file save is disabled in GoodVibes Agent: copy the block explicitly or use /export markdown <path> --yes for the conversation.]',
  noteTouch: (conversation, key) => conversation.searchExpansion.noteUserTouch(key),
  bookmarkTarget: describeBlockForReceipt,
});
