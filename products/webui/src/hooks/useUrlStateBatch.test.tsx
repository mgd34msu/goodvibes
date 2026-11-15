import { afterEach, beforeEach, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useUrlState } from './useUrlState';
import type { UseUrlStateReturn } from './useUrlState';

let handle: UseUrlStateReturn | undefined;
function Owner(): null {
  const current = useUrlState();
  React.useLayoutEffect(() => { handle = current; });
  return null;
}

beforeEach(() => { window.history.replaceState({}, '', '/?view=chat'); });
afterEach(() => { handle = undefined; });

test('two setters called in one handler keep both changes', () => {
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(<Owner />));
  flushSync(() => {
    handle?.setSession('s-1');
    handle?.setTab('details');
  });
  const params = new URLSearchParams(window.location.search);
  expect(params.get('session')).toBe('s-1');
  expect(params.get('tab')).toBe('details');
  expect(handle?.session).toBe('s-1');
  expect(handle?.tab).toBe('details');
  flushSync(() => root.unmount());
  container.remove();
});
