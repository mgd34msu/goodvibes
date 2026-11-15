import { expect, test } from 'bun:test';
import type { Cell } from '../platform/src/platform/types/grid.js';
import { SearchManager } from '../terminal-shell/src/transcript-search.js';

const cell = (char: string): Cell => ({ char, fg: '', bg: '', bold: false, dim: false, underline: false, italic: false, strikethrough: false });

test('a match after a wide glyph is placed at its cell column, not its string index', () => {
  // A wide glyph occupies two cells; its second cell carries an empty char.
  const line = [cell('日'), cell(''), cell('a'), cell('b')];
  const manager = new SearchManager();
  manager.search('ab', { getAllLines: () => [line] });
  expect(manager.matches.map((m) => [m.line, m.col])).toEqual([[0, 2]]);
});
