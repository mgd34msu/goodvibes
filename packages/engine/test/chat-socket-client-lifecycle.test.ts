import { describe, expect, test } from 'bun:test';


const suffix = "";
const slackMod = await import(`../platform/src/platform/integrations/slack${suffix}.ts`);
const discordMod = await import(`../platform/src/platform/integrations/discord${suffix}.ts`);

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  listeners = new Map<string, Array<(e: unknown) => void>>();
  sent: string[] = [];
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send(data: string): void { this.sent.push(data); }
  /** Like a real socket: close() returns at once, the close event arrives later. */
  close(): void { queueMicrotask(() => this.emit('close')); }
  emit(type: string, e: unknown = {}): void { for (const fn of this.listeners.get(type) ?? []) fn(e); }
}
const WS = FakeSocket as unknown as typeof WebSocket;
const tick = () => new Promise<void>(r => setTimeout(r, 0));

function slackFixture() {
  FakeSocket.instances = [];
  let opens = 0;
  const closed: string[] = [];
  const integration = { appsConnectionsOpen: async () => { opens++; await tick(); return { ok: true, url: 'wss://slack.test' }; } };
  const client = new slackMod.SlackSocketModeClient({
    appToken: 'xapp', integration, onEnvelope: () => {}, WebSocketImpl: WS, onClosed: (r: string) => closed.push(r),
  });
  return { client, closed, opens: () => opens };
}

function discordFixture() {
  FakeSocket.instances = [];
  let lookups = 0;
  const closed: string[] = [];
  const integration = { getGatewayBot: async () => { lookups++; await tick(); return { url: 'wss://gw.test', shards: 1 }; } };
  const client = new discordMod.DiscordGatewayClient({
    token: 't', integration, onDispatch: () => {}, WebSocketImpl: WS, onClosed: (r: string) => closed.push(r),
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
    await client.start();
    client.stop();
    await client.start();
    expect(FakeSocket.instances.length).toBe(2);
    await tick(); // the first socket's close arrives now
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

test('discord: a stale close does not clear the new connection heartbeat', async () => {
  const { client } = discordFixture();
  await client.start();
  client.stop();
  await client.start();
  FakeSocket.instances[1]!.emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }) });
  await tick();
  const hb = (client as unknown as { heartbeat: unknown }).heartbeat;
  expect(hb).not.toBeNull();
  await tick(); // stale close of socket 0
  expect((client as unknown as { heartbeat: unknown }).heartbeat).not.toBeNull();
  client.stop();
});
