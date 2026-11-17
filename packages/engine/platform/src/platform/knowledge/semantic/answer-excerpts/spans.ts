import { ANSWER_EXCERPT_LIMITS as LIMITS, type AnswerExcerptDocument, type AnswerExcerptSpan } from './types.js';

/**
 * Paragraph-sized spans of the fields, with exact offsets. Blank lines end a
 * paragraph; single newlines keep table rows and label/value lines together.
 * A paragraph longer than `passageChars` is cut at line ends, then at the
 * limit. A span whose text already appeared in an earlier field (the same body
 * stored as `searchText` and as `text`) is kept once.
 */
export function answerExcerptSpans(documents: readonly AnswerExcerptDocument[], maxChars = LIMITS.passageChars): AnswerExcerptSpan[] {
  const seen = new Set<string>();
  const spans: AnswerExcerptSpan[] = [];
  for (const document of documents) {
    const text = document.text;
    const push = (start: number, end: number) => {
      while (start < end && /\s/u.test(text[start]!)) start++;
      while (end > start && /\s/u.test(text[end - 1]!)) end--;
      if (start >= end) return;
      const key = text.slice(start, end).replace(/\s+/g, ' ').toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      spans.push({ field: document.field, kind: document.kind, start, end, text: text.slice(start, end) });
    };
    const block = (start: number, end: number) => {
      if (end - start <= maxChars) { push(start, end); return; }
      let from = start;
      let lineStart = start;
      while (lineStart < end) {
        const newline = text.indexOf('\n', lineStart);
        const lineEnd = newline === -1 || newline >= end ? end : newline + 1;
        if (lineEnd - from > maxChars && lineStart > from) { push(from, lineStart); from = lineStart; }
        if (lineEnd - from > maxChars) {
          // One line longer than the limit.
          for (let cut = from; cut < lineEnd; cut += maxChars) push(cut, Math.min(lineEnd, cut + maxChars));
          from = lineEnd;
        }
        lineStart = lineEnd;
      }
      if (from < end) push(from, end);
    };
    let start = 0;
    for (const boundary of text.matchAll(/\r?\n[ \t]*\r?\n/g)) {
      block(start, boundary.index);
      start = boundary.index + boundary[0].length;
    }
    block(start, text.length);
  }
  return spans;
}
