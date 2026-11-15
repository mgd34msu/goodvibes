/**
 * A Discord gateway connection that stops working must be reported, with the
 * reason Discord gave, instead of looking connected.
 */
import { describe, expect, test } from 'bun:test';
import { DiscordGatewayClient, type DiscordIntegration } from '../platform/src/platform/integrations/discord.ts';

class FakeSocket {
  static last: FakeSocket;
  static readonly OPEN = 1;
  readyState = 1;
  readonly sent: Array<{ op: number; d: unknown }> = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(public readonly url: string) {
    FakeSocket.last = this;
    queueMicrotask(() => this.emit('open', {}));
  }
  addEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send(raw: string): void { this.sent.push(JSON.parse(raw)); }
  close(): void { this.readyState = 3; }
  emit(type: string, event: unknown): void { for (const fn of this.listeners.get(type) ?? []) fn(event); }
  receive(frame: Record<string, unknown>): void { this.emit('message', { data: JSON.stringify(frame) }); }
}

function make(extra: Partial<ConstructorParameters<typeof DiscordGatewayClient>[0]> = {}) {
  const closed: Array<{ reason: string; code: number | undefined }> = [];
  const dispatched: string[] = [];
  const client = new DiscordGatewayClient({
    token: 't',
    integration: {} as DiscordIntegration,
    gatewayUrl: 'wss://gw.test',
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    jitter: () => 0,
    onClosed: (reason, code) => { closed.push({ reason, code }); },
    onDispatch: async (dispatch) => {
      const name = String(dispatch.t);
      // The first event is slower than the second; order must still hold.
      if (name === 'FIRST') await new Promise((resolve) => setTimeout(resolve, 20));
      dispatched.push(name);
    },
    ...extra,
  });
  return { client, closed, dispatched };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 5_000) throw new Error(`${label} never happened`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('Discord gateway liveness', () => {
  test('a connection that never acknowledges heartbeats is closed and reported', async () => {
    const { client, closed } = make();
    await client.start();
    FakeSocket.last.receive({ op: 10, d: { heartbeat_interval: 20 } });
    await waitFor(() => closed.length === 1, 'the dead connection report');
    expect(closed[0]!.reason).toContain('heartbeat');
    expect(client.isStarted).toBe(false);
    expect(FakeSocket.last.readyState).toBe(3);
  });

  test('a connection that acknowledges every heartbeat stays open', async () => {
    const { client, closed } = make();
    await client.start();
    const socket = FakeSocket.last;
    socket.receive({ op: 10, d: { heartbeat_interval: 20 } });
    let acked = 0;
    while (acked < 5) {
      await waitFor(() => socket.sent.filter((frame) => frame.op === 1).length > acked, 'a heartbeat');
      socket.receive({ op: 11 });
      acked += 1;
    }
    expect(closed).toEqual([]);
    expect(client.isStarted).toBe(true);
    client.stop();
  });

  test('the steady heartbeat interval starts from the first beat, so a late first beat is not followed by an early second one', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realSetInterval = globalThis.setInterval;
    const timeouts: Array<{ fn: () => void; ms: number }> = [];
    const intervals: Array<{ fn: () => void; ms: number }> = [];
    const { client, closed } = make({ jitter: () => 0.9 });
    await client.start();
    const socket = FakeSocket.last;
    try {
      globalThis.setTimeout = ((fn: () => void, ms: number) => {
        timeouts.push({ fn, ms });
        return { unref() {} };
      }) as unknown as typeof setTimeout;
      globalThis.setInterval = ((fn: () => void, ms: number) => {
        intervals.push({ fn, ms });
        return { unref() {} };
      }) as unknown as typeof setInterval;
      socket.receive({ op: 10, d: { heartbeat_interval: 1000 } });
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.setInterval = realSetInterval;
    }
    expect(timeouts.map((t) => t.ms)).toEqual([900]);
    // Nothing repeats until the first beat has gone out.
    expect(intervals).toEqual([]);
    try {
      globalThis.setInterval = ((fn: () => void, ms: number) => {
        intervals.push({ fn, ms });
        return { unref() {} };
      }) as unknown as typeof setInterval;
      timeouts[0]!.fn();
    } finally {
      globalThis.setInterval = realSetInterval;
    }
    expect(socket.sent.filter((frame) => frame.op === 1)).toHaveLength(1);
    expect(intervals.map((i) => i.ms)).toEqual([1000]);
    expect(closed).toEqual([]);
    client.stop();
  });

  test('an invalid session or a reconnect request is reported at once', async () => {
    for (const op of [7, 9]) {
      const { client, closed } = make();
      await client.start();
      FakeSocket.last.receive({ op });
      await waitFor(() => closed.length === 1, `the report for op ${op}`);
      expect(client.isStarted).toBe(false);
    }
  });

  test('the close code reaches the owner', async () => {
    const { client, closed } = make();
    await client.start();
    FakeSocket.last.emit('close', { code: 4014, reason: 'Disallowed intent(s)' });
    expect(closed).toHaveLength(1);
    expect(closed[0]!.code).toBe(4014);
    expect(closed[0]!.reason).toContain('4014');
  });

  test('dispatches are handled in the order they arrived', async () => {
    const { client, dispatched } = make();
    await client.start();
    const socket = FakeSocket.last;
    socket.receive({ op: 0, s: 1, t: 'FIRST', d: {} });
    socket.receive({ op: 0, s: 2, t: 'SECOND', d: {} });
    await waitFor(() => dispatched.length === 2, 'both dispatches');
    expect(dispatched).toEqual(['FIRST', 'SECOND']);
    client.stop();
  });
});
