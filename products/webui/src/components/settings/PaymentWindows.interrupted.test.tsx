import { afterEach, beforeEach, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PaymentWindows } from './PaymentWindows';
import { tokenStore, invalidateClientLifetime } from '../../lib/client-lifetime';

const originalFetch = globalThis.fetch;
const cleanups: (() => void)[] = [];
const purchaseWindow = { purchaseId: 'purchase', windowId: 'window', kind: 'approval', notice: 'Approval needed.', deadlineMs: Date.now() + 60_000 };
let approveStarted = false;
let release!: () => void;
async function until(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check()) { if (Date.now() > end) throw new Error('Purchase UI fixture did not settle'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
beforeEach(async () => {
  approveStarted = false;
  const gate = new Promise<void>(done => { release = done; });
  await tokenStore.setToken('fixture-paired-owner-token');
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === '/api/payments/purchase/status') return Response.json({ windows: [purchaseWindow], operations: [] });
    approveStarted = true;
    await gate;
    return Response.json({ answer: 'approve' });
  }) as typeof fetch;
});
afterEach(async () => { release(); for (const cleanup of cleanups.splice(0)) cleanup(); globalThis.fetch = originalFetch; await tokenStore.clearToken(); });

test('switching the connection while an answer is in flight says its outcome is unknown', async () => {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(React.createElement(QueryClientProvider, { client: query }, React.createElement(PaymentWindows))));
  cleanups.push(() => { flushSync(() => root.unmount()); query.clear(); container.remove(); });
  await until(() => container.textContent?.includes('Approve purchase') === true);
  [...container.querySelectorAll('button')].find(node => node.textContent === 'Approve purchase')!.click();
  await until(() => approveStarted);
  flushSync(() => invalidateClientLifetime());
  await until(() => container.textContent?.includes('whether the daemon applied it is unknown') === true);
  expect(container.textContent).not.toContain('Answer accepted.');
});
