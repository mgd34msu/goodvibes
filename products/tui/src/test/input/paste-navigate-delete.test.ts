import { describe, test, expect, beforeEach } from 'bun:test';
import { InputHandler } from '../../input/handler.ts';
import { SelectionManager } from '@goodvibes-jev/engine/terminal-shell';
import { InfiniteBuffer } from '@goodvibes-jev/engine/terminal-shell';
import { createDefaultUiRuntimeServices } from '../helpers/ui-services.ts';
import { disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';
import { registerPaste } from '../../input/handler-content-actions.ts';

// Stop the shared test runtime graph when this file ends. Called here, not
// registered inside the helper, for the reason its doc comment gives.
disposeTestRuntimeServicesAfterAll();

async function makeInput(contentWidth = 40): Promise<InputHandler> {
  const sel = new SelectionManager();
  const history = new InfiniteBuffer();
  const ih = new InputHandler(() => {}, sel, () => 0, () => 20, () => history, () => {}, () => {}, (await createDefaultUiRuntimeServices()));
  ih.setContentWidth(contentWidth);
  return ih;
}

/** Bracketed paste through the real handler at the current cursor. */
function pasteText(ih: InputHandler, text: string) {
  const before = ih.prompt;
  const pos = ih.cursorPos;
  ih.feed(`\x1b[200~${text}\x1b[201~`);
  expect(ih.prompt).toBe(before.slice(0, pos) + text + before.slice(pos));
  expect(ih.cursorPos).toBe(pos + text.length);
}

/** Typed characters through the real handler at the current cursor. */
function typeText(ih: InputHandler, text: string) {
  const before = ih.prompt;
  const pos = ih.cursorPos;
  ih.feed(text);
  expect(ih.prompt).toBe(before.slice(0, pos) + text + before.slice(pos));
  expect(ih.cursorPos).toBe(pos + text.length);
}

/** Real backspace: removes exactly the character before the cursor. */
function backspace(ih: InputHandler) {
  const before = ih.prompt;
  const pos = ih.cursorPos;
  ih.feed('\x7f');
  expect(ih.prompt).toBe(pos > 0 ? before.slice(0, pos - 1) + before.slice(pos) : before);
  expect(ih.cursorPos).toBe(Math.max(0, pos - 1));
}

/** Real forward delete: removes exactly the character under the cursor. */
function del(ih: InputHandler) {
  const before = ih.prompt;
  const pos = ih.cursorPos;
  ih.feed('\x1b[3~');
  expect(ih.prompt).toBe(pos < before.length ? before.slice(0, pos) + before.slice(pos + 1) : before);
  expect(ih.cursorPos).toBe(pos);
}

/** Move the cursor up one wrapped line, keeping its column where the line is long enough. */
function moveUpOneWrappedLine(ih: InputHandler, cw: number) {
  const info = ih.getWrappedPromptInfo(cw);
  const target = info.cursorWrappedLine - 1;
  expect(target).toBeGreaterThanOrEqual(0);
  const col = Math.min(info.cursorCol, info.segments[target].length);
  ih.cursorPos = info.segments[target].rawStart + col;
}

/** Verify the wrapped cursor position points at the character the cursor is really on. */
function verifyCursor(ih: InputHandler, cw: number, label: string) {
  const info = ih.getWrappedPromptInfo(cw);
  const seg = info.segments[info.cursorWrappedLine];
  expect(seg).toBeDefined();
  const visualChar = info.wrappedLines[info.cursorWrappedLine]?.[info.cursorCol];
  const actualChar = ih.prompt[ih.cursorPos];

  // At the end of the prompt the cursor is on the last wrapped line, past its text.
  if (ih.cursorPos >= ih.prompt.length) {
    expect(info.cursorWrappedLine).toBe(info.segments.length - 1);
    expect(info.cursorCol).toBe(seg.length);
    return;
  }

  // On a newline the cursor is drawn at column 0 of the line that follows it
  // (or of the empty line it ends).
  if (actualChar === '\n') {
    expect(info.cursorCol).toBe(0);
    expect([ih.cursorPos, ih.cursorPos + 1]).toContain(seg.rawStart);
    return;
  }

  // Everywhere else the visual cell under the cursor is the character it is on.
  if (visualChar !== actualChar) {
    throw new Error(`${label}: DESYNC visual=${JSON.stringify(visualChar)} actual=${JSON.stringify(actualChar)} pos=${ih.cursorPos} line=${info.cursorWrappedLine} col=${info.cursorCol}`);
  }
}

describe('Paste + Navigate + Delete/Backspace', () => {
  const CW = 40;

  test('multiline paste with newlines, navigate up, backspace at each position', async () => {
    const ih = (await makeInput(CW));
    const paste = 'Line one of paste\nLine two of paste\nLine three of paste\nLine four';
    pasteText(ih, paste);

    // Navigate up 2 lines
    for (let i = 0; i < 2; i++) moveUpOneWrappedLine(ih, CW);

    // Backspace 10 times, verify cursor consistency each time
    for (let i = 0; i < 10; i++) {
      verifyCursor(ih, CW, `backspace-${i}`);
      backspace(ih);
    }
    verifyCursor(ih, CW, 'after-backspaces');
  });

  test('paste exceeding content width, navigate left through wrap, backspace', async () => {
    const ih = (await makeInput(30));
    const paste = 'This is a long line that will definitely wrap around the content area multiple times';
    pasteText(ih, paste);

    // Navigate left 20 chars (through wrap boundaries)
    for (let i = 0; i < 20; i++) {
      ih.cursorPos = Math.max(0, ih.cursorPos - 1);
    }

    verifyCursor(ih, 30, 'after-left-nav');

    // Backspace 5 times
    for (let i = 0; i < 5; i++) {
      const beforeLen = ih.prompt.length;
      backspace(ih);
      expect(ih.prompt.length).toBe(beforeLen - 1);
      verifyCursor(ih, 30, `bs-${i}`);
    }
  });

  test('paste multiline with lines exceeding width, navigate and delete', async () => {
    const ih = (await makeInput(25));
    const paste = 'Short\nThis line is longer than twenty five characters wide\nAnother short\nYet another long line that exceeds the width';
    pasteText(ih, paste);

    // Navigate to middle of the long wrapped line
    ih.cursorPos = 35;
    verifyCursor(ih, 25, 'at-pos-35');

    // Delete forward 5 times
    for (let i = 0; i < 5; i++) {
      const beforeLen = ih.prompt.length;
      del(ih);
      expect(ih.prompt.length).toBe(beforeLen - 1);
      verifyCursor(ih, 25, `del-${i}`);
    }

    // Navigate up 2 lines and backspace
    for (let i = 0; i < 2; i++) moveUpOneWrappedLine(ih, 25);

    verifyCursor(ih, 25, 'after-up-nav');
    backspace(ih);
    verifyCursor(ih, 25, 'final-backspace');
  });

  test('multiple pastes then navigate between them', async () => {
    const ih = (await makeInput(CW));

    // First paste
    pasteText(ih, 'First paste line one\nFirst paste line two');
    // Second paste
    pasteText(ih, '\nSecond paste starts here\nAnd continues');
    // Third paste
    pasteText(ih, '\nThird paste\nWith multiple\nLines inside');

    // Navigate to various positions and verify
    for (let pos = 0; pos <= ih.prompt.length; pos += 7) {
      ih.cursorPos = Math.min(pos, ih.prompt.length);
      verifyCursor(ih, CW, `scan-pos-${pos}`);
    }

    // Navigate up from bottom to top
    ih.cursorPos = ih.prompt.length;
    let lineCount = ih.getWrappedPromptInfo(CW).wrappedLines.length;
    for (let i = 0; i < lineCount; i++) {
      const info = ih.getWrappedPromptInfo(CW);
      const target = info.cursorWrappedLine - 1;
      if (target >= 0) {
        const col = Math.min(info.cursorCol, info.segments[target].length);
        ih.cursorPos = info.segments[target].rawStart + col;
      }
      verifyCursor(ih, CW, `up-${i}`);
    }
  });

  test('backspace at newline joins lines', async () => {
    const ih = (await makeInput(CW));
    pasteText(ih, 'line one\nline two');

    // Navigate to start of "line two" (position 9)
    ih.cursorPos = 9;
    const info = ih.getWrappedPromptInfo(CW);
    expect(info.cursorWrappedLine).toBe(1);
    expect(info.cursorCol).toBe(0);

    // Backspace should delete the \n and join lines
    backspace(ih);
    expect(ih.prompt).toBe('line oneline two');
    expect(ih.cursorPos).toBe(8);
  });

  test('backspace at marker start removes entire marker', async () => {
    const ih = (await makeInput(CW));
    // Type some text before the marker
    pasteText(ih, 'before ');
    // Register a multi-line paste with >8 lines (creates a TEXT marker)
    const marker = ih.registerPaste('line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9');
    // Insert the marker text into the prompt at cursor
    ih.prompt = ih.prompt.slice(0, ih.cursorPos) + marker + ih.prompt.slice(ih.cursorPos);
    ih.cursorPos += marker.length;
    pasteText(ih, ' after');

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
    ih.cursorPos = 20; // middle
    verifyCursor(ih, 35, 'mid');

    // Type some text at cursor
    typeText(ih, ' INSERTED ');
    verifyCursor(ih, 35, 'after-insert');

    // Delete forward
    del(ih); del(ih); del(ih);
    verifyCursor(ih, 35, 'after-del');

    // Backspace
    backspace(ih); backspace(ih);
    verifyCursor(ih, 35, 'after-bs');

    // Navigate up
    const info = ih.getWrappedPromptInfo(35);
    if (info.cursorWrappedLine > 0) {
      const target = info.cursorWrappedLine - 1;
      const col = Math.min(info.cursorCol, info.segments[target].length);
      ih.cursorPos = info.segments[target].rawStart + col;
    }
    verifyCursor(ih, 35, 'after-up');

    backspace(ih);
    verifyCursor(ih, 35, 'final');
  });
});

describe('Bracketed paste line-ending normalization', () => {
  const CW = 40;

  // Terminals (xterm, tmux, kitty, iTerm2, alacritty) transmit the line
  // breaks inside a bracketed paste as \r, the same byte Enter sends, and
  // external clipboards can carry \r\n. Without normalization those bytes
  // land in the prompt string verbatim: split('\n') sees a single line (the
  // composer never grows, registerPaste never counts lines) and the \r cells
  // reach the terminal as control bytes that return the cursor to column 0
  // mid-row, overwriting the prompt marker.

  test('bracketed paste with CR separators lands as \\n and grows the composer', async () => {
    const ih = (await makeInput(CW));
    ih.feed('\x1b[200~line one\rline two\rline three\x1b[201~');
    expect(ih.prompt).toBe('line one\nline two\nline three');
    expect(ih.getVisiblePromptLineCount(CW)).toBe(3);
  });

  test('bracketed paste with CRLF separators lands as \\n', async () => {
    const ih = (await makeInput(CW));
    ih.feed('\x1b[200~alpha\r\nbeta\r\ngamma\x1b[201~');
    expect(ih.prompt).toBe('alpha\nbeta\ngamma');
    expect(ih.getVisiblePromptLineCount(CW)).toBe(3);
  });

  test('nine CR-separated lines register as a [TEXT:] marker with a true line count', async () => {
    const ih = (await makeInput(CW));
    const paste = Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join('\r');
    ih.feed(`\x1b[200~${paste}\x1b[201~`);
    expect(ih.prompt).toMatch(/^\[TEXT: p\d+, 9 lines\]$/);
  });

  test('registerPaste stores registry content with \\n line endings', () => {
    const state = {
      nextImageId: 0,
      nextPasteId: 0,
      pasteRegistry: new Map<string, string>(),
      imageRegistry: new Map<string, { data: string; mediaType: string }>(),
    };
    const content = Array.from({ length: 9 }, (_, i) => `l${i}`).join('\r\n');
    const { marker } = registerPaste(state, content, '/tmp');
    expect(marker).toBe('[TEXT: p0, 9 lines]');
    expect(state.pasteRegistry.get('p0')).toBe(Array.from({ length: 9 }, (_, i) => `l${i}`).join('\n'));
  });

  test('binary image paste keeps raw bytes (PNG magic contains \\r\\n)', () => {
    const state = {
      nextImageId: 0,
      nextPasteId: 0,
      pasteRegistry: new Map<string, string>(),
      imageRegistry: new Map<string, { data: string; mediaType: string }>(),
    };
    const png = '\x89PNG\r\n\x1a\n' + 'x'.repeat(200);
    const { marker } = registerPaste(state, png, '/tmp');
    expect(marker.startsWith('[IMAGE:')).toBe(true);
    expect(state.imageRegistry.get('img0')!.data).toBe(Buffer.from(png, 'binary').toString('base64'));
  });

  test('short CR-separated paste keeps editing consistent (backspace joins lines)', async () => {
    const ih = (await makeInput(CW));
    ih.feed('\x1b[200~one\rtwo\x1b[201~');
    expect(ih.prompt).toBe('one\ntwo');
    // Cursor sits at the end; backspace twice removes 'o' then 'w'
    ih.feed('\x7f');
    ih.feed('\x7f');
    expect(ih.prompt).toBe('one\nt');
    expect(ih.getVisiblePromptLineCount(CW)).toBe(2);
  });

});
