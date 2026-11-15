// relay-server.ts
//
// A minimal, self-hostable, zero-knowledge rendezvous relay. Deploy one process
// on any VPS with `bun`, point daemons and surfaces at it, and it pairs them
// without ever being able to read their traffic. It does exactly three things:
//
//   1. Lets a daemon connect OUTBOUND and register under its rendezvous id
//      (no inbound port on the daemon's network required). The id is derived
//      from the daemon's identity key, and the daemon proves it by signing a
//      fresh challenge, so a device that saw a pairing code cannot take the id,
//      and a proven registration replaces a stale one (a daemon whose network
//      changed is not locked out by its own dead connection).
//   2. Lets a client dial that same rendezvous id and opens a multiplexed pipe
//      between the two.
//   3. Forwards OPAQUE bytes between the paired endpoints. The end-to-end
//      handshake (see @goodvibes-jev/engine/transport-core/relay) runs inside each
//      pipe before any application data, so the relay only ever sees ciphertext
//      plus connection metadata (who paired with whom, byte counts, timing).
//
// There are NO accounts and NO stored state, a public instance is protected
// only by caps and rate limits so it cannot be turned into a liability. The
// core `RelayHub` is runtime-neutral and socket-agnostic (testable without a
// real server); `createBunRelayServer` is the thin Bun.serve adapter.

import {
  RELAY_PROTOCOL_VERSION,
  RELAY_PIPE_ID_BYTES,
  createRelayChallenge,
  decodeControlFrame,
  encodeControlFrame,
  framePipePayload,
  randomBytes,
  toBase64Url,
  unframePipePayload,
  verifyRelayRegistration,
  type PipeId,
  type RelayErrorCode,
  type RelayProveFrame,
  type RendezvousId,
} from '@goodvibes-jev/engine/transport-core/relay';

/** The subset of a WebSocket the hub needs. Keeps the hub runtime-neutral. */
export interface RelayServerSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/** Optional structured logger; defaults to silent. */
export interface RelayServerLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Caps and rate limits that keep a public instance from becoming a liability. */
export interface RelayServerLimits {
  /** Maximum concurrently-registered daemons. */
  readonly maxDaemons: number;
  /** Maximum concurrent client pipes across all daemons. */
  readonly maxPipes: number;
  /** Maximum concurrent client pipes for a single daemon. */
  readonly maxPipesPerDaemon: number;
  /**
   * Maximum bytes in a single forwarded data frame. Stated to every endpoint in
   * `registered` / `connected`, so endpoints fragment larger tunnel frames.
   */
  readonly maxMessageBytes: number;
  /** Maximum register/connect attempts per remote address per rolling minute. */
  readonly maxHandshakesPerMinutePerAddr: number;
}

export const DEFAULT_RELAY_LIMITS: RelayServerLimits = {
  maxDaemons: 256,
  maxPipes: 4096,
  maxPipesPerDaemon: 64,
  maxMessageBytes: 4 * 1024 * 1024,
  maxHandshakesPerMinutePerAddr: 120,
};

const SILENT_LOGGER: RelayServerLogger = { info: () => {}, warn: () => {}, error: () => {} };

interface DaemonRegistration {
  readonly socket: RelayServerSocket;
  readonly pipes: Set<PipeId>;
}

interface PipeRecord {
  readonly rid: RendezvousId;
  readonly client: RelayServerSocket;
  readonly daemon: RelayServerSocket;
  readonly pipeIdBytes: Uint8Array<ArrayBuffer>;
}

function errorFrame(code: RelayErrorCode, message: string, pipe?: PipeId): string {
  return encodeControlFrame(pipe !== undefined ? { t: 'error', code, message, pipe } : { t: 'error', code, message });
}

/** Most addresses the limiter remembers at once; past it the least recently active are forgotten. */
const MAX_TRACKED_ADDRESSES = 10_000;
const RATE_WINDOW_MS = 60_000;

/**
 * A per-address rolling-minute counter, bounded in the number of addresses it
 * remembers so a listener probed from many sources cannot grow it without
 * limit. It owns no timer: the map is kept in order of last activity, so each
 * call drops the addresses at its head whose attempts all left the window,
 * which is constant work per call on average. Behind a proxy every client
 * shares the proxy's address, so they also share one allowance. Used for relay
 * handshakes and for daemon sign-ins and requests.
 */
