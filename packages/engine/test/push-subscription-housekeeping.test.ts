/**
 * push-subscription-housekeeping.test.ts
 *
 * The custody rules for `push-subscriptions.json`, proven against the real
 * store on a real temp directory (no mocks of the persistence layer):
 *
 *  - Registration validates by CONTENT: a junk p256dh, a short auth secret, an
 *    oversized endpoint, and a non-http(s) scheme are each refused with a plain
 *    reason, so a record that could never receive a push is never stored.
 *  - The per-principal figure is a WARNING, not a cap. Passing it accepts the
 *    new device anyway; nothing that still works is ever removed to make room,
 *    so nobody has to resubscribe.
 *  - Only PROVABLY dead records leave: unusable key material, a torn record, or
 *    an endpoint the push service rejected past the bound. Age alone never
 *    removes anything. Reads leave them out; the next write drops them and the
 *    list reports the latest removal.
 *  - The VAPID `sub` contact: a configured one is signed into the JWT and the
 *    signature still verifies; an invalid one is rejected rather than signed.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { allowLocalPushEndpoints } from './_helpers/local-push-endpoints.ts';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createECDH, createPublicKey, randomBytes, verify as cryptoVerify } from 'node:crypto';
import {
  createPushService,
  createPushSubscriptionStore,
} from '../platform/src/platform/control-plane/routes/push-composition.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import {
  DEFAULT_VAPID_SUBJECT,
  PushSubscriptionStore,
  PushSubscriptionValidationError,
  VapidKeypairUnreadableError,
  VapidManager,
  VAPID_SECRET_KEY,
  isValidVapidSubject,
  PushService,
  type PushSubscriptionPolicy,
  type StoredPushSubscription,
  type VapidSecretStore,
} from '../platform/src/platform/push/index.ts';

// ---------------------------------------------------------------------------
// Real key material, a genuine 65-byte uncompressed P-256 point + 16-byte auth.
// ---------------------------------------------------------------------------
function realKeys(): { p256dh: string; auth: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
}

/**
 * Per-test ceiling for the tests below that do real work, real ECDH keygen,
 * real VAPID JWT signing, a real HTTP delivery to a real local socket, and real
 * file writes. A ceiling, not a target: nothing waits it out, so a fast host is
 * unaffected. bun's implicit 5 s default is an idle machine's number for that
 * mix.
 */
const REAL_WORK_BUDGET_MS = 60_000;

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-push-housekeeping-'));
  storePath = join(dir, 'push-subscriptions.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(records: readonly unknown[]): void {
  writeFileSync(storePath, `${JSON.stringify({ subscriptions: records }, null, 2)}\n`, 'utf-8');
}

function readStored(): unknown[] {
  const parsed = JSON.parse(readFileSync(storePath, 'utf-8')) as { subscriptions: unknown[] };
  return parsed.subscriptions;
}

test('reconcile compares actual keys and endpoint without rewriting an unchanged healthy record', async () => {
  const store = new PushSubscriptionStore(storePath);
  const input = { principalId: 'operator', deviceId: 'device-one', endpoint: 'https://push.example.test/device-one', keys: realKeys() };
  const registered = await store.reconcile(input);
  const before = readFileSync(storePath), identity = statSync(storePath, { bigint: true });
  expect((await store.reconcile(input)).drift).toBe('unchanged');
  expect(readFileSync(storePath)).toEqual(before);
  expect(statSync(storePath, { bigint: true }).ino).toBe(identity.ino);
  const rotatedKeys = realKeys();
  const refreshed = await store.reconcile({ ...input, keys: rotatedKeys });
  expect(refreshed.drift).toBe('keys-updated');
  expect(refreshed.record.id).toBe(registered.record.id);
  expect((await store.get(registered.record.id))?.keys).toEqual(rotatedKeys);
  const moved = await store.reconcile({ ...input, keys: rotatedKeys, endpoint: 'https://push.example.test/rotated-endpoint' });
  expect(moved.drift).toBe('endpoint-updated');
  expect(moved.record.id).toBe(registered.record.id);
  expect((await store.listPublic('operator'))[0]).not.toHaveProperty('endpoint');
  expect((await store.listPublic('operator'))[0]).not.toHaveProperty('keys');
});

