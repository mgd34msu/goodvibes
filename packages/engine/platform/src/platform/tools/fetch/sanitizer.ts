/**
 * Fetch response sanitizer.
 *
 * Three modes applied to the content a fetch returns. Every result names the
 * mode applied (`sanitization_tier`) and counts what each step removed, so a
 * caller can tell removed text from an empty page.
 *
 * Modes:
 *   - `none`     , No sanitization. Content is returned as-is. Use only for
 *                   trusted internal hosts.
 *   - `safe-text`, Default. Removes control characters and invisible Unicode
 *                   (tag characters, zero-width and bidi marks); when the
 *                   content is still markup it also drops script and style
 *                   elements. Attributes (event handlers included) are left
 *                   as written, and an opener with no closer stays as text.
 *   - `strict`   , Keeps only printable ASCII, tab and line breaks; when the
 *                   content is still markup it also removes every tag, script,
 *                   style and comment. Text in any other script (accented
 *                   letters, Cyrillic, CJK) is removed and counted.
 *
 * Markup handling runs only on content that is still markup (a raw HTML or
 * XML body). Text an extract mode produced is never scanned for tags, so
 * `a < b && c > d` in a code sample or formula is left intact.
 */

import { markupText, removeElements } from './markup.js';

/** Elements both sanitizing modes drop whole, content included. */
const SCRIPT_AND_STYLE: ReadonlySet<string> = new Set(['script', 'style']);

/**
 * Above this share of the text removed, the result carries a note saying how
 * much went and why, so a mangled page is not read as the page.
 */
const NOTABLE_REMOVED_SHARE = 0.1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Sanitization mode applied to an HTTP response body.
 *
 * - `none`     , No sanitization; content returned verbatim.
 * - `safe-text`, Removes control characters and invisible Unicode; drops
 *                script/style elements from markup.
 * - `strict`   , Keeps printable ASCII only; removes all markup from markup.
 */
export type SanitizeMode = 'none' | 'safe-text' | 'strict';

/** Characters each sanitizing step removed, counted from the replacements made. */
export interface SanitizeRemoved {
  /** Characters of tags, script/style elements and comments (markup content only). */
  markup_chars: number;
  /** C0/C1 control characters and DEL. */
  control_chars: number;
  /** Invisible Unicode: tag characters, zero-width and bidi marks, BOM (`safe-text`). */
  invisible_chars: number;
  /** Characters outside printable ASCII that were not control characters (`strict`). */
  non_ascii_chars: number;
}

/**
 * Result of applying a sanitizer to response content.
 */
export interface SanitizeResult {
  /** Sanitized content string. */
  content: string;
  /** The sanitization mode that was applied. */
  mode: SanitizeMode;
  /** Whether the content was modified by sanitization. */
  modified: boolean;
  /** What was removed, by kind. All zero when nothing was. */
  removed: SanitizeRemoved;
  /** Set when more than a tenth of the text (markup aside) was removed: how much, why, and how to keep it. */
  note?: string;
}

/** What the caller knows about the content being sanitized. */
export interface SanitizeOptions {
  /**
   * The content is still markup (a raw HTML or XML body), so tags and
   * script/style elements are handled. False for text an extract mode
   * produced. Defaults to true.
   */
  markup?: boolean;
}

// ---------------------------------------------------------------------------
// Sanitizer implementations
// ---------------------------------------------------------------------------

function noneRemoved(): SanitizeRemoved {
  return { markup_chars: 0, control_chars: 0, invisible_chars: 0, non_ascii_chars: 0 };
}

/** Replace every match with nothing and return the text and the characters removed. */
function strip(text: string, pattern: RegExp): { text: string; count: number } {
  let count = 0;
  const out = text.replace(pattern, (match) => {
    count += match.length;
    return '';
  });
  return { text: out, count };
}

// C0 controls except tab, LF and CR, plus DEL and C1 controls.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]+/g;
// Invisible characters that carry text the reader cannot see: tag characters,
// zero-width space/non-joiner, bidi marks and overrides, word joiner, BOM.
const INVISIBLE_CHARS = /[\u{E0000}-\u{E007F}​‌‎‏‪-‮⁠-⁤⁦-⁩﻿]+/gu;
// Anything outside printable ASCII, tab, LF and CR. Run after CONTROL_CHARS,
// so what it removes is counted as non-ASCII text.
// eslint-disable-next-line no-control-regex
const NOT_PRINTABLE_ASCII = /[^\x09\x0A\x0D\x20-\x7E]+/g;

