/** Real browser facade reconciliation sends the current endpoint and keys to their owner. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PUSH_DEVICE_ID_STORAGE_KEY, reconcilePushSubscriptionOnOpen } from './push-client';

const LIVE_ENDPOINT = 'https://push.example.test/live-endpoint';
const KNOWN_DEVICE_ID = 'device-e2e-fixed';

let originalFetch: typeof fetch;
let calls: { methodId: string; body: unknown }[];

function stubFetch(responses: Record<string, unknown>): void {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const match = /\/api\/control-plane\/methods\/([^/]+)\/invoke$/.exec(url);
    const methodId = match ? match[1] : 'unknown';
    const body = init?.body ? (JSON.parse(init.body as string) as { body?: unknown }).body : undefined;
    calls.push({ methodId, body });
    const responseBody = responses[methodId] ?? {};
    return new Response(JSON.stringify(responseBody), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

function installPushGlobals(subscription: { endpoint: string } | null): void {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  (window as unknown as { PushManager: unknown }).PushManager = function pushManagerStub() {
    /* presence-only stand-in */
  };
  (window as unknown as { Notification: unknown }).Notification = Object.assign(
    function notificationStub() {
      /* presence-only stand-in */
    },
    { permission: 'granted' },
  );
  const registration = {
    pushManager: {
      async getSubscription() {
        if (!subscription) return null;
        return {
          endpoint: subscription.endpoint,
          toJSON: () => ({ endpoint: subscription.endpoint, keys: { p256dh: 'p256dh-key', auth: 'auth-key' } }),
        };
      },
    },
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { ready: Promise.resolve(registration) },
  });
}

function uninstallPushGlobals(): void {
  delete (window as unknown as { PushManager?: unknown }).PushManager;
  delete (window as unknown as { Notification?: unknown }).Notification;
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined });
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: undefined });
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  window.localStorage.setItem(PUSH_DEVICE_ID_STORAGE_KEY, KNOWN_DEVICE_ID);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  uninstallPushGlobals();
  window.localStorage.removeItem(PUSH_DEVICE_ID_STORAGE_KEY);
});

describe('reconcilePushSubscriptionOnOpen', () => {
  test('no live subscription is an honest no-op, not an error', async () => {
    installPushGlobals(null);
    stubFetch({});
    const outcome = await reconcilePushSubscriptionOnOpen();
    expect(outcome.drift).toBe('not-subscribed');
    expect(outcome.subscription).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test.each(['created', 'unchanged', 'endpoint-updated', 'keys-updated'] as const)(
    'uses one authenticated owner comparison and reports %s', async drift => {
      installPushGlobals({ endpoint: LIVE_ENDPOINT });
      stubFetch({
        'push.subscriptions.reconcile': {
          subscription: { id: 'sub-1', principalId: 'operator', deviceId: KNOWN_DEVICE_ID,
            endpointOrigin: 'https://push.example.test', createdAt: 1 },
          drift,
        },
      });
      const outcome = await reconcilePushSubscriptionOnOpen();
      expect(outcome.drift).toBe(drift);
      expect(outcome.subscription?.id).toBe('sub-1');
      expect(calls.map(call => call.methodId)).toEqual(['push.subscriptions.reconcile']);
      expect(calls[0].body).toEqual({ deviceId: KNOWN_DEVICE_ID, endpoint: LIVE_ENDPOINT,
        keys: { p256dh: 'p256dh-key', auth: 'auth-key' } });
      expect(outcome.subscription).not.toHaveProperty('endpoint');
      expect(outcome.subscription).not.toHaveProperty('keys');
    },
  );
});
