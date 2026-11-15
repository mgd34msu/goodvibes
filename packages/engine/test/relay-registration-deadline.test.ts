/**
 * The daemon's relay registration must not sit in connecting/reconnecting when
 * the relay never confirms it: an error frame during registration, or no
 * `registered` before the deadline, fails the attempt and goes through the
 * normal reconnect backoff.
 */
import { afterEach, expect, jest, test } from 'bun:test';
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
// The registration deadline and the reconnect backoff are real timers inside
// the registration; fake timers make every elapsed-time claim exact.
afterEach(() => { jest.useRealTimers(); });

test('an error frame during registration fails the attempt and reconnects with backoff', async () => {
  const { reg, sockets, statuses } = await harness({ registrationTimeoutMs: 10_000 });
  jest.useFakeTimers();
  reg.start();
  sockets[0]!.emit('open');
  sockets[0]!.emit('message', { data: JSON.stringify({ t: 'error', code: 'rid-conflict', message: 'taken' }) });
  expect(sockets[0]!.closed).toBe(true);
  expect(statuses).toContain('reconnecting');
  expect(sockets).toHaveLength(1); // the retry waits out its backoff (5 ms) rather than reconnecting at once
  jest.advanceTimersByTime(5);
  expect(sockets).toHaveLength(2);
  reg.stop();
});

test('no registered frame before the deadline fails the attempt and reconnects', async () => {
  const { reg, sockets, statuses } = await harness({ registrationTimeoutMs: 20 });
  jest.useFakeTimers();
  reg.start();
  sockets[0]!.emit('open');
  jest.advanceTimersByTime(19);
  expect(sockets[0]!.closed).toBe(false);
  jest.advanceTimersByTime(1);
  expect(sockets[0]!.closed).toBe(true);
  expect(statuses).toContain('reconnecting');
  jest.advanceTimersByTime(5);
  expect(sockets).toHaveLength(2);
  reg.stop();
});

test('a registered socket is not torn down by the deadline, and an error frame after registration only logs', async () => {
  const { reg, sockets } = await harness({ registrationTimeoutMs: 20 });
  jest.useFakeTimers();
  reg.start();
  sockets[0]!.emit('open');
  sockets[0]!.emit('message', { data: JSON.stringify({ t: 'registered', rid: 'rid-deadline' }) });
  jest.advanceTimersByTime(80); // well past the 20 ms deadline
  expect(reg.status).toBe('registered');
  sockets[0]!.emit('message', { data: JSON.stringify({ t: 'error', code: 'rid-conflict', message: 'late' }) });
  jest.advanceTimersByTime(30);
  expect(reg.status).toBe('registered');
  expect(sockets[0]!.closed).toBe(false);
  expect(sockets).toHaveLength(1);
  reg.stop();
});
