import { createBlockContentActions } from '@goodvibes/engine/terminal-shell/block-content-actions';
export * from '@goodvibes/engine/terminal-shell/input-content';
import { expandPrompt as expand } from '@goodvibes/engine/terminal-shell/input-content';
export const expandPrompt = (...args: Parameters<typeof expand>) => expand(args[0], args[1], args[2], args[3], true);








export const { handleCopy, handleBlockCopy, handleBookmark, handleBlockSave, handleBlockToggle } = createBlockContentActions({
  noteTouch: (conversation, key) => conversation.noteUserTouch(key),
  bookmarkTarget: (block) => block.collapseKey,
});
