import { describe, expect, test } from 'bun:test';
import { createBottomBarLine, writeBottomBarText } from '@goodvibes-jev/engine/terminal-shell';

const style = { fg: '#000000', bg: '#00ffcc' };
const chars = (line: ReturnType<typeof createBottomBarLine>, from: number, to: number): string[] =>
  line.slice(from, to).map((cell) => cell.char);

// Pre-filled cells are the same blank as a continuation cell, so every cell
// is first set to a sentinel to prove what the writer itself wrote.
const sentinelLine = (width: number) => {
  const line = createBottomBarLine(width, style);
  for (let i = 0; i < line.length; i++) line[i] = { ...line[i]!, char: 'x' };
  return line;
};

describe('bottom bar renderer', () => {
  test('a wide glyph takes its cell plus a blank continuation cell, and the next glyph follows after both', () => {
    const line = sentinelLine(10);
    writeBottomBarText(line, 0, 10, '界a', style);
    expect(chars(line, 0, 4)).toEqual(['界', ' ', 'a', 'x']);
  });

  test('text that does not fit in maxWidth is cut before the glyph that would overflow, never written past it', () => {
    const line = createBottomBarLine(10, style);
    // maxWidth 3: the first wide glyph (2) fits, the second (2) would make 4.
    writeBottomBarText(line, 0, 3, '界界x', style);
    expect(chars(line, 0, 5)).toEqual(['界', ' ', ' ', ' ', ' ']);
  });

  test('writing stops at the end of the line and the line keeps its width', () => {
    const line = createBottomBarLine(4, style);
    writeBottomBarText(line, 3, 10, '界x', style);
    expect(line).toHaveLength(4);
    // The wide glyph starts in the last cell and has no continuation cell to claim.
    expect(chars(line, 3, 4)).toEqual(['界']);
  });

  test('zero-width characters occupy no column', () => {
    const line = createBottomBarLine(6, style);
    writeBottomBarText(line, 0, 6, 'a\u0301b', style);
    expect(chars(line, 0, 3)).toEqual(['a', 'b', ' ']);
  });
});
