import type { BlockMeta } from '../work-tree-types.js';

export interface BlockAction<Id extends string = string> {
  id: Id;
  label: string;
  key: string;
}
export const COMMON_BLOCK_ACTIONS = [
  { id: 'copy', label: 'Copy', key: 'c' },
  { id: 'bookmark', label: 'Bookmark', key: 'b' },
  { id: 'toggle', label: 'Collapse/Expand', key: 'Tab' },
] as const;
export interface BlockActionRule<Id extends string> extends BlockAction<Id> {
  readonly available?: (block: BlockMeta) => boolean;
}
/**
 * BlockActionsMenu - Lightweight overlay that shows available actions
 * for the block the cursor is currently on.
 *
 * Activated by pressing Enter on a block in the conversation.
 * Dismissed by Esc or by selecting an action.
 */
export class BlockActionsMenu<Id extends string = string> {
  constructor(private readonly rules: readonly BlockActionRule<Id>[]) {}
  public active = false;
  public selectedIndex = 0;
  public actions: BlockAction<Id>[] = [];
  public block: BlockMeta | null = null;

  /**
   * open - Show the menu for the given block.
   * Filters available actions by block type.
   */
  open(block: BlockMeta): void {
    this.block = block;
    this.actions = this.rules.filter(action => action.available?.(block) ?? true);
    this.selectedIndex = 0;
    this.active = true;
  }

  close(): void {
    this.active = false;
    this.block = null;
    this.actions = [];
    this.selectedIndex = 0;
  }

  moveUp(): void {
    if (this.actions.length === 0) return;
    this.selectedIndex = (this.selectedIndex - 1 + this.actions.length) % this.actions.length;
  }

  moveDown(): void {
    if (this.actions.length === 0) return;
    this.selectedIndex = (this.selectedIndex + 1) % this.actions.length;
  }

  getSelected(): BlockAction<Id> | null {
    return this.actions[this.selectedIndex] ?? null;
  }

  /**
   * getActionForKey - Return the action matching a single key press, or null.
   * Handles 'tab' as 'Tab'.
   */
  getActionForKey(key: string): BlockAction<Id> | null {
    const k = key === 'tab' ? 'Tab' : key;
    return this.actions.find(a => a.key === k) ?? null;
  }
}
