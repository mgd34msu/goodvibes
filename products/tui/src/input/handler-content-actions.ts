import { createBlockContentActions } from '@goodvibes/engine/terminal-shell/block-content-actions';
import { describeBlockForReceipt } from '@goodvibes/engine/terminal-shell/block-description';
export { describeBlockForReceipt } from '@goodvibes/engine/terminal-shell/block-description';
export * from '@goodvibes/engine/terminal-shell/input-content';
import { activeTokens } from '../renderer/theme.ts';
import { blockAt, isProposedDiff } from '@goodvibes/engine/terminal-shell/conversation-event-navigation';
import type { ConversationManager } from '../core/conversation';
import type { PermissionCategory } from '@goodvibes/engine/platform/platform/permissions';
import { analyzePermissionRequest } from '@goodvibes/engine/platform/platform/permissions';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils';
import type { CommandContext } from './command-registry.ts';

/**
 * Apply the diff under the anchor line (block actions, "Apply diff"). Only a
 * diff a tool showed without writing it qualifies: an edit or write call's
 * diff is the change already made. The write runs through the edit tool, so
 * its matching, change tracking and undo snapshot are the ones every edit
 * gets; the approval card and the edit are for the same call.
 */
export function handleDiffApply(
  conversationManager: ConversationManager | null,
  getAnchorLine: () => number,
  commandContext: CommandContext | undefined,
  requestRender: () => void,
  getCallId: () => string,
  category: PermissionCategory,
): void {
  if (!conversationManager) return;
  const say = (text: string, ok = false): void => {
    conversationManager.log(text, { fg: ok ? activeTokens().success : activeTokens().error });
    requestRender();
  };
  const block = blockAt(conversationManager.getBlockRegistry(), getAnchorLine(), 'diff');
  if (!block || !block.filePath) {
    say('[Apply diff: no diff is under the cursor line. Scroll until the diff is at the bottom of the view, then press Enter on it.]');
    return;
  }
  const path = block.filePath;
  if (!isProposedDiff(block)) {
    say(`[Apply diff: ${path} already holds this change; ${block.toolName ?? 'the tool'} wrote it. Nothing was applied.]`);
    return;
  }
  if (block.unsupported) {
    say(`[Apply diff refused: ${block.unsupported}]`);
    return;
  }
  const original = block.diffOriginal ?? '';
  const updated = block.diffUpdated ?? '';
  if (original === '') {
    say(`[Apply diff refused: the diff creates ${path} rather than changing text in it; apply supports changes to existing text.]`);
    return;
  }
  const requestPermission = commandContext?.requestPermission;
  const toolRegistry = commandContext?.extensions.toolRegistry;
  if (!requestPermission || !toolRegistry) {
    say('[Cannot apply the diff: this session has no approval surface or edit tool. Nothing was written.]');
    return;
  }
  const callId = getCallId();
  const args = { edits: [{ path, find: original, replace: updated }] };
  void (async () => {
    try {
      const { approved } = await requestPermission({
        callId,
        tool: 'edit',
        args,
        category,
        analysis: analyzePermissionRequest('edit', { path, original, updated }, category),
      });
      if (!approved) {
        say(`[Apply diff to ${path} denied; the file is unchanged.]`);
        return;
      }
      const result = await toolRegistry.execute(callId, 'edit', args);
      if (result.success) say(`[Applied diff to ${path} with the edit tool.]`, true);
      else say(`[Diff not applied to ${path}: ${result.error ?? 'the edit tool refused it'}]`);
    } catch (error) {
      say(`[Diff not applied to ${path}: ${summarizeError(error)}]`);
    }
  })();
}

export const { handleCopy, handleBlockCopy, handleBookmark, handleBlockSave, handleBlockToggle } = createBlockContentActions({
  noteTouch: (conversation, key) => conversation.searchExpansion.noteUserTouch(key),
  bookmarkTarget: describeBlockForReceipt,
});
