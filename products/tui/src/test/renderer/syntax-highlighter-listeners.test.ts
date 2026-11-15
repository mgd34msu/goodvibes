import { describe, expect, test } from 'bun:test';
import { SyntaxHighlighter } from '../../renderer/syntax-highlighter.ts';

describe('syntax highlighter ready listeners', () => {
  test('a listener that throws neither rejects the parse nor starves the next listener', async () => {
    const highlighter = new SyntaxHighlighter();
    let later = 0;
    highlighter.onReady(() => { throw new Error('listener failed'); });
    highlighter.onReady(() => { later++; });
    highlighter.highlight(`export const answer: number = ${Math.random()};`, 'ts');
    await highlighter.settle();
    expect(later).toBe(1);
    expect(highlighter.cacheSize).toBe(1);
  });
});
