// Proves: The relay, a server the owner does not control, impersonates the daemon or replays a tunnelled frame.
// Red when: The relay client stops checking the daemon's handshake confirmation, or its secure channel accepts a frame it already opened.

import { expect, test } from 'bun:test';
import { createRelayClient, type RelayWebSocketLike } from '../transport-realtime/src/relay-transport.ts';
import {
  RelaySecureChannel,
  decodeControlFrame,
  decodeTunnelFrame,
  encodeControlFrame,
  encodeTunnelFrame,
  encodeUtf8,
  generateRelayIdentity,
  createRelayPairingPayload,
  relayIdentityPublicKeyBase64Url,
  relayIdentityRendezvousId,
  respondToHandshake,
  type RelayKeyPair,
} from '../transport-core/src/relay/index.ts';

/**
 * The WebSocket, playing the relay: it forwards the client's handshake to a
 * responder holding `answerWith` (the real daemon's key, or one of its own),
 * answers each request as the daemon would, and can deliver an earlier sealed
 * frame again before the real answer.
 */
function relay(answerWith: RelayKeyPair, rid: string, replayEarlierFrame: () => boolean) {
  const fromClient: Uint8Array[] = [];
  const sentToClient: Uint8Array[] = [];
  let daemon: RelaySecureChannel | null = null;
  const socket = (): RelayWebSocketLike => {
    const listeners = new Map<string, Array<(event: unknown) => void>>();
    const fire = (type: string, event: unknown) => queueMicrotask(() => { for (const listener of listeners.get(type) ?? []) listener(event); });
    const toClient = (data: string | Uint8Array) => {
      if (typeof data !== 'string') sentToClient.push(data);
      fire('message', { data: typeof data === 'string' ? data : data.slice().buffer });
    };
    fire('open', {});
    return {
      binaryType: 'arraybuffer',
      addEventListener: (type, listener) => { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
      close: () => {},
      send: (data) => {
        if (typeof data === 'string') {
          if (decodeControlFrame(data)?.t === 'connect') toClient(encodeControlFrame({ t: 'connected', pipe: 'pipe-1' }));
          return;
        }
        const bytes = new Uint8Array(data instanceof ArrayBuffer ? data : data.slice().buffer);
        fromClient.push(bytes);
        void (async () => {
          if (!daemon) {
            const answered = await respondToHandshake(answerWith, encodeUtf8(rid), bytes);
            daemon = new RelaySecureChannel(answered.keys, 'daemon');
            toClient(answered.message2);
            return;
          }
          const request = decodeTunnelFrame(await daemon.open(bytes));
          if (!request || request.header.kind !== 'request') return;
          const earlier = sentToClient.at(-1);
          if (earlier && replayEarlierFrame()) toClient(earlier);
          toClient(await daemon.seal(encodeTunnelFrame(
            { id: request.header.id, kind: 'response', status: 200, headers: [['content-type', 'application/json']] },
            encodeUtf8(JSON.stringify({ answered: request.header.path })),
          )));
        })();
      },
    };
  };
  return { socket, fromClient };
}

test('only the paired daemon completes the handshake, and a frame delivered again tears the channel down', async () => {
  const daemonKey = await generateRelayIdentity();
  const rid = await relayIdentityRendezvousId(daemonKey);
  const pairing = createRelayPairingPayload({ relayUrl: 'wss://relay.invalid/connect', rid, daemonPublicKey: await relayIdentityPublicKeyBase64Url(daemonKey), code: 'relay-code-under-test' });

  // The control: the real daemon's key completes the handshake and one request round-trips.
  let replay = false;
  const honest = relay(daemonKey, rid, () => replay);
  const client = createRelayClient({ pairing, webSocketImpl: honest.socket });
  const first = await client.fetch('http://daemon.local/api/sessions');
  expect(await first.json()).toEqual({ answered: '/api/sessions' });

  // The relay delivers the first answer's sealed frame again ahead of the second answer.
  replay = true;
  await expect(client.fetch('http://daemon.local/api/tasks')).rejects.toThrow();
  expect(client.ready).toBe(false);

  // A relay that answers the handshake with a key of its own is refused, and no request is sent to it.
  const impostor = relay(await generateRelayIdentity(), rid, () => false);
  const fooled = createRelayClient({ pairing, webSocketImpl: impostor.socket });
  await expect(fooled.connect()).rejects.toThrow();
  expect(impostor.fromClient).toHaveLength(1);
});
