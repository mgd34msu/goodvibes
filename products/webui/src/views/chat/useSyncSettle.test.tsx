import { describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { SYNC_POLL_LIMIT, useSyncSettle } from './useSyncSettle';

function mount(settle: () => void) {
  function Owner({ turnState, polledAt }: { turnState: string; polledAt: number }): null {
    useSyncSettle(turnState, polledAt, settle);
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return {
    show: (turnState: string, polledAt: number) => flushSync(() => root.render(React.createElement(Owner, { turnState, polledAt }))),
    unmount: () => {
      flushSync(() => root.unmount());
      container.remove();
    },
  };
}

describe('useSyncSettle', () => {
  test('a syncing turn that never gets a reply settles after the poll limit', () => {
    let settled = 0;
    const view = mount(() => { settled += 1; });
    for (let poll = 1; poll <= SYNC_POLL_LIMIT; poll += 1) view.show('syncing', poll);
    expect(settled).toBe(0);
    view.show('syncing', SYNC_POLL_LIMIT + 1);
    expect(settled).toBe(1);
    view.unmount();
  });

  test('leaving syncing restarts the count', () => {
    let settled = 0;
    const view = mount(() => { settled += 1; });
    for (let poll = 1; poll <= SYNC_POLL_LIMIT; poll += 1) view.show('syncing', poll);
    view.show('completed', 100);
    for (let poll = 1; poll <= SYNC_POLL_LIMIT; poll += 1) view.show('syncing', 200 + poll);
    expect(settled).toBe(0);
    view.unmount();
  });

  test('other turn states are never settled', () => {
    let settled = 0;
    const view = mount(() => { settled += 1; });
    for (let poll = 1; poll <= SYNC_POLL_LIMIT * 2; poll += 1) view.show('streaming', poll);
    expect(settled).toBe(0);
    view.unmount();
  });
});
