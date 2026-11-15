/**
 * Markdown render dedupe, renderMarkdownTracked is the sole implementation.
 *
 * Verifies that renderMarkdown is now a thin wrapper over renderMarkdownTracked
 * and that their outputs are identical for the same input.
 */
import { describe, it, expect, spyOn } from 'bun:test';
import * as markdownModule from '../../renderer/markdown.ts';

const WIDTH = 80;

describe('markdown dedupe', () => {
  it('renderMarkdown output matches renderMarkdownTracked.lines', () => {
    const text = '# Hello\n\nSome **bold** text and `inline code`.\n\n- item one\n- item two';
    const direct = markdownModule.renderMarkdown(text, WIDTH);
    const { lines } = markdownModule.renderMarkdownTracked(text, WIDTH);
    // Every cell, including its colour and attributes, is the same.
    expect(direct).toEqual(lines);
    expect(direct.length).toBeGreaterThan(3);
  });

  it('renderMarkdown delegates to renderMarkdownTracked (single parse)', () => {
    const text = 'plain paragraph';
    const spy = spyOn(markdownModule, 'renderMarkdownTracked');
    markdownModule.renderMarkdown(text, WIDTH);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('renderMarkdownTracked returns both lines and codeBlocks', () => {
    const md = 'before\n\n```ts\nconst x = 1;\n```\n\nafter';
    const result = markdownModule.renderMarkdownTracked(md, WIDTH);
    expect(result.lines.length).toBeGreaterThan(0);
    expect(result.codeBlocks.length).toBe(1);
    expect(result.codeBlocks[0].rawContent).toBe('const x = 1;');
  });

  it('renderMarkdown symbol is still exported and callable', () => {
    expect(typeof markdownModule.renderMarkdown).toBe('function');
    const result = markdownModule.renderMarkdown('test', WIDTH);
    expect(result).toEqual(expect.any(Array));
  });
});
