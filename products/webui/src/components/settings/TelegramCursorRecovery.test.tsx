import { afterEach, beforeEach, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { TelegramCursorRecovery } from './TelegramCursorRecovery';
import { tokenStore, invalidateClientLifetime } from '../../lib/client-lifetime';

const originalFetch = globalThis.fetch, cleanups: (() => void)[] = [];
const preview = { state: 'unbound', previewId: 'telegram-cursor:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  accountId: '111', username: 'original_bot', offset: 501, updatedAt: '2026-11-08T12:00:00.000Z', expiresAtMs: Date.now() + 300_000 };
const requests: { path: string; body: unknown; headers: Headers }[] = [];
let responseStatus = 200, delay: Promise<void> | undefined;
async function until(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check()) { if (Date.now() > end) throw new Error('Cursor recovery UI did not settle'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function render() {
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container); flushSync(() => root.render(React.createElement(TelegramCursorRecovery)));
  cleanups.push(() => { flushSync(() => root.unmount()); container.remove(); }); return container;
}
function findButton(container: HTMLElement, label: string) {
  return [...container.querySelectorAll('button')].find(node => node.textContent === label);
}
function button(container: HTMLElement, label: string) {
  const result = findButton(container, label);
  if (!result) throw new Error(`Missing cursor recovery control ${label}`); return result;
}
beforeEach(async () => {
  requests.length = 0; responseStatus = 200; delay = undefined;
  await tokenStore.setToken('synthetic-administrative-token');
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    requests.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined, headers: new Headers(init?.headers) });
    const actionId = url.pathname.split('/').at(-1);
    if (actionId === 'cursor-migration-preview') { await delay; return Response.json({ surface: 'telegram', actionId, result: preview }); }
    if (actionId === 'cursor-migration-commit') {
      if (responseStatus !== 200) return Response.json({ error: 'The preview is no longer current' }, { status: responseStatus });
      return Response.json({ surface: 'telegram', actionId, result: { state: 'migrated', accountId: '111', offset: 501, running: true, message: 'Saved and polling restarted.' } });
    }
    throw new Error('Unexpected cursor recovery route');
  }) as typeof fetch;
});
afterEach(async () => { for (const cleanup of cleanups.splice(0)) cleanup(); globalThis.fetch = originalFetch; await tokenStore.clearToken(); });

test('visible bot confirmation sends one exact migration through the canonical browser transport', async () => {
  const container = render(); expect(requests).toEqual([]);
  button(container, 'Review saved Telegram cursor').click();
  await until(() => container.textContent?.includes('@original_bot') === true);
  const save = button(container, 'Keep saved position and restart polling'); expect(save.disabled).toBe(true);
  const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]'); if (!checkbox) throw new Error('Missing owner confirmation');
  checkbox.click(); await until(() => !save.disabled); save.click();
  await until(() => container.textContent?.includes('Saved and polling restarted.') === true);
  const writes = requests.filter(request => request.path.endsWith('cursor-migration-commit'));
  expect(writes).toHaveLength(1); expect(writes[0]?.body).toEqual({ previewId: preview.previewId, confirm: true });
  expect(writes[0]?.headers.get('authorization')).toBe('Bearer synthetic-administrative-token');
  expect(writes[0]?.headers.get('x-goodvibes-explicit-user-request')).toBe('true');
  expect(requests.every(request => request.path.startsWith('/api/channels/actions/telegram/'))).toBe(true);
});

test('a rejected write requires a new preview and never retries automatically', async () => {
  responseStatus = 409;
  const container = render(); button(container, 'Review saved Telegram cursor').click();
  await until(() => container.querySelector('input[type="checkbox"]') !== null);
  container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
  await until(() => !button(container, 'Keep saved position and restart polling').disabled);
  button(container, 'Keep saved position and restart polling').click();
  await until(() => container.textContent?.includes('before trying again') === true);
  expect(requests.filter(request => request.path.endsWith('cursor-migration-commit'))).toHaveLength(1);
  expect(container.querySelector('input[type="checkbox"]')).toBeNull();
});

test('changing the connected host discards a pending old-host preview and its confirmation', async () => {
  let release!: () => void; delay = new Promise<void>(done => { release = done; });
  cleanups.push(release);
  const container = render(); button(container, 'Review saved Telegram cursor').click();
  await until(() => requests.length === 1);
  invalidateClientLifetime(); release();
  await until(() => findButton(container, 'Review saved Telegram cursor')?.disabled === false);
  expect(requests).toHaveLength(1); // No implicit new-host preview or retry.
  expect(container.textContent).not.toContain('@original_bot'); expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  expect(requests.filter(request => request.path.endsWith('cursor-migration-commit'))).toHaveLength(0);
});
