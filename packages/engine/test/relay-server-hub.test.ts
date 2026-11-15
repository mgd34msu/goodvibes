/**
 * relay-server-hub.test.ts
 *
 * Behavioral tests for the runtime-neutral RelayHub, the rendezvous core of the
 * self-hostable relay. A pair of in-memory fake sockets stands in for real
 * WebSockets so the pairing, opaque forwarding, caps, and lifecycle can be
 * exercised deterministically without a network. The hub must never inspect the
 * payloads it forwards; these tests assert it forwards them byte-for-byte and
 * only ever adds/strips the pipe-routing prefix.
 */
import { describe, expect, test } from 'bun:test';
import {
  RelayHub,
  type RelayServerSocket,
} from '../daemon-api/src/relay-server.js';
import {
  RELAY_DEFAULT_MAX_MESSAGE_BYTES,
  decodeControlFrame,
  encodeControlFrame,
  fromBase64Url,
  framePipePayload,
  generateRelayIdentity,
  proveRelayRegistration,
  relayIdentityRendezvousId,
  toBase64Url,
  unframePipePayload,
  type RelayControlFrame,
  type RelayKeyPair,
} from '../transport-core/src/relay/index.js';

class FakeSocket implements RelayServerSocket {
  readonly texts: string[] = [];
  readonly binaries: Uint8Array<ArrayBuffer>[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: string | Uint8Array): void {
    if (typeof data === 'string') this.texts.push(data);
    else this.binaries.push(new Uint8Array(data));
  }
  close(code?: number, reason?: string): void {
    this.closed = { ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) };
  }
  lastControl(): RelayControlFrame | null {
    const last = this.texts.at(-1);
    return last ? decodeControlFrame(last) : null;
  }
}

