/**
 * A fetch result must say which of cancel or timeout ended a request, and one
 * malformed URL in a batch must not discard the results of requests already sent.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { executeFetchInput } from '../platform/src/platform/tools/fetch/index.js';

const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

function startServer(delayMs: number): string {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async () => {
      if (delayMs > 0) await Bun.sleep(delayMs);
      return new Response('ok', { headers: { 'content-type': 'text/plain' } });
    },
  });
  servers.push(server);
  return `http://localhost:${server.port}/`;
}

const deps = { isLocalhostAllowed: () => true };

describe('fetch cancel and timeout labels', () => {
  test('a real timeout is reported as a timeout with its duration', async () => {
    const url = startServer(2_000);
    const output = await executeFetchInput({ urls: [{ url, timeout_ms: 100 }] }, deps);
    const result = output.results?.[0];
    expect(result?.error).toStartWith('Timeout after 100ms');
    expect(result?.timed_out).toBe(true);
    expect(result?.cancelled).toBeUndefined();
  });

  test('a caller cancel is reported as cancelled, never as a timeout', async () => {
    const url = startServer(2_000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const output = await executeFetchInput({ urls: [{ url, timeout_ms: 30_000 }] }, { ...deps, signal: controller.signal });
    const result = output.results?.[0];
    expect(result?.error).toStartWith('Cancelled');
    expect(result?.error).not.toContain('Timeout');
    expect(result?.cancelled).toBe(true);
  });

  test('a cancelled sequential batch stops waiting out rate_limit_ms and sends nothing further', async () => {
    const url = startServer(0);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const output = await executeFetchInput(
      { urls: [{ url }, { url }, { url }], parallel: false, rate_limit_ms: 5_000 },
      { ...deps, signal: controller.signal },
    );
    expect(output.results?.[0]?.status).toBe(200);
    expect(output.results?.slice(1).every((r) => r.cancelled === true)).toBe(true);
  });
});

describe('fetch batch with a malformed URL', () => {
  test('sequential: earlier results are kept and the malformed entry carries its own error', async () => {
    const url = startServer(0);
    const output = await executeFetchInput(
      { urls: [{ url, method: 'POST', body: '{}' }, { url: 'nope', params: { a: '1' } }], parallel: false },
      deps,
    );
    expect(output.results).toHaveLength(2);
    expect(output.results?.[0]?.status).toBe(200);
    expect(output.results?.[1]?.error).toContain('Invalid URL: nope');
    expect(output.summary.failed).toBe(1);
  });

  test('parallel: a malformed URL does not fail the whole batch', async () => {
    const url = startServer(0);
    const output = await executeFetchInput({ urls: [{ url }, { url: 'nope', params: { a: '1' } }] }, deps);
    expect(output.results?.[0]?.status).toBe(200);
    expect(output.results?.[1]?.error).toContain('Invalid URL');
  });
});

describe('fetch call-level outcome', () => {
  function startStatusServer(status: number): string {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('nope', { status }) });
    servers.push(server);
    return `http://localhost:${server.port}/`;
  }
  const failedCall = (output: Awaited<ReturnType<typeof executeFetchInput>>) => output.success;

  test('a call where every URL failed, or every response was an HTTP error, is a failed call; any usable response keeps it a success', async () => {
    const bad = await executeFetchInput({ urls: [{ url: 'not a url' }] }, deps);
    expect(failedCall(bad)).toBe(false);
    expect(bad.summary).toMatchObject({ total: 1, succeeded: 0, failed: 1 });
    const notFound = await executeFetchInput({ urls: [{ url: startStatusServer(404) }, { url: startStatusServer(500) }] }, deps);
    expect(failedCall(notFound)).toBe(false);
    expect(notFound.summary).toMatchObject({ succeeded: 2, http_errors: 2 });
    const mixed = await executeFetchInput({ urls: [{ url: startStatusServer(404) }, { url: startServer(0) }] }, deps);
    expect(failedCall(mixed)).toBe(true);
  });

  test('the tool result of an all-failed call is unsuccessful, carries the per-URL results and names the reasons', async () => {
    const { createFetchTool } = await import('../platform/src/platform/tools/fetch/index.js');
    const result = await createFetchTool(deps).execute({ urls: [{ url: 'not a url' }, { url: startStatusServer(503) }] });
    expect(result.success).toBe(false);
    expect(result.error).toContain('All 2 fetches failed');
    expect(result.error).toContain('HTTP 503');
    expect(JSON.parse(result.output!).results).toHaveLength(2);
  });
});

describe('fetch refresh and approval waits', () => {
  test('a cancel while the localhost approval is pending ends the call as cancelled without waiting for the answer', async () => {
    const controller = new AbortController();
    let asked!: () => void;
    const questionAsked = new Promise<void>((resolve) => { asked = resolve; });
    const run = executeFetchInput({ urls: [{ url: 'http://localhost:9/' }] }, {
      isLocalhostAllowed: () => false,
      approveLocalhostFetch: () => { asked(); return new Promise<boolean>(() => { /* never answered */ }); },
      signal: controller.signal,
    });
    await questionAsked;
    controller.abort();
    const output = await run;
    expect(output.results?.[0]).toMatchObject({ cancelled: true });
    expect(output.results?.[0]?.error).toContain('Nothing was sent');
  });

  test('the refused 401 response is released before the refreshed request goes out', async () => {
    const events: string[] = [];
    let authReads = 0;
    const spy = spyOn(globalThis, 'fetch').mockImplementation((async (_url: unknown, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization');
      events.push(`request:${authorization}`);
      if (authorization === 'Bearer fresh') return new Response('ok', { headers: { 'content-type': 'text/plain' } });
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('expired')); },
        cancel() { events.push('released-401-body'); },
      }), { status: 401, headers: { 'content-type': 'text/plain' } });
    }) as unknown as typeof fetch);
    try {
      const output = await executeFetchInput({ urls: [{ url: 'http://localhost:9/', service: 'svc' }] }, {
        ...deps,
        serviceRegistry: { resolveAuth: async () => ({ authorization: ++authReads === 1 ? 'Bearer stale' : 'Bearer fresh' }), getAll: () => [], inspect: () => undefined } as never,
      });
      expect(output.results?.[0]?.status).toBe(200);
      expect(events).toEqual(['request:Bearer stale', 'released-401-body', 'request:Bearer fresh']);
    } finally { spy.mockRestore(); }
  });
});
