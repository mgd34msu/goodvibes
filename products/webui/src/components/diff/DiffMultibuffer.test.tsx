/**
 * The hunk review key is stored by SessionChanges, so its value is a contract:
 * file path, a NUL separator, the hunk header. The source stays plain text.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DiffHunk } from '../../lib/unified-diff';
import { hunkReviewKey } from './DiffMultibuffer';

test('hunkReviewKey joins the file path and the hunk header with a NUL', () => {
  expect(hunkReviewKey('a', { header: 'b' } as DiffHunk)).toBe('a\0b');
});

test('the source file contains no literal NUL byte', () => {
  const bytes = readFileSync(fileURLToPath(new URL('./DiffMultibuffer.tsx', import.meta.url)));
  expect(bytes.includes(0)).toBe(false);
});
