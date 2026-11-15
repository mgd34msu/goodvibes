/**
 * markup.ts, the one reader of "what is markup" for a fetched page.
 *
 * A fetched body is remote and untrusted, and the old readers were
 * backtracking regular expressions (`<script[\s\S]*?<\/script>`, a tag pattern
 * whose attribute group also matched `<`): a page with many `<` and no later
 * `>`, or many `<script` with no closer, cost a scan to the end of the page per
 * opener, so one fetch could hold the process for minutes. This scanner walks
 * the page once:
 *   - the next `<` is found with `indexOf`;
 *   - a tag ends at the first `>` outside quotes; a `<` outside quotes first
 *     means the opener was text, and the scan resumes at that `<`;
 *   - when a tag scan reaches the end of the page, no later `<` can end a tag,
 *     so the rest is text;
 *   - the content of a raw-text element (`script`, `style`, `title`,
 *     `textarea`) and of a skipped element runs to its closing tag, found by
 *     one forward search; when an element has no closer, later openers of it
 *     are read as ordinary tags, so no opener searches twice.
 * Every character is visited a bounded number of times, so the cost follows
 * the page size.
 */

/** Elements whose content is text, never tags (HTML raw text and escapable raw text elements). */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(['script', 'style', 'title', 'textarea']);

/** One piece of a scanned page, by position in the page. */
export type MarkupToken =
  | { readonly kind: 'text'; readonly start: number; readonly end: number }
  | {
    readonly kind: 'tag';
    readonly name: string;
    readonly closing: boolean;
    readonly selfClosing: boolean;
    /** The text between the tag name and the closing `>`. */
    readonly attributes: string;
    readonly start: number;
    readonly end: number;
  }
  /** A raw-text or skipped element, whole: opener, content and closer. */
  | { readonly kind: 'element'; readonly name: string; readonly start: number; readonly contentStart: number; readonly contentEnd: number; readonly end: number }
  /** A comment, a doctype or a processing instruction. */
  | { readonly kind: 'comment'; readonly start: number; readonly end: number };

export interface MarkupScanOptions {
  /** Elements whose whole content is passed over as one `element` token (besides the raw-text ones). */
  readonly skip?: ReadonlySet<string> | undefined;
}

const isNameStart = (code: number): boolean => (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a);
const isNameChar = (code: number): boolean => isNameStart(code) || (code >= 0x30 && code <= 0x39) || code === 0x2d || code === 0x3a;

const closerPatterns = new Map<string, RegExp>();

/** The position of `</name` (followed by space, `/` or `>`) at or after `from`, or -1. */
function findCloser(html: string, name: string, from: number): number {
  let pattern = closerPatterns.get(name);
  if (!pattern) {
    pattern = new RegExp(`</${name}[\\s/>]`, 'gi');
    closerPatterns.set(name, pattern);
  }
  pattern.lastIndex = from;
  const match = pattern.exec(html);
  return match ? match.index : -1;
}

