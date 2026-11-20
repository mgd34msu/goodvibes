import { BlockActionsMenu as PlatformMenu, COMMON_BLOCK_ACTIONS } from '@goodvibes/engine/terminal-shell/block-actions';
import type { BlockAction as PlatformAction } from '@goodvibes/engine/terminal-shell/block-actions';
export type BlockActionId = 'copy' | 'bookmark' | 'toggle';
export type BlockAction = PlatformAction<BlockActionId>;
export class BlockActionsMenu extends PlatformMenu<BlockActionId> {
  constructor() { super([...COMMON_BLOCK_ACTIONS]); }
}
