import { afterEach, expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../lib/toast';

const updates: unknown[] = [];

mock.module('../../lib/goodvibes', () => ({
  hasStoredTokenSync: () => true, GOODVIBES_BASE_URL: 'http://localhost', WEBUI_VERSION: 'test',
  runBrowserJudgment: async () => { throw new Error('No judgments in this fixture'); },
  readBrowserDecisionPolicy: async () => ({ policy: 'Default - On', operation: 'decision', reason: null, revision: 0 }),
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: () => Promise.resolve({}),
  client: {
    operator: {
      principals: {
        list: () => Promise.resolve({ principals: [{ id: 'p1', name: 'Ada', kind: 'user', identities: [{ channel: 'slack', value: 'U123' }] }] }),
        update: (id: string, input: unknown) => { updates.push({ id, input }); return Promise.resolve({}); },
      },
      channels: {
        profiles: { list: () => Promise.resolve({ bindings: [{ surfaceKind: 'slack' }] }) },
      },
    },
  },
}));

const { PrincipalsView } = await import('./PrincipalsView');
const cleanups: (() => void)[] = [];
afterEach(() => { updates.length = 0; for (const clean of cleanups.splice(0)) clean(); });

async function settle() {
  for (let i = 0; i < 4; i += 1) { await new Promise((r) => setTimeout(r, 0)); flushSync(() => {}); }
}

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const el = document.createElement('div'); document.body.append(el);
  const root = createRoot(el);
  flushSync(() => root.render(<QueryClientProvider client={client}><ToastProvider><PrincipalsView /></ToastProvider></QueryClientProvider>));
  cleanups.push(() => { flushSync(() => root.unmount()); client.clear(); el.remove(); });
  await settle();
  return el;
}

function click(el: Element | null | undefined) { flushSync(() => el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))); }

test('a malformed identity line blocks the save instead of silently dropping the mapping', async () => {
  const el = await mount();
  click(el.querySelector('button[aria-label="Edit Ada"]'));
  await settle();
  const textarea = el.querySelector('textarea') as HTMLTextAreaElement;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'slack U123');
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  expect(el.textContent).toContain('Not a "channel:value" pair: slack U123');
  const save = [...el.querySelectorAll('form button')].find((b) => b.textContent === 'Save') as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  flushSync(() => el.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  await settle();
  expect(document.querySelector('.gv-confirm')).toBeNull();
  expect(updates).toEqual([]);
});

test('editing a binding never lets the channel id be typed, so it cannot create a second binding', async () => {
  const el = await mount();
  click(el.querySelector('button[aria-label="Edit slack"]'));
  await settle();
  const label = [...el.querySelectorAll('label')].find((l) => l.textContent?.startsWith('Channel id'))!;
  const channel = el.querySelector(`#${label.htmlFor}`) as HTMLInputElement;
  expect(channel.disabled).toBe(true);
  const model = el.querySelector(`#${[...el.querySelectorAll('label')].find((l) => l.textContent?.startsWith('Model'))!.htmlFor}`) as HTMLInputElement;
  expect(model.disabled).toBe(false);
});
