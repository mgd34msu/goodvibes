import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { createContext, runInContext } from 'node:vm';
import { renderControlPlaneGatewayWebUi } from '../platform/src/platform/control-plane/gateway-web-ui.js';

interface Recorded { url: string; method: string; headers: Record<string, string> }

/** The page's own script, run against a DOM with an injected fetch and a timer table the test fires by hand. */
async function openPage(respond: (url: string, count: number) => Response) {
  const requests: Recorded[] = [];
  const timers: (() => void)[] = [];
  const dom = new JSDOM(await renderControlPlaneGatewayWebUi().text(), { url: 'http://localhost' });
  const context = createContext({
    document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    AbortController, TextDecoder, URLSearchParams, window: { location: dom.window.location, confirm: () => true },
    setTimeout: (callback: () => void) => timers.push(callback),
    clearTimeout: () => undefined,
    fetch: async (url: string, options?: RequestInit) => {
      requests.push({ url, method: options?.method ?? 'GET', headers: { ...(options?.headers as Record<string, string> | undefined) } });
      return respond(url, requests.length);
    },
  });
  runInContext(dom.window.document.querySelector('script')!.textContent!, context);
  return { requests, timers, context, close: () => dom.window.close() };
}

const settle = async (done: () => boolean) => { for (let turn = 0; turn < 200 && !done(); turn += 1) await new Promise((resolve) => setImmediate(resolve)); };

test('the rendered page uses browser fetch for its stream and mutations', async () => {
  const page = await openPage(() => Response.json({}));
  try {
    runInContext("state.token = 'synthetic'; connectStream(); state.token = ''", page.context);
    await runInContext("postJson('/api/service/start', {})", page.context);
    expect(page.requests.some(r => r.url.startsWith('/api/control-plane/events?'))).toBe(true);
    expect(page.requests).toContainEqual(expect.objectContaining({ url: '/api/service/start', method: 'POST' }));
  } finally { page.close(); }
});

test('a dropped event stream is reopened from the last event it delivered', async () => {
  const page = await openPage((url) => url.startsWith('/api/control-plane/events?')
    ? new Response('id: evt-7\nevent: tasks\ndata: {}\n\n')
    : Response.json({}));
  try {
    runInContext("state.token = 'synthetic'; connectStream()", page.context);
    await settle(() => page.timers.length > 0);
    expect(page.timers).toHaveLength(1);
    page.timers[0]!();
    await settle(() => page.requests.filter((r) => r.url.startsWith('/api/control-plane/events?')).length >= 2);
    const streams = page.requests.filter((r) => r.url.startsWith('/api/control-plane/events?'));
    expect(streams[0]!.headers['Last-Event-ID']).toBeUndefined();
    expect(streams[1]!.headers['Last-Event-ID']).toBe('evt-7');
    runInContext('state.stream.close()', page.context);
  } finally { page.close(); }
});

test('a burst of refresh requests costs one running refresh and one follow-up, not one per request', async () => {
  const page = await openPage(() => Response.json({}));
  try {
    runInContext("state.token = 'synthetic'", page.context);
    await runInContext('Promise.all([loadSnapshot(), loadSnapshot(), loadSnapshot(), loadSnapshot()])', page.context);
    const endpointsPerRefresh = 11;
    expect(page.requests.length).toBe(2 * endpointsPerRefresh);
  } finally { page.close(); }
});

test('one failing endpoint is named instead of reading as a rejected token', async () => {
  const page = await openPage((url) => url === '/api/service/status' ? Response.json({}, { status: 403 }) : Response.json({}));
  try {
    runInContext("state.token = 'synthetic'", page.context);
    await runInContext('loadSnapshot()', page.context);
    const status = runInContext('els.authStatus.textContent', page.context);
    expect(String(status)).toContain('/api/service/status (HTTP 403)');
    expect(String(status)).not.toContain('Authentication failed');
  } finally { page.close(); }
});
