// relay-registration.ts
//
// The daemon half of the relay path. It dials the relay OUTBOUND (so the daemon
// needs no inbound port or public IP), registers under its rendezvous id, and
// terminates the end-to-end secure channel INSIDE this process. Tunneled HTTP
// requests are decrypted here and replayed against the daemon's own route
// dispatcher, exactly as if they had arrived on the local HTTP listener, the
// relay only ever moved ciphertext.
//
// Reconnect uses the same capped exponential-backoff shape as the transport
// stream reconnector (base 500ms, ×2, cap 30s). The channel keys are per-pipe
// and ephemeral, so a reconnect simply re-registers and old pipes are dropped.
//
// The rendezvous id is derived from the identity key, and the daemon proves it
// by signing the relay's challenge. Once registered, a periodic ping the relay
// answers keeps `registered` true: a path that died without a close (a network
// change, a suspend) is noticed within two intervals and re-registered.

import {
  RELAY_DEFAULT_MAX_MESSAGE_BYTES,
  RELAY_PROTOCOL_VERSION,
  RelaySecureChannel,
  TunnelFragmentJoiner,
  createRelayPairingPayload,
  decodeControlFrame,
  decodeTunnelFrame,
  encodeControlFrame,
  encodeTunnelFrame,
  encodeUtf8,
  fragmentTunnelFrame,
  framePipePayload,
  proveRelayRegistration,
  relayErrorAdvice,
  relayIdentityPublicKeyBase64Url,
  relayIdentityRendezvousId,
  respondToHandshake,
  toBase64Url,
  tunnelFrameLimit,
  unframePipePayload,
  type RelayHandshakeKeys,
  type RelayKeyPair,
  type RelayPairingPayload,
  type TunnelHeader,
  RELAY_CODE_HEADER,
} from '@goodvibes-jev/engine/transport-core/relay';

/** Structural client WebSocket the daemon uses to dial the relay. */
export interface RelayClientWebSocket {
  binaryType: string;
  send(data: string | Uint8Array | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: unknown) => void): void;
}

/** Header set on every relay-tunneled request so downstream can tell it apart. */
export const RELAY_VIA_HEADER = 'x-goodvibes-via-relay';

/**
 * Whether a request arrived over the relay (vs the trusted LAN). Surfaces and
 * policy hooks use this to show connections as "via relay" and to apply
 * relay-specific controls such as WebAuthn step-up on mutating calls.
 */
export function isRelayTunneledRequest(req: Request): boolean {
  return req.headers.get(RELAY_VIA_HEADER) === '1';
}

/**
 * Build the tunneled request headers with the relay marker owned by the
 * daemon: any marker the remote client sent is dropped first, because a
 * duplicate header would combine into "<value>, 1" and defeat the check.
 */
function markRelayTunneledHeaders(clientHeaders: ReadonlyArray<readonly [string, string]>): Array<[string, string]> {
  const kept: Array<[string, string]> = [];
  for (const [name, value] of clientHeaders) {
    if (name.toLowerCase() !== RELAY_VIA_HEADER) kept.push([name, value]);
  }
  kept.push([RELAY_VIA_HEADER, '1']);
  return kept;
}

/**
 * Lifecycle status of the daemon's relay registration. `refused` means the
 * relay refused it for a reason a retry cannot clear (see `lastRefusal`); the
 * daemon stops dialling until the registration is started again, which a
 * change to the relay settings or the identity does.
 */
export type RelayRegistrationStatus = 'idle' | 'connecting' | 'registered' | 'reconnecting' | 'refused' | 'stopped';

export interface RelayRegistrationLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Options for {@link createRelayDaemonRegistration}. */
export interface RelayDaemonRegistrationOptions {
  /** The relay URL to dial (wss://…). */
  readonly relayUrl: string;
  /**
   * A configured rendezvous id. The daemon registers under the id derived from
   * `identity` (the only one it can prove); a different configured id is
   * replaced and reported through `rendezvousId`.
   */
  readonly rid?: string | undefined;
  /** The daemon's persistent relay identity key pair. */
  readonly identity: RelayKeyPair;
  /** Base URL used to resolve tunneled request paths into local Requests. */
  readonly localBaseUrl: string;
  /** Replay a reconstructed request against the daemon; returns null if unrouted. */
  readonly dispatch: (req: Request) => Promise<Response | null>;
  /** WebSocket constructor override (defaults to globalThis.WebSocket). */
  readonly webSocketImpl?: (url: string) => RelayClientWebSocket;
  /** Reconnect backoff base delay in ms (default 500). */
  readonly reconnectBaseDelayMs?: number;
  /** Reconnect backoff cap in ms (default 30000). */
  readonly reconnectMaxDelayMs?: number;
  /**
   * How long a connection may go without the relay's `registered` frame before
   * the attempt is abandoned and retried through the reconnect backoff
   * (default 15000). Covers a socket that never opens and one that opens but is
   * never registered.
   */
  readonly registrationTimeoutMs?: number;
  /**
   * How often a registered daemon pings the relay (default 25000). An interval
   * that passes with the previous ping unanswered ends the connection and
   * re-registers through the reconnect backoff.
   */
  readonly keepaliveIntervalMs?: number;
  /** Max concurrent event-subscription streams per pipe (default 8). */
  readonly maxStreamsPerPipe?: number;
  /** Bounded per-stream send buffer, in chunks; overflow drops-with-notice (default 256). */
  readonly streamBufferChunks?: number;
  /**
   * Max simultaneously-open secure-channel pipes retained in memory (default
   * 512). Each pipe holds a live secure channel derived from the connecting
   * surface's session; a relay that drops pipes WITHOUT sending a pipe-close
   * control frame (crash, network partition) would otherwise leave the channel
   * context, and the operator-token-authenticated requests riding it, pinned
   * forever. When the cap is hit the least-recently-used pipe is evicted (its
   * streams closed) so retained-context count stays bounded.
   */
  readonly maxPipes?: number;
  /**
   * Max concurrently in-flight tunneled REQUESTS across all pipes (default
   * 1024). Each in-flight request retains its reconstructed Request, headers
   * (including the operator-token Authorization header) and any buffered body,
   * for the FULL lifetime: dispatch AND response buffering (the max-memory
   * phase). When the cap is hit a new request is refused with
   * an honest 503 `relay-overloaded` response instead of being retained, so a
   * dispatch stall (or a hot job-transition loop fanning requests) can never
   * accumulate request contexts without limit.
   */
  readonly maxInFlightRequests?: number;
  readonly logger?: RelayRegistrationLogger;
  readonly onStatusChange?: (status: RelayRegistrationStatus) => void;
}

