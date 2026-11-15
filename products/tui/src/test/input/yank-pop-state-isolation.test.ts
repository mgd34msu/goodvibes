/**
 * Regression: yank-pop state must be cleared by any intervening non-yank edit or
 * cursor move. Emacs semantics: Alt+Y (yank-pop) is only valid immediately after
 * a yank or yank-pop. Any text insertion, backspace, delete, or cursor move must
 * clear lastActionWasYank so Alt+Y becomes a no-op.
 *
 * See Issue 1 fix: clearYankState() threaded into handlePromptTextToken,
 * handlePromptKeyToken (backspace, delete, left, right, home, end).
 */
import { describe, test, expect, mock } from 'bun:test';
import { KillRing } from '../../input/kill-ring.ts';
import { handlePromptTextToken, type TextRouteState } from '../../input/handler-feed-routes.ts';
import { handlePromptKeyToken, type KeyRouteState } from '../../input/handler-feed-routes.ts';
import { handleGlobalShortcutToken, type GlobalShortcutRouteState } from '../../input/handler-shortcuts.ts';
import { saveUndoState, undoPromptState, type UndoState } from '../../input/handler-prompt-buffer.ts';

function makeKillRing(): KillRing {
  return new KillRing();
}

function makeTextState(overrides: Partial<TextRouteState> & { killRing: KillRing }): TextRouteState {
  return {
    prompt: '',
    cursorPos: 0,
    commandMode: false,
    nextPasteId: 0,
    nextImageId: 0,
    pasteRegistry: new Map(),
    imageRegistry: new Map(),
    inputHistory: null,
    commandRegistry: null,
    commandContext: undefined,
    autocomplete: null,
    filePicker: { open: mock(() => {}) } as unknown as TextRouteState['filePicker'],
    modalOpened: mock(() => {}),
    saveUndoState: mock(() => {}),
    saveUndoStateForText: mock(() => {}),
    ensureInputCursorVisible: mock(() => {}),
    registerPaste: (s) => s,
    requestRender: mock(() => {}),
    ...overrides,
  };
}

function makeKeyState(overrides: Partial<KeyRouteState> & { killRing: KillRing }): KeyRouteState {
  return {
    prompt: 'hello',
    cursorPos: 5,
    inputScrollTop: 0,
    commandMode: false,
    contentWidth: 80,
    maxInputRows: 8,
    inputHistory: null,
    indicatorFocused: false,
    conversationManager: null,
    commandContext: undefined,
    autocomplete: null,
    blockActionsMenu: { open: mock(() => {}) } as unknown as KeyRouteState['blockActionsMenu'],
    getBlockAnchorLine: () => 0,
    modalOpened: mock(() => {}),
    saveUndoState: mock(() => {}),
    breakUndoCoalesce: mock(() => {}),
    ensureInputCursorVisible: mock(() => {}),
    getWrappedPromptInfo: () => ({
      wrappedLines: ['hello'],
      segments: [{ rawStart: 0, length: 5 }],
      cursorWrappedLine: 0,
      cursorCol: 5,
      visibleLines: ['hello'],
      visibleCursorLine: 0,
      visibleCursorCol: 5,
    }),
    moveCursorVertical: () => false,
    handlePathCompletion: () => false,
    handleBlockToggle: mock(() => {}),
    findMarkerAtPos: () => null,
    cleanupMarkerRegistry: mock(() => {}),
    expandPrompt: (t) => t,
    scroll: mock(() => {}),
    exitApp: mock(() => {}),
    requestRender: mock(() => {}),
    openAgentsView: mock(() => {}),
    ...overrides,
  };
}

function makeShortcutState(ring: KillRing, overrides: Partial<GlobalShortcutRouteState> = {}): GlobalShortcutRouteState {
  return {
    keybindingsManager: {
      matches: () => false,
      lookup: (token: { logicalName?: string; alt?: boolean }) =>
        token.logicalName === 'y' && token.alt ? 'yank-pop' : null,
    } as unknown as GlobalShortcutRouteState['keybindingsManager'],
    prompt: '',
    cursorPos: 0,
    commandMode: false,
    autocomplete: null,
    historySearch: { open: mock(() => {}) } as unknown as GlobalShortcutRouteState['historySearch'],
    searchManager: { active: false, open: mock(() => {}), close: mock(() => {}) } as unknown as GlobalShortcutRouteState['searchManager'],
    conversationManager: null,
    commandContext: undefined,
    contentWidth: 80,
    getScrollTop: () => 0,
    getWrappedPromptInfo: () => ({ wrappedLines: [''], segments: [{ rawStart: 0, length: 0 }], cursorWrappedLine: 0 }),
    saveUndoState: mock(() => {}),
    requestRender: mock(() => {}),
    scroll: mock(() => {}),
    ensureInputCursorVisible: mock(() => {}),
    handleCopy: mock(() => {}),
    handleCtrlC: mock(() => {}),
    handleBlockCopy: mock(() => {}),
    handleBookmark: mock(() => {}),
    handleBlockSave: mock(() => {}),
    handleUndo: mock(() => {}),
    handleRedo: mock(() => {}),
    handlePaste: mock(() => {}),
    handleEscape: mock(() => {}),
    killRing: ring,
    ...overrides,
  };
}

