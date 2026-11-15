import { afterEach, beforeEach, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { TelegramCursorRecovery } from './TelegramCursorRecovery';
import { tokenStore, invalidateClientLifetime } from '../../lib/client-lifetime';

const originalFetch = globalThis.fetch, cleanups: (() => void)[] = [];
const preview = { state: 'unbound', previewId: 'telegram-cursor:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  accountId: '111', username: 'original_bot', offset: 501, updatedAt: '2026-11-08T12:00:00.000Z', expiresAtMs: Date.now() + 300_000 };
let commitStarted = false;
let release!: () => void;
async function until(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check()) { if (Date.now() > end) throw new Error('Cursor recovery UI did not settle'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function button(container: HTMLElement, label: string) {
  const found = [...container.querySelectorAll('button')].find(node => node.textContent === label);
  if (!found) throw new Error(`Missing control ${label}`);
  return found;
}
beforeEach(async () => {
  commitStarted = false;
  const gate = new Promise<void>(done => { release = done; });
  await tokenStore.setToken('synthetic-administrative-token');
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const actionId = url.pathname.split('/').at(-1);
    if (actionId === 'cursor-migration-preview') return Response.json({ surface: 'telegram', actionId, result: preview });
    commitStarted = true;
    await gate;
    return Response.json({ surface: 'telegram', actionId, result: { state: 'migrated', accountId: '111', offset: 501, running: true, message: 'Saved and polling restarted.' } });
  }) as typeof fetch;
});
afterEach(async () => { release(); for (const cleanup of cleanups.splice(0)) cleanup(); globalThis.fetch = originalFetch; await tokenStore.clearToken(); });

test('switching the connection while the cursor write is in flight says its outcome is unknown', async () => {
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container); flushSync(() => root.render(React.createElement(TelegramCursorRecovery)));
  cleanups.push(() => { flushSync(() => root.unmount()); container.remove(); });
  button(container, 'Review saved Telegram cursor').click();
  await until(() => container.querySelector('input[type="checkbox"]') !== null);
  container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
  await until(() => !button(container, 'Keep saved position and restart polling').disabled);
  button(container, 'Keep saved position and restart polling').click();
  await until(() => commitStarted);
  flushSync(() => invalidateClientLifetime());
  await until(() => container.textContent?.includes('whether it was saved is unknown') === true);
  expect(container.textContent).not.toContain('Saved and polling restarted.');
});
