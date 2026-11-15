/**
 * Over the relay, a streamed request is answered with the daemon's own status
 * and headers before its bytes. When the daemon refuses the stream, the caller
 * gets that status and body; when it closes the stream before answering, the
 * fetch fails with the daemon's reason rather than a clean end of stream; and a
 * relay connection that failed once must be retried by the next connect().
 *
 * The daemon here is a scripted peer on the real secure channel, so the frames
 * it answers with are chosen by each test.
 */
import { describe, expect, test } from 'bun:test';
import {
  RelaySecureChannel,
  decodeControlFrame,
  decodeTunnelFrame,
  encodeControlFrame,
  encodeTunnelFrame,
  encodeUtf8,
  generateRelayIdentity,
  relayIdentityPublicKeyBase64Url,
  respondToHandshake,
  createRelayPairingPayload,
  type TunnelHeader,
} from '../transport-core/src/relay/index.js';
import { createRelayClient, type RelayWebSocketLike } from '../transport-realtime/src/relay-transport.js';

const RID = 'rid-scripted-daemon';

type DaemonScript = (
  header: TunnelHeader,
  reply: (header: TunnelHeader, body?: Uint8Array<ArrayBuffer>) => void,
  body: Uint8Array<ArrayBuffer>,
) => void;

/** A relay client socket whose far end is a scripted daemon speaking the real handshake and channel. */
async function scriptedDaemon(script: DaemonScript): Promise<{ pairing: ReturnType<typeof createRelayPairingPayload>; socket: () => RelayWebSocketLike }> {
  const identity = await generateRelayIdentity();
  const pairing = createRelayPairingPayload({
    relayUrl: 'ws://relay.invalid',
    rid: RID as never,
    daemonPublicKey: await relayIdentityPublicKeyBase64Url(identity),
  });
  const socket = (): RelayWebSocketLike => {
    const listeners = new Map<string, Array<(event: unknown) => void>>();
    const deliver = (type: string, event: unknown): void => { for (const fn of listeners.get(type) ?? []) fn(event); };
    const toClient = (bytes: Uint8Array<ArrayBuffer>): void => deliver('message', { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    let channel: RelaySecureChannel | null = null;
    let chain: Promise<void> = Promise.resolve();
    const ws: RelayWebSocketLike = {
      binaryType: 'blob',
      addEventListener(type, listener) { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
      close() {},
      send(data) {
        chain = chain.then(async () => {
          if (typeof data === 'string') {
            const frame = decodeControlFrame(data);
            if (frame?.t === 'connect') deliver('message', { data: encodeControlFrame({ t: 'connected', pipe: 'pipe-1' }) });
            return;
          }
          const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data);
          if (!channel) {
            const { keys, message2 } = await respondToHandshake(identity, encodeUtf8(RID), bytes);
            channel = new RelaySecureChannel(keys, 'daemon');
            toClient(message2);
            return;
          }
          const framed = decodeTunnelFrame(await channel.open(bytes));
          if (!framed) return;
          const active = channel;
          script(framed.header, (header, body = new Uint8Array(0)) => {
            chain = chain.then(async () => toClient(await active.seal(encodeTunnelFrame(header, body))));
          }, framed.body);
        });
      },
    };
    queueMicrotask(() => deliver('open', {}));
    return ws;
  };
  return { pairing, socket };
}

const EVENTS_URL = 'http://relay.local/api/control-plane/events?domains=turn';
const sseRequest = { headers: { Accept: 'text/event-stream' } };

describe('relay event stream: the daemon\'s refusal is not a clean end of stream', () => {
  test('a stream the daemon closes with stream-limit fails the fetch and names the reason', async () => {
    const { pairing, socket } = await scriptedDaemon((header, reply) => {
      if (header.kind === 'stream-open') reply({ id: header.id, kind: 'stream-close', reason: 'stream-limit' });
    });
    const client = createRelayClient({ pairing, webSocketImpl: socket });
    await expect(client.fetch(EVENTS_URL, sseRequest)).rejects.toThrow('stream-limit');
    client.close();
  });

  test('a stream whose source ended normally closes cleanly', async () => {
    const { pairing, socket } = await scriptedDaemon((header, reply) => {
      if (header.kind === 'stream-open') {
        reply({ id: header.id, kind: 'response', status: 200, headers: [['content-type', 'text/event-stream']] });
        reply({ id: header.id, kind: 'stream-close', reason: 'source-ended' });
      }
    });
    const client = createRelayClient({ pairing, webSocketImpl: socket });
    const response = await client.fetch(EVENTS_URL, sseRequest);

    expect((await response.body!.getReader().read()).done).toBe(true);
    client.close();
  });

  test('a daemon that answers the stream with a 401 response frame answers the caller with that status and body', async () => {
    const { pairing, socket } = await scriptedDaemon((header, reply) => {
      if (header.kind === 'stream-open') {
        reply({ id: header.id, kind: 'response', status: 401, headers: [['content-type', 'application/json']] }, encodeUtf8('{"error":"Unauthorized"}'));
      }
    });
    const client = createRelayClient({ pairing, webSocketImpl: socket });
    const response = await client.fetch(EVENTS_URL, sseRequest);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    client.close();
  });

  test('a POST that asks for a streamed answer goes as a stream with its method and body', async () => {
    let opened: { method: string; body: string } | undefined;
    const { pairing, socket } = await scriptedDaemon((header, reply, body) => {
      if (header.kind !== 'stream-open') return;
      opened = { method: header.method, body: new TextDecoder().decode(body) };
      reply({ id: header.id, kind: 'response', status: 200, headers: [['content-type', 'audio/mpeg']] });
      reply({ id: header.id, kind: 'stream-data', seq: 0 }, encodeUtf8('chunk-1'));
      reply({ id: header.id, kind: 'stream-close', reason: 'source-ended' });
    });
    const client = createRelayClient({ pairing, webSocketImpl: socket });
    const response = await client.fetch('http://relay.local/api/voice/tts/stream', {
      method: 'POST', headers: { Accept: 'audio/mpeg', 'Content-Type': 'application/json' }, body: '{"text":"hi"}',
    });
    expect(opened).toEqual({ method: 'POST', body: '{"text":"hi"}' });
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(await response.text()).toBe('chunk-1');
    client.close();
  });
});

describe('relay client: a connection that failed to start is retried', () => {
  test('a socket constructor that throws once does not poison later connect() calls', async () => {
    let calls = 0;
    const failing: RelayWebSocketLike = {
      binaryType: 'blob',
      send() {},
      close() {},
      addEventListener(type, listener) {
        if (type === 'error') queueMicrotask(() => listener({}));
      },
    };
    const { pairing } = await scriptedDaemon(() => {});
    const client = createRelayClient({
      pairing,
      webSocketImpl: () => {
        calls += 1;
        if (calls === 1) throw new Error('constructor refused');
        return failing;
      },
    });

    await expect(client.connect()).rejects.toThrow('constructor refused');
    await expect(client.connect()).rejects.toThrow('Relay WebSocket error');
    expect(calls).toBe(2);
  });
});
