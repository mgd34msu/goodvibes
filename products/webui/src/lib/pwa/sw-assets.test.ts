/**
 * Hashed assets from every past deploy would pile up in the asset cache. Past
 * the cap, the oldest-stored entries (earlier builds) are dropped first and the
 * asset just fetched stays. Runs the real public/sw.js fetch handler.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SW_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../public/sw.js');
const ORIGIN = 'https://daemon.invalid';

test('the asset cache evicts the oldest entries once over its cap and keeps the new one', async () => {
  const handlers: Record<string, (event: unknown) => void> = {};
  const entries = new Map<string, Response>();
  for (let i = 0; i < 300; i += 1) entries.set(`${ORIGIN}/assets/old-${i}.js`, new Response('old'));
  const cache = {
    match: async (request: { url: string }) => entries.get(request.url)?.clone(),
    put: async (request: { url: string }, response: Response) => { entries.set(request.url, response); },
    keys: async () => [...entries.keys()].map((url) => ({ url })),
    delete: async (request: { url: string }) => entries.delete(request.url),
  };
  const fakeSelf = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: (event: unknown) => void) => { handlers[type] = handler; },
    clients: { claim: () => Promise.resolve() },
  };
  const network = async () => {
    const response = new Response('new');
    Object.defineProperty(response, 'type', { value: 'basic' });
    return response;
  };
  new Function('self', 'caches', 'fetch', readFileSync(SW_PATH, 'utf8'))(fakeSelf, { open: async () => cache }, network);

  const pending: Promise<unknown>[] = [];
  let responded: Promise<Response> | undefined;
  handlers.fetch?.({
    request: { url: `${ORIGIN}/assets/new-1.js`, mode: 'no-cors', method: 'GET' },
    respondWith: (response: Promise<Response>) => { responded = response; },
    waitUntil: (work: Promise<unknown>) => { pending.push(work); },
  });
  await responded;
  await Promise.all(pending);

  expect(entries.size).toBe(300);
  expect(entries.has(`${ORIGIN}/assets/new-1.js`)).toBe(true);
  expect(entries.has(`${ORIGIN}/assets/old-0.js`)).toBe(false);
  expect(entries.has(`${ORIGIN}/assets/old-1.js`)).toBe(true);
});
