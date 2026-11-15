import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../../lib/toast';

const requests: { battery: string; keys: string[] }[] = [];
const extra: Record<string, number> = {};
for (let index = 0; index < 65; index++) extra[`zz_unlisted_${String(index).padStart(2, '0')}`] = index;

mock.module('../../../lib/goodvibes', () => ({
  runBrowserJudgment: async (request: { battery: string; input: { keys: string[] } }) => {
    requests.push({ battery: request.battery, keys: request.input.keys });
    throw new Error('No semantic reading fixture');
  },
  client: { operator: { config: { get: () => Promise.resolve({ display: { theme: 'nord' }, unlisted: extra }) } } },
}));
const { ConfigSettingsProvider, useConfigSettings } = await import('./ConfigSettings');

function Probe() {
  useConfigSettings();
  return null;
}

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); requests.length = 0; });

describe('config key classification', () => {
  test('more than 64 unresolved names are read in batches instead of being left unclassified', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    flushSync(() => root.render(
      <QueryClientProvider client={client}><ToastProvider><ConfigSettingsProvider><Probe /></ConfigSettingsProvider></ToastProvider></QueryClientProvider>,
    ));
    cleanups.push(() => { flushSync(() => root.unmount()); client.clear(); el.remove(); });
    const start = Date.now();
    while (requests.length < 4) {
      if (Date.now() - start > 2000) throw new Error('classification was never requested');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (const battery of ['webui.config.credential-key', 'webui.settings.card-material-key']) {
      const sizes = requests.filter((request) => request.battery === battery).map((request) => request.keys.length).sort((a, b) => b - a);
      expect(sizes).toEqual([64, 1]);
    }
    expect(new Set(requests.flatMap((request) => request.keys)).size).toBe(65);
  });
});
