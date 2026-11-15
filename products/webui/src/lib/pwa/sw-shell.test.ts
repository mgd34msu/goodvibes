/**
 * Opening the app after an upgrade must load the daemon's current shell, not a
 * cached one naming chunks the daemon no longer serves. Offline still opens
 * from the cache. Runs the real public/sw.js fetch handler.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SW_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../public/sw.js');

function navigate(
  network: () => Promise<Response>,
  cachedShell: string | undefined,
  stored: Map<string, Response> = new Map(),
): Promise<Response> {
  const handlers: Record<string, (event: unknown) => void> = {};
  const pending: Promise<unknown>[] = [];
  if (cachedShell !== undefined) stored.set('/index.html', new Response(cachedShell));
  const cache = {
    match: async (key: string) => stored.get(key)?.clone(),
    put: async (key: string, response: Response) => { stored.set(key, response); },
  };
  const fakeSelf = {
    location: { origin: 'https://daemon.invalid' },
    addEventListener: (type: string, handler: (event: unknown) => void) => { handlers[type] = handler; },
    clients: { claim: () => Promise.resolve() },
  };
  new Function('self', 'caches', 'fetch', readFileSync(SW_PATH, 'utf8'))(fakeSelf, { open: async () => cache }, network);
  let responded: Promise<Response> | undefined;
  handlers.fetch?.({
    request: { url: 'https://daemon.invalid/?view=sessions', mode: 'navigate', method: 'GET' },
    respondWith: (response: Promise<Response>) => { responded = response; },
    waitUntil: (work: Promise<unknown>) => { pending.push(work); },
  });
  if (!responded) throw new Error('The service worker did not answer the navigation');
  return responded.then(async (response) => {
    await Promise.all(pending);
    return response;
  });
}

describe('sw.js navigation shell', () => {
  test('a reachable daemon serves its current shell instead of the cached one', async () => {
    const response = await navigate(async () => new Response('new shell', { headers: { 'content-type': 'text/html' } }), 'old shell');
    expect(await response.text()).toBe('new shell');
  });

  test('a navigation that answers with something other than HTML never replaces the cached shell', async () => {
    const stored = new Map<string, Response>();
    const response = await navigate(
      async () => new Response('{"status":"ok"}', { headers: { 'content-type': 'application/json' } }),
      'old shell',
      stored,
    );
    expect(await response.text()).toBe('{"status":"ok"}');
    expect(await stored.get('/index.html')?.text()).toBe('old shell');
  });

  test('an HTML navigation refreshes the cached shell', async () => {
    const stored = new Map<string, Response>();
    await navigate(async () => new Response('new shell', { headers: { 'content-type': 'text/html; charset=utf-8' } }), 'old shell', stored);
    expect(await stored.get('/index.html')?.text()).toBe('new shell');
  });

  test('an unreachable daemon still opens the cached shell', async () => {
    const response = await navigate(() => Promise.reject(new TypeError('offline')), 'old shell');
    expect(await response.text()).toBe('old shell');
  });

  test('a daemon that does not answer in time falls back to the cached shell', async () => {
    const response = await navigate(() => new Promise<Response>(() => {}), 'old shell');
    expect(await response.text()).toBe('old shell');
  });
});