export class AddressRateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly perMinute: number, private readonly maxAddresses = MAX_TRACKED_ADDRESSES) {}
  /** Addresses currently remembered. */
  get trackedAddresses(): number {
    return this.hits.size;
  }
  /** True when `addr` may make one more attempt now; the attempt is counted. A refused attempt is not stored. */
  allow(addr: string, now: number = Date.now()): boolean {
    const cutoff = now - RATE_WINDOW_MS;
    const list = (this.hits.get(addr) ?? []).filter((t) => t > cutoff);
    // Re-insert so the map stays ordered by most recent activity.
    this.hits.delete(addr);
    const allowed = list.length < this.perMinute;
    if (allowed) list.push(now);
    this.hits.set(addr, list);
    this.trim(cutoff);
    return allowed;
  }
  forget(addr: string): void {
    this.hits.delete(addr);
  }
  private trim(cutoff: number): void {
    // The head is the least recently active address; once its newest attempt is
    // inside the window, so is every address after it.
    for (const [addr, list] of this.hits) {
      if (list[list.length - 1]! > cutoff && this.hits.size <= this.maxAddresses) break;
      this.hits.delete(addr);
    }
  }
}

/**
 * The runtime-neutral rendezvous core. One instance per relay process. Every
 * connection is represented by a `RelayConnection` returned from `accept`.
 */
export class RelayHub {
  private readonly daemons = new Map<RendezvousId, DaemonRegistration>();
  private readonly pipes = new Map<PipeId, PipeRecord>();
  private readonly limits: RelayServerLimits;
  private readonly logger: RelayServerLogger;
  private readonly rateLimiter: AddressRateLimiter;

  constructor(options: { limits?: Partial<RelayServerLimits>; logger?: RelayServerLogger } = {}) {
    this.limits = { ...DEFAULT_RELAY_LIMITS, ...options.limits };
    this.logger = options.logger ?? SILENT_LOGGER;
    this.rateLimiter = new AddressRateLimiter(this.limits.maxHandshakesPerMinutePerAddr);
  }

  /** Current occupancy, surfaces/monitoring can read this. */
  stats(): { readonly daemons: number; readonly pipes: number } {
    return { daemons: this.daemons.size, pipes: this.pipes.size };
  }

  /** Maximum bytes allowed in a single forwarded data frame. */
  get maxMessageBytes(): number {
    return this.limits.maxMessageBytes;
  }

  /** Begin tracking a freshly-connected socket. */
  accept(socket: RelayServerSocket, remoteAddr: string): RelayConnection {
    return new RelayConnection(this, socket, remoteAddr);
  }

  // ── internal operations invoked by RelayConnection ──

  /** @internal */
  _rateOk(addr: string): boolean {
    return this.rateLimiter.allow(addr, Date.now());
  }

  /**
   * @internal Register a daemon that proved it owns `rid`. A registration
   * already held for the id is a stale connection of the same daemon (only
   * the key holder can prove the id), so it is closed with its pipes and
   * replaced. Returns an error code or null on success.
   */
  _register(rid: RendezvousId, socket: RelayServerSocket): RelayErrorCode | null {
    const stale = this.daemons.get(rid);
    if (stale && stale.socket !== socket) {
      this._unregister(rid, stale.socket);
      try { stale.socket.close(1008, 'replaced'); } catch { /* already gone */ }
      this.logger.info('relay daemon registration replaced', { rid });
    }
    if (this.daemons.size >= this.limits.maxDaemons) return 'capacity';
    this.daemons.set(rid, { socket, pipes: new Set() });
    this.logger.info('relay daemon registered', { rid, daemons: this.daemons.size });
    return null;
  }

  /** @internal Open a client pipe to a registered daemon. */
  _openPipe(rid: RendezvousId, client: RelayServerSocket): { pipeId: PipeId; pipeIdBytes: Uint8Array<ArrayBuffer> } | RelayErrorCode {
    const daemon = this.daemons.get(rid);
    if (!daemon) return 'daemon-offline';
    if (this.pipes.size >= this.limits.maxPipes) return 'capacity';
    if (daemon.pipes.size >= this.limits.maxPipesPerDaemon) return 'capacity';
    const pipeIdBytes = randomBytes(RELAY_PIPE_ID_BYTES);
    const pipeId = toBase64Url(pipeIdBytes);
    this.pipes.set(pipeId, { rid, client, daemon: daemon.socket, pipeIdBytes });
    daemon.pipes.add(pipeId);
    daemon.socket.send(encodeControlFrame({ t: 'pipe-open', pipe: pipeId }));
    this.logger.info('relay pipe opened', { rid, pipe: pipeId, pipes: this.pipes.size });
    return { pipeId, pipeIdBytes };
  }

