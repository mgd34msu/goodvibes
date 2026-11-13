/**
 * Stop during start, and concurrent start, on the Slack / Discord runtimes.
 *
 * The socket clients already survive stop-during-start and share an in-flight
 * start, but only if the manager hands the SAME client to stop() and to a second
 * start(). The manager used to store the client only after start() resolved.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { ChannelProviderRuntimeManager } from '../platform/src/platform/channels/provider-runtime.js';
import { SlackSocketModeClient } from '../platform/src/platform/integrations/slack.js';
import { DiscordGatewayClient } from '../platform/src/platform/integrations/discord.js';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function makeManager(): ChannelProviderRuntimeManager {
  const values: Record<string, unknown> = {
    'surfaces.slack.appToken': 'xapp-test',
    'surfaces.slack.botToken': 'xoxb-test',
    'surfaces.discord.botToken': 'discord-test',
  };
  return new ChannelProviderRuntimeManager({
    configManager: { get: (key: string) => values[key] } as never,
    serviceRegistry: { resolveSecret: async () => null, get: () => null } as never,
    buildSurfaceAdapterContext: () => ({}) as never,
  });
}

interface Gate { release(ok?: boolean): void }

/** Replace start/stop/isStarted on the real client class with a controllable fake. */
function fakeClient(proto: typeof SlackSocketModeClient.prototype | typeof DiscordGatewayClient.prototype, shape: (ok: boolean) => unknown) {
  const instances: object[] = [];
  const stops: object[] = [];
  const gates: Gate[] = [];
  const started = new WeakSet<object>();
  const p = proto as unknown as { start(): Promise<unknown>; stop(): void };
  const startSpy = spyOn(p, 'start').mockImplementation(function (this: object) {
    if (!instances.includes(this)) instances.push(this);
    return new Promise((resolve) => {
      gates.push({ release: (ok = true) => { if (ok) started.add(this); resolve(shape(ok)); } });
    });
  });
  const stopSpy = spyOn(p, 'stop').mockImplementation(function (this: object) { stops.push(this); started.delete(this); });
  const original = Object.getOwnPropertyDescriptor(proto, 'isStarted')!;
  Object.defineProperty(proto, 'isStarted', { configurable: true, get(this: object) { return started.has(this); } });
  return { instances, stops, gates, restore: () => { startSpy.mockRestore(); stopSpy.mockRestore(); Object.defineProperty(proto, 'isStarted', original); } };
}

const cases = [
  { name: 'slack', proto: SlackSocketModeClient.prototype, shape: (ok: boolean) => ok ? { ok: true, url: 'wss://x' } : { ok: false, error: 'nope' } },
  { name: 'discord', proto: DiscordGatewayClient.prototype, shape: () => ({ url: 'wss://gw', shards: 1 }) },
] as const;

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });

for (const { name, proto, shape } of cases) describe(`${name} runtime lifecycle`, () => {
  test('stop() during an in-flight start stops that client and the finished start does not mark started', async () => {
    const fake = fakeClient(proto, shape); restore = fake.restore;
    const manager = makeManager();
    const starting = manager.start(name);
    await tick();
    expect(fake.instances.length).toBe(1);
    manager.stop(name);
    expect(fake.stops).toEqual([fake.instances[0]!]);
    fake.gates[0]!.release();
    const result = await starting;
    expect(result.ok).toBe(false);
    expect(manager.status(name).running).toBe(false);
  });

  test('a concurrent start reuses the in-flight client', async () => {
    const fake = fakeClient(proto, shape); restore = fake.restore;
    const manager = makeManager();
    const first = manager.start(name);
    const second = manager.start(name);
    await tick();
    expect(fake.instances.length).toBe(1);
    fake.gates[0]!.release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(fake.instances.length).toBe(1);
    manager.stop(name);
  });

  test('a start after stop-during-start gets a fresh client and is not poisoned by the old one', async () => {
    const fake = fakeClient(proto, shape); restore = fake.restore;
    const manager = makeManager();
    const old = manager.start(name);
    await tick();
    manager.stop(name);
    const fresh = manager.start(name);
    await tick();
    expect(fake.instances.length).toBe(2);
    fake.gates[0]!.release();
    fake.gates[1]!.release();
    expect((await old).ok).toBe(false);
    expect((await fresh).ok).toBe(true);
    manager.stop(name);
  });
});

describe('slack failed start', () => {
  test('a failed start leaves no client behind, so a retry builds a new one', async () => {
    const fake = fakeClient(SlackSocketModeClient.prototype, cases[0].shape); restore = fake.restore;
    const manager = makeManager();
    const first = manager.start('slack');
    await tick();
    fake.gates[0]!.release(false);
    expect((await first).ok).toBe(false);
    const second = manager.start('slack');
    await tick();
    expect(fake.instances.length).toBe(2);
    fake.gates[1]!.release();
    expect((await second).ok).toBe(true);
    manager.stop('slack');
  });
});
