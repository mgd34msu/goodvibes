/**
 * theme-call-sites.test.ts: an end-to-end flip proof. renderMarkdown swaps its
 * heading/inline-code/link colours from the dark to the light tokens of the
 * active theme when the active mode flips.
 *
 * The source-wide guard (no raw colour anywhere outside the theme layer and
 * the protected splash) lives in theme.test.ts.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { renderMarkdown } from '../../renderer/markdown.ts';
import { resolveTheme, setActiveThemeMode } from '../../renderer/theme.ts';
import type { Line } from '@goodvibes-jev/engine/platform/platform/types';

afterEach(() => setActiveThemeMode('dark'));

// ---------------------------------------------------------------------------
// End-to-end transcript flip.
// ---------------------------------------------------------------------------

function fgSet(lines: Line[]): Set<string> {
  const out = new Set<string>();
  for (const line of lines) for (const cell of line) if (cell.fg) out.add(cell.fg);
  return out;
}

describe('markdown transcript renders in the active mode', () => {
  const MD = '# Heading One\n\nA `code` span and a [link](https://example.com).';

  test('dark uses the dark heading token', () => {
    const fgs = fgSet(renderMarkdown(MD, 80));
    expect(fgs.has(resolveTheme('dark').heading1)).toBe(true);
    expect(fgs.has(resolveTheme('light').heading1)).toBe(false); // no light heading leaks
  });

  test('light swaps heading/inline-code/link to the light tokens', () => {
    const dark = resolveTheme('dark');
    setActiveThemeMode('light');
    const light = resolveTheme('light');
    const fgs = fgSet(renderMarkdown(MD, 80));
    expect(fgs.has(light.heading1)).toBe(true);
    expect(fgs.has(dark.heading1)).toBe(false);      // dark heading gone
    expect(fgs.has(light.inlineCodeFg)).toBe(true);
    expect(fgs.has(light.link)).toBe(true);
  });
});