/** Register a daemon the way a real one does: register, answer the challenge with its key, wait for the verdict. */
async function registerDaemon(hub: RelayHub, identity?: RelayKeyPair, claimRid?: string) {
  const key = identity ?? await generateRelayIdentity();
  const rid = claimRid ?? await relayIdentityRendezvousId(key);
  const sock = new FakeSocket();
  const conn = hub.accept(sock, '10.0.0.1');
  conn.handleText(encodeControlFrame({ t: 'register', role: 'daemon', protocol: 1, rid }));
  const challenge = sock.lastControl();
  if (challenge?.t === 'challenge') {
    const sent = sock.texts.length;
    conn.handleText(encodeControlFrame(await proveRelayRegistration(key, rid, challenge.nonce)));
    for (let i = 0; i < 200 && sock.texts.length === sent; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return { sock, conn, rid, key };
}

function connectClient(hub: RelayHub, rid: string, addr = '10.0.0.2') {
  const sock = new FakeSocket();
  const conn = hub.accept(sock, addr);
  conn.handleText(encodeControlFrame({ t: 'connect', role: 'client', protocol: 1, rid }));
  return { sock, conn };
}

describe('RelayHub pairing + opaque forwarding', () => {
  test('daemon registers and a client pairs, opening a pipe both sides see', async () => {
    const hub = new RelayHub();
    const daemon = await registerDaemon(hub);
    expect(daemon.sock.lastControl()).toEqual({ t: 'registered', rid: daemon.rid, maxMessageBytes: RELAY_DEFAULT_MAX_MESSAGE_BYTES });

    const client = connectClient(hub, daemon.rid);
    const clientFrame = client.sock.lastControl();
    expect(clientFrame?.t).toBe('connected');
    const pipe = clientFrame?.t === 'connected' ? clientFrame.pipe : '';
    expect(daemon.sock.lastControl()).toEqual({ t: 'pipe-open', pipe });
    expect(hub.stats()).toEqual({ daemons: 1, pipes: 1 });
  });

  test('forwards client bytes to the daemon with a pipe prefix, and back', async () => {
    const hub = new RelayHub();
    const daemon = await registerDaemon(hub);
    const client = connectClient(hub, daemon.rid);
    const connected = client.sock.lastControl();
    const pipe = connected?.t === 'connected' ? connected.pipe : '';
    const pipeBytes = fromBase64Url(pipe);

    // client -> daemon: hub prepends the pipe id, payload is untouched.
    const payload = new Uint8Array([9, 8, 7, 6, 5]);
    client.conn.handleBinary(payload);
    const forwarded = daemon.sock.binaries.at(-1)!;
    const split = unframePipePayload(forwarded)!;
    expect(toBase64Url(split.pipeId.slice())).toBe(pipe);
    expect(Array.from(split.payload)).toEqual([9, 8, 7, 6, 5]);

    // daemon -> client: hub strips the pipe id, client sees the bare payload.
    const reply = new Uint8Array([1, 2, 3]);
    daemon.conn.handleBinary(framePipePayload(pipeBytes, reply));
    expect(Array.from(client.sock.binaries.at(-1)!)).toEqual([1, 2, 3]);
  });
});

describe('RelayHub honest failure + caps', () => {
  test('dialing an unregistered rendezvous id returns daemon-offline and closes', () => {
    const hub = new RelayHub();
    const client = connectClient(hub, 'nope');
    const frame = client.sock.lastControl();
    expect(frame).toMatchObject({ t: 'error', code: 'daemon-offline' });
    expect(client.sock.closed).not.toBeNull();
  });

  test('a registration that cannot prove the rendezvous id is refused, and the owner keeps it', async () => {
    const hub = new RelayHub();
    const owner = await registerDaemon(hub);
    const squatter = await registerDaemon(hub, await generateRelayIdentity(), owner.rid);
    expect(squatter.sock.lastControl()).toMatchObject({ t: 'error', code: 'unauthorized' });
    expect(squatter.sock.closed).not.toBeNull();
    expect(owner.sock.closed).toBeNull();
    expect(connectClient(hub, owner.rid).sock.lastControl()?.t).toBe('connected');
  });

  test('a proven registration replaces the same daemon\'s stale connection', async () => {
    const hub = new RelayHub();
    const stale = await registerDaemon(hub);
    const fresh = await registerDaemon(hub, stale.key);
    expect(fresh.sock.lastControl()).toMatchObject({ t: 'registered', rid: stale.rid });
    expect(stale.sock.closed).toMatchObject({ code: 1008, reason: 'replaced' });
    stale.conn.handleClose();
    expect(hub.stats().daemons).toBe(1);
    const client = connectClient(hub, stale.rid);
    expect(fresh.sock.lastControl()?.t).toBe('pipe-open');
    expect(client.sock.lastControl()?.t).toBe('connected');
  });

  test('protocol-version mismatch is rejected', () => {
    const hub = new RelayHub();
    const sock = new FakeSocket();
    const conn = hub.accept(sock, 'a');
    conn.handleText(encodeControlFrame({ t: 'register', role: 'daemon', protocol: 999, rid: 'x' }));
    expect(sock.lastControl()).toMatchObject({ t: 'error', code: 'protocol-version' });
  });

  test('per-daemon pipe cap trips capacity', async () => {
    const hub = new RelayHub({ limits: { maxPipesPerDaemon: 1 } });
    const daemon = await registerDaemon(hub);
    connectClient(hub, daemon.rid);
    const overflow = connectClient(hub, daemon.rid);
    expect(overflow.sock.lastControl()).toMatchObject({ t: 'error', code: 'capacity' });
  });

  test('oversized data frame is rejected', async () => {
    const hub = new RelayHub({ limits: { maxMessageBytes: 8 } });
    const daemon = await registerDaemon(hub);
    const client = connectClient(hub, daemon.rid);
    client.conn.handleBinary(new Uint8Array(9));
    expect(client.sock.lastControl()).toMatchObject({ t: 'error', code: 'capacity' });
  });

  test('a daemon frame over the cap closes only its pipe, never the registration or other pipes', async () => {
    const hub = new RelayHub({ limits: { maxMessageBytes: 64 } });
    const daemon = await registerDaemon(hub);
    const big = connectClient(hub, daemon.rid);
    const other = connectClient(hub, daemon.rid, '10.0.0.3');
    const pipeOf = (frame: RelayControlFrame | null) => fromBase64Url(frame?.t === 'connected' ? frame.pipe : '');
    const otherPipe = pipeOf(other.sock.lastControl());
    daemon.conn.handleBinary(framePipePayload(pipeOf(big.sock.lastControl()), new Uint8Array(100)));
    expect(big.sock.lastControl()).toMatchObject({ t: 'pipe-close', reason: 'frame-too-large' });
    expect(daemon.sock.closed).toBeNull();
    expect(hub.stats()).toEqual({ daemons: 1, pipes: 1 });
    daemon.conn.handleBinary(framePipePayload(otherPipe, new Uint8Array([1, 2])));
    expect(Array.from(other.sock.binaries.at(-1)!)).toEqual([1, 2]);
  });

  test('handshake rate limit trips after the configured budget', async () => {
    const hub = new RelayHub({ limits: { maxHandshakesPerMinutePerAddr: 2 } });
    const { rid } = await registerDaemon(hub);
    // same address dials repeatedly
    connectClient(hub, rid, 'spammer'); // 1
    const third = connectClient(hub, rid, 'spammer'); // 2 (register used 0 for this addr; this is 2nd client)
    // The daemon registered from a different addr, so 'spammer' has 2 connects.
    const fourth = connectClient(hub, rid, 'spammer');
    expect(fourth.sock.lastControl()).toMatchObject({ t: 'error', code: 'rate-limited' });
    expect(third.sock.lastControl()?.t).toBe('connected');
  });
});

describe('RelayHub lifecycle cleanup', () => {
  test('client disconnect notifies the daemon and frees the pipe', async () => {
    const hub = new RelayHub();
    const daemon = await registerDaemon(hub);
    const client = connectClient(hub, daemon.rid);
    client.conn.handleClose();
    expect(daemon.sock.lastControl()?.t).toBe('pipe-close');
    expect(hub.stats().pipes).toBe(0);
  });

  test('daemon disconnect closes its clients and clears registration', async () => {
    const hub = new RelayHub();
    const daemon = await registerDaemon(hub);
    const client = connectClient(hub, daemon.rid);
    daemon.conn.handleClose();
    expect(client.sock.lastControl()).toMatchObject({ t: 'pipe-close', reason: 'daemon-disconnected' });
    expect(client.sock.closed).not.toBeNull();
    expect(hub.stats()).toEqual({ daemons: 0, pipes: 0 });
  });
});


describe('daemon-owned relay pipe close', () => {
  test('a daemon can close its own pipe but never another daemon pipe', async () => {
    const hub = new RelayHub();
    const owner = await registerDaemon(hub);
    const other = await registerDaemon(hub);
    const client = connectClient(hub, owner.rid);
    const connected = client.sock.lastControl();
    const pipe = connected?.t === 'connected' ? connected.pipe : '';
    other.conn.handleText(encodeControlFrame({ t: 'pipe-close', pipe }));
    expect(hub.stats().pipes).toBe(1);
    expect(client.sock.lastControl()?.t).toBe('connected');
    owner.conn.handleText(encodeControlFrame({ t: 'pipe-close', pipe }));
    expect(hub.stats().pipes).toBe(0);
    expect(client.sock.lastControl()).toEqual({ t: 'pipe-close', pipe, reason: 'daemon-closed' });
    expect(owner.sock.closed).toBeNull();
    expect(other.sock.closed).toBeNull();
  });
});