  /** @internal Forward an opaque payload from a client to its daemon (adds pipe prefix). */
  _clientToDaemon(pipeId: PipeId, payload: Uint8Array<ArrayBuffer>): boolean {
    const pipe = this.pipes.get(pipeId);
    if (!pipe) return false;
    pipe.daemon.send(framePipePayload(pipe.pipeIdBytes, payload));
    return true;
  }

  /** @internal Forward an opaque daemon frame ([pipeId][payload]) to the right client. */
  _daemonToClient(frame: Uint8Array<ArrayBuffer>): boolean {
    const split = unframePipePayload(frame);
    if (!split) return false;
    const pipeId = toBase64Url(split.pipeId.slice());
    const pipe = this.pipes.get(pipeId);
    if (!pipe) return false;
    pipe.client.send(split.payload.slice());
    return true;
  }

  /**
   * @internal A data frame over the size cap closes only the pipe it was
   * addressed to, never the daemon's registration and every other pipe on it.
   */
  _refuseOversizeDaemonFrame(frame: Uint8Array<ArrayBuffer>, daemon: RelayServerSocket): void {
    const split = unframePipePayload(frame);
    if (!split) return;
    const pipeId = toBase64Url(split.pipeId.slice());
    if (this.pipes.get(pipeId)?.daemon !== daemon) return;
    daemon.send(errorFrame('capacity', `Data frame exceeds the relay message-size cap of ${this.limits.maxMessageBytes} bytes; send it in fragments.`, pipeId));
    this._closePipe(pipeId, 'both', 'frame-too-large');
  }

  /** @internal A daemon may close only a pipe owned by its own registered socket. */
  _closeDaemonPipe(pipeId: PipeId, daemon: RelayServerSocket): boolean {
    if (this.pipes.get(pipeId)?.daemon !== daemon) return false;
    this._closePipe(pipeId, 'client', 'daemon-closed');
    return true;
  }

  /** @internal Tear down a single pipe, notifying the surviving peer. */
  _closePipe(pipeId: PipeId, notify: 'client' | 'daemon' | 'both', reason?: string): void {
    const pipe = this.pipes.get(pipeId);
    if (!pipe) return;
    this.pipes.delete(pipeId);
    this.daemons.get(pipe.rid)?.pipes.delete(pipeId);
    const closeFrame = encodeControlFrame(reason !== undefined ? { t: 'pipe-close', pipe: pipeId, reason } : { t: 'pipe-close', pipe: pipeId });
    if (notify === 'client' || notify === 'both') pipe.client.send(closeFrame);
    if (notify === 'daemon' || notify === 'both') pipe.daemon.send(closeFrame);
  }

  /** @internal Remove the registration `socket` holds for `rid` and close all its pipes. */
  _unregister(rid: RendezvousId, socket: RelayServerSocket): void {
    const daemon = this.daemons.get(rid);
    if (!daemon || daemon.socket !== socket) return;
    for (const pipeId of [...daemon.pipes]) {
      const pipe = this.pipes.get(pipeId);
      this.pipes.delete(pipeId);
      pipe?.client.send(encodeControlFrame({ t: 'pipe-close', pipe: pipeId, reason: 'daemon-disconnected' }));
      pipe?.client.close(1001, 'daemon-disconnected');
    }
    this.daemons.delete(rid);
    this.logger.info('relay daemon unregistered', { rid, daemons: this.daemons.size });
  }
}

/** Per-connection state machine. One instance per accepted socket. */
export class RelayConnection {
  private role: 'unknown' | 'proving' | 'daemon' | 'client' = 'unknown';
  private rid: RendezvousId | undefined;
  private pipeId: PipeId | undefined;
  private nonce: string | undefined;
  private closed = false;

  constructor(
    private readonly hub: RelayHub,
    private readonly socket: RelayServerSocket,
    private readonly remoteAddr: string,
  ) {}