function sanitizeNone(content: string): SanitizeResult {
  return { content, mode: 'none', modified: false, removed: noneRemoved() };
}

function sanitizeSafeText(content: string, markup: boolean): SanitizeResult {
  const removed = noneRemoved();
  let text = content;
  if (markup) {
    // The one linear markup scanner (markup.ts): a page of unclosed openers cannot stall the call.
    const withoutScripts = removeElements(text, SCRIPT_AND_STYLE);
    removed.markup_chars = text.length - withoutScripts.length;
    text = withoutScripts;
  }
  const control = strip(text, CONTROL_CHARS);
  removed.control_chars = control.count;
  const invisible = strip(control.text, INVISIBLE_CHARS);
  removed.invisible_chars = invisible.count;
  return finish(content, invisible.text, 'safe-text', removed);
}

function sanitizeStrict(content: string, markup: boolean): SanitizeResult {
  const removed = noneRemoved();
  let text = content;
  if (markup) {
    // Script and style content, comments and every tag go in one linear pass (markup.ts).
    // Each tag becomes one space, so the count is net of those separators.
    const withoutMarkup = markupText(text, ' ');
    removed.markup_chars = Math.max(0, text.length - withoutMarkup.length);
    text = withoutMarkup;
  }
  const control = strip(text, CONTROL_CHARS);
  removed.control_chars = control.count;
  const nonAscii = strip(control.text, NOT_PRINTABLE_ASCII);
  removed.non_ascii_chars = nonAscii.count;
  const sanitized = nonAscii.text.replace(/ {2,}/g, ' ').trim();
  return finish(content, sanitized, 'strict', removed);
}

function finish(original: string, content: string, mode: SanitizeMode, removed: SanitizeRemoved): SanitizeResult {
  const result: SanitizeResult = { content, mode, modified: content !== original, removed };
  // Dropping markup is what the mode is for; the note is about text the reader loses.
  const text = original.length - removed.markup_chars;
  const lost = removed.control_chars + removed.invisible_chars + removed.non_ascii_chars;
  if (text > 0 && lost / text > NOTABLE_REMOVED_SHARE) {
    result.note = removalNote(mode, lost, text, removed);
  }
  return result;
}

function removalNote(mode: SanitizeMode, lost: number, length: number, removed: SanitizeRemoved): string {
  const share = Math.round((lost / length) * 100);
  const parts: string[] = [];
  if (removed.non_ascii_chars > 0) parts.push(`${removed.non_ascii_chars} non-ASCII`);
  if (removed.control_chars > 0) parts.push(`${removed.control_chars} control`);
  if (removed.invisible_chars > 0) parts.push(`${removed.invisible_chars} invisible`);
  const head = `sanitize_mode ${mode} removed ${lost} of ${length} text characters (${share}%): ${parts.join(', ')}.`;
  if (removed.non_ascii_chars > 0) {
    return `${head} Strict keeps printable ASCII only, so text in other scripts or with accents is gone; fetch again with sanitize_mode "safe-text" to keep it.`;
  }
  return head;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply the specified sanitization mode to response content.
 *
 * Deterministic: the same content, mode and options always give the same
 * result. Counts come from the replacements made; there is no second pass.
 *
 * @param content - Response content (the raw body, or the extracted text).
 * @param mode    - Sanitization mode to apply.
 * @param options - Whether the content is still markup.
 */
export function applySanitizer(content: string, mode: SanitizeMode, options: SanitizeOptions = {}): SanitizeResult {
  const markup = options.markup ?? true;
  switch (mode) {
    case 'none':
      return sanitizeNone(content);
    case 'safe-text':
      return sanitizeSafeText(content, markup);
    case 'strict':
      return sanitizeStrict(content, markup);
    default: {
      // Exhaustiveness guard, TypeScript ensures this is unreachable
      const _exhaustive: never = mode;
      return sanitizeSafeText(content as string, markup);
    }
  }
}

/**
 * Resolve the effective sanitize mode: `'safe-text'` when none was requested.
 *
 * @param requested - Caller-supplied mode (may be undefined).
 * @returns         Effective `SanitizeMode` to apply.
 */
export function resolveSanitizeMode(requested: SanitizeMode | undefined): SanitizeMode {
  return requested ?? 'safe-text';
}