/**
 * Point-in-time footprint of the retained relay contexts. Exposed so ops
 * surfaces and regression tests can assert the caps hold under load.
 */
export interface RelayRegistrationStats {
  /** Open secure-channel pipes currently retained. */
  readonly pipes: number;
  /** Tunneled requests currently mid-dispatch (contexts still retained). */
  readonly inFlightRequests: number;
  /** Live event-subscription streams currently retained across all pipes. */
  readonly streams: number;
  /** Pipes evicted because the maxPipes cap was exceeded (cumulative). */
  readonly droppedPipes: number;
  /** Requests refused because the maxInFlightRequests cap was exceeded (cumulative). */
  readonly droppedRequests: number;
}

/** Why the relay last refused this registration: what is true and what gets past it. */
export interface RelayRegistrationRefusal {
  readonly code: string;
  readonly message: string;
  readonly state: string;
  readonly next: readonly string[];
  /** Whether the daemon keeps trying; false means the registration is `refused` until it is started again. */
  readonly retryable: boolean;
}

/** A running daemon-side relay registration. */
export interface RelayDaemonRegistration {
  start(): void;
  stop(): void;
  readonly status: RelayRegistrationStatus;
  /** The rendezvous id registered under (derived from the identity), once known. */
  readonly rendezvousId: string | null;
  /** When the relay last confirmed the registration (registered, or a keepalive answer), epoch ms. */
  readonly lastConfirmedAt: number | null;
  /** The relay's last refusal of this registration, cleared when it registers. */
  readonly lastRefusal: RelayRegistrationRefusal | null;
  /** A pairing payload carrying `code`, the device's relay code the daemon just issued. */
  mintPairing(code: string, label?: string): Promise<RelayPairingPayload>;
  /**
   * End every relay connection (pipe) that presented a relay code `revoked`
   * now answers true for: its streams get a `stream-close` naming `reason`, its
   * in-flight requests are aborted, and the relay is told to close the pipe.
   * Returns how many pipes were closed.
   */
  closePipesPresenting(revoked: (code: string) => boolean, reason: string): Promise<number>;
  /** Retained-context footprint, for ops visibility and cap regression tests. */
  stats(): RelayRegistrationStats;
}

const SILENT: RelayRegistrationLogger = { info: () => {}, warn: () => {}, error: () => {} };

function defaultWebSocket(url: string): RelayClientWebSocket {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => RelayClientWebSocket }).WebSocket;
  if (!Ctor) throw new Error('No WebSocket implementation available; provide options.webSocketImpl.');
  return new Ctor(url);
}

function toBytes(data: unknown): Uint8Array<ArrayBuffer> | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) return new Uint8Array(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return null;
}

const DEFAULT_MAX_STREAMS_PER_PIPE = 8;
const DEFAULT_STREAM_BUFFER_CHUNKS = 256;
const DEFAULT_MAX_PIPES = 512;
const DEFAULT_MAX_IN_FLIGHT_REQUESTS = 1024;
const DEFAULT_KEEPALIVE_INTERVAL_MS = 25_000;
/** Ceiling on one buffered tunneled response body; larger (or endless) bodies are refused with 502. A streamed answer has none. */
const MAX_TUNNEL_RESPONSE_BYTES = 32 * 1024 * 1024;
/** Ceiling on the error body that accompanies a refused stream. */
const MAX_STREAM_REFUSAL_BYTES = 64 * 1024;
const MAX_QUEUED_FRAME_BYTES = 64 * 1024 * 1024;
interface FrameQueue { tail: Promise<void>; count: number; bytes: number; }
interface OwnedRequest { readonly abort: AbortController; cancelled: boolean; }
const cancelRequest = (request: OwnedRequest): void => { request.cancelled = true; request.abort.abort(); };

/** Read a response body with a hard byte ceiling; over-ceiling reads are cancelled and refused. */
async function readTunnelBodyBounded(response: Response, maxBytes: number, signal: AbortSignal): Promise<{ ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false }> {
  const body = response.body;
  if (!body) return { ok: true, bytes: new Uint8Array(0) };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Native reader cancellation settles pending read requests immediately even
  // when the underlying source's cancellation promise never settles.
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          void reader.cancel().catch(() => {});
          return { ok: false };
        }
        chunks.push(value);
      }
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, bytes: merged };
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

/**
 * The daemon-side pump for one event subscription: it seals event-source chunks
 * into `stream-data` frames and writes them to the relay socket, applying a
 * bounded buffer so a slow consumer can never make the daemon buffer without
 * limit. When the buffer is full a chunk is DROPPED and counted, and the next
 * successful flush emits a `stream-overflow` notice carrying the dropped count,
 * an honest gap signal, never a silent one. Clean close is explicit in both
 * directions (`stream-close`). A clean close (`source-ended`) first sends every
 * chunk already queued, and an overflow notice for any still uncounted, so the
 * end of a source is never the loss of its last chunks; only a cancellation
 * (`cancelPending`) discards the queue.
 */
class DaemonStreamPump {
  private readonly queue: Uint8Array<ArrayBuffer>[] = [];
  private dropped = 0;
  private seq = 0;
  private flushing = false;
  private flushingDone: Promise<void> = Promise.resolve();
  private closing: Promise<void> | null = null;
  private closed = false;
  private cancelPending = false;

