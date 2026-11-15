/**
 * DeviceGrants, a refused revoke must be visible: the grant stays in force and
 * the operator is told so, never left believing a durable grant was removed.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const revokeCalls: unknown[] = [];
let revokeFails = true;
let grantsListCalls = 0;

const grant = {
  grantId: 'g-1',
  nodeId: 'n-1',
  nodeKind: 'phone',
  capabilityId: 'camera',
  capabilityTitle: 'Camera capture',
  grantedAt: 1_700_000_000_000,
  expiresAt: null,
  useCount: 2,
  lastUsedAt: null,
};

mock.module('../../lib/goodvibes', () => ({
  runBrowserJudgment: () => Promise.reject(new Error('No semantic reading in this display fixture.')),
  invokeMethod: (method: string, input: unknown) => {
    if (method === 'devices.grants.list') {
      grantsListCalls += 1;
      return Promise.resolve({ grants: [grant], audit: [] });
    }
    if (method === 'devices.nodes.list') return Promise.resolve({ nodes: [{ nodeId: 'n-1', label: 'Pixel' }], captureRetentionHours: 24 });
    if (method === 'devices.grants.revoke') {
      revokeCalls.push(input);
      return revokeFails ? Promise.reject(new Error('daemon refused the revoke')) : Promise.resolve({ revoked: true });
    }
    return Promise.resolve({});
  },
}));

const { DeviceGrants } = await import('./DeviceGrants');

function render(): { el: HTMLElement; unmount: () => void } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(React.createElement(QueryClientProvider, { client }, React.createElement(DeviceGrants)));
  });
  return {
    el: document.body,
    unmount: () => {
      flushSync(() => root.unmount());
      container.remove();
    },
  };
}

function click(el: Element | null | undefined): void {
  flushSync(() => {
    el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => {});
  }
  if (!predicate()) throw new Error('waitFor: condition never held');
}

afterEach(() => {
  revokeCalls.length = 0;
  revokeFails = true;
  grantsListCalls = 0;
});

describe('DeviceGrants revoke', () => {
  test('a refused revoke shows an alert and the grant row remains', async () => {
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[aria-label="Revoke Camera capture"]')));
    click(el.querySelector('[aria-label="Revoke Camera capture"]'));
    await waitFor(() => Boolean(el.querySelector('.gv-confirm')));
    click(el.querySelector('.gv-confirm__confirm'));
    await waitFor(() => Boolean(el.querySelector('[role="alert"]')));
    expect(revokeCalls).toEqual([{ grantId: 'g-1' }]);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('daemon refused the revoke');
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('still in force');
    expect(el.querySelector('[aria-label="Revoke Camera capture"]')).not.toBeNull();
    unmount();
  });

  test('a refused revoke re-reads the grants so the list shows what the daemon honours', async () => {
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[aria-label="Revoke Camera capture"]')));
    const before = grantsListCalls;
    click(el.querySelector('[aria-label="Revoke Camera capture"]'));
    await waitFor(() => Boolean(el.querySelector('.gv-confirm')));
    click(el.querySelector('.gv-confirm__confirm'));
    await waitFor(() => grantsListCalls > before);
    unmount();
  });
});
