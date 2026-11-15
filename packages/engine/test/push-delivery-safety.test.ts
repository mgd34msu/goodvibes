/**
 * What a push delivery may and may not do to a healthy subscription, and which
 * endpoints it will talk to. Real key material, a real subscription store on a
 * temp file, injected transports (and one real local socket for the redirect
 * rule); nothing leaves the machine.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createECDH, randomBytes } from 'node:crypto';
import {
  PushSubscriptionStore,
  PushSubscriptionValidationError,
  VapidManager,
  deliverToAll,
  deliverToSubscription,
  type PushTransport,
  type StoredPushSubscription,
  type VapidSecretStore,
} from '../platform/src/platform/push/index.ts';
import { PUSH_ALLOW_LOCAL_ENDPOINTS_ENV } from '../platform/src/platform/push/subscription-validation.ts';

function realKeys(): { p256dh: string; auth: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
}

function memorySecrets(failReads = 0): VapidSecretStore {
  const values = new Map<string, string>();
  let remaining = failReads;
  return {
    getOrCreateDaemonSecret: async (key, create) => {
      if (remaining > 0) { remaining--; throw new Error('keychain is locked'); }
      const value = values.get(key) ?? create();
      values.set(key, value);
      return value;
    },
  };
}

let dir: string;
let previousAllow: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-push-safety-'));
  previousAllow = process.env[PUSH_ALLOW_LOCAL_ENDPOINTS_ENV];
  delete process.env[PUSH_ALLOW_LOCAL_ENDPOINTS_ENV];
});
afterEach(() => {
  if (previousAllow === undefined) delete process.env[PUSH_ALLOW_LOCAL_ENDPOINTS_ENV];
  else process.env[PUSH_ALLOW_LOCAL_ENDPOINTS_ENV] = previousAllow;
  rmSync(dir, { recursive: true, force: true });
});

function makeStore(): PushSubscriptionStore {
  return new PushSubscriptionStore(join(dir, 'subs.json'), { policy: { warnAbovePerPrincipal: 50, failureThreshold: 5 } });
}

async function register(store: PushSubscriptionStore, endpoint: string, deviceId?: string): Promise<StoredPushSubscription> {
  return (await store.register({ principalId: 'op', endpoint, keys: realKeys(), ...(deviceId ? { deviceId } : {}) }));
}

const ok: PushTransport = async () => ({ status: 201 });
const message = { title: 'Approval required', body: 'shell: run a thing' };

describe('a failure before anything is sent is not the device failing', () => {
  test('an unreadable signing key never prunes a healthy subscription', async () => {
    const store = makeStore();
    const sub = await register(store, 'https://push.example/a');
    const vapid = new VapidManager(memorySecrets(6));
    for (let attempt = 0; attempt < 6; attempt++) {
      const receipt = await deliverToSubscription(sub, message, { vapid, store, transport: ok });
      expect(receipt.outcome).toBe('failed');
      expect(receipt.detail).toContain('keychain is locked');
    }
    const stored = await store.get(sub.id);
    expect(stored).not.toBeNull();
    expect(stored?.consecutiveFailures ?? 0).toBe(0);
  });

  test('a message too large for one push is reported by name and never prunes', async () => {
    const store = makeStore();
    const sub = await register(store, 'https://push.example/a');
    const vapid = new VapidManager(memorySecrets());
    const tooBig = { ...message, data: { kind: 'approval' as const, approvalId: 'x'.repeat(5000) } };
    for (let attempt = 0; attempt < 6; attempt++) {
      const receipt = await deliverToSubscription(sub, tooBig, { vapid, store, transport: ok });
      expect(receipt.outcome).toBe('failed');
      expect(receipt.detail).toContain('Push payload too large');
    }
    expect((await store.get(sub.id))?.consecutiveFailures ?? 0).toBe(0);
  });

  test('a long body is cut to fit and still delivered', async () => {
    const store = makeStore();
    const sub = await register(store, 'https://push.example/a');
    let sent = 0;
    const transport: PushTransport = async (_url, init) => { sent = init.body.length; return { status: 201 }; };
    const receipt = await deliverToSubscription(sub, { ...message, body: 'y'.repeat(8000) }, { vapid: new VapidManager(memorySecrets()), store, transport });
    expect(receipt.outcome).toBe('delivered');
    expect(sent).toBeLessThanOrEqual(4096);
  });

  test('an outage never costs a device its subscription', async () => {
    const vapid = new VapidManager(memorySecrets());
    const outages: PushTransport[] = [
      async () => { throw new Error('getaddrinfo ENOTFOUND push.example'); },
      async () => ({ status: 503 }),
      async () => ({ status: 429 }),
      async () => ({ status: 408 }),
    ];
    for (const transport of outages) {
      const store = makeStore();
      const sub = await register(store, 'https://push.example/a');
      for (let attempt = 0; attempt < 6; attempt++) {
        expect((await deliverToSubscription(sub, message, { vapid, store, transport })).outcome).toBe('failed');
      }
      const stored = await store.get(sub.id);
      expect(stored?.lastOutcome).toBe('failed');
      expect(stored?.consecutiveFailures ?? 0).toBe(0);
    }
  });

  test('a push service that keeps rejecting the endpoint removes it at the bound, and the list says why', async () => {
    const store = makeStore();
    const sub = await register(store, 'https://push.example/a');
    const vapid = new VapidManager(memorySecrets());
    const reject: PushTransport = async () => ({ status: 403 });
    let last = await deliverToSubscription(sub, message, { vapid, store, transport: reject });
    for (let attempt = 1; attempt < 5; attempt++) last = await deliverToSubscription(sub, message, { vapid, store, transport: reject });
    expect(last.outcome).toBe('pruned');
    expect(await store.get(sub.id)).toBeNull();
    const status = await store.status('op');
    expect(status.subscriptions).toHaveLength(0);
    expect(status.lastRemoval?.subscriptionId).toBe(sub.id);
    expect(status.lastRemoval?.reason).toBe('failure-threshold');
  });
});

describe('one bad endpoint does not hold back the others', () => {
  test('an endpoint that never answers times out and the next device still gets the push', async () => {
    const store = makeStore();
    const hung = await register(store, 'https://push.example/hung');
    const live = await register(store, 'https://push.example/live');
    const reached: string[] = [];
    const transport: PushTransport = (url, init) => {
      if (url.endsWith('/hung')) {
        return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('timed out'))));
      }
      reached.push(url);
      return Promise.resolve({ status: 201 });
    };
    const receipts = await deliverToAll(message, { vapid: new VapidManager(memorySecrets()), store, transport, requestTimeoutMs: 20 });
    expect(receipts.map((r) => [r.subscriptionId, r.outcome])).toEqual([[hung.id, 'failed'], [live.id, 'delivered']]);
    expect(reached).toEqual(['https://push.example/live']);
    // A timeout says nothing about the endpoint and is never counted toward removal.
    expect((await store.get(hung.id))?.consecutiveFailures ?? 0).toBe(0);
  });

  test('one fan-out to four devices stamps every outcome in one store write', async () => {
    const store = makeStore();
    for (const name of ['one', 'two', 'three', 'four']) await register(store, `https://push.example/${name}`);
    let writes = 0;
    const counted = Object.create(store) as PushSubscriptionStore;
    counted.applyOutcomes = async (stamps, bound) => { writes++; return store.applyOutcomes(stamps, bound); };
    const receipts = await deliverToAll(message, { vapid: new VapidManager(memorySecrets()), store: counted, transport: ok });
    expect(receipts.map((r) => r.outcome)).toEqual(['delivered', 'delivered', 'delivered', 'delivered']);
    expect(writes).toBe(1);
    expect((await store.all()).every((r) => r.lastOutcome === 'delivered')).toBe(true);
  });

  test('a store write that throws keeps every receipt and says the outcome was not saved', async () => {
    const store = makeStore();
    const first = await register(store, 'https://push.example/one');
    const second = await register(store, 'https://push.example/two');
    const flaky = Object.create(store) as PushSubscriptionStore;
    flaky.applyOutcomes = async () => { throw new Error('disk full'); };
    const receipts = await deliverToAll(message, { vapid: new VapidManager(memorySecrets()), store: flaky, transport: ok });
    expect(receipts.map((r) => [r.subscriptionId, r.outcome])).toEqual([[first.id, 'delivered'], [second.id, 'delivered']]);
    expect(receipts[0]?.detail).toContain('disk full');
  });

  test('two records for one endpoint receive the message once', async () => {
    const store = makeStore();
    const a = await register(store, 'https://push.example/same');
    const other = await store.register({ principalId: 'second-principal', endpoint: 'https://push.example/same', keys: realKeys() });
    let calls = 0;
    const transport: PushTransport = async () => { calls++; return { status: 201 }; };
    const receipts = await deliverToAll(message, { vapid: new VapidManager(memorySecrets()), store, transport });
    expect(calls).toBe(1);
    expect(receipts.map((r) => [r.subscriptionId, r.outcome])).toEqual([[a.id, 'delivered'], [other.id, 'skipped']]);
  });
});

describe('which endpoints may be registered and sent to', () => {
  test('loopback, private, link-local and plain-http endpoints are refused', async () => {
    const store = makeStore();
    for (const endpoint of [
      'https://127.0.0.1/x',
      'http://localhost/x',
      'https://[::1]/x',
      'https://169.254.169.254/latest/meta-data/',
      'https://10.0.0.5/x',
      'http://push.example/x',
      'https://user:secret@push.example/x',
    ]) {
      await expect(register(store, endpoint)).rejects.toBeInstanceOf(PushSubscriptionValidationError);
    }
  });

  test('a redirect from the endpoint is not followed', async () => {
    process.env[PUSH_ALLOW_LOCAL_ENDPOINTS_ENV] = '1';
    let targetHits = 0;
    const target = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => { targetHits++; return new Response('', { status: 201 }); } });
    const redirector = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('', { status: 302, headers: { location: `http://127.0.0.1:${target.port}/internal` } }) });
    try {
      const store = makeStore();
      const sub = await register(store, `http://127.0.0.1:${redirector.port}/push`);
      const receipt = await deliverToSubscription(sub, message, { vapid: new VapidManager(memorySecrets()), store });
      expect(receipt.outcome).toBe('failed');
      expect(receipt.httpStatus).toBe(302);
      expect(targetHits).toBe(0);
    } finally {
      void redirector.stop(true);
      void target.stop(true);
    }
  });
});

describe('one device registered under a new identity', () => {
  test('a legacy record is adopted by a device-id registration of the same endpoint', async () => {
    const store = makeStore();
    const endpoint = 'https://push.example/device';
    const legacy = await register(store, endpoint);
    const { record } = await store.reconcile({ principalId: 'op', deviceId: 'dev-1', endpoint, keys: legacy.keys });
    expect(record.id).toBe(legacy.id);
    expect(record.deviceId).toBe('dev-1');
    expect(await store.all()).toHaveLength(1);
  });

  test('moving a device onto an endpoint another of its records holds leaves one record', async () => {
    const store = makeStore();
    const keys = realKeys();
    await store.register({ principalId: 'op', deviceId: 'dev-1', endpoint: 'https://push.example/old', keys });
    await store.register({ principalId: 'op', endpoint: 'https://push.example/new', keys });
    await store.reconcile({ principalId: 'op', deviceId: 'dev-1', endpoint: 'https://push.example/new', keys });
    const all = await store.all();
    expect(all).toHaveLength(1);
    expect(all[0]?.endpoint).toBe('https://push.example/new');
  });
});
