/**
 * ModelPricesModal, the commit path: a saved table is written once under
 * pricing.modelPrices and announced; a refused write tells the operator and
 * the editor keeps the failure visible instead of reporting success.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../lib/toast';
import { ToastViewport } from '../toast/ToastViewport';

const setCalls: [string, unknown][] = [];
let setFails = false;
const HAIKU = { 'anthropic:claude-3-5-haiku': { input: 0.8, output: 4 } };
let daemonPrices: Record<string, { input: number; output: number }> = HAIKU;

mock.module('../../lib/goodvibes', () => ({
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: () => Promise.resolve({}),
  runBrowserJudgment: () => Promise.reject(new Error('No semantic reading in this display fixture.')),
  client: {
    operator: {
      config: {
        get: () => Promise.resolve({ pricing: { modelPrices: daemonPrices } }),
        set: (key: string, value: unknown) => {
          setCalls.push([key, value]);
          return setFails ? Promise.reject(new Error('config refused')) : Promise.resolve({ success: true });
        },
      },
    },
  },
}));

const { ModelPricesModal } = await import('./ModelPricesModal');

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(
          ToastProvider,
          null,
          React.createElement(ModelPricesModal, { open: true, onClose: () => {} }),
          React.createElement(ToastViewport),
        ),
      ),
    );
  });
  return {
    el: document.body,
    unmount: () => {
      flushSync(() => root.unmount());
      client.clear();
      container.remove();
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !predicate(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => {});
  }
  if (!predicate()) throw new Error('waitFor: condition never held');
}

function click(el: Element | null | undefined): void {
  flushSync(() => {
    el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

afterEach(() => {
  setCalls.length = 0;
  setFails = false;
  daemonPrices = HAIKU;
});

describe('ModelPricesModal', () => {
  test('removing a price writes the remaining table to pricing.modelPrices and confirms it', async () => {
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('button[aria-label="Remove price for anthropic:claude-3-5-haiku"]')));
    click(el.querySelector('button[aria-label="Remove price for anthropic:claude-3-5-haiku"]'));
    await waitFor(() => (el.textContent ?? '').includes('Model prices saved'));
    expect(setCalls).toEqual([['pricing.modelPrices', {}]]);
    unmount();
  });

  test('a refused write shows the failure, never the success notice', async () => {
    setFails = true;
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('button[aria-label="Remove price for anthropic:claude-3-5-haiku"]')));
    click(el.querySelector('button[aria-label="Remove price for anthropic:claude-3-5-haiku"]'));
    await waitFor(() => (el.textContent ?? '').includes('Failed to save model prices'));
    expect(el.textContent).toContain('config refused');
    expect(el.textContent).not.toContain('Model prices saved');
    expect(el.querySelector('[data-model-key="anthropic:claude-3-5-haiku"]')).not.toBeNull();
    unmount();
  });

  test('removing a price keeps a price another client added after the modal loaded', async () => {
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('button[aria-label="Remove price for anthropic:claude-3-5-haiku"]')));
    // The modal's cached table still shows one row; the daemon now holds two.
    daemonPrices = { ...HAIKU, 'openai:added-elsewhere': { input: 1, output: 2 } };
    click(el.querySelector('button[aria-label="Remove price for anthropic:claude-3-5-haiku"]'));
    await waitFor(() => (el.textContent ?? '').includes('Model prices saved'));
    expect(setCalls).toEqual([['pricing.modelPrices', { 'openai:added-elsewhere': { input: 1, output: 2 } }]]);
    unmount();
  });
});
