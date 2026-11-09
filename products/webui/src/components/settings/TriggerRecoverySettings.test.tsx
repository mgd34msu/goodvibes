/** UNRUN browser operator gestures; native manager/catalog behavior is covered
 * by engine/test/trigger-operator-migration.test.ts with actual saved state. */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { client as platformClient } from '../../lib/goodvibes';
import { invalidateClientLifetime, tokenStore } from '../../lib/client-lifetime';
import type { TriggerOperatorStatus } from '@goodvibes-jev/engine/platform/platform/triggers/browser';
let status: TriggerOperatorStatus = { ownership: 'migration-required', migrationRequired: true,
  records: [{ id: 'watch', label: 'Build readiness', kind: 'condition', state: 'idle' }], message: 'Close older GoodVibes instances before migrating.' };
const calls: unknown[] = [];
// Keep the real browser module and its semantic runner/confirmation helpers.
// Only this operator's two transport methods are isolated for these gestures.
const restoreMethods: (() => void)[] = [];
beforeEach(async () => {
  await tokenStore.setToken('synthetic-trigger-operator');
  const operator = platformClient.operator.watchers.triggers;
  const inspect = spyOn(operator, 'status').mockImplementation(async () => status);
  const migrate = spyOn(operator, 'migrate').mockImplementation(async input => {
    calls.push(input);
    status = { ...status, ownership: 'local', migrationRequired: false, message: 'This process owns trigger execution.' };
    return { migrated: true as const, status };
  });
  restoreMethods.push(() => inspect.mockRestore(), () => migrate.mockRestore());
});
const { TriggerRecoverySettings } = await import('./TriggerRecoverySettings');
let mounted: Root | undefined, container: HTMLElement | undefined, client: QueryClient | undefined;
afterEach(async () => {
  if (mounted) flushSync(() => mounted!.unmount()); mounted = undefined; container?.remove(); client?.clear(); calls.length = 0;
  for (const restore of restoreMethods.splice(0).reverse()) restore();
  await tokenStore.clearToken();
  status = { ownership: 'migration-required', migrationRequired: true, records: [{ id: 'watch', label: 'Build readiness', kind: 'condition', state: 'idle' }], message: 'Close older GoodVibes instances before migrating.' };
});
function render() { const selectedClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); client = selectedClient; container = document.createElement('div'); document.body.appendChild(container); mounted = createRoot(container);
  flushSync(() => mounted!.render(React.createElement(QueryClientProvider, { client: selectedClient }, React.createElement(TriggerRecoverySettings)))); }
function click(element: Element | null) { if (!element) throw new Error('Expected actual control'); flushSync(() => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))); }
function button(label: string) { return [...document.body.querySelectorAll('button')].find(element => element.textContent === label) ?? null; }
async function until(predicate: () => boolean) { const end = Date.now() + 2000; while (!predicate()) { if (Date.now() > end) throw new Error('UI did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); flushSync(() => {}); } }

test('real visible affected record and two explicit owner gestures precede migration', async () => {
  render(); await until(() => !!button('Migrate supervised triggers'));
  expect(document.body.textContent).toContain('Build readiness'); expect(button('Migrate supervised triggers')?.disabled).toBe(true); expect(calls).toEqual([]);
  click(document.body.querySelector('input[type="checkbox"]')); expect(button('Migrate supervised triggers')?.disabled).toBe(false);
  click(button('Migrate supervised triggers')); await until(() => !!button('Migrate triggers')); expect(calls).toEqual([]);
  click(button('Migrate triggers')); await until(() => calls.length === 1);
  expect(calls).toEqual([{ olderInstancesClosed: true, confirm: true }]);
});

test('cancelled confirmation never changes trigger state', async () => {
  render(); await until(() => !!button('Migrate supervised triggers')); click(document.body.querySelector('input[type="checkbox"]')); click(button('Migrate supervised triggers'));
  await until(() => !!button('Migrate triggers')); click(button('Cancel')); expect(calls).toEqual([]);
});

test('another process remains inspectable and has no migration control', async () => {
  status = { ...status, ownership: 'other-process', migrationRequired: false, message: 'Another GoodVibes process owns these triggers.' };
  render(); await until(() => !!button('Refresh trigger status') && document.body.textContent!.includes('Another GoodVibes process'));
  expect(document.body.textContent).toContain('Build readiness'); expect(button('Migrate supervised triggers')).toBeNull(); expect(calls).toEqual([]);
});

test('changed operator identity during confirmation cannot send the old acknowledgement to the new selection', async () => {
  render(); await until(() => !!button('Migrate supervised triggers')); click(document.body.querySelector('input[type="checkbox"]')); click(button('Migrate supervised triggers'));
  await until(() => !!button('Migrate triggers')); flushSync(() => invalidateClientLifetime()); click(button('Migrate triggers'));
  await new Promise(resolve => setTimeout(resolve, 20)); expect(calls).toEqual([]);
});

test('confirmation resolved just before unmount cannot dispatch from the closed owner view', async () => {
  render(); await until(() => !!button('Migrate supervised triggers')); click(document.body.querySelector('input[type="checkbox"]')); click(button('Migrate supervised triggers'));
  await until(() => !!button('Migrate triggers')); click(button('Migrate triggers'));
  flushSync(() => mounted!.unmount()); mounted = undefined;
  await new Promise(resolve => setTimeout(resolve, 20)); expect(calls).toEqual([]);
});