  constructor(
    private readonly streamId: string,
    private readonly send: (frame: Uint8Array<ArrayBuffer>, wanted?: () => boolean) => Promise<void>,
    private readonly bufferCap: number,
    private readonly onError: (error: unknown) => void,
  ) {}

  enqueue(chunk: Uint8Array<ArrayBuffer>): void {
    if (this.closed) return;
    if (this.queue.length >= this.bufferCap) {
      this.dropped += 1;
      return;
    }
    this.queue.push(chunk);
    if (this.flushing) return;
    let resolveFlush: () => void = () => {};
    let rejectFlush: (error: unknown) => void = () => {};
    // Install completion before sendFrame can synchronously retire this pump.
    this.flushingDone = new Promise<void>((resolve, reject) => {
      resolveFlush = resolve;
      rejectFlush = reject;
    });
    this.flushing = true;
    void this.flush().then(resolveFlush, rejectFlush);
  }

  private async flush(): Promise<void> {
    try {
      while (this.queue.length > 0 && !this.cancelPending) {
        const chunk = this.queue.shift()!;
        const frame = encodeTunnelFrame({ id: this.streamId, kind: 'stream-data', seq: this.seq++ }, chunk);
        await this.send(frame, () => !this.cancelPending);
        if (this.dropped > 0 && !this.cancelPending) {
          const dropped = this.dropped;
          this.dropped = 0;
          const notice = encodeTunnelFrame({ id: this.streamId, kind: 'stream-overflow', dropped }, new Uint8Array(0));
          await this.send(notice, () => !this.cancelPending);
        }
      }
    } catch (error) {
      this.onError(error);
    } finally {
      this.flushing = false;
    }
  }

  close(reason?: string, cancelPending = false): Promise<void> {
    // A clean end retains its accepted in-flight frame; cancellation suppresses
    // it even when a clean close is already awaiting that same flush.
    this.cancelPending ||= cancelPending;
    if (this.cancelPending) this.queue.length = 0;
    if (this.closing) return this.closing;
    // No chunk is accepted after this; the ones already queued still go out on a clean close.
    this.closed = true;
    this.closing = (async () => {
      try {
        await this.flushingDone;
        if (this.dropped > 0 && !this.cancelPending) {
          const dropped = this.dropped;
          this.dropped = 0;
          await this.send(encodeTunnelFrame({ id: this.streamId, kind: 'stream-overflow', dropped }, new Uint8Array(0)), () => !this.cancelPending);
        }
        const frame = encodeTunnelFrame({ id: this.streamId, kind: 'stream-close', ...(reason ? { reason } : {}) }, new Uint8Array(0));
        await this.send(frame);
      } catch (error) {
        this.onError(error);
      }
    })();
    return this.closing;
  }
}

interface DaemonStreamRecord {
  readonly pump: DaemonStreamPump;
  readonly abort: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
}

