import { describe, test, expect, beforeEach } from 'bun:test';
import { InputHandler } from '../../input/handler.ts';
import { SelectionManager } from '@goodvibes-jev/engine/terminal-shell';
import { InfiniteBuffer } from '@goodvibes-jev/engine/terminal-shell';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';

async function makeInput(contentWidth = 40): Promise<InputHandler> {
  const sel = new SelectionManager();
  const history = new InfiniteBuffer();
  const ih = new InputHandler(() => {}, sel, () => 0, () => 20, () => history, () => {}, () => {}, (await createDefaultUiRuntimeServices()));
  ih.setContentWidth(contentWidth);
  return ih;
}

/** A bracketed paste as the terminal delivers it: newlines arrive as carriage returns. */
function pasteText(ih: InputHandler, text: string) {
  ih.feed(`\x1b[200~${text.replace(/\n/g, '\r')}\x1b[201~`);
}

const LEFT = '\x1b[D';
const UP = '\x1b[A';
const BACKSPACE = '\x7f';
const DELETE = '\x1b[3~';

function press(ih: InputHandler, key: string, times = 1) {
  for (let i = 0; i < times; i++) ih.feed(key);
}

/** Verify the wrapped-line cursor and the edit position agree, and that the visual character is the character under the edit position. */
function verifyCursor(ih: InputHandler, cw: number, label: string) {
  const info = ih.getWrappedPromptInfo(cw);
  const seg = info.segments[info.cursorWrappedLine];
  if (!seg) throw new Error(`${label}: no segment for wrapped line ${info.cursorWrappedLine}`);

  // A space consumed at a wrap boundary, or a newline, has no cell of its own: the cursor shows at column 0 of the next line.
  const gapChar = ih.prompt[ih.cursorPos];
  const onConsumedSpace = info.cursorCol === 0 && (gapChar === ' ' || gapChar === '\n') && seg.rawStart === ih.cursorPos + 1;
  if (!onConsumedSpace && seg.rawStart + info.cursorCol !== ih.cursorPos) {
    throw new Error(`${label}: DESYNC edit position ${ih.cursorPos} but wrapped line ${info.cursorWrappedLine} col ${info.cursorCol} starts at ${seg.rawStart}`);
  }
  expect(info.cursorCol).toBeLessThanOrEqual(seg.length);

  if (!onConsumedSpace && info.cursorCol < seg.length) {
    const visualChar = info.wrappedLines[info.cursorWrappedLine]?.[info.cursorCol];
    const actualChar = ih.prompt[ih.cursorPos];
    if (visualChar !== actualChar) {
      throw new Error(`${label}: DESYNC visual=${JSON.stringify(visualChar)} actual=${JSON.stringify(actualChar)} pos=${ih.cursorPos} line=${info.cursorWrappedLine} col=${info.cursorCol}`);
    }
  }
}

