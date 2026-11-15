import { describe, expect, test } from 'bun:test';
import { InputTokenizer } from '../platform/src/platform/core/tokenizer.ts';

describe('bracketed paste split across reads', () => {
  test('an end marker split between two reads still ends the paste', () => {
    const tokenizer = new InputTokenizer();
    expect(tokenizer.feed('\x1b[200~ab\x1b[20')).toEqual([]);
    expect(tokenizer.feed('1~')).toEqual([{ type: 'text', value: 'ab' }]);
    expect(tokenizer.feed('x')).toEqual([{ type: 'text', value: 'x' }]);
  });

  test('an end marker split one byte at a time keeps the paste text intact', () => {
    const tokenizer = new InputTokenizer();
    expect(tokenizer.feed('\x1b[200~')).toEqual([]);
    const tokens = [...'a\x1b[b\x1b[201~'].flatMap((ch) => tokenizer.feed(ch));
    expect(tokens).toEqual([{ type: 'text', value: 'a\x1b[b' }]);
  });

  test('a paste larger than the limit is dropped whole and later input works', () => {
    const tokenizer = new InputTokenizer();
    const huge = 'a'.repeat(9 * 1024 * 1024);
    expect(tokenizer.feed(`\x1b[200~${huge}`)).toEqual([]);
    expect(tokenizer.feed('\x1b[201~')).toEqual([]);
    expect(tokenizer.feed('x')).toEqual([{ type: 'text', value: 'x' }]);
  });
});
