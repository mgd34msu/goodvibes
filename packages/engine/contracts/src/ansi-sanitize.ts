/**
 * ANSI sanitizer for untrusted content entering a terminal renderer: the one
 * sanitiser, used by both terminal apps and the web UI. Browser-safe (no node
 * imports).
 *
 * A cell-grid renderer that emits content character by character tends to drop
 * escape bytes anyway, because a zero-width character claims no cell. That is
 * incidental, a property of how one renderer happens to measure, not a
 * guarantee any caller can rely on. This module is the explicit contract:
 * content that has been through `stripDangerousAnsi` cannot move the cursor,
 * switch to the alternate screen, retitle the window, or ring the bell,
 * whatever the renderer downstream does with it.
 *
 * Strategy:
 * - STRIP all non-SGR escape sequences (cursor moves, OSC, BEL, alt-screen,
 *   DECSET/private mode, and any other CSI/ESC sequences).
 * - PRESERVE SGR color/style codes (\x1b[<params>m), colorized output is a
 *   legitimate, non-navigating use of the escape channel.
 * - STRIP bare BEL (\x07) characters and the 8-bit C1 controls (U+0080-U+009F).
 * - DROP SGR conceal (parameter 8), which hides text from the reader.
 *
 * Safe SGR pattern: \x1b[ followed by digits/semicolons, ending in 'm'.
 * Everything else that starts with \x1b is dangerous and stripped.
 */

// Matches safe SGR sequences: ESC [ <digits/semicolons> m
const SGR_PATTERN = /\x1b\[([0-9;]*)m/g;

// Matches ALL CSI sequences: ESC [ ... <final byte 0x40-0x7E>
const CSI_SEQUENCE = /\x1b\[[\x20-\x3f]*[\x40-\x7e]/g;

// Matches OSC sequences: ESC ] ... (ESC \ or BEL)
const OSC_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// Matches other ESC sequences (ESC + single character that is not '[' or ']')
const ESC_OTHER = /\x1b[^\[\]]/g;

// 8-bit C1 forms of CSI and OSC. Terminals that honour C1 controls treat these as the escape sequences above.
const C1_CSI_SEQUENCE = /\x9b[\x20-\x3f]*[\x40-\x7e]/g;
const C1_OSC_SEQUENCE = /\x9d[^\x07\x9c\x1b]*(?:\x07|\x9c|\x1b\\)/g;
const C1_CONTROL = /[\x80-\x9f]/g;

/** SGR parameter 8 hides text from the reader; colour arguments (38/48/58 ; 5 ; n or ; 2 ; r ; g ; b) may legitimately contain an 8. */
function sgrConceals(params: string): boolean {
  const parts = params.split(';');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const code = part === undefined || part === '' ? 0 : Number(part);
    if (code === 38 || code === 48 || code === 58) {
      const mode = parts[i + 1] === undefined || parts[i + 1] === '' ? 0 : Number(parts[i + 1]);
      i += mode === 5 ? 2 : mode === 2 ? 4 : 0;
      continue;
    }
    // Leading zeros are the same parameter: ESC[08m conceals just like ESC[8m.
    if (code === 8) return true;
  }
  return false;
}

// Matches standalone BEL
const BEL = /\x07/g;

/** A terminal hyperlink is metadata: reject controls instead of stripping them into a different target. */
export function safeTerminalLink(value: string | undefined): string | undefined {
  if (!value || /[\x00-\x20\x7f-\x9f]/.test(value)) return undefined;
  const target = value.startsWith('/') && !value.startsWith('//') ? `file://${value}` : value;
  try {
    const url = new URL(target);
    if (!['http:', 'https:', 'file:', 'mailto:'].includes(url.protocol)) return undefined;
    return target;
  } catch { return undefined; }
}

/**
 * Strip dangerous ANSI escape sequences from untrusted content.
 *
 * Preserves SGR color codes (\x1b[<n>m). Removes:
 * - Cursor movement CSI sequences (\x1b[<n>A/B/C/D, \x1b[H, etc.)
 * - OSC sequences (\x1b]...\x07 or \x1b]...\x1b\\)
 * - Alt-screen and DECSET private mode (\x1b[?...h/l)
 * - Any other CSI or ESC sequences
 * - Bare BEL (\x07)
 *
 * @param input - Raw string that may contain ANSI escape sequences
 * @returns Sanitized string safe for grid rendering
 */
export function stripDangerousAnsi(input: string): string {
  // Extract and preserve SGR sequences by replacing them with placeholders,
  // then strip all other escape sequences, then restore SGR sequences.
  // This approach avoids complex negative lookahead regexes.

  // Collect SGR sequences and replace with unique markers
  const sgrTokens: string[] = [];
  const withPlaceholders = input.replace(C1_CSI_SEQUENCE, '').replace(C1_OSC_SEQUENCE, '').replace(C1_CONTROL, '').replace(SGR_PATTERN, (match, params: string) => {
    if (sgrConceals(params)) return '';
    const idx = sgrTokens.length;
    sgrTokens.push(match);
    return `\x00SGR${idx}\x00`;
  });

  // Strip all remaining dangerous sequences
  let sanitized = withPlaceholders
    .replace(CSI_SEQUENCE, '')   // removes cursor moves, alt-screen, DECSET, etc.
    .replace(OSC_SEQUENCE, '')   // removes OSC
    .replace(ESC_OTHER, '')      // removes remaining ESC+char sequences
    .replace(/\x1b/g, '')        // removes any leftover bare ESC
    .replace(BEL, '');           // removes BEL

  // Restore SGR sequences from placeholders
  sanitized = sanitized.replace(/\x00SGR(\d+)\x00/g, (_match, idxStr) => {
    const idx = parseInt(idxStr, 10);
    return sgrTokens[idx] ?? '';
  });

  return sanitized;
}