export function createRelayDaemonRegistration(options: RelayDaemonRegistrationOptions): RelayDaemonRegistration {
  const logger = options.logger ?? SILENT;
  const makeSocket = options.webSocketImpl ?? defaultWebSocket;
  let rid: string | null = null;
  let ridBytes = new Uint8Array(0) as Uint8Array<ArrayBuffer>;
  const ridReady: Promise<string> = relayIdentityRendezvousId(options.identity).then((derived) => {
    if (options.rid && options.rid !== derived) {
      logger.warn('relay rendezvous id differs from the one derived from the identity key; registering under the derived id', { configured: options.rid, rid: derived });
    }
    rid = derived;
    ridBytes = encodeUtf8(derived);
    return derived;
  });
  ridReady.catch((error: unknown) => logger.error('relay rendezvous id could not be derived from the identity key', { error: String(error) }));
  const keepaliveInterval = Math.max(1, options.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS);
  const baseDelay = options.reconnectBaseDelayMs ?? 500;
  const maxDelay = options.reconnectMaxDelayMs ?? 30_000;
  const registrationTimeout = Math.max(1, options.registrationTimeoutMs ?? 15_000);
  const maxStreamsPerPipe = options.maxStreamsPerPipe ?? DEFAULT_MAX_STREAMS_PER_PIPE;
  const streamBufferChunks = options.streamBufferChunks ?? DEFAULT_STREAM_BUFFER_CHUNKS;
  const maxPipes = Math.max(1, Math.trunc(options.maxPipes ?? DEFAULT_MAX_PIPES));
  const maxInFlightRequests = Math.max(1, Math.trunc(options.maxInFlightRequests ?? DEFAULT_MAX_IN_FLIGHT_REQUESTS));

  let status: RelayRegistrationStatus = 'idle';
  let socket: RelayClientWebSocket | null = null;
  let stopped = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let registrationTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlightRequests = 0;
  let droppedPipes = 0;
  let droppedRequests = 0;
  // The largest tunnel frame one relay message carries; the relay states its limit when it registers us.
  let frameLimit = tunnelFrameLimit(RELAY_DEFAULT_MAX_MESSAGE_BYTES);
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let pingsSent = 0;
  let awaitingPong = false;
  let lastConfirmedAt: number | null = null;
  let lastRefusal: RelayRegistrationRefusal | null = null;
  // When the current connection registered; a registration that held for a keepalive interval resets the backoff.
  let registeredAt: number | null = null;
  // Partial fragmented frames per channel, bounded like the admission queue.
  const joiners = new WeakMap<RelaySecureChannel, TunnelFragmentJoiner>();
  // Secure channels keyed by pipe. Map insertion order is the LRU order used
  // to evict the coldest pipe when the maxPipes cap is exceeded; a served frame
  // re-inserts its pipe so active pipes stay warm (see touchPipe).
  const channels = new Map<string, RelaySecureChannel>();
  // Per-pipe live event subscriptions: pipeKey -> (streamId -> record).
  const pipeStreams = new Map<string, Map<string, DaemonStreamRecord>>();
  // The relay codes each pipe presented (bounded per pipe), so revoking one
  // ends the connections it opened. Dropped with the pipe.
  const pipeCodes = new Map<string, Set<string>>();
  const MAX_CODES_PER_PIPE = 4;
  function notePipeCode(pipeKey: string, headers: ReadonlyArray<readonly [string, string]>): void {
    const code = headers.find(([name]) => name.toLowerCase() === RELAY_CODE_HEADER)?.[1];
    if (!code) return;
    const codes = pipeCodes.get(pipeKey) ?? new Set<string>();
    if (codes.size < MAX_CODES_PER_PIPE || codes.has(code)) codes.add(code);
    pipeCodes.set(pipeKey, codes);
  }
  // Unary requests remain owned until dispatch/body buffering actually drain.
  const pipeRequests = new Map<string, Map<string, OwnedRequest>>();
  const outgoing = new WeakMap<RelaySecureChannel, FrameQueue>();
  // Serialize decryption and admission, never the pending dispatch itself: a
  // cancel frame must be admitted after its request even with asynchronous crypto.
  const admissions = new WeakMap<RelaySecureChannel, { tail: Promise<void>; queued: number; bytes: number }>();

  function abortPipeRequests(pipeKey: string): void {
    for (const request of pipeRequests.get(pipeKey)?.values() ?? []) cancelRequest(request);
  }
  function abortAllRequests(): void {
    for (const pipeKey of pipeRequests.keys()) abortPipeRequests(pipeKey);
  }

  /** Every encrypted daemon frame shares this bounded seal-and-send order. */
  function sendFrame(frame: Uint8Array<ArrayBuffer>, channel: RelaySecureChannel, pipeIdBytes: Uint8Array<ArrayBuffer>,
    ws: RelayClientWebSocket, wanted: () => boolean = () => true): Promise<void> {
    const pipeKey = toBase64Url(pipeIdBytes);
    const attached = () => !stopped && socket === ws && channels.get(pipeKey) === channel;
    const retire = () => {
      if (!attached()) return;
      channels.delete(pipeKey); abortPipeRequests(pipeKey); void closePipeStreams(pipeKey);
      ws.send(encodeControlFrame({ t: 'pipe-close', pipe: pipeKey, reason: 'send-failed' }));
    };
    if (!attached() || !wanted()) return Promise.resolve();
    const queue = outgoing.get(channel) ?? { tail: Promise.resolve(), count: 0, bytes: 0 };
    if (queue.count >= maxInFlightRequests + maxStreamsPerPipe * 2 + 1 || queue.bytes + frame.byteLength > MAX_QUEUED_FRAME_BYTES) {
      retire();
      return Promise.reject(new Error('relay outbound frame queue limit exceeded'));
    }
    // A frame larger than one relay message goes as consecutive fragments; they
    // are queued together so no other frame lands between them.
    const parts = fragmentTunnelFrame(frame, frameLimit);
    queue.count++; queue.bytes += frame.byteLength;
    const work = queue.tail.then(async () => {
      for (const part of parts) {
        if (!attached() || !wanted()) return;
        const sealed = await channel.seal(part);
        if (!attached() || !wanted()) return;
        ws.send(framePipePayload(pipeIdBytes, sealed));
      }
    }).catch((error: unknown) => { retire(); throw error; });
    queue.tail = work.then(() => {}, () => {}).finally(() => { queue.count--; queue.bytes -= frame.byteLength; });
    outgoing.set(channel, queue);
    return work;
  }

  function countStreams(): number {
    let total = 0;
    for (const streams of pipeStreams.values()) total += streams.size;
    return total;
  }

  /** Move a pipe to the warm (most-recent) end of the LRU order. */
  function touchPipe(pipeKey: string): void {
    const channel = channels.get(pipeKey);
    if (!channel) return;
    channels.delete(pipeKey);
    channels.set(pipeKey, channel);
  }

  /**
   * Enforce the maxPipes cap by evicting the least-recently-used pipe(s). Each
   * eviction closes the pipe's streams and drops its channel, releasing the
   * retained request/session context with a structured, counted log line,
   * never a silent leak.
   */
  function enforcePipeCap(): void {
    while (channels.size > maxPipes) {
      const oldest = channels.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      channels.delete(oldest);
      abortPipeRequests(oldest);
      void closePipeStreams(oldest);
      socket?.send(encodeControlFrame({ t: 'pipe-close', pipe: oldest }));
      droppedPipes += 1;
      logger.warn('relay pipe cap exceeded, evicted coldest pipe', {
        maxPipes,
        droppedPipes,
        pipe: oldest,
      });
    }
  }

  /** Settles once every stream's close notice was handed to the channel. */
  function closePipeStreams(pipeKey: string, reason = 'pipe-closed'): Promise<unknown> {
    pipeCodes.delete(pipeKey);
    const streams = pipeStreams.get(pipeKey);
    if (!streams) return Promise.resolve();
    // Retire the exact map before abort/cancel can call back into the daemon.
    pipeStreams.delete(pipeKey);
    const records = [...streams.values()];
    streams.clear();
    const notices: Promise<void>[] = [];
    for (const record of records) {
      notices.push(record.pump.close(reason, true).catch(() => {}));
      record.abort.abort();
      void record.reader?.cancel().catch(() => {});
    }
    return Promise.all(notices);
  }

  function setStatus(next: RelayRegistrationStatus): void {
    status = next;
    options.onStatusChange?.(next);
  }

  function clearRegistrationTimer(): void {
    if (registrationTimer) clearTimeout(registrationTimer);
    registrationTimer = null;
  }

  function stopKeepalive(): void {
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    keepaliveTimer = null;
    awaitingPong = false;
  }

  /** Ping the relay each interval; an interval that ends with the last ping unanswered ends this connection. */
  function startKeepalive(ws: RelayClientWebSocket): void {
    stopKeepalive();
    keepaliveTimer = setInterval(() => {
      if (socket !== ws || stopped) { stopKeepalive(); return; }
      if (awaitingPong) {
        failRegistration(ws, 'the relay did not answer the keepalive');
        return;
      }
      awaitingPong = true;
      try { ws.send(encodeControlFrame({ t: 'ping', n: ++pingsSent })); }
      catch { failRegistration(ws, 'the keepalive could not be sent'); }
    }, keepaliveInterval);
  }

  /** Abandon a connection that is not (or no longer) registered and retry through the normal backoff. */
  function failRegistration(ws: RelayClientWebSocket, reason: string): void {
    if (socket !== ws || stopped) return;
    logger.warn('relay registration failed; reconnecting', { rid, reason });
    clearRegistrationTimer();
    stopKeepalive();
    socket = null;
    abortAllRequests();
    for (const pipeKey of [...pipeStreams.keys()]) void closePipeStreams(pipeKey);
    channels.clear();
    pipeCodes.clear();
    try {
      ws.close();
    } catch {
      // ignore: the attempt is already abandoned
    }
    scheduleReconnect();
  }

  /**
   * End a connection the relay refused for a reason another attempt cannot
   * clear: the registration rests at `refused` with the refusal stated, and
   * the relay is not dialled again until start() runs anew.
   */
  function refuseRegistration(ws: RelayClientWebSocket, refusal: RelayRegistrationRefusal): void {
    if (socket !== ws || stopped) return;
    logger.warn('relay refused the registration; not reconnecting', { rid, code: refusal.code });
    clearRegistrationTimer();
    stopKeepalive();
    socket = null;
    abortAllRequests();
    for (const pipeKey of [...pipeStreams.keys()]) void closePipeStreams(pipeKey);
    channels.clear();
    pipeCodes.clear();
    try {
      ws.close();
    } catch {
      // ignore: the attempt is already abandoned
    }
    stopped = true;
    setStatus('refused');
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    // Only a registration that held for a keepalive interval earns a fast retry;
    // one cut sooner keeps backing off, so two holders of one identity cannot churn.
    if (registeredAt !== null && Date.now() - registeredAt >= keepaliveInterval) attempt = 0;
    registeredAt = null;
    setStatus('reconnecting');
    const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
    attempt += 1;
    reconnectTimer = setTimeout(openConnection, delay);
  }

  async function handleDaemonFrame(pipeIdBytes: Uint8Array<ArrayBuffer>, payload: Uint8Array<ArrayBuffer>, ws: RelayClientWebSocket): Promise<void> {
    if (stopped || socket !== ws) return;
    const pipeKey = toBase64Url(pipeIdBytes);
    const existing = channels.get(pipeKey);
    if (!existing) {
      // First frame on a new pipe is the client's handshake initiation.
      await ridReady;
      if (stopped || socket !== ws) return;
      const { keys, message2 } = await respondToHandshake(options.identity, ridBytes, payload);
      if (stopped || socket !== ws) return;
      channels.set(pipeKey, new RelaySecureChannel(keys, 'daemon'));
      pipeCodes.delete(pipeKey);
      enforcePipeCap();
      ws.send(framePipePayload(pipeIdBytes, message2));
      return;
    }
    touchPipe(pipeKey);
    const admission = admissions.get(existing) ?? { tail: Promise.resolve(), queued: 0, bytes: 0 };
    // Reserve control-frame headroom even when the request admission cap is one.
    if (admission.queued >= maxInFlightRequests + maxStreamsPerPipe + 1 || admission.bytes + payload.byteLength > MAX_QUEUED_FRAME_BYTES) {
      channels.delete(pipeKey); abortPipeRequests(pipeKey); void closePipeStreams(pipeKey);
      logger.warn('relay pipe frame admission cap exceeded');
      ws.send(encodeControlFrame({ t: 'pipe-close', pipe: pipeKey, reason: 'frame-limit' }));
      return;
    }
    admission.queued++; admission.bytes += payload.byteLength;
    const work = admission.tail.then(() => serveTunneledFrame(pipeKey, existing, pipeIdBytes, payload, ws));
    admission.tail = work.then(() => {}, () => {}).finally(() => { admission.queued--; admission.bytes -= payload.byteLength; });
    admissions.set(existing, admission);
    await work;
  }

  async function serveTunneledFrame(
    pipeKey: string,
    channel: RelaySecureChannel,
    pipeIdBytes: Uint8Array<ArrayBuffer>,
    sealed: Uint8Array<ArrayBuffer>,
    ws: RelayClientWebSocket,
  ): Promise<void> {
    if (stopped || socket !== ws || channels.get(pipeKey) !== channel) return;
    let framed: { readonly header: TunnelHeader; readonly body: Uint8Array<ArrayBuffer> } | null = decodeTunnelFrame(await channel.open(sealed));
    if (!framed || stopped || socket !== ws || channels.get(pipeKey) !== channel) return;
    if (framed.header.kind === 'fragment') {
      const joiner = joiners.get(channel) ?? new TunnelFragmentJoiner(MAX_QUEUED_FRAME_BYTES);
      joiners.set(channel, joiner);
      const joined = joiner.push(framed.header, framed.body);
      if (joined.kind === 'pending') return;
      if (joined.kind === 'too-large') {
        const refused = encodeTunnelFrame(
          { id: joined.id, kind: 'response', status: 413, headers: [['content-type', 'application/json']] },
          encodeUtf8(JSON.stringify({ error: 'request-too-large', code: 'RELAY_REQUEST_TOO_LARGE', state: 'the request was not run', next: [`Send a request body under ${MAX_QUEUED_FRAME_BYTES} bytes over the relay, or use the daemon's local address`] })),
        );
        await sendFrame(refused, channel, pipeIdBytes, ws);
        return;
      }
      if (joined.kind === 'malformed') {
        logger.warn('relay fragment out of order; frame dropped', { pipe: pipeKey });
        return;
      }
      framed = joined;
    }
    const header = framed.header;
    if (header.kind === 'request' || header.kind === 'stream-open') notePipeCode(pipeKey, header.headers);
    if (header.kind === 'request') {
      void serveTunneledRequest(pipeKey, header, framed.body, channel, pipeIdBytes, ws).catch((error: unknown) => {
        logger.error('relay request handling failed', { error: String(error) });
      });
      return;
    }
    if (header.kind === 'request-cancel') {
      const request = pipeRequests.get(pipeKey)?.get(header.id);
      if (request) cancelRequest(request);
      return;
    }
    if (header.kind === 'stream-open') {
      void openTunneledStream(pipeKey, header, framed.body, channel, pipeIdBytes, ws).catch((error: unknown) => {
        logger.error('relay stream handling failed', { error: String(error) });
      });
      return;
    }
    if (header.kind === 'stream-close') {
      closeTunneledStream(pipeKey, header.id);
      return;
    }
    // Other kinds (response, stream-data, stream-overflow) are daemon → surface
    // only; a surface should never send them. Ignore rather than trust.
  }

  async function serveTunneledRequest(
    pipeKey: string,
    header: { id: string; method: string; path: string; headers: ReadonlyArray<readonly [string, string]> },
    body: Uint8Array<ArrayBuffer>,
    channel: RelaySecureChannel,
    pipeIdBytes: Uint8Array<ArrayBuffer>,
    ws: RelayClientWebSocket,
  ): Promise<void> {
    if (pipeRequests.get(pipeKey)?.has(header.id)) return;
    // In-flight request cap: refuse (don't retain) when saturated. Each in-flight
    // request pins its reconstructed Request, headers carry the operator-token
    // Authorization header, until dispatch resolves, so an unbounded backlog is
    // exactly the retained-context leak this guard prevents. The refusal is an
    // honest structured 503 the surface can surface and retry.
    if (inFlightRequests >= maxInFlightRequests) {
      droppedRequests += 1;
      logger.warn('relay in-flight request cap exceeded, refused', {
        maxInFlightRequests,
        droppedRequests,
      });
      const busy = encodeTunnelFrame(
        { id: header.id, kind: 'response', status: 503, headers: [['content-type', 'application/json'], ['retry-after', '1']] },
        encodeUtf8(JSON.stringify({ error: 'relay-overloaded', message: 'Daemon relay is at its in-flight request cap; retry shortly.' })),
      );
      await sendFrame(busy, channel, pipeIdBytes, ws);
      return;
    }
    // Abortable request: a streaming endpoint reached as a plain tunneled
    // request tears down on request.signal abort; without a signal its
    // producer would run (and buffer) forever.
    const abort = new AbortController();
    const request = new Request(new URL(header.path, options.localBaseUrl), {
      method: header.method,
      headers: markRelayTunneledHeaders(header.headers),
      ...(body.length > 0 ? { body } : {}),
      signal: abort.signal,
    });
    // The in-flight count covers the FULL request lifetime, dispatch AND
    // response buffering. Buffering is the max-memory phase; releasing the slot
    // at dispatch-resolve would let N buffering requests bypass the cap.
    inFlightRequests += 1;
    const requests = pipeRequests.get(pipeKey) ?? new Map<string, OwnedRequest>();
    pipeRequests.set(pipeKey, requests);
    const owned: OwnedRequest = { abort, cancelled: false };
    requests.set(header.id, owned);
    const isCurrent = () => !owned.cancelled && !stopped && socket === ws && channels.get(pipeKey) === channel;
    const send = (frame: Uint8Array<ArrayBuffer>): Promise<void> => sendFrame(frame, channel, pipeIdBytes, ws, isCurrent);
    try {
      let response: Response;
      try {
        response = (await options.dispatch(request)) ?? new Response('Not found', { status: 404 });
      } catch (err) {
        logger.error('relay dispatch failed', { error: String(err) });
        response = new Response('Internal error', { status: 500 });
      }
      if (!isCurrent()) { void response.body?.cancel().catch(() => {}); return; }
      // A plain tunneled request must never buffer an event stream: refuse
      // honestly and tear the producer down. A caller that wants a streamed
      // answer says so (Accept: text/event-stream, or `stream: true`), and the
      // client then sends it as a stream-open frame.
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream')) {
        abort.abort();
        void response.body?.cancel().catch(() => {});
        const refused = encodeTunnelFrame(
          { id: header.id, kind: 'response', status: 501, headers: [['content-type', 'application/json']] },
          encodeUtf8(JSON.stringify({ error: 'streaming-not-requested', code: 'RELAY_STREAM_NOT_REQUESTED', state: 'this path answers with an event stream, which a plain request cannot carry', next: ['Repeat the request with the header Accept: text/event-stream'] })),
        );
        await send(refused);
        return;
      }
      let bounded: Awaited<ReturnType<typeof readTunnelBodyBounded>>;
      try { bounded = await readTunnelBodyBounded(response, MAX_TUNNEL_RESPONSE_BYTES, abort.signal); }
      catch (error) { if (abort.signal.aborted) return; throw error; }
      if (!isCurrent()) return;
      if (!bounded.ok) {
        abort.abort();
        const refused = encodeTunnelFrame(
          { id: header.id, kind: 'response', status: 502, headers: [['content-type', 'application/json']] },
          encodeUtf8(JSON.stringify({ error: 'response-too-large', message: `Response exceeded the ${MAX_TUNNEL_RESPONSE_BYTES}-byte tunneled-request ceiling.` })),
        );
        await send(refused);
        return;
      }
      const bodyBytes = bounded.bytes;
      const respHeaders: Array<[string, string]> = [];
      response.headers.forEach((value, key) => respHeaders.push([key, value]));
      const out = encodeTunnelFrame(
        { id: header.id, kind: 'response', status: response.status, headers: respHeaders },
        bodyBytes,
      );
      await send(out);
    } finally {
      requests.delete(header.id);
      if (requests.size === 0 && pipeRequests.get(pipeKey) === requests) pipeRequests.delete(pipeKey);
      inFlightRequests -= 1;
    }
  }

  async function openTunneledStream(
    pipeKey: string,
    header: { id: string; method: string; path: string; headers: ReadonlyArray<readonly [string, string]> },
    body: Uint8Array<ArrayBuffer>,
    channel: RelaySecureChannel,
    pipeIdBytes: Uint8Array<ArrayBuffer>,
    ws: RelayClientWebSocket,
  ): Promise<void> {
    const streams = pipeStreams.get(pipeKey) ?? new Map<string, DaemonStreamRecord>();
    pipeStreams.set(pipeKey, streams);
    // Per-pipe stream cap: refuse a new stream with an immediate close notice.
    if (streams.size >= maxStreamsPerPipe || streams.has(header.id)) {
      const refused = new DaemonStreamPump(header.id, (frame, wanted) => sendFrame(frame, channel, pipeIdBytes, ws, wanted), streamBufferChunks, (error) =>
        logger.error('relay stream send failed', { error: String(error) }),
      );
      await refused.close('stream-limit');
      return;
    }
    const abort = new AbortController();
    const ownsSlot = () => pipeStreams.get(pipeKey) === streams && streams.get(header.id) === record;
    const isCurrent = () => !abort.signal.aborted && !stopped && socket === ws && channels.get(pipeKey) === channel && ownsSlot();
    // A cancellation acknowledgement may outlive removal of its own slot, but
    // must never close a replacement with the same stream ID or pipe map.
    const canClose = () => {
      const currentStreams = pipeStreams.get(pipeKey);
      return (currentStreams === undefined || currentStreams === streams)
        && (streams.get(header.id) === undefined || streams.get(header.id) === record);
    };
    const pump = new DaemonStreamPump(header.id, (frame, wanted) =>
      sendFrame(frame, channel, pipeIdBytes, ws, () => wanted ? isCurrent() && wanted() : canClose()),
    streamBufferChunks, (error) => logger.error('relay stream send failed', { error: String(error) }));
    const record: DaemonStreamRecord = { pump, abort, reader: null };
    streams.set(header.id, record);

    try {
      const request = new Request(new URL(header.path, options.localBaseUrl), {
        method: header.method,
        headers: markRelayTunneledHeaders(header.headers),
        ...(body.length > 0 && header.method !== 'GET' && header.method !== 'HEAD' ? { body } : {}),
        signal: abort.signal,
      });
      if (!isCurrent()) return;
      let response: Response | null;
      try {
        response = await options.dispatch(request);
      } catch (err) {
        if (isCurrent()) logger.error('relay stream dispatch failed', { error: String(err) });
        response = null;
      }
      const source = response?.body;
      if (!isCurrent()) {
        // Cancellation settles native pending reads without waiting for an
        // arbitrary underlying source's cancellation promise to settle.
        if (source) void source.cancel().catch(() => {});
        return;
      }
      if (response && !response.ok) {
        // A refusal (401, 403, 404, ...) is the answer's status and body,
        // carried by a response frame under the stream's id; the client answers
        // the caller with it instead of an event stream.
        const refusal = await readTunnelBodyBounded(response, MAX_STREAM_REFUSAL_BYTES, abort.signal).catch(() => null);
        if (!isCurrent()) return;
        const refusalHeaders: Array<[string, string]> = [];
        response.headers.forEach((value, key) => refusalHeaders.push([key, value]));
        await sendFrame(
          encodeTunnelFrame(
            { id: header.id, kind: 'response', status: response.status, headers: refusalHeaders },
            refusal?.ok ? refusal.bytes : new Uint8Array(0),
          ),
          channel, pipeIdBytes, ws, isCurrent,
        );
        await pump.close('source-ended');
        return;
      }
      if (!response || !source) {
        await pump.close('no-stream');
        return;
      }
      // The answer's own status and headers go first, so the caller reads the
      // real content type (an audio stream, a chat completion) before its bytes.
      const answerHeaders: Array<[string, string]> = [];
      response.headers.forEach((value, key) => answerHeaders.push([key, value]));
      await sendFrame(encodeTunnelFrame({ id: header.id, kind: 'response', status: response.status, headers: answerHeaders }, new Uint8Array(0)),
        channel, pipeIdBytes, ws, isCurrent);
      const reader = source.getReader();
      record.reader = reader;
      if (!isCurrent()) {
        void reader.cancel().catch(() => {});
        return;
      }
      // Retain the reader/pump chain in this owned operation. Each awaited read
      // is fenced before its bytes can be enqueued; queued sends are fenced too.
      try {
        for (;;) {
          if (!isCurrent()) return;
          const { done, value } = await reader.read();
          if (!isCurrent()) return;
          if (done) break;
          if (value) pump.enqueue(new Uint8Array(value));
        }
        await pump.close('source-ended');
      } catch (err) {
        if (isCurrent()) {
          logger.warn('relay stream source error', { error: String(err) });
          await pump.close('source-error');
        }
      }
    } finally {
      if (streams.get(header.id) === record) streams.delete(header.id);
      if (streams.size === 0 && pipeStreams.get(pipeKey) === streams) pipeStreams.delete(pipeKey);
      abort.abort();
      try {
        await pump.close('source-error');
      } finally {
        record.reader?.releaseLock();
        record.reader = null;
      }
    }
  }

  function closeTunneledStream(pipeKey: string, streamId: string): void {
    const streams = pipeStreams.get(pipeKey);
    if (!streams) return;
    const record = streams.get(streamId);
    if (!record) return;
    // Removal and pump retirement precede callbacks from native cancellation.
    streams.delete(streamId);
    if (streams.size === 0 && pipeStreams.get(pipeKey) === streams) pipeStreams.delete(pipeKey);
    void record.pump.close('client-unsubscribed', true);
    record.abort.abort();
    void record.reader?.cancel().catch(() => {});
  }

  function openConnection(): void {
    if (stopped) return;
    reconnectTimer = null;
    setStatus(attempt === 0 ? 'connecting' : 'reconnecting');
    abortAllRequests();
    for (const pipeKey of [...pipeStreams.keys()]) void closePipeStreams(pipeKey);
    channels.clear();
    pipeCodes.clear();
    let ws: RelayClientWebSocket;
    try {
      ws = makeSocket(options.relayUrl);
    } catch (err) {
      logger.error('relay socket construction failed', { error: String(err) });
      scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    socket = ws;
    clearRegistrationTimer();
    registrationTimer = setTimeout(() => failRegistration(ws, 'no registered frame before the deadline'), registrationTimeout);
    ws.addEventListener('open', () => {
      void ridReady.then((id) => {
        if (socket === ws && !stopped) ws.send(encodeControlFrame({ t: 'register', role: 'daemon', protocol: RELAY_PROTOCOL_VERSION, rid: id }));
      }, () => failRegistration(ws, 'the rendezvous id could not be derived from the identity key'));
    });
    ws.addEventListener('message', (event) => {
      if (socket !== ws || stopped) return;
      const data = (event as { data: unknown }).data;
      void (async () => {
        try {
          if (typeof data === 'string') {
            const frame = decodeControlFrame(data);
            if (!frame) return;
            if (frame.t === 'challenge') {
              const id = await ridReady;
              const proof = await proveRelayRegistration(options.identity, id, frame.nonce);
              if (socket === ws && !stopped) ws.send(encodeControlFrame(proof));
            } else if (frame.t === 'registered') {
              registeredAt = Date.now();
              clearRegistrationTimer();
              frameLimit = tunnelFrameLimit(frame.maxMessageBytes ?? RELAY_DEFAULT_MAX_MESSAGE_BYTES);
              lastConfirmedAt = Date.now();
              lastRefusal = null;
              startKeepalive(ws);
              setStatus('registered');
              logger.info('relay registered', { rid });
            } else if (frame.t === 'pong') {
              awaitingPong = false;
              lastConfirmedAt = Date.now();
            } else if (frame.t === 'pipe-close') {
              channels.delete(frame.pipe);
              abortPipeRequests(frame.pipe);
              void closePipeStreams(frame.pipe);
            } else if (frame.t === 'error') {
              logger.warn('relay error frame', { code: frame.code, message: frame.message });
              // Before `registered`, an unscoped error means the relay refused this registration;
              // `replaced` ends a live one because another daemon proved the same identity.
              if (frame.pipe === undefined && (status !== 'registered' || frame.code === 'replaced')) {
                const advice = relayErrorAdvice(frame.code);
                lastRefusal = { code: frame.code, message: frame.message, state: advice.state, next: advice.next, retryable: advice.retryable };
                if (advice.retryable) failRegistration(ws, `relay error ${frame.code}`);
                else refuseRegistration(ws, lastRefusal);
              }
            }
            return;
          }
          const bytes = toBytes(data);
          if (!bytes) return;
          const split = unframePipePayload(bytes);
          if (!split) return;
          await handleDaemonFrame(split.pipeId.slice(), split.payload.slice(), ws);
        } catch (err) {
          logger.error('relay frame handling failed', { error: String(err) });
        }
      })();
    });
    ws.addEventListener('close', (event) => {
      if (socket !== ws) return;
      const closed = event as { code?: unknown; reason?: unknown } | null;
      if (closed?.code === 1008 && closed.reason === 'replaced') {
        // The relay closed this registration for another daemon with the same identity;
        // dialling back would evict that daemon in turn, so the registration stops and says why.
        const advice = relayErrorAdvice('replaced');
        lastRefusal = { code: 'replaced', message: 'another daemon registered with this relay identity', state: advice.state, next: advice.next, retryable: advice.retryable };
        refuseRegistration(ws, lastRefusal);
        return;
      }
      clearRegistrationTimer();
      stopKeepalive();
      socket = null;
      abortAllRequests();
      for (const pipeKey of [...pipeStreams.keys()]) void closePipeStreams(pipeKey);
      channels.clear();
      pipeCodes.clear();
      if (!stopped) scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      logger.warn('relay websocket error', { rid });
    });
  }

  return {
    start(): void {
      if (!stopped && status !== 'idle') return;
      // A refused registration starts over without the refusal it rested on.
      if (status === 'refused') lastRefusal = null;
      stopped = false;
      attempt = 0;
      registeredAt = null;
      openConnection();
    },
    stop(): void {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      clearRegistrationTimer();
      stopKeepalive();
      abortAllRequests();
      for (const pipeKey of [...pipeStreams.keys()]) void closePipeStreams(pipeKey);
      channels.clear();
      pipeCodes.clear();
      try {
        socket?.close();
      } catch {
        // ignore
      }
      socket = null;
      setStatus('stopped');
    },
    get status(): RelayRegistrationStatus {
      return status;
    },
    get rendezvousId(): string | null {
      return rid;
    },
    get lastConfirmedAt(): number | null {
      return lastConfirmedAt;
    },
    get lastRefusal(): RelayRegistrationRefusal | null {
      return lastRefusal;
    },
    async mintPairing(code: string, label?: string): Promise<RelayPairingPayload> {
      return createRelayPairingPayload({
        relayUrl: options.relayUrl,
        rid: await ridReady,
        daemonPublicKey: await relayIdentityPublicKeyBase64Url(options.identity),
        code,
        ...(label !== undefined ? { label } : {}),
      });
    },
    async closePipesPresenting(revoked: (code: string) => boolean, reason: string): Promise<number> {
      const closing: Promise<unknown>[] = [];
      for (const [pipeKey, codes] of [...pipeCodes]) {
        if (![...codes].some(revoked)) continue;
        abortPipeRequests(pipeKey);
        // Each stream gets its stream-close naming the reason before the pipe goes.
        const ws = socket;
        closing.push(closePipeStreams(pipeKey, reason).then(() => {
          channels.delete(pipeKey);
          try { ws?.send(encodeControlFrame({ t: 'pipe-close', pipe: pipeKey, reason })); } catch { /* the socket is already gone */ }
        }));
      }
      await Promise.all(closing);
      return closing.length;
    },
    stats(): RelayRegistrationStats {
      return {
        pipes: channels.size,
        inFlightRequests,
        streams: countStreams(),
        droppedPipes,
        droppedRequests,
      };
    },
  };
}
