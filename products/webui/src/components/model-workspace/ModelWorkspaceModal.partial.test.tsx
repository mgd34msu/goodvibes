/**
 * A helper/tool pick is several config writes in a row. When a later one is
 * refused the earlier ones are already stored, so the dialog must re-read the
 * config and the toast must say what was and was not applied.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../lib/toast';
import { ToastViewport } from '../toast/ToastViewport';

const PROVIDERS_RESPONSE = {
  providers: [
    {
      providerId: 'openai',
      active: true,
      configured: true,
      models: [{ id: 'gpt-5', registryKey: 'openai:gpt-5', displayName: 'GPT-5' }],
    },
  ],
};

let configGetCalls = 0;
const configSetCalls: string[] = [];

mock.module('../../lib/goodvibes', () => ({
  client: {
    operator: {
      providers: { list: () => Promise.resolve(PROVIDERS_RESPONSE) },
      models: {
        current: {
          get: () => Promise.resolve({ model: null }),
          set: () => Promise.resolve({}),
        },
      },
      config: {
        get: () => {
          configGetCalls += 1;
          return Promise.resolve({ helper: { enabled: false, globalProvider: '', globalModel: '' } });
        },
        set: (key: string) => {
          configSetCalls.push(key);
          return key === 'helper.globalModel' ? Promise.reject(new Error('model refused')) : Promise.resolve({ success: true });
        },
      },
    },
  },
}));

const { ModelWorkspaceModal } = await import('./ModelWorkspaceModal');

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
          React.createElement(ModelWorkspaceModal, { open: true, onClose: () => {} }),
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

function click(el: Element | null | undefined) {
  flushSync(() => {
    el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

afterEach(() => {
  configGetCalls = 0;
  configSetCalls.length = 0;
});

describe('ModelWorkspaceModal partial target write', () => {
  test('a refused second key re-reads config and names the failed and stored keys', async () => {
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[role="radiogroup"]')));
    click([...el.querySelectorAll('[role="radio"]')].find((t) => t.textContent === 'Helper Model'));
    await waitFor(() => el.textContent?.includes('GPT-5') ?? false);
    const readsBefore = configGetCalls;
    click([...el.querySelectorAll('.model-workspace-row')].find((r) => r.textContent?.includes('GPT-5'))?.querySelector('button'));
    await waitFor(() => (el.textContent ?? '').includes('partly applied'));
    expect(configSetCalls).toEqual(['helper.globalProvider', 'helper.globalModel']);
    expect(el.textContent).toContain('Could not set helper.globalModel: model refused');
    expect(el.textContent).toContain('Already stored: helper.globalProvider');
    await waitFor(() => configGetCalls > readsBefore);
    unmount();
  });
});
