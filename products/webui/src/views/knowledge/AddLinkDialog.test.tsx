/**
 * AddLinkDialog: a pending ingest keeps the dialog open (a late result must not
 * navigate after a cancel), and a closed dialog reopens blank.
 */
import { afterEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let ingestImpl: () => Promise<unknown> = () => Promise.resolve({ source: { id: 'src-1' } });
const ingestCalls: unknown[] = [];

mock.module('../../lib/goodvibes', () => ({
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: (method: string, input?: unknown) => {
    if (method === 'knowledge.ingest.url') {
      ingestCalls.push(input);
      return ingestImpl();
    }
    return Promise.resolve({});
  },
  client: { operator: { calendar: { events: {}, ics: {} } } },
}));

const { AddLinkDialog } = await import('./AddLinkDialog');

function render(initialOpen: boolean, onClose: () => void, onIngested: (id: string) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const show = (open: boolean) => flushSync(() => {
    root.render(React.createElement(QueryClientProvider, { client }, React.createElement(AddLinkDialog, { open, onClose, onIngested })));
  });
  show(initialOpen);
  return {
    show,
    unmount: () => {
      flushSync(() => root.unmount());
      container.remove();
    },
  };
}

function button(name: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
  if (!found) throw new Error(`Missing ${name} button`);
  return found;
}

function typeUrl(value: string) {
  const input = document.body.querySelector<HTMLInputElement>('input[aria-label="URL to ingest"]');
  if (!input) throw new Error('Missing URL input');
  flushSync(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 20));
  flushSync(() => {});
}

afterEach(() => {
  ingestImpl = () => Promise.resolve({ source: { id: 'src-1' } });
  ingestCalls.length = 0;
  document.body.innerHTML = '';
});

test('Cancel is disabled while an ingest is pending and the late result is still delivered once', async () => {
  let release!: (value: unknown) => void;
  ingestImpl = () => new Promise((resolve) => { release = resolve; });
  const closed: number[] = [];
  const ingested: string[] = [];
  const view = render(true, () => closed.push(1), (id) => ingested.push(id));
  try {
    typeUrl('https://example.com');
    flushSync(() => button('Ingest URL').click());
    await settle();
    expect(button('Cancel').disabled).toBe(true);
    flushSync(() => button('Cancel').click());
    expect(closed).toEqual([]);

    release({ source: { id: 'src-9' } });
    await settle();
    expect(ingested).toEqual(['src-9']);
    expect(closed).toEqual([1]);
  } finally {
    view.unmount();
  }
});

test('a closed dialog reopens with Allow private hosts cleared', async () => {
  const view = render(true, () => undefined, () => undefined);
  try {
    const checkbox = () => document.body.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const box = checkbox();
    if (!box) throw new Error('Missing Allow private hosts checkbox');
    flushSync(() => box.click());
    expect(checkbox()?.checked).toBe(true);
    view.show(false);
    await settle();
    view.show(true);
    await settle();
    expect(checkbox()?.checked).toBe(false);
  } finally {
    view.unmount();
  }
});
