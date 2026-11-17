// Proves: After a reconnect, or on the stream opened for the next turn, a client is replayed frames it already has or is not replayed the ones it missed.
// Red when: The event connector stops presenting its last position on a reconnect or a new stream, or the gateway stops resuming from that position.

import { expect, test } from 'bun:test';
import { createEventSourceConnector } from '../transport-realtime/src/event-source-connector.ts';
import { ControlPlaneGateway } from '../platform/src/platform/control-plane/gateway.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { createFeatureFlagManager } from '../platform/src/platform/runtime/feature-flags/manager.ts';
import { emitStreamDelta, emitTurnCompleted, emitTurnSubmitted } from '../platform/src/platform/runtime/emitters/turn.ts';

test('a cut stream resumes with exactly the frames it missed, and the next turn\'s stream is not handed the finished turn again', async () => {
  const bus = new RuntimeEventBus();
  const gateway = new ControlPlaneGateway({ runtimeBus: bus, featureFlags: createFeatureFlagManager() });
  // The socket: each response body passes through a stream the test can cut, as a dropped connection would.
  const cuts: Array<() => void> = [];
  const positions: Array<string | null> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const request = new Request(url, { ...(init?.headers ? { headers: init.headers } : {}), signal: init?.signal ?? null });
    positions.push(request.headers.get('last-event-id'));
    const response = gateway.createEventStream(request, { admin: true, clientKind: 'web', requestedDomains: (url.searchParams.get('domains') ?? '').split(',') });
    const reader = response.body!.getReader();
    const body = new ReadableStream<Uint8Array>({
      // The daemon side learns of the drop only when the client's request is aborted, as over a real network.
      start(controller) { cuts.push(() => controller.error(new Error('connection reset'))); },
      async pull(controller) {
        const next = await reader.read();
        if (next.done) controller.close(); else controller.enqueue(next.value);
      },
    });
    return new Response(body, { status: response.status, headers: response.headers });
  };
  const connector = createEventSourceConnector('http://127.0.0.1:3210', 'token', fetch, {
    reconnect: { baseDelayMs: 1, maxDelayMs: 1 },
    // Only the position is under test; the turn gate is the second line for when it fails.
    turnScope: 'off',
  });

  const frames: string[] = [];
  let waiting: { count: number; resolve: () => void } | null = null;
  const until = (count: number) => new Promise<void>((resolve) => {
    if (frames.length >= count) resolve(); else waiting = { count, resolve };
  });
  const listen = () => connector('turn', (envelope) => {
    const payload = envelope.payload as { type: string; turnId?: string };
    frames.push(`${payload.turnId}:${payload.type}`);
    if (waiting && frames.length >= waiting.count) { const done = waiting; waiting = null; done.resolve(); }
  });
  const ctx = { sessionId: 'session-1', source: 'test', traceId: 'trace-1' };

  const release = await listen();
  emitTurnSubmitted(bus, ctx, { turnId: 'turn-a', prompt: 'first' });
  emitStreamDelta(bus, ctx, { turnId: 'turn-a', content: 'one', accumulated: 'one' });
  await until(2);
  // The turn goes on and the connection drops before the client reads another frame (the bus delivers after this tick).
  emitStreamDelta(bus, ctx, { turnId: 'turn-a', content: ' two', accumulated: 'one two' });
  emitTurnCompleted(bus, ctx, { turnId: 'turn-a', response: 'one two', stopReason: 'completed' });
  cuts.at(-1)!();
  await until(4);
  expect(frames).toEqual(['turn-a:TURN_SUBMITTED', 'turn-a:STREAM_DELTA', 'turn-a:STREAM_DELTA', 'turn-a:TURN_COMPLETED']);
  expect(positions[1]).toBeTruthy();

  // Every listener released; the next turn opens a new stream, which presents the position.
  release?.();
  const releaseNext = await listen();
  emitTurnSubmitted(bus, ctx, { turnId: 'turn-b', prompt: 'second' });
  await until(5);
  expect(frames.slice(4)).toEqual(['turn-b:TURN_SUBMITTED']);
  releaseNext?.();
});
