import { describe, test, expect } from 'bun:test';
import { activeTokens } from '../../renderer/theme.ts';
import { renderCodeBlock } from '../../renderer/code-block.ts';
import { LAYOUT } from '../../renderer/layout.ts';
import { lineToString } from '../setup.ts';

const WIDTH = 80;

const lineText = lineToString;

describe('renderCodeBlock', () => {
  test('returns Line array', () => {
    const result = renderCodeBlock(['const x = 1;'], 'ts', WIDTH);
    expect(result).toEqual(expect.any(Array));
    expect(result.length).toBeGreaterThan(0);
  });

  test('each line has correct width', () => {
    const result = renderCodeBlock(['const x = 1;', 'let y = 2;'], 'ts', WIDTH);
    for (const line of result) {
      expect(line.length).toBe(WIDTH);
    }
  });

  test('no header bar: a padding row opens the fill and the language sits muted at the right of the first code row', () => {
    const result = renderCodeBlock(['code here'], 'ts', WIDTH);
    expect(lineText(result[0]).trim()).toBe('');
    const first = lineText(result[1]);
    expect(first).toContain('code here');
    expect(first.trimEnd().endsWith('ts')).toBe(true);
  });

  test('without a language there is no label at all', () => {
    const result = renderCodeBlock(['line'], '', WIDTH);
    expect(lineText(result[1]).trim()).toBe('1 line');
  });

  test('contains code content in body lines', () => {
    const result = renderCodeBlock(['const x = 1;'], 'ts', WIDTH);
    // Skip header (index 0) and footer (last)
    const bodyLines = result.slice(1, -1);
    const allText = bodyLines.map(lineText).join('\n');
    expect(allText).toContain('x');
  });

  test('includes line numbers in body lines', () => {
    const result = renderCodeBlock(['first', 'second', 'third'], 'ts', WIDTH);
    const bodyLines = result.slice(1, -1);
    // Line numbers should appear as digits
    const firstBody = lineText(bodyLines[0]);
    expect(firstBody).toMatch(/\d/);
  });

  test('has a footer line after code', () => {
    const result = renderCodeBlock(['x'], 'ts', WIDTH);
    // Should be: header + 1 code line + footer = 3 lines minimum
    expect(result.length).toBeGreaterThanOrEqual(3);
    // Footer is last line, its chars should all be spaces
    const footerText = result[result.length - 1].map((c) => c.char).join('');
    expect(footerText.trim()).toBe('');
  });

  test('handles empty code lines array', () => {
    const result = renderCodeBlock([], 'ts', WIDTH);
    // Should at minimum have header and footer
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  test('handles TypeScript language detection', () => {
    const result = renderCodeBlock(['const x = 1;'], 'typescript', WIDTH);
    expect(result.length).toBeGreaterThan(0);
  });

  test('handles python language', () => {
    const result = renderCodeBlock(['def foo():', '  return 42'], 'python', WIDTH);
    const bodyLines = result.slice(1, -1);
    const text = bodyLines.map(lineText).join('\n');
    expect(text).toContain('foo');
  });

  test('handles bash language', () => {
    const result = renderCodeBlock(['echo hello'], 'bash', WIDTH);
    expect(result.length).toBeGreaterThan(0);
  });

  test('handles json language', () => {
    const result = renderCodeBlock(['{"key": "value"}'], 'json', WIDTH);
    expect(result.length).toBeGreaterThan(0);
  });

  test('handles unknown language without crash', () => {
    const result = renderCodeBlock(['some content'], 'cobol', WIDTH);
    expect(result).toEqual(expect.any(Array));
  });

  test('code lines have dark background color', () => {
    const result = renderCodeBlock(['const x = 1;'], 'ts', WIDTH);
    // Body lines (index 1) use the theme's code background
    const bodyLine = result[1];
    const codeCells = bodyLine.filter((c) => c.char !== ' ');
    expect(codeCells.length).toBeGreaterThan(0);
    for (const cell of codeCells) expect(cell.bg).toBe(activeTokens().backgroundCode);
  });

  test('body rows keep the shared right margin unpainted', () => {
    const result = renderCodeBlock(['const x = 1;'], 'ts', WIDTH);
    const bodyLine = result[1];
    const contentEnd = WIDTH - LAYOUT.RIGHT_MARGIN;

    for (let x = contentEnd; x < WIDTH; x++) {
      expect(bodyLine[x]?.bg).toBe('');
    }
  });

  test('the first row is a padding row on the code background, with no header bar', () => {
    const result = renderCodeBlock(['x'], 'ts', WIDTH);
    expect(result[0].every((c) => c.char === ' ')).toBe(true);
    const painted = result[0].filter((c) => c.bg !== '');
    expect(painted.length).toBeGreaterThan(0);
    for (const c of painted) expect(c.bg).toBe(activeTokens().backgroundCode);
  });

  test('a line wider than the fill wraps with its indentation kept; no character is cut at the edge', () => {
    // The live run's reviewer JSON: a long string value at 6 columns of indent.
    const long = '      "evidence": "The engineer reports zero files created, modified, or deleted and explicitly says, \\"I did not modify any files\\" in its report."';
    const width = 100;
    const rows = renderCodeBlock(['{', long, '}'], 'json', width, { showLineNumbers: false }).map((l) => lineText(l).replace(/\s+$/, ''));
    const wrapped = rows.slice(2, -2);
    expect(wrapped.length).toBeGreaterThan(1);
    // Text stays 2 columns inside the fill's right edge (the fill ends at width - RIGHT_MARGIN).
    const textEnd = width - LAYOUT.RIGHT_MARGIN - 2;
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(textEnd);
    // Every word of the line is drawn, in order.
    expect(wrapped.map((r) => r.trim()).join(' ')).toBe(long.trim());
    // Continuation rows keep the indent: they start where the line's text starts.
    const start = wrapped[0]!.indexOf('"evidence"');
    for (const r of wrapped.slice(1)) expect(r.search(/\S/)).toBe(start);
  });
});
