import { afterEach, beforeEach, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PaymentWindows } from './PaymentWindows';
import { tokenStore, invalidateClientLifetime } from '../../lib/client-lifetime';
import type { PaymentOperationView } from '@goodvibes-jev/engine/sdk/platform/payments/browser';

const originalFetch = globalThis.fetch;
const cleanups: (() => void)[] = [];
const window = { purchaseId: 'purchase', windowId: 'exact-window-revision', kind: 'approval', notice: 'Approval needed: the full total exceeds your requested maximum.\nTOTAL: USD 25.00\nRequested maximum: USD 20.00', deadlineMs: Date.now() + 60_000 };
const requests: { path: string; headers: Headers; body: unknown }[] = [];
let pending = true, answerStatus = 200;
let operations: PaymentOperationView[] = [];
let delay: Promise<void> | undefined;
function barrier() { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); return { wait, release }; }
async function until(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check()) { if (Date.now() > end) throw new Error('Purchase UI fixture did not settle'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function render() {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(React.createElement(QueryClientProvider, { client: query }, React.createElement(PaymentWindows))));
  cleanups.push(() => { flushSync(() => root.unmount()); query.clear(); container.remove(); });
  return container;
}
function button(container: HTMLElement, text: string) {
  const found = [...container.querySelectorAll('button')].find(node => node.textContent === text);
  if (!found) throw new Error(`Missing purchase UI control ${text}`);
  return found;
}

beforeEach(async () => {
  pending = true; answerStatus = 200; delay = undefined; requests.length = 0; operations = [];
  await tokenStore.setToken('fixture-paired-owner-token');
  globalThis.fetch = (async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const body: unknown = typeof options?.body === 'string' ? JSON.parse(options.body) : undefined;
    requests.push({ path: url.pathname, headers: new Headers(options?.headers), body });
    if (url.pathname === '/api/payments/purchase/status') return Response.json({ windows: pending ? [window] : [], operations });
    if (url.pathname === '/api/payments/purchase/cancel') {
      await delay;
      if (answerStatus !== 200) return Response.json({ error: 'FAILED_PRECONDITION', message: 'This purchase is no longer current.' }, { status: answerStatus });
      const operation = operations[0]; if (!operation) throw new Error('Missing operation fixture');
      operations = [{ ...operation, state: 'cancelling' }];
      return Response.json({ purchaseId: operation.purchaseId, operationId: operation.operationId, accepted: true,
        mayHaveSubmitted: operation.phase === 'submit-pending' || operation.phase === 'submitted' });
    }
    if (url.pathname === '/api/payments/purchase/approve' || url.pathname === '/api/payments/purchase/deny') {
      await delay;
      if (answerStatus !== 200) return Response.json({ error: 'FAILED_PRECONDITION', message: 'This window is no longer current.' }, { status: answerStatus });
      pending = false;
      return Response.json({ purchaseId: window.purchaseId, windowId: window.windowId, accepted: true,
        answer: url.pathname.endsWith('/approve') ? 'approve' : 'deny' });
    }
    throw new Error(`Unexpected purchase UI request ${url.pathname}`);
  }) as typeof fetch;
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  globalThis.fetch = originalFetch;
  await tokenStore.clearToken();
});

test('the visible notice and deadline lead to one exact owner answer through the real browser transport', async () => {
  const container = render();
  await until(() => container.textContent?.includes(window.notice) === true);
  expect(container.textContent).toContain('Deadline:');
  button(container, 'Approve purchase').click();
  await until(() => container.textContent?.includes('Answer accepted.') === true);
  const answers = requests.filter(request => request.path.endsWith('/approve'));
  expect(answers).toHaveLength(1);
  expect(answers[0]?.body).toEqual({ purchaseId: window.purchaseId, windowId: window.windowId, confirm: true });
  expect(answers[0]?.headers.get('x-goodvibes-explicit-user-request')).toBe('true');
  expect(answers[0]?.headers.get('authorization')).toBe('Bearer fixture-paired-owner-token');
  expect(requests.filter(request => request.path.endsWith('/status')).every(request => !request.headers.has('x-goodvibes-explicit-user-request'))).toBe(true);
  expect(container.textContent).not.toContain('Purchase completed');
});

test('a stale answer is not retried or sent for model interpretation', async () => {
  answerStatus = 409;
  const container = render();
  await until(() => container.textContent?.includes(window.notice) === true);
  button(container, 'Deny purchase').click();
  await until(() => container.textContent?.includes('Refresh the purchase status') === true);
  expect(requests.filter(request => request.path.endsWith('/deny'))).toHaveLength(1);
  expect(requests.every(request => request.path.startsWith('/api/payments/purchase/'))).toBe(true);
});

test('switching the connected client cancels the active answer and removes the old notice', async () => {
  const gate = barrier(); delay = gate.wait;
  const container = render();
  await until(() => container.textContent?.includes(window.notice) === true);
  button(container, 'Approve purchase').click();
  await until(() => requests.some(request => request.path.endsWith('/approve')));
  pending = false;
  invalidateClientLifetime();
  gate.release();
  await until(() => container.textContent?.includes('No purchase window') === true);
  expect(container.textContent).not.toContain(window.notice);
  expect(container.textContent).not.toContain('Answer accepted.');
  expect(requests.filter(request => request.path.endsWith('/approve'))).toHaveLength(1);
});

function operation(): PaymentOperationView {
  return { purchaseId: 'checkout', operationId: 'exact-operation', state: 'running', phase: 'submit-pending',
    createdAtMs: 1, updatedAtMs: 2, totalMinorUnits: 2500, currency: 'USD', outcome: null };
}
test('operation status remains visible without a window and stopping sends the exact original reference once', async () => {
  pending = false; operations = [operation()];
  const container = render(); await until(() => container.textContent?.includes('Checkout checkout') === true);
  expect(container.textContent).toContain('25.00 USD');
  button(container, 'Stop checkout').click();
  await until(() => container.textContent?.includes('does not undo an order') === true);
  const stops = requests.filter(request => request.path.endsWith('/cancel'));
  expect(stops).toHaveLength(1);
  expect(stops[0]?.body).toEqual({ purchaseId: 'checkout', operationId: 'exact-operation', confirm: true });
  expect(stops[0]?.headers.get('x-goodvibes-explicit-user-request')).toBe('true');
  expect(container.textContent).not.toContain('Purchase completed');
});

test('a stale operation stop is not retried and changing clients retires an outstanding stop result', async () => {
  pending = false; operations = [operation()]; answerStatus = 409;
  const container = render(); await until(() => container.textContent?.includes('Checkout checkout') === true);
  button(container, 'Stop checkout').click();
  await until(() => container.textContent?.includes('Refresh purchase status') === true);
  expect(requests.filter(request => request.path.endsWith('/cancel'))).toHaveLength(1);
  const gate = barrier(); delay = gate.wait; answerStatus = 200;
  button(container, 'Stop checkout').click();
  await until(() => requests.filter(request => request.path.endsWith('/cancel')).length === 2);
  invalidateClientLifetime(); gate.release();
  await until(() => requests.filter(request => request.path.endsWith('/status')).length >= 2);
  expect(container.textContent).not.toContain('Stopping was requested after submission');
});
