/**
 * Tests for platform/core/tokenizer.ts (InputTokenizer).
 *
 * This tokenizer is consumed downstream by goodvibes-tui's input pipeline
 * (src/input/handler-feed.ts). It previously had no dedicated test file in
 * this repo even though the TUI depends on its exact token shapes, most
 * importantly the terminal focus-reporting sequences (DECSET ?1004h):
 * `\x1b[I` (focus-in) and `\x1b[O` (focus-out). Those tokens were parsed
 * here long before anything downstream consumed them; this file pins the
 * parsing contract so a future refactor of the escape-sequence branch can't
 * silently break the one thing the TUI's focus-tracking feature depends on.
 */
import { describe, expect, test } from 'bun:test';
import { InputTokenizer, type InputToken } from '../platform/src/platform/core/tokenizer.js';

describe('InputTokenizer: encoded printable input', () => {
  test.each([
    ['modifyOtherKeys uppercase', '\x1b[27;2;65~', 'A'],
    ['modifyOtherKeys punctuation', '\x1b[27;2;33~', '!'],
    ['CSI-u uppercase codepoint', '\x1b[65;2u', 'A'],
    ['Kitty shifted letter', '\x1b[97;2u', 'A'],
    ['Kitty alternate shifted letter', '\x1b[97:65;2u', 'A'],
    ['Kitty layout-specific punctuation', '\x1b[49:33;2u', '!'],
    ['Kitty associated text', '\x1b[97;2;65u', 'A'],
    ['Kitty multiple associated codepoints', '\x1b[0;;101:769u', 'e\u0301'],
    ['Kitty Unicode shifted letter', '\x1b[233:201;2u', 'É'],
    ['Kitty supplementary Unicode', '\x1b[128512u', '😀'],
    ['Kitty Caps Lock', '\x1b[97;65u', 'A'],
    ['Kitty Caps Lock and Shift', '\x1b[97;66u', 'a'],
    ['Kitty unmodified letter', '\x1b[97u', 'a'],
    ['Kitty shifted space', '\x1b[32;2u', ' '],
  ])('%s reaches every text consumer as text', (_label, raw, value) => {
    expect(new InputTokenizer().feed(raw)).toEqual([{ type: 'text', value }]);
  });

  test('held Shift produces one insertion per press/repeat, none on release', () => {
    const tokenizer = new InputTokenizer();
    expect(tokenizer.feed('\x1b[97:65;2:1u\x1b[97:65;2:2u\x1b[97:65;2:3u'))
      .toEqual([{ type: 'text', value: 'A' }, { type: 'text', value: 'A' }]);
  });

  test('split encoded input preserves text and surrounding plain input', () => {
    const tokenizer = new InputTokenizer();
    expect(tokenizer.feed('x\x1b[97:')).toEqual([{ type: 'text', value: 'x' }]);
    expect(tokenizer.feed('65;2')).toEqual([]);
    expect(tokenizer.feed('uy')).toEqual([{ type: 'text', value: 'A' }, { type: 'text', value: 'y' }]);
  });

  test.each([
    ['\x1b[99:67;6u', 'c', true, true, false],
    ['\x1b[27;6;90~', 'z', true, true, false],
    ['\x1b[97:65;4u', 'a', false, true, true],
    ['\x1b[13;2u', 'enter', false, true, false],
    ['\x1b[9;2u', 'tab', false, true, false],
    ['\x1b[1;2D', 'left', false, true, false],
    ['\x1b[57350;2u', 'left', false, true, false],
  ])('%s preserves shortcuts and navigation', (raw, logicalName, ctrl, shift, meta) => {
    expect(new InputTokenizer().feed(raw)).toEqual([{ type: 'key', name: raw, logicalName, ctrl, shift, meta }]);
  });

  test('shortcut release does not fire an action', () => {
    expect(new InputTokenizer().feed('\x1b[99:67;6:3u')).toEqual([]);
  });

  test.each(['\x1b[97;9u', '\x1b[97;17u', '\x1b[97;33u', '\x1b[55296u', '\x1b[1114112u', '\x1b[57358u', '\x1b[0;;27u'])
    ('%s cannot become printable text', (raw) => {
      expect(new InputTokenizer().feed(raw).every(token => token.type === 'key')).toBe(true);
    });
});

describe('InputTokenizer: focus-reporting sequences (CSI ?1004h)', () => {
  test('\\x1b[I parses to a focus-in token', () => {
    const tokenizer = new InputTokenizer();
    const tokens = tokenizer.feed('\x1b[I');
    expect(tokens).toHaveLength(1);
    const t = tokens[0] as Extract<InputToken, { type: 'focus' }>;
    expect(t.type).toBe('focus');
    expect(t.action).toBe('in');
  });

  test('\\x1b[O parses to a focus-out token', () => {
    const tokenizer = new InputTokenizer();
    const tokens = tokenizer.feed('\x1b[O');
    expect(tokens).toHaveLength(1);
    const t = tokens[0] as Extract<InputToken, { type: 'focus' }>;
    expect(t.type).toBe('focus');
    expect(t.action).toBe('out');
  });

  test('focus sequences interleaved with printable text do not corrupt either stream', () => {
    const tokenizer = new InputTokenizer();
    const tokens = tokenizer.feed('a\x1b[Ib\x1b[Oc');
    expect(tokens.map((t) => t.type)).toEqual(['text', 'focus', 'text', 'focus', 'text']);
    expect((tokens[1] as Extract<InputToken, { type: 'focus' }>).action).toBe('in');
    expect((tokens[3] as Extract<InputToken, { type: 'focus' }>).action).toBe('out');
  });

  test('a focus sequence split across two feed() calls is buffered, not dropped or misparsed', () => {
    const tokenizer = new InputTokenizer();
    const first = tokenizer.feed('\x1b[');
    expect(first).toHaveLength(0);
    const second = tokenizer.feed('I');
    expect(second).toHaveLength(1);
    expect(second[0]!.type).toBe('focus');
  });

  test('repeated focus-in tokens (no matching focus-out) parse independently, no state carried', () => {
    const tokenizer = new InputTokenizer();
    const tokens = tokenizer.feed('\x1b[I\x1b[I');
    expect(tokens).toHaveLength(2);
    expect(tokens.every((t) => t.type === 'focus' && t.action === 'in')).toBe(true);
  });
});

describe('InputTokenizer: baseline sanity (text and key tokens)', () => {
  test('a plain printable character produces a text token', () => {
    const tokenizer = new InputTokenizer();
    const tokens = tokenizer.feed('a');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.type).toBe('text');
    expect((tokens[0] as Extract<InputToken, { type: 'text' }>).value).toBe('a');
  });

  test('Enter (\\r) produces a key token with logicalName=enter', () => {
    const tokenizer = new InputTokenizer();
    const tokens = tokenizer.feed('\r');
    expect(tokens).toHaveLength(1);
    const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
    expect(t.type).toBe('key');
    expect(t.logicalName).toBe('enter');
  });

  test('an unrecognized bare escape does not throw', () => {
    const tokenizer = new InputTokenizer();
    expect(() => tokenizer.feed('\x1b')).not.toThrow();
  });
});
