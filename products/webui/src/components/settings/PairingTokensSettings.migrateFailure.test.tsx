/**
 * When the daemon mints the migrated token but this browser cannot switch to
 * it, the user is told which device is now an unusable orphan.
 */
import { describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../lib/toast';
import { ToastViewport } from '../toast/ToastViewport';

const setExplicitAuthTokenCalls: string[] = [];

mock.module('../../lib/goodvibes', () => ({
  runBrowserJudgment: () => Promise.reject(new Error('No semantic reading in this display fixture.')),
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: () => Promise.resolve({}),
  setExplicitAuthToken: (token: string) => {
    setExplicitAuthTokenCalls.push(token);
    return Promise.reject(new Error('token storage refused'));
  },
  client: {
    operator: {
      pairing: {
        tokens: {
          list: () => Promise.resolve({ tokens: [], legacySharedRevoked: false }),
          migrate: (name: string) =>
            Promise.resolve({ token: { id: 'tok-new', name, token: 'raw-new-token', createdAt: 1 } }),
        },
      },
    },
  },
}));

const { PairingTokensSettings } = await import('./PairingTokensSettings');

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
    flushSync(() => {});
  }
}

describe('PairingTokensSettings migrate failure', () => {
  test('names the orphaned device and never shows the secret when the token swap fails', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(ToastProvider, null, React.createElement(PairingTokensSettings), React.createElement(ToastViewport)),
        ),
      );
    });
    const body = document.body;
    await waitFor(() => (body.textContent ?? '').includes('Give this browser its own token'));
    const button = [...body.querySelectorAll('button')].find((b) => b.textContent?.includes('Give this browser its own token'));
    flushSync(() => button?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    await waitFor(() => Boolean(body.querySelector('.gv-confirm')));
    flushSync(() => body.querySelector('.gv-confirm__confirm')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    await waitFor(() => (body.textContent ?? '').includes('Migrate failed after the token was created'));
    const text = body.textContent ?? '';
    expect(text).toContain('"This browser"');
    expect(text).toContain('revoke it in the list');
    expect(text).not.toContain('raw-new-token');
    expect(setExplicitAuthTokenCalls).toEqual(['raw-new-token']);
    flushSync(() => root.unmount());
    container.remove();
  });
});
