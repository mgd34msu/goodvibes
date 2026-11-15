/** Turning notifications off removes the daemon record, and a failed removal can be retried. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { unsubscribeFromPush } from './push-client';

const STORE_KEY = 'goodvibes.webui.push.subscriptionId';

let originalFetch: typeof fetch;
let originalServiceWorker: PropertyDescriptor | undefined;
let daemonStatus: number;
let daemonBody: unknown;
let daemonCalls: number;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
  daemonCalls = 0;
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { ready: Promise.resolve({ pushManager: { getSubscription: async () => null } }) },
  });
  globalThis.fetch = Object.assign(async () => {
    daemonCalls += 1;
    return new Response(JSON.stringify(daemonBody), { status: daemonStatus, headers: { 'content-type': 'application/json' } });
  }, { preconnect() {} });
  window.localStorage.setItem(STORE_KEY, 'sub-1');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalServiceWorker) Object.defineProperty(navigator, 'serviceWorker', originalServiceWorker);
  else Reflect.deleteProperty(navigator, 'serviceWorker');
  window.localStorage.removeItem(STORE_KEY);
});

describe('unsubscribeFromPush', () => {
  test('a daemon that no longer knows the subscription counts as success', async () => {
    daemonStatus = 404;
    daemonBody = { error: 'Unknown push subscription', code: 'SUBSCRIPTION_NOT_FOUND' };
    await unsubscribeFromPush();
    expect(daemonCalls).toBe(1);
    expect(window.localStorage.getItem(STORE_KEY)).toBeNull();
  });

  test('a failed daemon removal keeps the id so the next call retries it', async () => {
    daemonStatus = 503;
    daemonBody = { error: 'unavailable' };
    await expect(unsubscribeFromPush()).rejects.toBeDefined();
    expect(window.localStorage.getItem(STORE_KEY)).toBe('sub-1');

    daemonStatus = 200;
    daemonBody = { subscriptionId: 'sub-1', deleted: true };
    await unsubscribeFromPush();
    expect(daemonCalls).toBeGreaterThanOrEqual(2);
    expect(window.localStorage.getItem(STORE_KEY)).toBeNull();
  });
});
