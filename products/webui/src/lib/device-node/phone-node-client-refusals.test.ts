import { describe, expect, test } from 'bun:test';
import type { BrowserBindings } from './capability-bindings';
import { PhoneNodeClient, type PhoneNodeIdentity, type PhoneNodeStorage } from './phone-node-client';

const BINDINGS: BrowserBindings = {
  isSecureContext: true,
  mediaDevices: undefined,
  geolocation: undefined,
  clipboard: undefined,
  notificationPermission: 'granted',
  canNotify: true,
  canVibrate: true,
  canOpenWindow: true,
} as unknown as BrowserBindings;

function storage(): PhoneNodeStorage & { current: PhoneNodeIdentity | null } {
  const store = {
    current: { nodeId: 'node-1', token: 'secret', label: 'Pixel' } as PhoneNodeIdentity | null,
    read: () => store.current,
    write: (identity: PhoneNodeIdentity) => { store.current = identity; },
    clear: () => { store.current = null; },
  };
  return store;
}

const WORK = { id: 'w1', type: 'device.capability', payload: { capabilityId: 'device.command.vibrate', input: {} } };

function respond(status: number, json: unknown): Response {
  return { status, json: async () => json } as unknown as Response;
}

describe('daemon refusals', () => {
  test('a 403 on work pull keeps the pairing and says a permission is missing', async () => {
    const store = storage();
    const client = new PhoneNodeClient({
      baseUrl: 'http://daemon.test', label: 'Pixel', storage: store, bindings: BINDINGS,
      fetchImpl: async () => respond(403, { error: 'Remote peer token missing required scope: remote:work' }),
    });
    await client.pumpOnce();
    expect(store.current).not.toBeNull();
    expect(client.getState().status).toBe('connected');
    expect(client.getState().message).toContain('lacks a permission');
  });

  test('the permission notice clears once the daemon accepts a pull again', async () => {
    let granted = false;
    const client = new PhoneNodeClient({
      baseUrl: 'http://daemon.test', label: 'Pixel', storage: storage(), bindings: BINDINGS,
      fetchImpl: async () => granted ? respond(200, { work: [] }) : respond(403, {}),
    });
    await client.pumpOnce();
    expect(client.getState().message).toContain('lacks a permission');
    granted = true;
    await client.pumpOnce();
    expect(client.getState().message).toBe('Paired. Waiting for requests.');
  });

  test('the permission notice clears once the daemon accepts a heartbeat again', async () => {
    let granted = false;
    const client = new PhoneNodeClient({
      baseUrl: 'http://daemon.test', label: 'Pixel', storage: storage(), bindings: BINDINGS,
      pullIntervalMs: 3_600_000, heartbeatIntervalMs: 3_600_000,
      fetchImpl: async (input) => String(input).endsWith('/heartbeat')
        ? (granted ? respond(200, {}) : respond(403, {}))
        : respond(500, {}),
    });
    client.start();
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.getState().message).toContain('lacks a permission');
    granted = true;
    client.stop();
    client.start();
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    client.stop();
    expect(client.getState().message).toBe('Paired. Waiting for requests.');
  });

  test('a successful pull does not hide a heartbeat the daemon still refuses', async () => {
    let heartbeatGranted = false;
    const client = new PhoneNodeClient({
      baseUrl: 'http://daemon.test', label: 'Pixel', storage: storage(), bindings: BINDINGS,
      pullIntervalMs: 3_600_000, heartbeatIntervalMs: 3_600_000,
      fetchImpl: async (input) => String(input).endsWith('/heartbeat')
        ? (heartbeatGranted ? respond(200, {}) : respond(403, {}))
        : respond(200, { work: [] }),
    });
    client.start();
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    await client.pumpOnce();
    expect(client.getState().message).toContain('lacks a permission');
    heartbeatGranted = true;
    client.stop();
    client.start();
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    client.stop();
    expect(client.getState().message).toBe('Paired. Waiting for requests.');
  });

  test('a successful heartbeat does not hide a pull the daemon still refuses', async () => {
    const client = new PhoneNodeClient({
      baseUrl: 'http://daemon.test', label: 'Pixel', storage: storage(), bindings: BINDINGS,
      pullIntervalMs: 3_600_000, heartbeatIntervalMs: 3_600_000,
      fetchImpl: async (input) => String(input).endsWith('/heartbeat') ? respond(200, {}) : respond(403, {}),
    });
    client.start();
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    client.stop();
    expect(client.getState().message).toContain('lacks a permission');
  });

  test('a completion report the daemon refuses for a scope shows the notice despite successful pulls', async () => {
    const client = new PhoneNodeClient({
      baseUrl: 'http://daemon.test', label: 'Pixel', storage: storage(), bindings: BINDINGS,
      runCapability: async () => ({ ok: true }),
      fetchImpl: async (input) => String(input).endsWith('/work/pull') ? respond(200, { work: [WORK] }) : respond(403, {}),
    });
    await client.pumpOnce();
    await client.pumpOnce();
    expect(client.getState().message).toContain('lacks a permission');
  });

  test('a 401 on work pull still discards the pairing', async () => {
    const store = storage();
    const client = new PhoneNodeClient({
      baseUrl: 'http://daemon.test', label: 'Pixel', storage: store, bindings: BINDINGS,
      fetchImpl: async () => respond(401, { error: 'Unauthorized remote peer' }),
    });
    await client.pumpOnce();
    expect(store.current).toBeNull();
    expect(client.getState().status).toBe('unpaired');
  });

  test('a completion the daemon rejects is shown as a failed report, not only as served', async () => {
    const client = new PhoneNodeClient({
      baseUrl: 'http://daemon.test', label: 'Pixel', storage: storage(), bindings: BINDINGS,
      runCapability: async () => ({ ok: true }),
      fetchImpl: async (input) => String(input).endsWith('/work/pull') ? respond(200, { work: [WORK] }) : respond(500, {}),
    });
    await client.pumpOnce();
    const rows = client.getState().activity;
    expect(rows.some((row) => !row.ok && row.detail.includes('HTTP 500'))).toBe(true);
  });
});

describe('work in flight across stop and start', () => {
  test('a redelivery handled by a new lifetime does not run the capability a second time', async () => {
    let pulls = 0;
    let runs = 0;
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const running = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const client = new PhoneNodeClient({
      baseUrl: 'http://daemon.test', label: 'Pixel', storage: storage(), bindings: BINDINGS,
      pullIntervalMs: 3_600_000, heartbeatIntervalMs: 3_600_000,
      runCapability: async () => { runs += 1; entered(); await gate; return { ok: true }; },
      fetchImpl: async (input) => {
        if (String(input).endsWith('/work/pull')) { pulls += 1; return respond(200, { work: [WORK] }); }
        return respond(200, {});
      },
    });
    const first = client.pumpOnce();
    await running;
    client.stop();
    client.start();
    while (pulls < 2) await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await first;
    client.stop();
    expect(runs).toBe(1);
  });
});
