/**
 * Tests for platform/core/tokenizer.ts (InputTokenizer): the encoded-input matrix, focus reporting,
 * and the per-token behaviour the terminal products consume (text, control keys, escape sequences,
 * kitty keyboard protocol, bracketed paste, buffer safety, panel control codes).
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
import { beforeEach, describe, expect, test } from 'bun:test';
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

describe('InputTokenizer: focus-reporting sequences (CSI ?1004h), buffering and interleaving', () => {
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

describe('InputTokenizer', () => {
  let tokenizer: InputTokenizer;

  beforeEach(() => {
    tokenizer = new InputTokenizer();
  });

  describe('plain text', () => {
    test('single printable char produces text token', () => {
      const tokens = tokenizer.feed('a');
      expect(tokens).toHaveLength(1);
      expect(tokens[0]!.type).toBe('text');
      expect((tokens[0] as Extract<InputToken, { type: 'text' }>).value).toBe('a');
    });

    test('multiple printable chars produce individual text tokens', () => {
      const tokens = tokenizer.feed('hi');
      expect(tokens).toHaveLength(2);
      expect(tokens[0]!.type).toBe('text');
      expect(tokens[1]!.type).toBe('text');
    });

    test('space is a text token', () => {
      const tokens = tokenizer.feed(' ');
      expect(tokens).toHaveLength(1);
      expect(tokens[0]!.type).toBe('text');
      expect((tokens[0] as Extract<InputToken, { type: 'text' }>).value).toBe(' ');
    });
  });

  describe('control keys', () => {
    test('Enter (\\r) produces key token with logicalName=enter', () => {
      const tokens = tokenizer.feed('\r');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('enter');
    });

    test('Ctrl+C (\\x03) produces key with logicalName=c and ctrl=true', () => {
      const tokens = tokenizer.feed('\x03');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('c');
      expect(t.ctrl).toBe(true);
    });

    test('Backspace (127) produces key with logicalName=backspace', () => {
      const tokens = tokenizer.feed('\x7f');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('backspace');
    });

    test('newline (\\n) produces key token with logicalName=enter', () => {
      const tokens = tokenizer.feed('\n');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('enter');
    });

    test('Ctrl+A produces key with ctrl=true', () => {
      const tokens = tokenizer.feed('\x01'); // SOH
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.ctrl).toBe(true);
    });
  });

  describe('escape sequences', () => {
    test('focus-in sequence produces focus token', () => {
      const tokens = tokenizer.feed('\x1b[I');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'focus' }>;
      expect(t.type).toBe('focus');
      expect(t.action).toBe('in');
    });

    test('focus-out sequence produces focus token', () => {
      const tokens = tokenizer.feed('\x1b[O');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'focus' }>;
      expect(t.type).toBe('focus');
      expect(t.action).toBe('out');
    });

    test('up arrow (\\x1b[A) produces key token with logicalName=up', () => {
      const tokens = tokenizer.feed('\x1b[A');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('up');
    });

    test('down arrow (\\x1b[B) produces key token with logicalName=down', () => {
      const tokens = tokenizer.feed('\x1b[B');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('down');
    });

    test('mouse press sequence produces mouse token', () => {
      // SGR mouse: ESC[<0;10;5M  (button=0, col=10-1=9, row=5-1=4, press)
      const tokens = tokenizer.feed('\x1b[<0;10;5M');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'mouse' }>;
      expect(t.type).toBe('mouse');
      expect(t.button).toBe(0);
      expect(t.col).toBe(9);
      expect(t.row).toBe(4);
      expect(t.action).toBe('press');
    });

    test('mouse release sequence produces mouse token with action=release', () => {
      const tokens = tokenizer.feed('\x1b[<0;1;1m');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'mouse' }>;
      expect(t.type).toBe('mouse');
      expect(t.action).toBe('release');
    });
  });

  describe('kitty keyboard protocol', () => {

    test('CSI u space (32) produces ordinary text', () => {
      const tokens = tokenizer.feed('[32;1u');
      expect(tokens).toEqual([{ type: 'text', value: ' ' }]);
    });

    test('CSI u insert (57348) produces key with logicalName=insert', () => {
      const tokens = tokenizer.feed('\x1b[57348;1u');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('insert');
    });

    test('CSI u delete (57349) produces key with logicalName=delete', () => {
      const tokens = tokenizer.feed('\x1b[57349;1u');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('delete');
    });

    test('CSI u left (57350) produces key with logicalName=left', () => {
      const tokens = tokenizer.feed('\x1b[57350;1u');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('left');
    });

    test('CSI u right (57351) produces key with logicalName=right', () => {
      const tokens = tokenizer.feed('\x1b[57351;1u');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('right');
    });

    test('CSI u up (57352) produces key with logicalName=up', () => {
      const tokens = tokenizer.feed('\x1b[57352;1u');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('up');
    });

    test('CSI u down (57353) produces key with logicalName=down', () => {
      const tokens = tokenizer.feed('\x1b[57353;1u');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('down');
    });

    test('CSI u home (57356) produces key with logicalName=home', () => {
      const tokens = tokenizer.feed('\x1b[57356;1u');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('home');
    });

    test('CSI u end (57357) produces key with logicalName=end', () => {
      const tokens = tokenizer.feed('\x1b[57357;1u');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('end');
    });

    test('CSI u f1 (57364) produces key with logicalName=f1', () => {
      const tokens = tokenizer.feed('\x1b[57364;1u');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('f1');
    });

    test('CSI u f12 (57375) produces key with logicalName=f12', () => {
      const tokens = tokenizer.feed('\x1b[57375;1u');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('f12');
    });

    test('CSI u left (57350) bare form without modifier suffix', () => {
      const tokens = tokenizer.feed('\x1b[57350u');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('left');
    });

    test('CSI u pageup (57354) produces key with logicalName=pageup', () => {
      const tokens = tokenizer.feed('\x1b[57354;1u');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('pageup');
    });

    test('CSI u pagedown (57355) produces key with logicalName=pagedown', () => {
      const tokens = tokenizer.feed('\x1b[57355;1u');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('pagedown');
    });

    test('CSI u left (57350) with modifier 6 (shift+ctrl) produces key with ctrl=true, shift=true, meta=false', () => {
      const tokens = tokenizer.feed('\x1b[57350;6u');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('left');
      expect(t.ctrl).toBe(true);
      expect(t.shift).toBe(true);
      expect(t.meta).toBe(false);
    });

    test('CSI u Ctrl+[ produces key with logicalName=[ and ctrl=true', () => {
      const tokens = tokenizer.feed('\x1b[91;5u');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('[');
      expect(t.ctrl).toBe(true);
    });

    test('CSI u Ctrl+] produces key with logicalName=] and ctrl=true', () => {
      const tokens = tokenizer.feed('\x1b[93;5u');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe(']');
      expect(t.ctrl).toBe(true);
    });

    test('modifyOtherKeys Ctrl+[ produces key with logicalName=[ and ctrl=true', () => {
      const tokens = tokenizer.feed('\x1b[27;5;91~');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('[');
      expect(t.ctrl).toBe(true);
    });

    test('modifyOtherKeys Ctrl+] produces key with logicalName=] and ctrl=true', () => {
      const tokens = tokenizer.feed('\x1b[27;5;93~');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe(']');
      expect(t.ctrl).toBe(true);
    });
  });

  describe('bracketed paste', () => {
    test('bracketed paste produces a single text token with full content', () => {
      const tokens = tokenizer.feed('\x1b[200~hello world\x1b[201~');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'text' }>;
      expect(t.type).toBe('text');
      expect(t.value).toBe('hello world');
    });

    test('bracketed paste with newlines is treated as single token', () => {
      const tokens = tokenizer.feed('\x1b[200~line1\nline2\x1b[201~');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'text' }>;
      expect(t.value).toContain('line1');
      expect(t.value).toContain('line2');
    });

    test('partial paste buffers until end marker arrives', () => {
      // Feed start and content without end marker
      const partial = tokenizer.feed('\x1b[200~hello');
      expect(partial).toHaveLength(0); // still buffering

      // Feed end marker
      const complete = tokenizer.feed('\x1b[201~');
      expect(complete).toHaveLength(1);
      const t = complete[0] as Extract<InputToken, { type: 'text' }>;
      expect(t.value).toBe('hello');
    });
  });

  describe('buffer safety', () => {
    test('oversized buffer is discarded and returns empty array', () => {
      const big = 'a'.repeat(1024 * 101);
      const tokens = tokenizer.feed(big);
      expect(tokens).toEqual([]);
    });

    test('can process input after buffer reset from overflow', () => {
      tokenizer.feed('a'.repeat(1024 * 101)); // overflow, resets
      const tokens = tokenizer.feed('x');
      expect(tokens).toHaveLength(1);
      expect(tokens[0]!.type).toBe('text');
    });
  });

  describe('panel control codes', () => {
    test('0x1c (Ctrl+\\\\) produces key with logicalName="\\\\" and ctrl=true', () => {
      const tokens = tokenizer.feed('\x1c');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('\\');
      expect(t.ctrl).toBe(true);
    });

    test('0x1d (Ctrl+]) produces key with logicalName="]" and ctrl=true', () => {
      const tokens = tokenizer.feed('\x1d');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe(']');
      expect(t.ctrl).toBe(true);
    });

    test('0x1e (Ctrl+^) produces key with logicalName="^" and ctrl=true', () => {
      const tokens = tokenizer.feed('\x1e');
      expect(tokens).toHaveLength(1);
      const t = tokens[0] as Extract<InputToken, { type: 'key' }>;
      expect(t.type).toBe('key');
      expect(t.logicalName).toBe('^');
      expect(t.ctrl).toBe(true);
    });
  });

  describe('sequential feed calls', () => {
    test('bare escape emits escape key token', () => {
      const t1 = tokenizer.feed('\x1b');
      expect(t1).toHaveLength(1);
      const tok = t1[0]!;
      expect(tok.type).toBe('key');
      if (tok.type !== 'key') throw new Error('expected a key token');
      expect(tok.logicalName).toBe('escape');
    });

    test('multiple text chars feed sequentially produce all tokens', () => {
      const t1 = tokenizer.feed('a');
      const t2 = tokenizer.feed('b');
      expect(t1[0]!.type).toBe('text');
      expect(t2[0]!.type).toBe('text');
    });
  });
});