/** Scans `html` once, in document order. */
export function* scanMarkup(html: string, options: MarkupScanOptions = {}): Generator<MarkupToken> {
  const length = html.length;
  const unclosed = new Set<string>();
  let position = 0;
  let textStart = 0;
  /** From here on no tag can end: a tag scan reached the end of the page. */
  let deadFrom = length;
  const lastDoubleQuote = html.lastIndexOf('"');
  const lastSingleQuote = html.lastIndexOf("'");

  const flushText = function* (upTo: number): Generator<MarkupToken> {
    if (upTo > textStart) yield { kind: 'text', start: textStart, end: upTo };
  };

  while (position < length) {
    const open = html.indexOf('<', position);
    if (open < 0 || open >= deadFrom) break;
    const next = html.charCodeAt(open + 1);

    // Comments, doctypes and processing instructions.
    if (next === 0x21 /* ! */ || next === 0x3f /* ? */) {
      if (html.startsWith('<!--', open)) {
        const close = html.indexOf('-->', open + 4);
        yield* flushText(open);
        // An unterminated comment runs to the end of the page, as a browser reads it.
        const end = close < 0 ? length : close + 3;
        yield { kind: 'comment', start: open, end };
        position = textStart = end;
        continue;
      }
      const close = html.indexOf('>', open + 2);
      if (close < 0) { deadFrom = open; break; }
      yield* flushText(open);
      yield { kind: 'comment', start: open, end: close + 1 };
      position = textStart = close + 1;
      continue;
    }

    const closing = next === 0x2f /* / */;
    let cursor = closing ? open + 2 : open + 1;
    if (!isNameStart(html.charCodeAt(cursor))) {
      position = open + 1;
      continue;
    }
    const nameStart = cursor;
    while (cursor < length && isNameChar(html.charCodeAt(cursor))) cursor++;
    const name = html.slice(nameStart, cursor).toLowerCase();
    const attributesStart = cursor;

    // The tag ends at the first `>` outside quotes; a `<` outside quotes first makes the opener text.
    let tagEnd = -1;
    let abandoned = false;
    while (cursor < length) {
      const code = html.charCodeAt(cursor);
      if (code === 0x3e /* > */) { tagEnd = cursor; break; }
      if (code === 0x3c /* < */) { abandoned = true; break; }
      if (code === 0x22 || code === 0x27) {
        // A quote with no partner later in the page is an ordinary character.
        const last = code === 0x22 ? lastDoubleQuote : lastSingleQuote;
        const quoteEnd = cursor < last ? html.indexOf(code === 0x22 ? '"' : "'", cursor + 1) : -1;
        cursor = quoteEnd < 0 ? cursor + 1 : quoteEnd + 1;
        continue;
      }
      cursor++;
    }
    if (abandoned) { position = cursor; continue; }
    if (tagEnd < 0) { deadFrom = open; break; }

    const rawAttributes = html.slice(attributesStart, tagEnd);
    const selfClosing = rawAttributes.trimEnd().endsWith('/');
    yield* flushText(open);

    const contentElement = !closing && !selfClosing && !unclosed.has(name)
      && (RAW_TEXT_ELEMENTS.has(name) || options.skip?.has(name) === true);
    if (contentElement) {
      const closer = findCloser(html, name, tagEnd + 1);
      if (closer >= 0) {
        const closerEnd = html.indexOf('>', closer);
        const end = closerEnd < 0 ? length : closerEnd + 1;
        yield { kind: 'element', name, start: open, contentStart: tagEnd + 1, contentEnd: closer, end };
        position = textStart = end;
        continue;
      }
      // No closer anywhere after this opener, so none after a later one either.
      unclosed.add(name);
    }
    yield {
      kind: 'tag', name, closing, selfClosing,
      attributes: selfClosing ? rawAttributes.trimEnd().slice(0, -1) : rawAttributes,
      start: open, end: tagEnd + 1,
    };
    position = textStart = tagEnd + 1;
  }
  yield* flushText(length);
}

/** Every attribute of a tag, names lower-cased; a repeated name keeps its first value. */
export function tagAttributes(attributes: string): Map<string, string> {
  const result = new Map<string, string>();
  const length = attributes.length;
  let cursor = 0;
  while (cursor < length) {
    while (cursor < length && /[\s/]/.test(attributes[cursor]!)) cursor++;
    const nameStart = cursor;
    while (cursor < length && !/[\s/=>]/.test(attributes[cursor]!)) cursor++;
    if (cursor === nameStart) { cursor++; continue; }
    const name = attributes.slice(nameStart, cursor).toLowerCase();
    while (cursor < length && /\s/.test(attributes[cursor]!)) cursor++;
    let value = '';
    if (attributes[cursor] === '=') {
      cursor++;
      while (cursor < length && /\s/.test(attributes[cursor]!)) cursor++;
      const quote = attributes[cursor];
      if (quote === '"' || quote === "'") {
        const end = attributes.indexOf(quote, cursor + 1);
        value = attributes.slice(cursor + 1, end < 0 ? length : end);
        cursor = end < 0 ? length : end + 1;
      } else {
        const valueStart = cursor;
        while (cursor < length && !/\s/.test(attributes[cursor]!)) cursor++;
        value = attributes.slice(valueStart, cursor);
      }
    }
    if (!result.has(name)) result.set(name, value);
  }
  return result;
}

/**
 * The page with the named elements removed whole (opener, content, closer)
 * and everything else kept as written. Used by the sanitizer to drop script
 * and style without touching the rest.
 */
export function removeElements(html: string, names: ReadonlySet<string>): string {
  if (html.indexOf('<') < 0) return html;
  const skip = new Set([...names].filter((name) => !RAW_TEXT_ELEMENTS.has(name)));
  const parts: string[] = [];
  let kept = 0;
  for (const token of scanMarkup(html, { skip })) {
    if (token.kind === 'element' && names.has(token.name)) {
      parts.push(html.slice(kept, token.start));
      kept = token.end;
    }
  }
  if (kept === 0) return html;
  parts.push(html.slice(kept));
  return parts.join('');
}

/**
 * The page's text with every tag replaced by `separator`, comments dropped,
 * and the content of `script`, `style` and any `skip` element dropped. The
 * text of `title` and `textarea` is kept as text. Character references are
 * left as written.
 */
export function markupText(html: string, separator: string, skip?: ReadonlySet<string>): string {
  if (html.indexOf('<') < 0) return html;
  const parts: string[] = [];
  for (const token of scanMarkup(html, { skip })) {
    if (token.kind === 'text') parts.push(html.slice(token.start, token.end));
    else if (token.kind === 'tag') parts.push(separator);
    else if (token.kind === 'element' && (token.name === 'title' || token.name === 'textarea')) {
      parts.push(separator, html.slice(token.contentStart, token.contentEnd), separator);
    }
  }
  return parts.join('');
}
