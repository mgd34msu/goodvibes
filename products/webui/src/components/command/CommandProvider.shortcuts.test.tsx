/**
 * The shortcut a command advertises (palette, cheatsheet) and the key that
 * actually fires must be one fact: every "g x" sequence a command lists does
 * what the command does, and "g a" is a listed command.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import CommandProvider from './CommandProvider';
import { getCommands, unregisterCommand } from '../../lib/commands';

function clearRegistry(): void {
  for (const cmd of getCommands()) unregisterCommand(cmd.id);
}
beforeEach(clearRegistry);
afterEach(clearRegistry);

function press(key: string): void {
  flushSync(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
}

test('every "g x" shortcut a command lists fires the same call as the command, and "g a" is listed', () => {
  const calls: unknown[][] = [];
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      <CommandProvider
        onNavigate={(...args) => { calls.push(['navigate', ...args]); }}
        onOpenSettings={(...args) => { calls.push(['settings', ...args]); }}
      />,
    );
  });

  const sequences = getCommands().filter((c) => /^g \w$/.test(c.shortcut ?? ''));
  expect(sequences.map((c) => c.shortcut)).toContain('g a');
  expect(sequences.length).toBeGreaterThanOrEqual(7);
  for (const command of sequences) {
    calls.length = 0;
    command.run();
    const viaCommand = JSON.stringify(calls);
    expect(viaCommand).not.toBe('[]');
    calls.length = 0;
    for (const key of (command.shortcut ?? '').split(' ')) press(key);
    expect(JSON.stringify(calls)).toBe(viaCommand);
  }
  flushSync(() => root.unmount());
  container.remove();
});
