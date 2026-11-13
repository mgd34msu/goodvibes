/**
 * The daemon's relay registration must not sit in connecting/reconnecting when
 * the relay never confirms it: an error frame during registration, or no
 * `registered` before the deadline, fails the attempt and goes through the
 * normal reconnect backoff.
 */
import { expect, test } from 'bun:test';
import {
  createRelayDaemonRegistration,
  type RelayClientWebSocket,
  type RelayRegistrationStatus,
} from '../daemon-api/src/index.js';
import { generateRelayIdentity } from '../transport-core/src/relay/index.js';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

class FakeSocket implements RelayClientWebSocket {
  binaryType = 'arraybuffer';
  closed = false;
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  send(): void {}
  close(): void { this.closed = true; }
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event: unknown = {}): void { for (const l of this.listeners.get(type) ?? []) l(event); }
}

async function harness(extra: { registrationTimeoutMs?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const statuses: RelayRegistrationStatus[] = [];
  const reg = createRelayDaemonRegistration({
    relayUrl: 'ws://mock', rid: 'rid-deadline', identity: await generateRelayIdentity(), localBaseUrl: 'http://daemon.local',
    dispatch: async () => new Response('ok'),
    webSocketImpl: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    logger: silent, reconnectBaseDelayMs: 5, reconnectMaxDelayMs: 10, onStatusChange: s => statuses.push(s),
    ...extra,
  });
  return { reg, sockets, statuses };
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('an error frame during registration fails the attempt and reconnects with backoff', async () => {
  const { reg, sockets, statuses } = await harness({ registrationTimeoutMs: 10_000 });
  reg.start();
  sockets[0]!.emit('open');
  sockets[0]!.emit('message', { data: JSON.stringify({ t: 'error', code: 'rid-conflict', message: 'taken' }) });
  await wait(60);
  expect(sockets[0]!.closed).toBe(true);
  expect(statuses).toContain('reconnecting');
  expect(sockets.length).toBeGreaterThan(1);
  reg.stop();
});

test('no registered frame before the deadline fails the attempt and reconnects', async () => {
  const { reg, sockets, statuses } = await harness({ registrationTimeoutMs: 20 });
  reg.start();
  sockets[0]!.emit('open');
  await wait(100);
  expect(sockets[0]!.closed).toBe(true);
  expect(statuses).toContain('reconnecting');
  expect(sockets.length).toBeGreaterThan(1);
  reg.stop();
});

test('a registered socket is not torn down by the deadline, and an error frame after registration only logs', async () => {
  const { reg, sockets } = await harness({ registrationTimeoutMs: 20 });
  reg.start();
  sockets[0]!.emit('open');
  sockets[0]!.emit('message', { data: JSON.stringify({ t: 'registered', rid: 'rid-deadline' }) });
  await wait(80);
  expect(reg.status).toBe('registered');
  sockets[0]!.emit('message', { data: JSON.stringify({ t: 'error', code: 'rid-conflict', message: 'late' }) });
  await wait(30);
  expect(reg.status).toBe('registered');
  expect(sockets[0]!.closed).toBe(false);
  expect(sockets).toHaveLength(1);
  reg.stop();
});
