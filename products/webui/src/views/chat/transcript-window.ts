/**
 * Which messages of a long chat are mounted: the ones near what is on screen.
 *
 * Every message keeps a row in the transcript, so the scroll height, the
 * scrollbar and the order are the whole chat's. A row near the viewport (within
 * {@link NEAR_MARGIN_PX} above or below, watched with an IntersectionObserver on
 * the scroller) holds the message itself; a row further away holds its plain
 * text at the height it was last drawn (or an estimate before it ever was), so
 * the browser's find-in-page and a selection still reach its words. The newest
 * few rows are always mounted (a reply arriving, the newest failure row).
 *
 * Kept as it was:
 * - position: when rows above what is on screen change (a message mounts in
 *   place of its plain text, or the other way), the first row on screen keeps
 *   its place (scrollTop is corrected by what it moved), and a view at the
 *   bottom stays at the bottom;
 * - jump-to-message: the target is mounted first, then scrolled to, and it keeps
 *   its place while the rows around it mount, until the person scrolls;
 * - a selection: while text in the transcript is selected nothing is unmounted,
 *   so a selection dragged across many messages keeps both of its ends;
 * - focus: a row holding the focus (an edit being typed) is never unmounted.
 *
 * Cost: one IntersectionObserver and one ResizeObserver per chat; no request.
 */

/** How far beyond the visible part of the transcript a message is mounted, above and below. */
export const NEAR_MARGIN_PX = 1600;
/** The newest rows, always mounted. */
export const ALWAYS_MOUNTED_TAIL = 3;
/** Rows mounted on first draw, before the observer has reported (the chat opens at its end). */
export const FIRST_DRAW_TAIL = 30;

/**
 * The browser keeps what is on screen still when content above it changes size (CSS scroll
 * anchoring: Chrome, Edge, Firefox). Where it does not, the transcript does it by hand.
 */
export const NATIVE_SCROLL_ANCHORING: boolean = typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
  && CSS.supports('overflow-anchor', 'auto');

/** Where a row starts on screen, relative to the scroller's top edge. */
export interface RowAnchor {
  readonly key: string;
  readonly top: number;
}

/** The row element of `key` under `container` (compared as an attribute value, so any id is safe). */
export function rowElement(container: Element | null | undefined, key: string): HTMLElement | undefined {
  if (!container) return undefined;
  for (const element of container.querySelectorAll<HTMLElement>('[data-row-key]')) {
    if (element.dataset.rowKey === key) return element;
  }
  return undefined;
}

/** The first row whose bottom is below the scroller's top edge: what the person is looking at first. */
export function firstVisibleRow(container: HTMLElement): RowAnchor | null {
  const rows = container.querySelectorAll<HTMLElement>('[data-row-key]');
  if (rows.length === 0) return null;
  const edge = container.getBoundingClientRect().top;
  let low = 0;
  let high = rows.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (rows[middle]!.getBoundingClientRect().bottom > edge) high = middle;
    else low = middle + 1;
  }
  const row = rows[low]!;
  return { key: row.dataset.rowKey ?? '', top: row.getBoundingClientRect().top - edge };
}

/**
 * An unmounted message's height before it has ever been drawn: its text's lines at the
 * column's width, the bubble's padding for a person's message, and the actions row.
 */
export function estimatedRowHeight(text: string, tone: string, columnWidth: number): number {
  const user = tone === 'user';
  const usable = Math.max(200, user ? columnWidth * 0.8 - 30 : columnWidth - 40);
  const charsPerLine = Math.max(20, Math.floor(usable / 8.4));
  let lines = 0;
  for (const paragraph of text.split('\n')) lines += Math.max(1, Math.ceil(paragraph.length / charsPerLine));
  return Math.round(lines * (user ? 26 : 28) + (user ? 18 : 0) + 30);
}
