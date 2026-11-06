import type { BookmarkManager } from '@goodvibes-jev/engine/sdk/platform/bookmarks';
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
            actions: '[d] delete',
          }));
    ctx.openSelection('Bookmarks', items, { allowSearch: true, customActions: deleteAction }, (result) => {
      if (!result) return;
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
