import { describe, expect, jest, test } from 'bun:test';


const suffix = "";
const slackMod = await import(`../platform/src/platform/integrations/slack${suffix}.ts`);
const discordMod = await import(`../platform/src/platform/integrations/discord${suffix}.ts`);

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  listeners = new Map<string, Array<(e: unknown) => void>>();
  sent: string[] = [];
  /** Real sockets open after the constructor returns; a test that wants one that never does sets this false. */
  static opensByItself = true;
  /** A test that wants to choose when the old socket's close event arrives sets this; close() then emits nothing. */
  static holdsCloses = false;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
    if (FakeSocket.opensByItself) queueMicrotask(() => this.emit('open'));
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send(data: string): void { this.sent.push(data); }
  /** Like a real socket: close() returns at once, the close event arrives later. */
  close(): void { if (!FakeSocket.holdsCloses) queueMicrotask(() => this.emit('close')); }
  emit(type: string, e: unknown = {}): void { for (const fn of this.listeners.get(type) ?? []) fn(e); }
}
const WS = FakeSocket as unknown as typeof WebSocket;
const tick = () => new Promise<void>(r => setTimeout(r, 0));

function slackFixture(extra: Record<string, unknown> = {}) {
  FakeSocket.instances = [];
  FakeSocket.opensByItself = true;
  FakeSocket.holdsCloses = false;
  let opens = 0;
  const closed: string[] = [];
  const integration = { appsConnectionsOpen: async () => { opens++; await tick(); return { ok: true, url: 'wss://slack.test' }; } };
  const client = new slackMod.SlackSocketModeClient({
    appToken: 'xapp', integration, onEnvelope: () => {}, WebSocketImpl: WS, onClosed: (r: string) => closed.push(r), ...extra,
  });
  return { client, closed, opens: () => opens };
}

function discordFixture(extra: Record<string, unknown> = {}) {
  FakeSocket.instances = [];
  FakeSocket.opensByItself = true;
  FakeSocket.holdsCloses = false;
  let lookups = 0;
  const closed: string[] = [];
  const integration = { getGatewayBot: async () => { lookups++; await tick(); return { url: 'wss://gw.test', shards: 1 }; } };
  const client = new discordMod.DiscordGatewayClient({
    token: 't', integration, onDispatch: () => {}, WebSocketImpl: WS, onClosed: (r: string) => closed.push(r), ...extra,
  });
  return { client, closed, lookups: () => lookups };
}

describe.each([
  ['slack', slackFixture],
  ['discord', discordFixture],
] as const)('%s socket client lifecycle', (_name, make) => {
  test('a deliberate stop() is not reported as an unexpected close', async () => {
    const { client, closed } = make();
    await client.start();
    client.stop();
    await tick();
    expect(closed).toEqual([]);
    expect(client.isStarted).toBe(false);
  });

  test('an unexpected close is reported once and clears started', async () => {
    const { client, closed } = make();
    await client.start();
    FakeSocket.instances[0]!.emit('close');
    expect(closed.length).toBe(1);
    expect(client.isStarted).toBe(false);
  });

  test('a stale socket closing late does not disturb a newer connection', async () => {
    const { client, closed } = make();
    FakeSocket.holdsCloses = true;
    await client.start();
    client.stop();
    await client.start();
    expect(FakeSocket.instances.length).toBe(2);
    expect(client.isStarted).toBe(true);
    // The first socket's close arrives only now, with the second already open and current.
    FakeSocket.instances[0]!.emit('close');
    await tick();
    expect(closed).toEqual([]);
    expect(client.isStarted).toBe(true);
  });

  test('concurrent start() calls share one connection attempt', async () => {
    const { client } = make();
    const [a, b] = await Promise.all([client.start(), client.start()]);
    expect(FakeSocket.instances.length).toBe(1);
    expect(a).toBe(b);
  });

  test('stop() during an in-flight start leaves no socket open', async () => {
    const { client } = make();
    const pending = client.start().catch(() => undefined);
    client.stop();
    await pending;
    expect(FakeSocket.instances.length).toBe(0);
    expect(client.isStarted).toBe(false);
  });
});

describe.each([
  ['slack', slackFixture],
  ['discord', discordFixture],
] as const)('%s socket client: a start resolves when the socket is open, not when it was constructed', (_name, make) => {
  /** start() as a settled outcome: failures from either client's convention become `failed`. */
  async function outcome(started: Promise<unknown>): Promise<'opened' | 'failed'> {
    try {
      const result = await started as { ok?: boolean } | undefined;
      return result?.ok === false ? 'failed' : 'opened';
    } catch { return 'failed'; }
  }

  test('nothing is reported started until the socket opens', async () => {
    const { client } = make();
    FakeSocket.opensByItself = false;
    const pending = client.start();
    await tick(); await tick();
    expect(client.isStarted).toBe(false);
    FakeSocket.instances[0]!.emit('open');
    expect(await outcome(pending)).toBe('opened');
    expect(client.isStarted).toBe(true);
  });

  test('a socket that closes before it opens fails the start and is not reported as a lost connection', async () => {
    const { client, closed } = make();
    FakeSocket.opensByItself = false;
    const pending = client.start();
    await tick(); await tick();
    FakeSocket.instances[0]!.emit('close');
    expect(await outcome(pending)).toBe('failed');
    expect(client.isStarted).toBe(false);
    expect(closed).toEqual([]);
  });

  test('a socket that errors before it opens fails the start', async () => {
    const { client } = make();
    FakeSocket.opensByItself = false;
    const pending = client.start();
    await tick(); await tick();
    FakeSocket.instances[0]!.emit('error');
    expect(await outcome(pending)).toBe('failed');
    expect(client.isStarted).toBe(false);
  });

  test('a socket that never opens fails the start at the deadline', async () => {
    let fire: () => void = () => undefined;
    const { client } = make({ setTimer: (fn: () => void) => { fire = fn; return () => undefined; } });
    FakeSocket.opensByItself = false;
    const pending = client.start();
    await tick(); await tick();
    fire();
    expect(await outcome(pending)).toBe('failed');
    expect(client.isStarted).toBe(false);
  });

  test('stop() while the socket is still opening settles the start as failed', async () => {
    const { client } = make();
    FakeSocket.opensByItself = false;
    const pending = client.start();
    await tick(); await tick();
    client.stop();
    expect(await outcome(pending)).toBe('failed');
    expect(client.isStarted).toBe(false);
  });
});

test('discord: a stale close does not stop the new connection heartbeat', async () => {
  jest.useFakeTimers();
  try {
    // A fixed gateway URL skips the lookup, so nothing here waits on a timer.
    const { client } = discordFixture({ gatewayUrl: 'wss://gw.test', jitter: () => 0.5 });
    FakeSocket.holdsCloses = true;
    await client.start();
    client.stop();
    await client.start();
    const [stale, current] = FakeSocket.instances as [FakeSocket, FakeSocket];
    current.emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }) });
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();

    // The first socket's close arrives now, after the second one is live and has its heartbeat.
    stale.emit('close');
    expect(client.isStarted).toBe(true);

    // The first beat is due after interval * jitter. Heartbeat opcode 1 is what a live heartbeat sends.
    const beatsBefore = current.sent.filter((frame) => (JSON.parse(frame) as { op: number }).op === 1).length;
    jest.advanceTimersByTime(30_000);
    const beatsAfter = current.sent.filter((frame) => (JSON.parse(frame) as { op: number }).op === 1).length;
    expect(beatsAfter).toBe(beatsBefore + 1);
    client.stop();
  } finally { jest.useRealTimers(); }
});
