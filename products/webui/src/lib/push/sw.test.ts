/**
 * sw.test.ts, proves the service worker's OWN `linkForNotification` copy (public/sw.js)
 * actually enforces the same in-app-only guard as the pure helper (notification-link.ts).
 *
 * public/sw.js is a plain script that runs in a ServiceWorkerGlobalScope, not a module,
 * it cannot be `import`-ed. This test instead reads the real file off disk and executes
 * it (via `new Function`, with the ambient happy-dom `self`/`caches` this project's
 * test-setup.ts already registers), then captures the top-level `linkForNotification`
 * declaration via a trailing `return`. That is the actual runtime code path a real
 * notification tap executes, not a hand-transcribed copy that could silently drift
 * from the file the browser loads (the cohesion review's exact finding: the two copies
 * "kept deliberately in sync" had drifted, and nothing loaded sw.js to catch it).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { linkForNotification, type NotificationData } from './notification-link';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SW_PATH = resolve(__dirname, '../../../public/sw.js');

function loadServiceWorkerLinkForNotification(): (data: unknown, action?: string) => string {
  const source = readFileSync(SW_PATH, 'utf8');
  // The top level only defines constants/functions and calls `self.addEventListener`
  // (a real happy-dom EventTarget method, a no-op registration here since none of
  // those events fire in this test). Nothing else executes at load time.
  const factory = new Function(`${source}\nreturn linkForNotification;`);
  return factory() as (data: unknown, action?: string) => string;
}

function loadServiceWorkerHandlePushSubscriptionChange(): (event: unknown) => Promise<void> {
  const source = readFileSync(SW_PATH, 'utf8');
  const factory = new Function(`${source}\nreturn handlePushSubscriptionChange;`);
  return factory() as (event: unknown) => Promise<void>;
}

describe('sw.js linkForNotification (loaded and executed from the real file, not a hand copy)', () => {
  // Every notification kind the daemon sends (PushNotificationCategory), with and
  // without its ids and an action, plus the fallbacks: the service worker's copy
  // must answer exactly what the app's helper answers.
  const cases: ReadonlyArray<readonly [unknown, string | undefined]> = [
    [{ kind: 'approval', approvalId: 'apr-1' }, undefined],
    [{ kind: 'approval', approvalId: 'apr-1' }, 'approve'],
    [{ kind: 'approval', approvalId: 'a/b c' }, 'deny'],
    [{ kind: 'approval', approvalId: 'apr-1' }, 'snooze'],
    [{ kind: 'approval' }, 'approve'],
    [{ kind: 'needs-input', nodeId: 'agent-7', sessionId: 's-1' }, undefined],
    [{ kind: 'needs-input', nodeId: 'a/b', sessionId: 'x y', escalated: true }, undefined],
    [{ kind: 'needs-input' }, undefined],
    [{ kind: 'completion', nodeId: 'run-3', sessionId: 's-2' }, undefined],
    [{ kind: 'completion', nodeId: 'run-3' }, undefined],
    [{ kind: 'completion' }, undefined],
    [{ url: '/?view=sessions' }, undefined],
    [{ url: 'https://evil.example/phish' }, undefined],
    [{}, undefined],
    [undefined, undefined],
    [null, undefined],
  ];

  test('answers exactly what notification-link.ts answers for every kind', () => {
    const serviceWorkerLink = loadServiceWorkerLinkForNotification();
    for (const [data, action] of cases) {
      expect(serviceWorkerLink(data, action)).toBe(linkForNotification(data as NotificationData | undefined | null, action));
    }
  });

  test('a completion push opens the run that finished, not the app root', () => {
    expect(loadServiceWorkerLinkForNotification()({ kind: 'completion', sessionId: 's', nodeId: 'n' })).toBe(
      '/?view=fleet#fleet-node=n&fleet-session=s',
    );
  });
});

// ─── handlePushSubscriptionChange (real sw.js copy) ─────────────────────────
//
// A REAL browser-triggered endpoint rotation cannot be produced in this (or any
// headless) test environment, there is no way to make the OS push service
// actually rotate a live subscription. What IS tested here, against the exact
// code the browser runs: given a synthetic pushsubscriptionchange event, the
// handler (a) re-subscribes using the old subscription's own options (no
// separately-cached VAPID key needed) and (b) posts the new endpoint/keys to
// every open window client, the two things the handler can do without a
// daemon auth token (see the file's own header comment on that boundary).
describe('sw.js handlePushSubscriptionChange (real sw.js copy)', () => {
  const selfGlobal = globalThis as unknown as {
    self: { registration?: unknown; clients?: unknown };
  };

  afterEach(() => {
    delete selfGlobal.self.registration;
    delete selfGlobal.self.clients;
  });

  test('re-subscribes with the old subscription’s own options and notifies open clients', async () => {
    const subscribeCalls: unknown[] = [];
    const postedMessages: unknown[] = [];
    selfGlobal.self.registration = {
      pushManager: {
        async subscribe(options: unknown) {
          subscribeCalls.push(options);
          return {
            toJSON: () => ({ endpoint: 'https://push.example/new-endpoint', keys: { p256dh: 'new-p', auth: 'new-a' } }),
          };
        },
      },
    };
    selfGlobal.self.clients = {
      async matchAll() {
        return [{ postMessage: (msg: unknown) => postedMessages.push(msg) }];
      },
    };

    const handlePushSubscriptionChange = loadServiceWorkerHandlePushSubscriptionChange();
    const oldOptions = { userVisibleOnly: true, applicationServerKey: 'old-vapid-key' };
    await handlePushSubscriptionChange({ oldSubscription: { options: oldOptions } });

    expect(subscribeCalls).toEqual([oldOptions]);
    expect(postedMessages).toEqual([
      { type: 'goodvibes-push-subscription-changed', endpoint: 'https://push.example/new-endpoint', keys: { p256dh: 'new-p', auth: 'new-a' } },
    ]);
  });

  test('no oldSubscription still re-subscribes with a bare userVisibleOnly request (never a dead SW)', async () => {
    const subscribeCalls: unknown[] = [];
    selfGlobal.self.registration = {
      pushManager: {
        async subscribe(options: unknown) {
          subscribeCalls.push(options);
          return { toJSON: () => ({ endpoint: 'https://push.example/new-endpoint', keys: { p256dh: 'p', auth: 'a' } }) };
        },
      },
    };
    selfGlobal.self.clients = { async matchAll() { return []; } };

    const handlePushSubscriptionChange = loadServiceWorkerHandlePushSubscriptionChange();
    await handlePushSubscriptionChange({ oldSubscription: null });

    expect(subscribeCalls).toEqual([{ userVisibleOnly: true }]);
  });

  test('a re-subscribe the browser refuses is swallowed, never an unhandled rejection', async () => {
    selfGlobal.self.registration = {
      pushManager: {
        async subscribe() {
          throw new Error('permission revoked');
        },
      },
    };
    let matchAllCalled = false;
    selfGlobal.self.clients = {
      async matchAll() {
        matchAllCalled = true;
        return [];
      },
    };

    const handlePushSubscriptionChange = loadServiceWorkerHandlePushSubscriptionChange();
    await expect(handlePushSubscriptionChange({ oldSubscription: null })).resolves.toBeUndefined();
    // The failed re-subscribe returns before ever reaching the client notify step.
    expect(matchAllCalled).toBe(false);
  });
});

test('notification URLs cannot change origin through slash, backslash or control characters', () => {
  const linkForNotification = loadServiceWorkerLinkForNotification();
  for (const url of ['//evil.test/path', '/\\evil.test', '/\tevil.test', 'https://evil.test']) {
    expect(linkForNotification({ url })).toBe('/');
  }
});

describe('sw.js install', () => {
  function runInstall(addAll: () => Promise<void>): { waited: Promise<unknown>[]; skipped: number } {
    const source = readFileSync(SW_PATH, 'utf8');
    const handlers: Record<string, (event: unknown) => void> = {};
    const fakeSelf = {
      addEventListener: (type: string, handler: (event: unknown) => void) => { handlers[type] = handler; },
      skipWaiting: () => { result.skipped += 1; return Promise.resolve(); },
      clients: { claim: () => Promise.resolve() },
    };
    const fakeCaches = { open: () => Promise.resolve({ addAll }) };
    new Function('self', 'caches', source)(fakeSelf, fakeCaches);
    const result = { waited: [] as Promise<unknown>[], skipped: 0 };
    handlers.install?.({ waitUntil: (promise: Promise<unknown>) => { result.waited.push(promise); } });
    return result;
  }

  test('a precache failure is logged, and the install still completes and activates', async () => {
    const original = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      const result = runInstall(() => Promise.reject(new Error('precache 404')));
      await Promise.all(result.waited);
      expect(result.skipped).toBe(1);
      expect(warnings.length).toBe(1);
      expect(String(warnings[0]?.[0])).toContain('precache');
      expect(String(warnings[0]?.[1])).toContain('precache 404');
    } finally {
      console.warn = original;
    }
  });
});
