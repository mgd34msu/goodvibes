import { BlockActionsMenu as PlatformMenu, COMMON_BLOCK_ACTIONS } from '@goodvibes/engine/terminal-shell/block-actions';
import type { BlockAction as PlatformAction } from '@goodvibes/engine/terminal-shell/block-actions';
import { isProposedDiff } from '@goodvibes/engine/terminal-shell/conversation-event-navigation';
export type BlockActionId = 'copy' | 'bookmark' | 'toggle' | 'apply';
export type BlockAction = PlatformAction<BlockActionId>;
export class BlockActionsMenu extends PlatformMenu<BlockActionId> {
  constructor() { super([...COMMON_BLOCK_ACTIONS, { id: 'apply', label: 'Apply diff', key: 'a', available: isProposedDiff }]); }
}
