import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useDaemonHealth } from './useDaemonHealth';
import { client as platformClient } from '../lib/goodvibes';
import { closeRelayClient, setActiveRoute } from '../lib/relay-connection';
import { nativeRequestPrimitives } from '../test-setup';

const cleanups: (() => void)[] = [];
const nativeResponse = nativeRequestPrimitives.Response;
const domRequestPrimitives = {
  Request: globalThis.Request,
  Headers: globalThis.Headers,
  AbortController: globalThis.AbortController,
  AbortSignal: globalThis.AbortSignal,
};

async function until(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 4_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise<void>(resolve => setImmediate(resolve));
    flushSync(() => {});
  }
}

interface Source { readonly controller: ReadableStreamDefaultController<Uint8Array> }

/** Serves the health stream from a body the test writes frames into. */
function installStreamFetch(): Source[] {
  const originalFetch = globalThis.fetch;
  const sources: Source[] = [];
  globalThis.fetch = Object.assign((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.pathname).toBe('/api/control-plane/events');
    const body = new ReadableStream<Uint8Array>({ start(controller) { sources.push({ controller }); } });
    return Promise.resolve(new nativeResponse(body, { headers: { 'Content-Type': 'text/event-stream' } }));
  }, { preconnect: (...args: Parameters<typeof fetch.preconnect>) => nativeRequestPrimitives.fetch.preconnect(...args) });
  cleanups.push(() => {
    globalThis.fetch = originalFetch;
    for (const source of sources) { try { source.controller.close(); } catch { /* already closed */ } }
  });
  return sources;
}

function renderHealth() {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, gcTime: 0 } } });
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  function Probe() {
    return <output data-sse={useDaemonHealth().sse} />;
  }
  flushSync(() => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
  cleanups.push(() => { flushSync(() => root.unmount()); container.remove(); client.clear(); });
  return () => container.querySelector('output')?.getAttribute('data-sse');
}

const READY = new TextEncoder().encode('event: ready\ndata: {}\n\n');

beforeEach(() => {
  Object.assign(globalThis, {
    Request: nativeRequestPrimitives.Request,
    Headers: nativeRequestPrimitives.Headers,
    AbortController: nativeRequestPrimitives.AbortController,
    AbortSignal: nativeRequestPrimitives.AbortSignal,
  });
  closeRelayClient(); setActiveRoute('direct'); platformClient.auth.clearToken();
});
afterEach(() => {
  try { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); }
  finally {
    closeRelayClient(); setActiveRoute('direct'); platformClient.auth.clearToken();
    Object.assign(globalThis, domRequestPrimitives);
  }
});

describe('health stream state on an idle daemon', () => {
  test('the daemon ready frame makes the stream active without any turn event', async () => {
    const sources = installStreamFetch();
    const state = renderHealth();
    await until(() => sources.length === 1, 'The stream was not opened');
    expect(state()).toBe('connecting');
    sources[0]?.controller.enqueue(READY);
    await until(() => state() === 'active', 'ready frame did not make the stream active');
  }, 10_000);

  test('after a stream failure the reconnect ready frame leaves the error state', async () => {
    const sources = installStreamFetch();
    const state = renderHealth();
    await until(() => sources.length === 1, 'The stream was not opened');
    sources[0]?.controller.enqueue(READY);
    await until(() => state() === 'active', 'first ready frame did not make the stream active');
    sources[0]?.controller.error(new Error('connection reset'));
    await until(() => state() === 'error', 'a stream failure did not pause health');
    await until(() => sources.length === 2, 'the platform did not reconnect');
    sources[1]?.controller.enqueue(READY);
    await until(() => state() === 'active', 'the reconnect ready frame did not leave the error state');
  }, 10_000);
});
