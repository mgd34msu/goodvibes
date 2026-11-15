import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { composeMiddleware, type TransportContext, type TransportMiddleware } from '../transport-core/src/middleware.ts';
import { invokeTransportObserver } from '../transport-core/src/observer.ts';
import { injectTraceparent } from '../transport-core/src/otel.ts';
import { readCachedOtelApi, resetOtelState } from '../transport-core/src/otel-state.ts';
import { decodeTunnelFrame, encodeTunnelFrame } from '../transport-core/src/relay/tunnel.ts';
import { createRelayPairingPayload, decodeRelayPairingString, encodeRelayPairingString } from '../transport-core/src/relay/pairing.ts';
import { RELAY_PROTOCOL_VERSION } from '../transport-core/src/relay/protocol.ts';
import { WEBSOCKET_CHUNK_CHARS, WebSocketMessageAssembler, sendWebSocketMessage } from '../transport-core/src/websocket-messages.ts';

afterEach(() => resetOtelState());

const frameOf = (header: Record<string, unknown>): Uint8Array<ArrayBuffer> => encodeTunnelFrame(header as never, new Uint8Array(0));

describe('relay tunnel frames from a surface', () => {
  test('a surface-supplied via-relay marker is dropped so the daemon alone decides it', () => {
    const decoded = decodeTunnelFrame(frameOf({ id: '1', kind: 'request', method: 'POST', path: '/api/x', headers: [['X-GoodVibes-Via-Relay', '0'], ['accept', 'json']] }));
    expect(decoded?.header).toMatchObject({ kind: 'request', headers: [['accept', 'json']] });
    const stream = decodeTunnelFrame(frameOf({ id: '2', kind: 'stream-open', method: 'GET', path: '/events', headers: [['x-goodvibes-via-relay', '1']] }));
    expect(stream?.header).toMatchObject({ kind: 'stream-open', headers: [] });
  });

  test.each(['//evil/x', 'http://other/api', 'api/x', '/a\\b', '', '/\t/evil.com/x', '/\n/evil.com/x', '/\r/evil.com/x', '/a b'])('a request path that is not a local path is refused: %p', (path) => {
    expect(decodeTunnelFrame(frameOf({ id: '1', kind: 'request', method: 'GET', path, headers: [] }))).toBeNull();
  });

  test.each([[[1]], [[['a']]], [[['a', 1]]]])('headers that are not string pairs are refused: %p', (headers) => {
    expect(decodeTunnelFrame(frameOf({ id: '1', kind: 'request', method: 'GET', path: '/x', headers }))).toBeNull();
  });

  test('a well-formed request with a query still decodes', () => {
    expect(decodeTunnelFrame(frameOf({ id: '1', kind: 'request', method: 'GET', path: '/api/x?y=1', headers: [['a', 'b']] }))?.header).toMatchObject({ path: '/api/x?y=1' });
  });
});

describe('relay pairing', () => {
  test('a pairing code for another protocol version is refused up front, naming both versions', () => {
    const payload = { ...createRelayPairingPayload({ relayUrl: 'wss://relay.example', rid: 'r', daemonPublicKey: 'k' }), protocol: RELAY_PROTOCOL_VERSION + 1 };
    expect(() => decodeRelayPairingString(encodeRelayPairingString(payload))).toThrow(`protocol ${RELAY_PROTOCOL_VERSION + 1}`);
  });
  test('a current pairing code round-trips', () => {
    const payload = createRelayPairingPayload({ relayUrl: 'wss://relay.example', rid: 'r', daemonPublicKey: 'k', label: 'home' });
    expect(decodeRelayPairingString(encodeRelayPairingString(payload))).toEqual(payload);
  });
});

describe('WebSocket message framing', () => {
  const chunk = (index: number, final = false) => ({ type: 'chunk', id: 'm', index, final, data: 'x'.repeat(WEBSOCKET_CHUNK_CHARS) });

  test('a peer that never sends the final chunk is cut off at the size limit and the partial message is dropped', () => {
    const assembler = new WebSocketMessageAssembler();
    let accepted = 0;
    expect(() => { for (let i = 0; i < 100_000; i++) { assembler.accept(chunk(i)); accepted++; } }).toThrow('size limit');
    expect(accepted).toBeLessThan(2000);
    // The next message starts clean at index 0.
    expect(assembler.accept({ type: 'chunk', id: 'n', index: 0, final: true, data: '{"ok":true}' })).toEqual({ ok: true });
  });

  test('sending on a closed socket rejects instead of waiting on a backlog that never drains', async () => {
    const socket = { send: () => 1, bufferedAmount: 5 * 1024 * 1024, readyState: 3 };
    await expect(sendWebSocketMessage(socket, 'hello')).rejects.toThrow('closed');
  });

  test('a socket that closes while the backlog is draining ends the wait', async () => {
    const socket = { send: () => 1, bufferedAmount: 5 * 1024 * 1024, readyState: 1 };
    const sending = sendWebSocketMessage(socket, 'hello');
    socket.readyState = 3;
    await expect(sending).rejects.toThrow('closed');
  });

  test('a message the socket dropped is reported, not counted as sent', async () => {
    await expect(sendWebSocketMessage({ send: () => 0, readyState: 1 }, 'hello')).rejects.toThrow('dropped');
    await expect(sendWebSocketMessage({ send: () => -1, readyState: 1 }, 'hello')).resolves.toBeUndefined();
  });
});

describe('transport middleware depth', () => {
  const ctx = (): TransportContext => ({ method: 'GET', url: 'https://example.com/', headers: {}, body: undefined, options: {}, signal: undefined });
  test('a chain of the maximum length still reaches the real fetch', async () => {
    const passThrough: TransportMiddleware = async (_ctx, next) => { await next(); };
    let reached = false;
    const run = composeMiddleware(Array.from({ length: 128 }, () => passThrough), async () => { reached = true; return new Response('ok'); });
    const context = ctx();
    await run(context);
    expect(context.error).toBeUndefined();
    expect(reached).toBe(true);
  });
  test('a chain over the maximum length is refused up front', () => {
    expect(() => composeMiddleware(Array.from({ length: 129 }, () => async (_c, next) => { await next(); }), async () => new Response('ok'))).toThrow('maximum depth');
  });
});

describe('trace context', () => {
  test('the synchronous probe does not cache a negative that would hide OTel from the async probe', () => {
    resetOtelState();
    injectTraceparent({});
    expect(readCachedOtelApi()).toBeUndefined();
  });
});

describe('transport observer failures', () => {
  test('a throwing callback with no onObserverError is warned about once, and never reaches the transport', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let i = 0; i < 3; i++) invokeTransportObserver(() => { throw new Error('observer broke'); });
      expect(warn.mock.calls).toHaveLength(1);
    } finally { warn.mockRestore(); }
  });
  test('onObserverError still receives every failure', () => {
    const seen: string[] = [];
    for (let i = 0; i < 2; i++) invokeTransportObserver(() => { throw new Error('observer broke'); }, (error) => seen.push(error.message));
    expect(seen).toHaveLength(2);
  });
});
