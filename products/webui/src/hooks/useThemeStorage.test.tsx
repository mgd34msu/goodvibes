import { afterEach, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ThemeProvider, useTheme } from './useTheme';

let handle: ReturnType<typeof useTheme> | undefined;
function Capture(): null {
  const current = useTheme();
  React.useLayoutEffect(() => { handle = current; });
  return null;
}

const realSetItem = Storage.prototype.setItem;
afterEach(() => { Storage.prototype.setItem = realSetItem; handle = undefined; });

test('choosing a theme with blocked storage still applies it and does not throw', () => {
  Storage.prototype.setItem = () => { throw new DOMException('blocked', 'SecurityError'); };
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(<ThemeProvider><Capture /></ThemeProvider>));
  expect(() => flushSync(() => handle?.setTheme('light'))).not.toThrow();
  expect(handle?.theme).toBe('light');
  flushSync(() => root.unmount()); container.remove();
});
