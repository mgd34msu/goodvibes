import { describe, test, expect, beforeEach } from 'bun:test';
import { InputHandler } from '../../input/handler.ts';
import { SelectionManager } from '@goodvibes-jev/engine/terminal-shell';
import { InfiniteBuffer } from '@goodvibes-jev/engine/terminal-shell';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';
import { disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';

// Stop the shared test runtime graph when this file ends. Called here, not
// registered inside the helper, for the reason its doc comment gives.
disposeTestRuntimeServicesAfterAll();

describe('Cursor mapping through word-wrap', () => {
  let input: InputHandler;

  beforeEach(async () => {
    const sel = new SelectionManager();
    const history = new InfiniteBuffer();
    input = new InputHandler(() => {}, sel, () => 0, () => 20, () => history, () => {}, () => {}, (await createDefaultUiRuntimeServices()));
    input.setContentWidth(20);
  });

  test('simple text: cursor at each position maps correctly', () => {
    input.prompt = 'hello world';
    const w = 20;
    for (let i = 0; i <= input.prompt.length; i++) {
      input.cursorPos = i;
      const info = input.getWrappedPromptInfo(w);
      // Single line, no wrapping
      expect(info.cursorWrappedLine).toBe(0);
      expect(info.cursorCol).toBe(i);
    }
  });

  test('wrapped text: cursor maps to correct segment', () => {
    input.prompt = 'hello world foo bar baz'; // wraps at width 12
    const w = 12;
    const info0 = (() => { input.cursorPos = 0; return input.getWrappedPromptInfo(w); })();
    expect(info0.cursorWrappedLine).toBe(0);
    expect(info0.cursorCol).toBe(0);

    // End of first segment
    const info11 = (() => { input.cursorPos = 11; return input.getWrappedPromptInfo(w); })();
    expect(info11.cursorWrappedLine).toBe(0);
    expect(info11.cursorCol).toBe(11);

    // Start of second segment
    const info12 = (() => { input.cursorPos = 12; return input.getWrappedPromptInfo(w); })();
    expect(info12.cursorWrappedLine).toBe(1);
    expect(info12.cursorCol).toBe(0);
  });

  test('backspace at each position deletes the character before the cursor and keeps the cursor mapped', () => {
    const original = 'abc def ghi jkl';
    input.setContentWidth(8);

    for (let pos = 1; pos <= original.length; pos++) {
      input.prompt = original;
      input.cursorPos = pos;

      input.feed('\x7f');

      expect(input.prompt).toBe(original.slice(0, pos - 1) + original.slice(pos));
      expect(input.cursorPos).toBe(pos - 1);

      const info = input.getWrappedPromptInfo(8);
      const seg = info.segments[info.cursorWrappedLine]!;
      expect(info.cursorCol).toBe(input.cursorPos - seg.rawStart);
      expect(info.cursorCol).toBeLessThanOrEqual(seg.length);
    }
  });

  test('cursor on consumed space maps to segment boundary', () => {
    input.prompt = 'hello world test';
    const w = 12;
    // "hello world" (11) wraps, then "test" (4)
    // Space at position 11 is consumed

    input.cursorPos = 11; // the consumed space
    const info = input.getWrappedPromptInfo(w);

    // Should map to end of segment 0 or start of segment 1
    // Either way, the cursorCol should be valid for its segment
    const seg = info.segments[info.cursorWrappedLine];
    expect(info.cursorCol).toBeLessThanOrEqual(seg.length);
    expect(info.cursorCol).toBeGreaterThanOrEqual(0);
  });

  test('multiline with newlines: cursor at newline maps correctly', () => {
    input.prompt = 'line one\nline two';
    const w = 20;

    input.cursorPos = 8; // the \n character
    const info = input.getWrappedPromptInfo(w);

    // Should be at end of line 0 or start of line 1
    const seg = info.segments[info.cursorWrappedLine];
    expect(info.cursorCol).toBeLessThanOrEqual(seg.length);
  });

  test('up/down arrows keep the column across wrapped lines', () => {
    input.setContentWidth(14);
    input.prompt = 'abcdef ghijkl mnopqr stuvwx'; // wraps to "abcdef ghijkl " / "mnopqr stuvwx"
    input.cursorPos = 7;

    input.feed('\x1b[B');
    expect(input.cursorPos).toBe(21);
    const down = input.getWrappedPromptInfo(14);
    expect(down.cursorWrappedLine).toBe(1);
    expect(down.cursorCol).toBe(7);

    input.feed('\x1b[A');
    expect(input.cursorPos).toBe(7);
    const up = input.getWrappedPromptInfo(14);
    expect(up.cursorWrappedLine).toBe(0);
    expect(up.cursorCol).toBe(7);
  });

  test('moving onto a shorter wrapped line clamps the column to that line', () => {
    input.setContentWidth(14);
    input.prompt = 'abcdef ghijkl mn'; // "abcdef ghijkl " / "mn"
    input.cursorPos = 10;

    input.feed('\x1b[B');
    expect(input.cursorPos).toBe(16);
    expect(input.getWrappedPromptInfo(14).cursorCol).toBe(2);

    input.feed('\x1b[A');
    expect(input.cursorPos).toBe(2);
  });

  test('pasted multi-line text: backspace mid-line edits that line and the cursor stays on it', () => {
    input.prompt = 'first line\nsecond line\nthird line';
    input.cursorPos = 16; // after "secon", before "d"
    const before = input.getWrappedPromptInfo(20);
    expect(before.wrappedLines[before.cursorWrappedLine]).toBe('second line');
    expect(before.cursorCol).toBe(5);

    input.feed('\x7f');

    expect(input.prompt).toBe('first line\nsecod line\nthird line');
    expect(input.cursorPos).toBe(15);
    const after = input.getWrappedPromptInfo(20);
    expect(after.wrappedLines[after.cursorWrappedLine]).toBe('secod line');
    expect(after.cursorCol).toBe(4);
  });
});