describe('Paste + Navigate + Delete/Backspace', () => {
  const CW = 40;

  test('multiline paste with newlines, navigate up, backspace at each position', async () => {
    const ih = (await makeInput(CW));
    const paste = 'Line one of paste\nLine two of paste\nLine three of paste\nLine four';
    pasteText(ih, paste);
    expect(ih.prompt).toBe(paste);
    expect(ih.cursorPos).toBe(paste.length);

    press(ih, UP, 2);
    const info = ih.getWrappedPromptInfo(CW);
    expect(info.cursorWrappedLine).toBe(1);
    const cursorAfterNav = ih.cursorPos;
    expect(cursorAfterNav).toBeLessThan(paste.length);

    // Each backspace removes exactly the character before the cursor
    for (let i = 0; i < 10; i++) {
      verifyCursor(ih, CW, `backspace-${i}`);
      const before = ih.prompt;
      const pos = ih.cursorPos;
      ih.feed(BACKSPACE);
      expect(ih.prompt).toBe(before.slice(0, pos - 1) + before.slice(pos));
      expect(ih.cursorPos).toBe(pos - 1);
    }
    verifyCursor(ih, CW, 'after-backspaces');
  });

  test('paste exceeding content width, navigate left through wrap, backspace', async () => {
    const ih = (await makeInput(30));
    const paste = 'This is a long line that will definitely wrap around the content area multiple times';
    pasteText(ih, paste);
    expect(ih.getWrappedPromptInfo(30).wrappedLines.length).toBeGreaterThan(2);

    // Navigate left 20 chars (through wrap boundaries)
    press(ih, LEFT, 20);
    expect(ih.cursorPos).toBe(paste.length - 20);
    verifyCursor(ih, 30, 'after-left-nav');

    for (let i = 0; i < 5; i++) {
      const beforePrompt = ih.prompt;
      const pos = ih.cursorPos;
      ih.feed(BACKSPACE);
      expect(ih.prompt).toBe(beforePrompt.slice(0, pos - 1) + beforePrompt.slice(pos));
      verifyCursor(ih, 30, `bs-${i}`);
    }
  });

  test('paste multiline with lines exceeding width, navigate and delete', async () => {
    const ih = (await makeInput(25));
    const paste = 'Short\nThis line is longer than twenty five characters wide\nAnother short\nYet another long line that exceeds the width';
    pasteText(ih, paste);
    expect(ih.prompt).toBe(paste);

    // Navigate to the middle of the long wrapped line
    press(ih, LEFT, paste.length - 35);
    expect(ih.cursorPos).toBe(35);
    verifyCursor(ih, 25, 'at-pos-35');

    for (let i = 0; i < 5; i++) {
      const before = ih.prompt;
      ih.feed(DELETE);
      expect(ih.prompt).toBe(before.slice(0, 35) + before.slice(36));
      expect(ih.cursorPos).toBe(35);
      verifyCursor(ih, 25, `del-${i}`);
    }

    // Navigate up 2 lines and backspace
    const lineBefore = ih.getWrappedPromptInfo(25).cursorWrappedLine;
    press(ih, UP, 2);
    expect(ih.getWrappedPromptInfo(25).cursorWrappedLine).toBe(lineBefore - 2);
    verifyCursor(ih, 25, 'after-up-nav');
    const beforeFinal = ih.prompt;
    const posFinal = ih.cursorPos;
    ih.feed(BACKSPACE);
    expect(ih.prompt).toBe(beforeFinal.slice(0, posFinal - 1) + beforeFinal.slice(posFinal));
    verifyCursor(ih, 25, 'final-backspace');
  });

  test('multiple pastes then navigate between them', async () => {
    const ih = (await makeInput(CW));

    const first = 'First paste line one\nFirst paste line two';
    const second = '\nSecond paste starts here\nAnd continues';
    const third = '\nThird paste\nWith multiple\nLines inside';
    pasteText(ih, first);
    pasteText(ih, second);
    pasteText(ih, third);
    expect(ih.prompt).toBe(first + second + third);
    verifyCursor(ih, CW, 'after-pastes');

    // Walk left from the end one key at a time; the cursor must stay in sync everywhere
    for (let pos = ih.prompt.length; pos > 0; pos--) {
      expect(ih.cursorPos).toBe(pos);
      verifyCursor(ih, CW, `left-${pos}`);
      ih.feed(LEFT);
    }
    expect(ih.cursorPos).toBe(0);
    verifyCursor(ih, CW, 'at-start');
  });

  test('backspace at newline joins lines', async () => {
    const ih = (await makeInput(CW));
    pasteText(ih, 'line one\nline two');

    // Navigate to start of "line two" (position 9)
    press(ih, LEFT, 'line two'.length);
    expect(ih.cursorPos).toBe(9);
    const info = ih.getWrappedPromptInfo(CW);
    expect(info.cursorWrappedLine).toBe(1);
    expect(info.cursorCol).toBe(0);

    // Backspace should delete the \n and join lines
    ih.feed(BACKSPACE);
    expect(ih.prompt).toBe('line oneline two');
    expect(ih.cursorPos).toBe(8);
  });

  test('backspace at marker start removes entire marker', async () => {
    const ih = (await makeInput(CW));
    // Type some text before the marker
    ih.feed('before ');
    // Register a multi-line paste with >8 lines (creates a TEXT marker)
    const marker = ih.registerPaste('line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9');
    // Insert the marker text into the prompt at cursor
    ih.prompt = ih.prompt.slice(0, ih.cursorPos) + marker + ih.prompt.slice(ih.cursorPos);
    ih.cursorPos += marker.length;
    ih.feed(' after');

    const promptWithMarker = ih.prompt;
    const markerStart = promptWithMarker.indexOf('[TEXT:');
    expect(markerStart).toBeGreaterThanOrEqual(0);

    // Position cursor exactly at the START of the marker (simulates left-arrow jump)
    ih.cursorPos = markerStart;

    // Feed backspace, handler should detect marker.start === cursorPos and delete entire marker
    ih.feed('\x7f');

    // The entire marker should be gone, not just one character
    expect(ih.prompt).not.toContain('[TEXT:');
    // The surrounding text should remain intact
    expect(ih.prompt).toContain('before');
    expect(ih.prompt).toContain('after');
    // Prompt should be shorter by the full marker length, not just 1 char
    const markerLen = marker.length;
    expect(ih.prompt.length).toBe(promptWithMarker.length - markerLen);
  });

  test('cursor position survives full edit cycle', async () => {
    const ih = (await makeInput(35));

    // Paste, navigate, type, delete, navigate, backspace
    pasteText(ih, 'Hello world this is a test of the editing system');
    press(ih, LEFT, ih.prompt.length - 20);
    expect(ih.cursorPos).toBe(20);
    verifyCursor(ih, 35, 'mid');

    // Type some text at cursor
    ih.feed(' INSERTED ');
    expect(ih.prompt).toBe('Hello world this is  INSERTED a test of the editing system');
    expect(ih.cursorPos).toBe(30);
    verifyCursor(ih, 35, 'after-insert');

    press(ih, DELETE, 3);
    expect(ih.prompt).toBe('Hello world this is  INSERTED est of the editing system');
    expect(ih.cursorPos).toBe(30);
    verifyCursor(ih, 35, 'after-del');

    press(ih, BACKSPACE, 2);
    expect(ih.prompt).toBe('Hello world this is  INSERTEest of the editing system');
    expect(ih.cursorPos).toBe(28);
    verifyCursor(ih, 35, 'after-bs');

    // Move onto the second wrapped line so navigating up has somewhere to go
    press(ih, '\x1b[C', 10);
    expect(ih.getWrappedPromptInfo(35).cursorWrappedLine).toBe(1);

    // Navigate up
    const lineBefore = ih.getWrappedPromptInfo(35).cursorWrappedLine;
    expect(lineBefore).toBeGreaterThan(0);
    ih.feed(UP);
    expect(ih.getWrappedPromptInfo(35).cursorWrappedLine).toBe(lineBefore - 1);
    verifyCursor(ih, 35, 'after-up');

    const before = ih.prompt;
    const pos = ih.cursorPos;
    ih.feed(BACKSPACE);
    expect(ih.prompt).toBe(before.slice(0, pos - 1) + before.slice(pos));
    verifyCursor(ih, 35, 'final');
  });
});