const ALT_Y = { type: 'key' as const, name: '\x1by', logicalName: 'y', alt: true, ctrl: false, shift: false, meta: false };

describe('yank-pop state isolation', () => {
  test('text insertion clears lastActionWasYank so Alt+Y becomes a no-op', () => {
    const ring = makeKillRing();
    ring.push('killed');
    ring.yank();
    // lastActionWasYank is now true, yank-pop would normally be valid
    expect(ring.lastActionWasYank).toBe(true);

    // Simulate typing a character through the text route
    const textState = makeTextState({
      killRing: ring,
      prompt: 'killed',
      cursorPos: 6,
    });
    handlePromptTextToken(textState, { type: 'text', value: 'a' });

    // After text insertion, yank state must be cleared
    expect(ring.lastActionWasYank).toBe(false);

    // Alt+Y in handler-shortcuts must now be rejected (lastActionWasYank is false)
    const shortcutState = makeShortcutState(ring, {
      prompt: textState.prompt,
      cursorPos: textState.cursorPos,
      handleUndo: mock(() => {}),
    });
    const initialPrompt = shortcutState.prompt;
    const handled = handleGlobalShortcutToken(shortcutState, ALT_Y, 24);
    // yank-pop guard: returns false when lastActionWasYank is false
    expect(handled).toBe(false);
    // prompt must be unchanged, no text was inserted by a spurious yank-pop
    expect(shortcutState.prompt).toBe(initialPrompt);
  });

  test('backspace clears lastActionWasYank', () => {
    const ring = makeKillRing();
    ring.push('killed');
    ring.yank();
    expect(ring.lastActionWasYank).toBe(true);

    const keyState = makeKeyState({ killRing: ring, prompt: 'hello', cursorPos: 5 });
    handlePromptKeyToken(keyState, { type: 'key', name: '\x7f', logicalName: 'backspace', ctrl: false, shift: false, meta: false });

    expect(ring.lastActionWasYank).toBe(false);
  });

  test('delete clears lastActionWasYank', () => {
    const ring = makeKillRing();
    ring.push('killed');
    ring.yank();
    expect(ring.lastActionWasYank).toBe(true);

    const keyState = makeKeyState({ killRing: ring, prompt: 'hello', cursorPos: 2 });
    handlePromptKeyToken(keyState, { type: 'key', name: '\x1b[3~', logicalName: 'delete', ctrl: false, shift: false, meta: false });

    expect(ring.lastActionWasYank).toBe(false);
  });

  test('left arrow clears lastActionWasYank', () => {
    const ring = makeKillRing();
    ring.push('killed');
    ring.yank();
    expect(ring.lastActionWasYank).toBe(true);

    const keyState = makeKeyState({ killRing: ring, prompt: 'hello', cursorPos: 5 });
    handlePromptKeyToken(keyState, { type: 'key', name: '\x1b[D', logicalName: 'left', ctrl: false, shift: false, meta: false });

    expect(ring.lastActionWasYank).toBe(false);
  });

  test('right arrow clears lastActionWasYank', () => {
    const ring = makeKillRing();
    ring.push('killed');
    ring.yank();
    expect(ring.lastActionWasYank).toBe(true);

    const keyState = makeKeyState({ killRing: ring, prompt: 'hello', cursorPos: 0 });
    handlePromptKeyToken(keyState, { type: 'key', name: '\x1b[C', logicalName: 'right', ctrl: false, shift: false, meta: false });

    expect(ring.lastActionWasYank).toBe(false);
  });

  test('home clears lastActionWasYank', () => {
    const ring = makeKillRing();
    ring.push('killed');
    ring.yank();
    expect(ring.lastActionWasYank).toBe(true);

    const keyState = makeKeyState({ killRing: ring, prompt: 'hello', cursorPos: 5 });
    handlePromptKeyToken(keyState, { type: 'key', name: '\x1b[H', logicalName: 'home', ctrl: false, shift: false, meta: false });

    expect(ring.lastActionWasYank).toBe(false);
  });

  test('end clears lastActionWasYank', () => {
    const ring = makeKillRing();
    ring.push('killed');
    ring.yank();
    expect(ring.lastActionWasYank).toBe(true);

    const keyState = makeKeyState({ killRing: ring, prompt: 'hello', cursorPos: 0 });
    handlePromptKeyToken(keyState, { type: 'key', name: '\x1b[F', logicalName: 'end', ctrl: false, shift: false, meta: false });

    expect(ring.lastActionWasYank).toBe(false);
  });

  test('consecutive yank then yank-pop remains valid (no intervening edit)', () => {
    const ring = makeKillRing();
    ring.push('old');
    ring.push('new');

    // Simulate yank via handler-shortcuts state (sets lastActionWasYank)
    ring.yank(); // lastActionWasYank = true

    // yank-pop should still be valid, no intervening edit cleared state
    expect(ring.lastActionWasYank).toBe(true);
    const rotated = ring.yankPop();
    expect(rotated).toBe('old');
    expect(ring.lastActionWasYank).toBe(true);
  });
});

