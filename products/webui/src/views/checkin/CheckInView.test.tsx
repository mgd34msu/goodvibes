/**
 * CheckInSettings: "Run check-in now" delivers through the configured channel for
 * real, so nothing is sent until the confirmation is accepted.
 */
import { afterEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const runCalls: number[] = [];

mock.module('../../lib/goodvibes', () => ({
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: () => Promise.resolve({}),
  client: {
    operator: {
      checkin: {
        config: {
          get: () => Promise.resolve({ config: { enabled: true, cadence: '0 9 * * *', deliveryChannel: 'slack:#daily', quietHours: '22:00-07:00' } }),
          set: () => Promise.resolve({}),
        },
        receipts: { list: () => Promise.resolve({ receipts: [] }) },
        run: () => { runCalls.push(1); return Promise.resolve({ outcome: 'delivered', summary: 'Sent.' }); },
      },
    },
  },
}));

const { CheckInSettings } = await import('./CheckInView');
const { ToastProvider } = await import('../../lib/toast');

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(React.createElement(QueryClientProvider, { client }, React.createElement(ToastProvider, null, React.createElement(CheckInSettings))));
  });
  return { el: container, unmount: () => { flushSync(() => root.unmount()); container.remove(); } };
}

function button(root: ParentNode, name: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim() === name);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
    flushSync(() => {});
  }
}

afterEach(() => {
  runCalls.length = 0;
  document.body.innerHTML = '';
});

test('a manual run waits for confirmation, and Cancel sends nothing', async () => {
  const { el, unmount } = render();
  try {
    await waitFor(() => (el.textContent ?? '').includes('slack:#daily'));
    flushSync(() => button(el, 'Run check-in now')?.click());
    await waitFor(() => Boolean(document.querySelector('.gv-confirm')));
    expect(document.querySelector('.gv-confirm')?.textContent).toContain('slack:#daily');
    expect(runCalls).toEqual([]);

    const dialog = document.querySelector('.gv-confirm');
    if (!dialog) throw new Error('Missing confirmation');
    flushSync(() => button(dialog, 'Cancel')?.click());
    await waitFor(() => !document.querySelector('.gv-confirm'));
    expect(runCalls).toEqual([]);
  } finally {
    unmount();
  }
});

test('accepting the confirmation runs the check-in once', async () => {
  const { el, unmount } = render();
  try {
    await waitFor(() => button(el, 'Run check-in now') !== undefined);
    flushSync(() => button(el, 'Run check-in now')?.click());
    await waitFor(() => Boolean(document.querySelector('.gv-confirm')));
    const dialog = document.querySelector('.gv-confirm');
    if (!dialog) throw new Error('Missing confirmation');
    flushSync(() => button(dialog, 'Send check-in')?.click());
    await waitFor(() => runCalls.length === 1);
  } finally {
    unmount();
  }
});
