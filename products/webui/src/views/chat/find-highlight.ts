/**
 * The words the chat's own search matched, marked in the message it jumped to.
 *
 * A long chat mounts only the messages near the screen, so the browser's own find
 * cannot be relied on to keep its highlight when a message mounts in place of its
 * plain text. The chat's search reaches every message (the daemon searches the text),
 * jumps to the one chosen, and marks its matching words here with the CSS Custom
 * Highlight API (`::highlight(gv-chat-find)` in chat-view.css): no element is added
 * to the message. Where a browser lacks the API, the message's own flash is the mark.
 */
const HIGHLIGHT_NAME = 'gv-chat-find';

interface HighlightRegistryLike {
  set(name: string, highlight: unknown): unknown;
  delete(name: string): unknown;
}
type HighlightConstructor = new (...ranges: Range[]) => unknown;

function registry(): { readonly highlights: HighlightRegistryLike; readonly Highlight: HighlightConstructor } | undefined {
  const highlights = typeof CSS === 'undefined' ? undefined : (CSS as unknown as { highlights?: HighlightRegistryLike }).highlights;
  const Highlight = (globalThis as unknown as { Highlight?: HighlightConstructor }).Highlight;
  return highlights && Highlight ? { highlights, Highlight } : undefined;
}

/** Remove the marks of the last search. */
export function clearFindMatches(): void {
  registry()?.highlights.delete(HIGHLIGHT_NAME);
}

/** Mark every place `query` appears (any case) in the text of `root`; earlier marks go. */
export function markFindMatches(root: Element | null | undefined, query: string): void {
  const api = registry();
  if (!api) return;
  api.highlights.delete(HIGHLIGHT_NAME);
  const needle = query.trim().toLowerCase();
  if (!root || needle.length === 0) return;
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.nodeValue ?? '').toLowerCase();
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
    }
  }
  if (ranges.length > 0) api.highlights.set(HIGHLIGHT_NAME, new api.Highlight(...ranges));
}