function makeStore(policy?: Partial<PushSubscriptionPolicy>): PushSubscriptionStore {
  return new PushSubscriptionStore(storePath, {
    policy: {
      warnAbovePerPrincipal: policy?.warnAbovePerPrincipal ?? 50,
      failureThreshold: policy?.failureThreshold ?? 5,
    },
  });
}

function record(overrides: Partial<StoredPushSubscription> & { id: string }): StoredPushSubscription {
  const keys = realKeys();
  return {
    principalId: 'op-1',
    endpoint: `https://push.example/${overrides.id}`,
    keys,
    createdAt: Date.now(),
    ...overrides,
  } as StoredPushSubscription;
}

// ---------------------------------------------------------------------------
// Registration validates by content
// ---------------------------------------------------------------------------
describe('registration refuses content that could never receive a push', () => {
  test('a junk p256dh is refused with the delivery path\'s own wording', async () => {
    const store = makeStore();
    const attempt = store.register({
      principalId: 'op-1',
      endpoint: 'https://push.example/a',
      keys: { p256dh: 'not-base64!!!!', auth: randomBytes(16).toString('base64url') },
    });
    await expect(attempt).rejects.toThrow('Push subscription p256dh key is not a 65-byte uncompressed P-256 point');
    expect(existsSync(storePath)).toBe(false);
  });

  test('a p256dh of the right length but the wrong point marker is refused', async () => {
    const store = makeStore();
    const bogus = Buffer.concat([Buffer.from([0x02]), randomBytes(64)]).toString('base64url');
    await expect(store.register({
      principalId: 'op-1',
      endpoint: 'https://push.example/a',
      keys: { p256dh: bogus, auth: randomBytes(16).toString('base64url') },
    })).rejects.toThrow('65-byte uncompressed P-256 point');
  });

  test('a short auth secret is refused', async () => {
    const store = makeStore();
    const keys = realKeys();
    await expect(store.register({
      principalId: 'op-1',
      endpoint: 'https://push.example/a',
      keys: { p256dh: keys.p256dh, auth: 'x' },
    })).rejects.toThrow('Push subscription auth secret is not 16 bytes');
  });

  test('an oversized endpoint is refused with its bound named', async () => {
    const store = makeStore();
    const huge = `https://push.example/${'p'.repeat(50_000)}`;
    const attempt = store.register({ principalId: 'op-1', endpoint: huge, keys: realKeys() });
    await expect(attempt).rejects.toThrow('longer than 2048 characters');
  });

  test('a non-http(s) endpoint is refused', async () => {
    const store = makeStore();
    await expect(store.register({
      principalId: 'op-1',
      endpoint: 'file:///etc/passwd',
      keys: realKeys(),
    })).rejects.toThrow('http(s)');
  });

  test('the refusal is a typed error naming the offending field', async () => {
    const store = makeStore();
    let caught: unknown;
    try {
      await store.register({ principalId: 'op-1', endpoint: 'https://push.example/a', keys: { p256dh: 'p', auth: 'a' } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PushSubscriptionValidationError);
    expect((caught as PushSubscriptionValidationError).field).toBe('keys.p256dh');
  });

  test('valid key material registers and round-trips', async () => {
    const store = makeStore();
    const created = await store.register({ principalId: 'op-1', endpoint: 'https://push.example/a', keys: realKeys() });
    expect(created.id).toStartWith('push-');
    expect(await store.all()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The per-principal figure is a warning, never an eviction
// ---------------------------------------------------------------------------
describe('a working subscription is never removed to make room', () => {
  test('registering past the warning threshold accepts the new device and keeps every old one', async () => {
    const store = makeStore({ warnAbovePerPrincipal: 2 });
    const ids: string[] = [];
    for (const name of ['a', 'b', 'c', 'd']) {
      const created = await store.register({
        principalId: 'op-1',
        deviceId: `dev-${name}`,
        endpoint: `https://push.example/${name}`,
        keys: realKeys(),
      });
      ids.push(created.id);
    }
    const all = await store.all();
    expect(all).toHaveLength(4);
    // Every device registered is still addressable, nothing was evicted.
    expect(all.map((r) => r.id).sort()).toEqual([...ids].sort());
  });
});

// ---------------------------------------------------------------------------
// Only provably dead records leave, in the next write, and the list says why
// ---------------------------------------------------------------------------
describe('removal requires evidence the subscription is already dead', () => {
  test('age alone never removes a subscription', async () => {
    const ancient = Date.now() - 400 * 24 * 60 * 60 * 1000;
    seed([
      record({ id: 'push-old', createdAt: ancient }),
      record({ id: 'push-quiet', createdAt: ancient, lastDeliveryAt: ancient, lastOutcome: 'delivered' }),
    ]);
    const store = makeStore();
    await store.register({ principalId: 'op-2', endpoint: 'https://push.example/new', keys: realKeys() });
    expect((await store.all()).map((r) => r.id)).toContain('push-old');
    expect((await store.all()).map((r) => r.id)).toContain('push-quiet');
  });

  test('a read never serves a dead record, and the next write drops it and keeps the removal for the list', async () => {
    seed([
      record({ id: 'push-junk', keys: { p256dh: 'p', auth: 'a' } }),
      record({ id: 'push-dead', consecutiveFailures: 5 }),
      { id: 'push-torn' },
      record({ id: 'push-ok' }),
    ]);
    const store = makeStore({ failureThreshold: 5 });
    expect((await store.all()).map((r) => r.id)).toEqual(['push-ok']);
    expect(await store.get('push-junk')).toBeNull();
    expect(readStored()).toHaveLength(4);

    await store.register({ principalId: 'op-1', endpoint: 'https://push.example/new', keys: realKeys() });
    const ids = readStored().map((r) => (r as { id: string }).id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain('push-ok');
    const status = await store.status('op-1');
    expect(status.subscriptions).toHaveLength(2);
    expect(status.lastRemoval?.subscriptionId).toBe('push-dead');
    expect(status.lastRemoval?.reason).toBe('failure-threshold');
    // The capability URL never appears in the removal, origin only.
    expect(status.lastRemoval?.endpointOrigin).toBe('https://push.example');
    expect(JSON.stringify(status.lastRemoval)).not.toContain('/push-dead');
  });

  test('raising the failure threshold keeps a record the old bound would have removed', async () => {
    seed([record({ id: 'push-flaky', consecutiveFailures: 5 })]);
    const store = makeStore({ failureThreshold: 10 });
    expect(await store.all()).toHaveLength(1);
  });

  test('two stores writing the same file at once both land', async () => {
    const store = makeStore();
    const other = makeStore();
    // Two independent store instances over the same file, as two processes would be.
    await Promise.all([
      store.register({ principalId: 'op-1', endpoint: 'https://push.example/one', keys: realKeys() }),
      other.register({ principalId: 'op-2', endpoint: 'https://push.example/two', keys: realKeys() }),
    ]);
    expect((await store.all()).map((r) => r.principalId).sort()).toEqual(['op-1', 'op-2']);
  });

  test('a delete of an already-absent id is honest about it', async () => {
    const store = makeStore();
    expect(await store.remove('push-nope')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The VAPID contact
// ---------------------------------------------------------------------------
describe('the VAPID sub contact', () => {
  function memorySecrets(): VapidSecretStore {
    const values = new Map<string, string>();
    return {
      getOrCreateDaemonSecret: async (key, create) => {
        const value = values.get(key) ?? create();
        values.set(key, value);
        return value;
      },
    };
  }

  async function subjectOf(manager: VapidManager): Promise<{ sub: string; verified: boolean }> {
    const header = await manager.buildAuthorizationHeader('https://push.example/endpoint');
    const jwt = /t=([^,]+)/.exec(header)?.[1] ?? '';
    const publicKey = /k=(.+)$/.exec(header)?.[1] ?? '';
    const [encodedHeader, encodedPayload, encodedSignature] = jwt.split('.');
    const payload = JSON.parse(Buffer.from(encodedPayload ?? '', 'base64url').toString('utf8')) as { sub: string };
    const key = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: Buffer.from(publicKey, 'base64url').subarray(1, 33).toString('base64url'),
        y: Buffer.from(publicKey, 'base64url').subarray(33, 65).toString('base64url'),
      },
      format: 'jwk',
    });
    const verified = cryptoVerify(
      'sha256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`, 'utf8'),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(encodedSignature ?? '', 'base64url'),
    );
    return { sub: payload.sub, verified };
  }

  test('a configured mailto: contact is signed into the JWT and still verifies', async () => {
    const manager = new VapidManager(memorySecrets(), { subject: 'mailto:ops@example.test' });
    expect(manager.getSubject()).toBe('mailto:ops@example.test');
    const { sub, verified } = await subjectOf(manager);
    expect(sub).toBe('mailto:ops@example.test');
    expect(verified).toBe(true);
  });

  test('a configured https: contact page works the same way', async () => {
    const manager = new VapidManager(memorySecrets(), { subject: 'https://example.test/contact' });
    const { sub, verified } = await subjectOf(manager);
    expect(sub).toBe('https://example.test/contact');
    expect(verified).toBe(true);
  });

  test('no configured contact falls back to the documented reserved-domain subject, which passes its own rule', async () => {
    const manager = new VapidManager(memorySecrets());
    expect(manager.getSubject()).toBe(DEFAULT_VAPID_SUBJECT);
    const { sub, verified } = await subjectOf(manager);
    expect(sub).toBe('mailto:goodvibes-push@goodvibes.invalid');
    // The fallback passes the same rule a configured subject is held to.
    expect(isValidVapidSubject(DEFAULT_VAPID_SUBJECT)).toBe(true);
    expect(verified).toBe(true);
  });

  test('an invalid subject is rejected rather than signed into every JWT', () => {
    for (const bad of ['ops@example.test', 'http://example.test/contact', 'not a url', 'mailto:', 'ftp://example.test']) {
      expect(isValidVapidSubject(bad)).toBe(false);
      expect(() => new VapidManager(memorySecrets(), { subject: bad })).toThrow('VAPID subject must be');
    }
  });

  test('the validity rule accepts exactly what the config key documents', () => {
    expect(isValidVapidSubject('mailto:ops@example.test')).toBe(true);
    expect(isValidVapidSubject('https://example.test/contact')).toBe(true);
    expect(isValidVapidSubject('https://example.test')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The composition root: config key -> a real signed delivery
// ---------------------------------------------------------------------------
describe('push.vapidSubject reaches a real delivery', () => {
  allowLocalPushEndpoints();
  test('the configured contact is the `sub` of the JWT a live delivery carries', async () => {
    const received: Array<{ authorization: string }> = [];
    const sink = Bun.serve({
      port: 0,
      async fetch(request) {
        received.push({ authorization: request.headers.get('authorization') ?? '' });
        await request.arrayBuffer();
        return new Response(null, { status: 201 });
      },
    });
    const sinkOrigin = `http://127.0.0.1:${sink.port}`;
    const secrets = new Map<string, string>();
    const config: Partial<Record<ConfigKey, unknown>> = {
      'push.vapidSubject': 'mailto:ops@example.test',
    };
    const deps = {
      secretsManager: {
        getOrCreateDaemonSecret: async (key: string, create: () => string): Promise<string> => {
          const value = secrets.get(key) ?? create();
          secrets.set(key, value);
          return value;
        },
      },
      shellPaths: { resolveUserPath: (...segments: string[]): string => join(dir, ...segments) },
      surfaceRoot: 'test-surface',
      configManager: { get: ((key: ConfigKey) => config[key]) as never },
    };
    try {
      const service = createPushService(deps);
      // The store the service built is the same file this one addresses.
      const store = createPushSubscriptionStore(deps);
      const registered = await store.register({
        principalId: 'op-1',
        endpoint: `${sinkOrigin}/push/device`,
        keys: realKeys(),
      });
      const receipt = await service.verify(registered.id, 'op-1');
      expect(receipt?.outcome).toBe('delivered');
      expect(received).toHaveLength(1);
      const jwt = /t=([^,]+)/.exec(received[0]?.authorization ?? '')?.[1] ?? '';
      const payload = JSON.parse(
        Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'),
      ) as { sub: string; aud: string };
      expect(payload.sub).toBe('mailto:ops@example.test');
      expect(payload.aud).toBe(sinkOrigin);
    } finally {
      sink.stop(true);
    }
  }, REAL_WORK_BUDGET_MS);

  test('an invalid configured contact falls back rather than crashing construction', () => {
    const config: Partial<Record<ConfigKey, unknown>> = {
      'push.vapidSubject': 'ops@example.test',
    };
    const deps = {
      secretsManager: {
        getOrCreateDaemonSecret: async (_key: string, create: () => string): Promise<string> => create(),
      },
      shellPaths: { resolveUserPath: (...segments: string[]): string => join(dir, ...segments) },
      surfaceRoot: 'test-surface',
      configManager: { get: ((key: ConfigKey) => config[key]) as never },
    };
    // Construction succeeds (a hand-edited config file must not wedge the
    // daemon) and the bad contact is dropped rather than signed into a JWT.
    expect(createPushService(deps)).toBeDefined();
  });
});

describe('the stored VAPID key pair', () => {
  // Every browser subscription is bound to the public key, so a stored pair
  // missing a field used to be replaced by a new one in silence, breaking
  // every subscription. It is now reported and left as it is.
  function storeHolding(raw: string) {
    const values = new Map<string, string>([[VAPID_SECRET_KEY, raw]]);
    return {
      values,
      getOrCreateDaemonSecret: async (key: string, create: () => string) => {
        const value = values.get(key) ?? create();
        values.set(key, value);
        return value;
      },
    };
  }

  test('a stored pair with no private key is reported, not replaced', async () => {
    const raw = JSON.stringify({ publicKey: 'BPublicKeyOnly' });
    const store = storeHolding(raw);
    await expect(new VapidManager(store).getPublicKey()).rejects.toBeInstanceOf(VapidKeypairUnreadableError);
    expect(store.values.get(VAPID_SECRET_KEY)).toBe(raw);
  });

  test('a stored pair whose public key is missing is completed from its private key, the same key', async () => {
    const first = storeHolding('');
    first.values.clear();
    const original = await new VapidManager(first).getPublicKey();
    const stored = JSON.parse(first.values.get(VAPID_SECRET_KEY)!) as { privateJwk: JsonWebKey };
    const store = storeHolding(JSON.stringify({ privateJwk: stored.privateJwk }));
    expect(await new VapidManager(store).getPublicKey()).toBe(original);
  });

  test('an unreadable stored pair is reported, not replaced', async () => {
    const store = storeHolding('{not json');
    await expect(new VapidManager(store).getPublicKey()).rejects.toThrow('not valid JSON');
    expect(store.values.get(VAPID_SECRET_KEY)).toBe('{not json');
  });

  test('an approval that reaches no device because the pair is unreadable leaves a daemon receipt for the next surface', async () => {
    const subscriptions = makeStore();
    await subscriptions.register({ principalId: 'op-1', endpoint: 'https://push.example/phone', keys: realKeys() });
    let listener: ((approval: { id: string; status: string }) => void) | undefined;
    const recorded = new Promise<string>((resolve) => {
      const service = new PushService({
        vapid: new VapidManager(storeHolding('{not json')),
        store: subscriptions,
        transport: async () => ({ status: 201 }),
        receipts: { record: (text) => { resolve(text); } },
      });
      service.attachApprovalSource({ subscribe: (fn) => { listener = fn; return () => undefined; } });
    });
    listener?.({ id: 'apr-1', status: 'pending' });
    expect(await recorded).toContain(VAPID_SECRET_KEY);
  });
});
