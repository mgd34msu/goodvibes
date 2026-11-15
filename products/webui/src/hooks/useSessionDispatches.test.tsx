import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getClientLifetime, tokenStore, WEBUI_TOKEN_STORE_KEY } from '../lib/client-lifetime';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let steerSignals: (AbortSignal | undefined)[] = [];
let settleSteer: (value: unknown) => void = () => undefined;
mock.module('../lib/goodvibes', () => ({
  DEFAULT_SSE_RECONNECT: { enabled: true },
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: () => Promise.resolve({}),
  hasStoredTokenSync: () => Boolean(localStorage.getItem(WEBUI_TOKEN_STORE_KEY)),
  client: { operator: { sessions: {
    steer: (_id: string, _body: unknown, signal?: AbortSignal) => {
      steerSignals.push(signal);
      return new Promise((resolve) => { settleSteer = resolve; });
    },
    followUp: () => Promise.reject(new Error('unused')),
    inputs: { list: () => Promise.resolve({ inputs: [] }) },
  } } },
}));
const { useSessionDispatches } = await import('./useSessionDispatches');

beforeEach(async () => { await tokenStore.setToken('synthetic-dispatch-account'); });
afterEach(async () => { await tokenStore.clearToken(); });

test('leaving the composer does not abort a sent steer, and the result still refreshes the session lists', async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidated: unknown[] = [];
  const original = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = ((filters: { queryKey?: unknown }) => { invalidated.push(filters?.queryKey); return original(filters as never); }) as typeof queryClient.invalidateQueries;
  const el = document.createElement('div'); document.body.append(el);
  const root = createRoot(el);
  let send: ((body: string, mode: 'steer' | 'followUp') => boolean) | undefined;
  function Harness() {
    send = useSessionDispatches(getClientLifetime(), 's-1', false).send;
    return null;
  }
  await act(async () => { root.render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>); });
  await act(async () => { send?.('go on', 'steer'); });
  expect(steerSignals).toHaveLength(1);
  await act(async () => { root.unmount(); });
  expect(steerSignals[0]?.aborted).toBe(false);
  await act(async () => { settleSteer({ input: { id: 'i-1', sessionId: 's-1', state: 'queued', updatedAt: 1 } }); });
  expect(invalidated).toContainEqual(['sessions']);
  el.remove(); queryClient.clear();
});
