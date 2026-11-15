import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createGoodVibesPlatform } from '../platform/src/client.js';
import { createMemoryTokenStore } from '../platform/src/auth.js';
import { AutoRefreshCoordinator } from '../platform/src/client-auth/auto-refresh.js';
import { GoodVibesError } from '../errors/src/index.js';
import { installFrozenNow } from './_helpers/test-timeout.js';

const NOW_MS = 1_800_000_000_000;
let restoreNow: (() => void) | undefined;
beforeEach(() => { restoreNow = installFrozenNow(NOW_MS); });
afterEach(() => { restoreNow?.(); restoreNow = undefined; });

const SNAPSHOT = { capturedAt: NOW_MS, providers: [], configuredCount: 0, issueCount: 0 };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface Seen { readonly headers: Record<string, string> }

function recordingFetch(respond: (call: number) => Response): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const impl = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    seen.push({ headers: { ...(init?.headers as Record<string, string> | undefined) } });
    return respond(seen.length);
  };
  return { fetch: Object.assign(impl, { preconnect: () => {} }) as typeof fetch, seen };
}

function rejection(status: number): Error {
  return Object.assign(new Error(`refresh answered ${status}`), { status });
}

describe('platform observer', () => {
  test('HTTP send and receive activity of operator calls reaches the platform observer', async () => {
    const { fetch } = recordingFetch(() => jsonResponse(SNAPSHOT));
    const activity: string[] = [];
    const platform = createGoodVibesPlatform({
      baseUrl: 'https://daemon.example.com',
      authToken: 'tok',
      fetch,
      observer: { onTransportActivity: (info) => activity.push(info.direction) },
    });
    await platform.operator.accounts.snapshot();
    expect(activity).toEqual(['send', 'recv']);
  });
});

describe('auto-refresh when the session is rejected during refresh', () => {
  test('the stale bearer is not sent, there is no second refresh, and the error names the cleared session', async () => {
    const store = createMemoryTokenStore('revoked-token');
    await store.setTokenEntry('revoked-token', NOW_MS - 1_000);
    let refreshes = 0;
    const { fetch, seen } = recordingFetch(() => jsonResponse({ error: 'Unauthorized' }, 401));
    const platform = createGoodVibesPlatform({
      baseUrl: 'https://daemon.example.com',
      tokenStore: store,
      fetch,
      autoRefresh: {
        refresh: async () => { refreshes += 1; throw rejection(401); },
      },
    });

    const error = await platform.operator.accounts.snapshot().then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(GoodVibesError);
    expect((error as GoodVibesError).message).toContain('stored token was cleared');
    expect(refreshes).toBe(1);
    expect(seen.length).toBe(1);
    expect(Object.keys(seen[0]!.headers).map((k) => k.toLowerCase())).not.toContain('authorization');
    expect(await store.getToken()).toBeNull();
  });
});

describe('auto-refresh retry after a 401', () => {
  test('the retried request keeps the caller headers', async () => {
    const store = createMemoryTokenStore('stale-token');
    const { fetch, seen } = recordingFetch((call) => (call === 1 ? jsonResponse({ error: 'Unauthorized' }, 401) : jsonResponse(SNAPSHOT)));
    const platform = createGoodVibesPlatform({
      baseUrl: 'https://daemon.example.com',
      tokenStore: store,
      fetch,
      autoRefresh: { refresh: async () => ({ token: 'fresh-token', expiresAt: NOW_MS + 3_600_000 }) },
    });

    await platform.operator.invoke('accounts.snapshot', {}, { headers: { 'X-Probe': '1' } });

    expect(seen.length).toBe(2);
    expect(seen[1]!.headers['x-probe']).toBe('1');
    expect(seen[1]!.headers['Authorization']).toBe('Bearer fresh-token');
  });

  test('a rejection of a token that has since been replaced retries without another refresh', async () => {
    const store = createMemoryTokenStore('newer-token');
    let refreshes = 0;
    const coordinator = new AutoRefreshCoordinator({
      tokenStore: store,
      autoRefresh: true,
      refreshLeewayMs: 0,
      now: () => NOW_MS,
      refresh: async () => { refreshes += 1; return { token: 'rotated-again' }; },
    });
    let attempts = 0;

    await coordinator.refreshAndRetryOnce(async () => { attempts += 1; }, 'older-token');
    expect({ refreshes, attempts }).toEqual({ refreshes: 0, attempts: 1 });

    await coordinator.refreshAndRetryOnce(async () => { attempts += 1; }, 'newer-token');
    expect({ refreshes, attempts }).toEqual({ refreshes: 1, attempts: 2 });
    expect(await store.getToken()).toBe('rotated-again');
  });
});

describe('realtime connects', () => {
  test('a token inside the refresh window is refreshed before the event stream connects', async () => {
    const store = createMemoryTokenStore('expired-token');
    await store.setTokenEntry('expired-token', NOW_MS - 1_000);
    let opened!: (headers: Headers) => void;
    const connected = new Promise<Headers>((resolve) => { opened = resolve; });
    const impl = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      opened(new Headers(init?.headers));
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { 'content-type': 'text/event-stream' } });
    };
    const platform = createGoodVibesPlatform({
      baseUrl: 'https://daemon.example.com',
      tokenStore: store,
      fetch: Object.assign(impl, { preconnect: () => {} }) as typeof fetch,
      autoRefresh: { refresh: async () => ({ token: 'fresh-token', expiresAt: NOW_MS + 3_600_000 }) },
    });

    const stop = platform.realtime.viaSse().turn.on('TURN_SUBMITTED', () => {});
    const headers = await connected;
    stop();

    expect(headers.get('authorization')).toBe('Bearer fresh-token');
  });
});
