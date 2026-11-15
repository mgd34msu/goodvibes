import { afterEach, expect, test } from 'bun:test';
import { fetchModelCatalogRepository } from '../platform/src/platform/providers/model-catalog-repository.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('a corrupt archive stops the download instead of reading on to the size limit', async () => {
  let pulls = 0;
  let cancelled = false;
  const chunk = new Uint8Array(1024).fill(7);
  const body = new ReadableStream<Uint8Array>({
    // A macrotask between chunks lets the parser's failure arrive, as network reads do.
    async pull(controller) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      pulls += 1;
      controller.enqueue(chunk);
    },
    cancel() { cancelled = true; },
  });
  globalThis.fetch = (async () => new Response(body)) as unknown as typeof fetch;
  await expect(fetchModelCatalogRepository()).rejects.toThrow();
  expect(cancelled).toBe(true);
  // The 32 MiB download budget is 32768 chunks of this size; a stopped reader is nowhere near it.
  expect(pulls).toBeLessThan(1000);
});
