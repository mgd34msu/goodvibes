import { describe, expect, test } from 'bun:test';
import { ControlPlaneGateway } from '../platform/src/platform/control-plane/gateway.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';

const HEARTBEAT_NEVER = 3_600_000;

interface Opened {
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly abort: () => void;
}

function open(gateway: ControlPlaneGateway, options: Parameters<ControlPlaneGateway['createEventStream']>[1] = {}, headers: Record<string, string> = {}, abortFirst = false): Opened {
  const controller = new AbortController();
  if (abortFirst) controller.abort();
  const response = gateway.createEventStream(
    new Request('http://127.0.0.1/api/control-plane/events', { signal: controller.signal, headers }),
    { heartbeatIntervalMs: HEARTBEAT_NEVER, ...options },
  );
  return { reader: response.body!.getReader(), abort: () => controller.abort() };
}

const decoder = new TextDecoder();

/** Read frames until the text satisfies `done`, or the stream ends. Bounded: a frame the test expects is queued already. */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, done: (text: string) => boolean, maxReads = 12): Promise<string> {
  let text = '';
  for (let index = 0; index < maxReads; index += 1) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
    if (done(text)) break;
  }
  return text;
}

function liveClientCount(gateway: ControlPlaneGateway): number {
  return (gateway as unknown as { liveClients: Map<string, unknown> }).liveClients.size;
}

describe('control-plane event streams', () => {
  test('closing a replaced stream leaves the stream that took over its client id receiving broadcasts', async () => {
    const gateway = new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() });
    const first = open(gateway, { clientId: 'shared-session:S1' });
    const second = open(gateway, { clientId: 'shared-session:S1' });
    first.abort();
    gateway.publishEvent('session-update', { sessionId: 'S1', marker: 'after-first-closed' });
    const text = await readUntil(second.reader, (seen) => seen.includes('after-first-closed'));
    expect(text).toContain('event: session-update');
    expect(text).toContain('after-first-closed');
    expect(liveClientCount(gateway)).toBe(1);
    second.abort();
    expect(liveClientCount(gateway)).toBe(0);
  });

  test('a request that is already aborted leaves no live client behind', () => {
    const gateway = new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() });
    open(gateway, { clientId: 'late' }, {}, true);
    expect(liveClientCount(gateway)).toBe(0);
  });

  test('a session-scoped stream is not handed another session approval, live or on replay', async () => {
    const gateway = new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() });
    gateway.publishEvent('approval-update', { approval: { id: 'ap-other-before', sessionId: 'B' } });
    const scoped = open(gateway, { sessionId: 'A', sessionScopedDelivery: true });
    gateway.publishEvent('approval-update', { approval: { id: 'ap-other-live', sessionId: 'B' } });
    gateway.publishEvent('approval-update', { approval: { id: 'ap-own-live', sessionId: 'A' } });
    gateway.publishSurfaceMessage({ surface: 'web', title: 'other', body: 'x', level: 'info', metadata: { sessionId: 'B', marker: 'msg-other' } });
    const text = await readUntil(scoped.reader, (seen) => seen.includes('ap-own-live'));
    expect(text).toContain('ap-own-live');
    expect(text).not.toContain('ap-other-before');
    expect(text).not.toContain('ap-other-live');
    expect(text).not.toContain('msg-other');
    scoped.abort();
  });

  test('a session-scoped stream opened with no position gets that session history even when other sessions were busier', async () => {
    const gateway = new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() });
    gateway.publishEvent('session-update', { sessionId: 'A', marker: 'turn-start-of-A' });
    for (let index = 0; index < 30; index += 1) gateway.publishEvent('session-update', { sessionId: 'B', marker: `busy-${index}` });
    const scoped = open(gateway, { sessionId: 'A', sessionScopedDelivery: true });
    const text = await readUntil(scoped.reader, (seen) => seen.includes('turn-start-of-A'));
    expect(text).toContain('turn-start-of-A');
    expect(text).not.toContain('busy-');
    scoped.abort();
  });

  test('a turn still running replays from its start even when its own deltas fill the catch-up window', async () => {
    const gateway = new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() });
    gateway.publishEvent('turn', { type: 'TURN_SUBMITTED', sessionId: 'A', payload: { turnId: 't1', prompt: 'start-of-t1' } });
    for (let index = 0; index < 30; index += 1) gateway.publishEvent('turn', { type: 'STREAM_DELTA', sessionId: 'A', payload: { turnId: 't1', content: `delta-${index}` } });
    const scoped = open(gateway, { sessionId: 'A', sessionScopedDelivery: true });
    const text = await readUntil(scoped.reader, (seen) => seen.includes('delta-29'), 30);
    expect(text).toContain('start-of-t1');
    expect(text.indexOf('start-of-t1')).toBeLessThan(text.indexOf('delta-10'));
    scoped.abort();
  });

  test('a turn that already ended is not replayed from a start whose end the consumer would never see', async () => {
    const gateway = new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() });
    gateway.publishEvent('turn', { type: 'TURN_SUBMITTED', sessionId: 'A', payload: { turnId: 't1', prompt: 'start-of-t1' } });
    gateway.publishEvent('turn', { type: 'TURN_COMPLETED', sessionId: 'A', payload: { turnId: 't1', response: 'done' } });
    for (let index = 0; index < 30; index += 1) gateway.publishEvent('turn', { type: 'STREAM_DELTA', sessionId: 'A', payload: { turnId: 't2', content: `later-${index}` } });
    const scoped = open(gateway, { sessionId: 'A', sessionScopedDelivery: true });
    const text = await readUntil(scoped.reader, (seen) => seen.includes('later-29'), 30);
    expect(text).not.toContain('start-of-t1');
    scoped.abort();
  });

  test('a consumer that falls behind is told how much it missed once it can read again', async () => {
    const gateway = new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() });
    const stream = open(gateway);
    const published = 300;
    for (let index = 0; index < published; index += 1) gateway.publishEvent('session-update', { marker: `n-${index}` });
    // The queue holds exactly its high-water mark; reading it all makes room again.
    let delivered = '';
    for (let index = 0; index < 256; index += 1) {
      const chunk = await stream.reader.read();
      delivered += decoder.decode(chunk.value);
    }
    expect(delivered).not.toContain('event: gap');
    const lastId = [...delivered.matchAll(/^id: (.+)$/gm)].at(-1)?.[1];
    gateway.publishEvent('session-update', { marker: 'after-drain' });
    const next = await readUntil(stream.reader, (seen) => seen.includes('after-drain'), 4);
    const gap = /event: gap\ndata: (.+)\n/.exec(next);
    expect(gap).not.toBeNull();
    const body = JSON.parse(gap![1]!) as { dropped: number; afterId?: string };
    expect(body.dropped).toBeGreaterThan(0);
    expect(body.afterId).toBe(lastId);
    expect(next.indexOf('event: gap')).toBeLessThan(next.indexOf('after-drain'));
    stream.abort();
  });
});
