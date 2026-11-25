import type { BookmarkManager } from '@goodvibes/engine/platform/platform/bookmarks';
import type { SelectionItem, SelectionResult, SelectionAction } from './selection-modal.js';
export interface BookmarkCommandContext {
  readonly print: (text: string) => void;
  readonly openBookmarkModal?: (() => void) | undefined;
  readonly jumpToBookmark?: ((key: string) => void) | undefined;
  readonly openSelection?:
    | ((
        title: string,
        items: SelectionItem[],
        options:
          | {
              readonly allowSearch?: boolean | undefined;
              readonly customActions?: Map<string, SelectionAction> | undefined;
            }
          | undefined,
        callback: (result: SelectionResult | null) => void,
      ) => void)
    | undefined;
}
/** Move the conversation to one bookmarked block (the Sessions place's Record list, or the model naming its key). */
export function jumpToBookmarkedBlock(ctx: BookmarkCommandContext, getManager: () => Pick<BookmarkManager, 'list'>, key: string): void {
  const entry = getManager().list().find((candidate) => candidate.key === key);
  if (!entry) throw new Error(`No bookmarked block is ${key}; the conversation stays where it is.`);
  if (!ctx.jumpToBookmark) throw new Error('This screen cannot move the conversation; it stays where it is.');
  ctx.jumpToBookmark(entry.key);
  // The label starts with the block's kind as stored (`assistant_turn: `), said again in words after it.
  ctx.print(`The conversation is at the bookmarked block "${entry.label.replace(/^[a-z]+(?:_[a-z]+)+:\s*/, '')}" now.`);
}

/** One command behavior whether a product exposes it directly or hides it behind a modal. */
export function handleBookmarks(ctx: BookmarkCommandContext, getManager: () => Pick<BookmarkManager, 'list' | 'toggle'>): void {
  if (ctx.openBookmarkModal) {
    ctx.openBookmarkModal();
    return;
  }
  const bm = getManager();
  const entries = bm.list();
  if (ctx.openSelection) {
    const deleteAction = new Map([['d', 'delete' as const]]);
    const items: SelectionItem[] =
      entries.length === 0
        ? [{ id: '_empty', label: 'No bookmarks', detail: 'Use Ctrl+B to bookmark' }]
        : entries.map((entry) => ({
            id: entry.key,
            label: entry.label,
            detail: new Date(entry.timestamp).toLocaleTimeString(),
            actions: '[Del] delete',
          }));
    ctx.openSelection('Bookmarks', items, { allowSearch: true, customActions: deleteAction }, (result) => {
      if (!result || result.item.id === '_empty') return;
      if (result.action === 'delete') {
        bm.toggle(result.item.id);
        ctx.print(`Bookmark removed: ${result.item.id}`);
      } else {
        ctx.jumpToBookmark?.(result.item.id);
      }
    });
    return;
  }
  ctx.print(
    [
      'Bookmarks:',
      '',
      ...entries.map((entry) => `  ${entry.key.padEnd(32)} ${entry.label}  (${new Date(entry.timestamp).toLocaleTimeString()})`),
    ].join('\n'),
  );
}
