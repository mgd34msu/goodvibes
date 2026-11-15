import { expect, test } from 'bun:test';
import { createEventSourceConnector } from '../transport-realtime/src/event-source-connector.ts';
import { createRelayClient } from '../transport-realtime/src/relay-transport.ts';

test('a throwing onTransportActivity does not stop onEvent from seeing the same SSE frame', async () => {
  const events: unknown[] = [];
  const reported: unknown[] = [];
  const encoder = new TextEncoder();
  const frame = `id: e1\nevent: tools\ndata: ${JSON.stringify({ type: 'TOOL_RECEIVED', payload: { marker: 1 } })}\n\n`;
  let release: () => void = () => {};
  const drained = new Promise<void>((resolve) => { release = resolve; });
  let sent = false;
  const fetchStub = (async () => new Response(new ReadableStream({
    pull(controller) {
      if (!sent) { sent = true; controller.enqueue(encoder.encode(frame)); return; }
      release();
    },
  }, { highWaterMark: 0 }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as unknown as typeof fetch;
  const connector = createEventSourceConnector('http://127.0.0.1:3210', null, fetchStub, {
    reconnect: { enabled: false },
    observer: {
      onTransportActivity: () => { throw new Error('activity observer broke'); },
      onEvent: (event: unknown) => { events.push(event); },
      onObserverError: (error: unknown) => { reported.push(error); },
    } as never,
  });
  const close = await connector('tools', () => {});
  await drained;
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  if (typeof close === 'function') close();
  expect(events).toEqual([{ marker: 1 }]);
});

test('an object pairing for another relay protocol is refused before any connection', () => {
  const pairing = { protocol: 99, relayUrl: 'wss://relay.invalid', rid: 'rid', daemonPublicKey: 'AA' };
  expect(() => createRelayClient({ pairing: pairing as never })).toThrow(/relay protocol 99/);
});