/** A shortcut state wired to a real undo stack, with keys mapped straight to actions. */
function undoableShortcutState(ring: KillRing, actions: Record<string, string>, prompt: string, cursorPos: number): GlobalShortcutRouteState {
  const undoStack: UndoState[] = [];
  const redoStack: UndoState[] = [];
  const state = makeShortcutState(ring, {
    prompt,
    cursorPos,
    keybindingsManager: {
      matches: () => false,
      lookup: (token: { logicalName?: string; alt?: boolean }) => actions[`${token.alt ? 'alt+' : ''}${token.logicalName}`] ?? null,
    } as unknown as GlobalShortcutRouteState['keybindingsManager'],
  });
  state.saveUndoState = () => saveUndoState(undoStack, redoStack, state.prompt, state.cursorPos, 100);
  state.handleUndo = () => undoPromptState(undoStack, redoStack, state.prompt, state.cursorPos) ?? undefined;
  return state;
}

const CTRL_U = { type: 'key' as const, name: '\x15', logicalName: 'u', ctrl: true, shift: false, meta: false };
const CTRL_Y = { type: 'key' as const, name: '\x19', logicalName: 'y', ctrl: true, shift: false, meta: false };

describe('kill and yank through the shortcut handler', () => {
  const actions = { u: 'kill-to-start', y: 'yank', 'alt+y': 'yank-pop' };

  test('a kill saves an undo snapshot first, so undo restores the killed text', () => {
    const ring = makeKillRing();
    const state = undoableShortcutState(ring, actions, 'hello world', 5);

    expect(handleGlobalShortcutToken(state, CTRL_U, 24)).toBe(true);
    expect(state.prompt).toBe(' world');
    expect(ring.yank()).toBe('hello');

    const edit = state.handleUndo();
    expect(edit).toEqual({ prompt: 'hello world', cursorPos: 5 });
  });

  test('a yank saves an undo snapshot first, so undo removes the yanked text', () => {
    const ring = makeKillRing();
    ring.push('XY');
    const state = undoableShortcutState(ring, actions, 'abc', 3);

    expect(handleGlobalShortcutToken(state, CTRL_Y, 24)).toBe(true);
    expect(state.prompt).toBe('abcXY');
    expect(state.cursorPos).toBe(5);

    expect(state.handleUndo()).toEqual({ prompt: 'abc', cursorPos: 3 });
  });

  test('Alt+Y right after a yank swaps the yanked text for the next ring entry', () => {
    const ring = makeKillRing();
    ring.push('old');
    ring.push('new');
    const state = undoableShortcutState(ring, actions, 'abc', 3);

    expect(handleGlobalShortcutToken(state, CTRL_Y, 24)).toBe(true);
    expect(state.prompt).toBe('abcnew');
    expect(handleGlobalShortcutToken(state, ALT_Y, 24)).toBe(true);
    expect(state.prompt).toBe('abcold');
    expect(state.cursorPos).toBe(6);
    expect(ring.lastActionWasYank).toBe(true);
  });
});
