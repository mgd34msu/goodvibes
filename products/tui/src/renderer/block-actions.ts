import { BlockActionsMenu as PlatformMenu, COMMON_BLOCK_ACTIONS } from '@goodvibes-jev/engine/terminal-shell/block-actions';
import type { BlockAction as PlatformAction } from '@goodvibes-jev/engine/terminal-shell/block-actions';
export type BlockActionId = 'copy' | 'bookmark' | 'toggle' | 'apply';
export type BlockAction = PlatformAction<BlockActionId>;
export class BlockActionsMenu extends PlatformMenu<BlockActionId> {
  constructor() { super([...COMMON_BLOCK_ACTIONS, { id: 'apply', label: 'Apply diff', key: 'a', available: block => block.type === 'diff' }]); }
}
