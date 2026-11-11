import { describe, expect, test } from 'bun:test';
import { createTerminalLifecycle, TERMINAL_ESCAPES } from '../terminal-shell/src/terminal-lifecycle.js';

describe('terminal keyboard mode ownership', () => {
  test('uses Kitty push/pop with the existing xterm fallback', () => {
    expect(TERMINAL_ESCAPES.KEYBOARD_EXT_ENABLE).toBe('\x1b[>4;2m\x1b[>1u');
    expect(TERMINAL_ESCAPES.KEYBOARD_EXT_DISABLE).toBe('\x1b[>4;0m\x1b[<u');
  });

  test.each([false, true])('balances entry, editor suspension and exit (noAltScreen=%s)', (noAltScreen) => {
    const writes: string[] = [];
    const terminal = createTerminalLifecycle({ noAltScreen, write: (s) => { writes.push(s); } });
    terminal.enterTerminal();
    terminal.enterTerminal();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('\x1b[>1u');
    if (!noAltScreen) expect(writes[0]!.indexOf('\x1b[>1u')).toBeGreaterThan(writes[0]!.indexOf('\x1b[?1049h'));
    terminal.suspendTerminal();
    terminal.suspendTerminal();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toContain('\x1b[<u');
    if (!noAltScreen) expect(writes[1]!.indexOf('\x1b[<u')).toBeLessThan(writes[1]!.indexOf('\x1b[?1049l'));
    expect(terminal.isTerminalRestored()).toBe(false);
    terminal.enterTerminal();
    terminal.restoreTerminal();
    expect(writes).toHaveLength(4);
    expect(writes[2]).toBe(writes[0]);
    expect(writes[3]).toBe(writes[1]);
    terminal.restoreTerminal();
    terminal.enterTerminal();
    expect(writes).toHaveLength(4);
    if (noAltScreen) expect(writes.join('')).not.toContain('\x1b[?1049');
  });

  test('pre-entry cleanup never pops the caller keyboard stack', () => {
    const writes: string[] = [];
    const terminal = createTerminalLifecycle({ noAltScreen: true, write: (s) => { writes.push(s); } });
    terminal.suspendTerminal();
    terminal.restoreTerminal();
    terminal.enterTerminal();
    expect(writes).toEqual([]);
  });

  test('shutdown while suspended cannot pop again or reenter afterward', () => {
    const writes: string[] = [];
    const terminal = createTerminalLifecycle({ noAltScreen: true, write: (s) => { writes.push(s); } });
    terminal.enterTerminal();
    terminal.suspendTerminal();
    terminal.restoreTerminal();
    terminal.enterTerminal();
    expect(writes).toHaveLength(2);
  });

  test('failed entry does not acquire a keyboard stack entry to pop', () => {
    let attempts = 0;
    const terminal = createTerminalLifecycle({ noAltScreen: false, write: () => {
      attempts++;
      throw new Error('terminal unavailable');
    } });
    expect(() => terminal.enterTerminal()).toThrow('terminal unavailable');
    expect(() => terminal.restoreTerminal()).not.toThrow();
    expect(attempts).toBe(1);
  });
});
