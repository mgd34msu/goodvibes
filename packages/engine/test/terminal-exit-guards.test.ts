import { describe, expect, test } from 'bun:test';
import { createTerminalLifecycle, TERMINAL_ESCAPES } from '../terminal-shell/src/terminal-lifecycle.js';
import { installTerminalExitGuards } from '../terminal-shell/src/terminal-exit-guards.js';

function fakeTerminal() {
  const writes: string[] = [];
  const events: string[] = [];
  const lifecycle = createTerminalLifecycle({
    write: (data) => { writes.push(data); events.push('write'); },
    noAltScreen: false,
    setRawMode: (enabled) => { events.push(`raw ${enabled}`); },
  });
  let exitListener: (() => void) | undefined;
  const guards = installTerminalExitGuards(lifecycle, { onProcessExit: (listener) => { exitListener = listener; } });
  return { writes, events, lifecycle, guards, fireExit: () => exitListener?.() };
}

describe('installTerminalExitGuards', () => {
  test('startup runs faults, raw mode, input, then enters the terminal', () => {
    const t = fakeTerminal();
    const order: string[] = [];
    t.guards.startTerminalSession({
      registerFaults: () => order.push('faults'),
      enableRawMode: () => order.push('raw'),
      prepareInput: () => order.push('input'),
      enter: () => { order.push('enter'); t.lifecycle.enterTerminal(); },
    });
    expect(order).toEqual(['faults', 'raw', 'input', 'enter']);
    expect(t.writes[0]).toContain(TERMINAL_ESCAPES.ALT_SCREEN_ENTER);
  });

  test('a step that throws after entry hands the terminal back and rethrows', () => {
    const t = fakeTerminal();
    const boom = new Error('boom');
    expect(() => t.guards.startTerminalSession({
      registerFaults: () => {},
      enableRawMode: () => {},
      enter: () => { t.lifecycle.enterTerminal(); throw boom; },
    })).toThrow(boom);
    expect(t.writes.at(-1)).toContain(TERMINAL_ESCAPES.ALT_SCREEN_EXIT);
    expect(t.lifecycle.isTerminalRestored()).toBe(true);
  });

  test('a throw before raw mode never reaches raw mode and still restores', () => {
    const t = fakeTerminal();
    const order: string[] = [];
    expect(() => t.guards.startTerminalSession({
      registerFaults: () => { order.push('faults'); throw new Error('no handlers'); },
      enableRawMode: () => order.push('raw'),
      enter: () => order.push('enter'),
    })).toThrow('no handlers');
    expect(order).toEqual(['faults']);
    expect(t.lifecycle.isTerminalRestored()).toBe(true);
  });

  test('the exit listener restores an entered terminal once and runs onExit after it', () => {
    const events: string[] = [];
    const lifecycle = createTerminalLifecycle({ write: () => { events.push('write'); }, noAltScreen: false });
    let listener: (() => void) | undefined;
    installTerminalExitGuards(lifecycle, {
      onProcessExit: (l) => { listener = l; },
      onExit: () => { events.push('onExit'); },
    });
    lifecycle.enterTerminal();
    events.length = 0;
    listener?.();
    listener?.();
    expect(events).toEqual(['write', 'onExit', 'onExit']);
  });

  test('a restore that throws never escapes the exit listener, and onExit still runs', () => {
    const calls: string[] = [];
    let listener: (() => void) | undefined;
    installTerminalExitGuards({ restoreTerminal: () => { throw new Error('stdout closed'); } }, {
      onProcessExit: (l) => { listener = l; },
      onExit: () => { calls.push('onExit'); },
    });
    expect(() => listener?.()).not.toThrow();
    expect(calls).toEqual(['onExit']);
  });

  test('exit after startup never entered writes nothing', () => {
    const t = fakeTerminal();
    t.fireExit();
    expect(t.writes.join('')).not.toContain(TERMINAL_ESCAPES.ALT_SCREEN_EXIT);
  });
});
