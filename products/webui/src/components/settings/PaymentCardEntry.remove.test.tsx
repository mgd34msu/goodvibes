import { afterEach, beforeEach, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../lib/toast';
import { PaymentCardEntry } from './PaymentCardEntry';

const CARD = {
  id: 'card-1', label: 'errands card', brand: 'Visa', last4: '5556', kind: 'virtual', expiryMonth: 9, expiryYear: 2029,
  issuerCapMinorUnits: null, addedAt: '2026-07-27T00:00:00.000Z', materialComplete: true,
};
const originalFetch = globalThis.fetch;
const cleanups: (() => void)[] = [];
let stored = true;
let calls: { url: string; method: string; body: string | undefined }[] = [];

beforeEach(() => {
  stored = true; calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? String(init.body) : undefined });
    const isList = method === 'GET' && url.includes('/api/payments/cards');
    if (!isList) { stored = false; return Response.json({ id: 'card-1', deleted: true, secretsCleared: 4 }); }
    return Response.json({ cards: stored ? [CARD] : [] });
  }) as typeof fetch;
});
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); globalThis.fetch = originalFetch; });

async function until(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check()) { if (Date.now() > end) throw new Error('Card list did not settle'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test('Remove asks first, then deletes the card by id and the row disappears after the refetch', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(
    <QueryClientProvider client={client}><ToastProvider><PaymentCardEntry /></ToastProvider></QueryClientProvider>,
  ));
  cleanups.push(() => { flushSync(() => root.unmount()); client.clear(); container.remove(); });
  await until(() => container.querySelector('[aria-label="Remove card errands card"]') !== null);
  flushSync(() => (container.querySelector('[aria-label="Remove card errands card"]') as HTMLElement).click());
  await until(() => document.body.querySelector('.gv-confirm') !== null);
  expect(calls.filter(call => call.method !== 'GET')).toEqual([]);
  flushSync(() => (document.body.querySelector('.gv-confirm__confirm') as HTMLElement).click());
  await until(() => container.querySelector('[data-testid="payment-card-list"]') === null);
  const writes = calls.filter(call => call.method !== 'GET');
  expect(writes).toHaveLength(1);
  expect(`${writes[0]!.url} ${writes[0]!.body ?? ''}`).toContain('card-1');
});