  /** Handle a text (control) frame from this socket. */
  handleText(text: string): void {
    const frame = decodeControlFrame(text);
    if (!frame) {
      this.fail('malformed', 'Unparseable control frame.');
      return;
    }
    if (frame.t === 'register' && this.role === 'unknown') {
      this.onRegister(frame.protocol, frame.rid);
      return;
    }
    if (frame.t === 'prove' && this.role === 'proving') {
      void this.onProve(frame);
      return;
    }
    if (frame.t === 'connect' && this.role === 'unknown') {
      this.onConnect(frame.protocol, frame.rid);
      return;
    }
    if (frame.t === 'ping' && (this.role === 'daemon' || this.role === 'client')) {
      // Endpoints ask this so a path that died without a close is noticed.
      this.socket.send(encodeControlFrame({ t: 'pong', n: frame.n }));
      return;
    }
    if (frame.t === 'pipe-close' && this.role === 'daemon') {
      // The pipe id alone grants no authority over another daemon's clients.
      this.hub._closeDaemonPipe(frame.pipe, this.socket);
      return;
    }
    // Any other control frame from an endpoint is out of protocol.
    this.fail('malformed', `Unexpected control frame "${frame.t}" for role "${this.role}".`);
  }

  /** Handle a binary (data) frame from this socket. */
  handleBinary(bytes: Uint8Array<ArrayBuffer>): void {
    if (bytes.length > this.hub.maxMessageBytes) {
      if (this.role === 'daemon') this.hub._refuseOversizeDaemonFrame(bytes, this.socket);
      else this.fail('capacity', `Data frame exceeds the relay message-size cap of ${this.hub.maxMessageBytes} bytes; send it in fragments.`);
      return;
    }
    if (this.role === 'client' && this.pipeId) {
      if (!this.hub._clientToDaemon(this.pipeId, bytes)) this.socket.close(1011, 'pipe-gone');
      return;
    }
    if (this.role === 'daemon') {
      if (!this.hub._daemonToClient(bytes)) {
        // Unknown/closed pipe, ignore silently (client may have just left).
      }
      return;
    }
    this.fail('malformed', 'Data frame before pairing.');
  }

  /** Handle socket closure. */
  handleClose(): void {
    this.closed = true;
    if (this.role === 'daemon' && this.rid) {
      this.hub._unregister(this.rid, this.socket);
    } else if (this.role === 'client' && this.pipeId) {
      this.hub._closePipe(this.pipeId, 'daemon', 'client-disconnected');
    }
  }

  private onRegister(protocol: number, rid: RendezvousId): void {
    if (protocol !== RELAY_PROTOCOL_VERSION) {
      this.fail('protocol-version', `Relay speaks protocol ${RELAY_PROTOCOL_VERSION}.`);
      return;
    }
    if (!this.hub._rateOk(this.remoteAddr)) {
      this.fail('rate-limited', 'Too many handshake attempts.');
      return;
    }
    // Nothing is registered until the daemon proves it holds the key the id
    // was derived from, by signing this connection's fresh nonce.
    const challenge = createRelayChallenge();
    this.role = 'proving';
    this.rid = rid;
    this.nonce = challenge.nonce;
    this.socket.send(encodeControlFrame(challenge));
  }

  private async onProve(proof: RelayProveFrame): Promise<void> {
    const rid = this.rid, nonce = this.nonce;
    this.nonce = undefined;
    if (!rid || !nonce) return;
    const proven = await verifyRelayRegistration(rid, nonce, proof);
    if (this.closed || this.role !== 'proving' || this.rid !== rid) return;
    if (!proven) {
      this.fail('unauthorized', 'The registration did not prove ownership of the rendezvous id.');
      return;
    }
    const err = this.hub._register(rid, this.socket);
    if (err) {
      this.fail(err, 'Relay at capacity.');
      return;
    }
    this.role = 'daemon';
    this.socket.send(encodeControlFrame({ t: 'registered', rid, maxMessageBytes: this.hub.maxMessageBytes }));
  }

  private onConnect(protocol: number, rid: RendezvousId): void {
    if (protocol !== RELAY_PROTOCOL_VERSION) {
      this.fail('protocol-version', `Relay speaks protocol ${RELAY_PROTOCOL_VERSION}.`);
      return;
    }
    if (!this.hub._rateOk(this.remoteAddr)) {
      this.fail('rate-limited', 'Too many handshake attempts.');
      return;
    }
    const result = this.hub._openPipe(rid, this.socket);
    if (typeof result === 'string') {
      this.fail(result, result === 'daemon-offline' ? 'No daemon is registered for that rendezvous id.' : 'Relay at capacity.');
      return;
    }
    this.role = 'client';
    this.rid = rid;
    this.pipeId = result.pipeId;
    this.socket.send(encodeControlFrame({ t: 'connected', pipe: result.pipeId, maxMessageBytes: this.hub.maxMessageBytes }));
  }

  private fail(code: RelayErrorCode, message: string): void {
    this.socket.send(errorFrame(code, message));
    this.socket.close(1008, code);
  }
}
