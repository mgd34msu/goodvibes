// relay-transport.ts
//
// The client half of the relay path. Its whole job is to produce a `fetch`
// implementation backed by the end-to-end secure channel, so the EXISTING typed
// operator/peer client works completely unchanged over the relay: you build the
// platform with `fetchImpl: relayClient.fetch` instead of the default, and every
// contract call is serialized to an HTTP request, tunneled as ciphertext to the
// daemon, replayed there, and its response tunneled back. The relay operator
// never sees any of it.
//
// This tunnels unary request/response calls AND streamed answers. A request
// whose caller asked for a streamed answer (`Accept: text/event-stream` or an
// audio type, or a JSON body with `"stream": true`) is opened as a tunneled
// stream, with its method and body: the returned `Response` carries the
// daemon's real status and headers and a `ReadableStream` body fed by
// `stream-data` frames as the daemon produces them, so the EXISTING
// Server-Sent-Events connector idiom works over the relay unchanged, and a
// streamed chat completion or streamed speech starts as soon as its first bytes
// exist. Overflow on the daemon's bounded send buffer ends the body with a
// typed `StreamGapError` carrying the dropped count (never a silent gap, and
// never text written into the body). A frame larger than the
// relay forwards in one message is sent and received in fragments.

import { GoodVibesError } from '@goodvibes/engine/errors';
import { createUuidV4, StreamGapError, type FetchLike } from '@goodvibes/engine/transport-core';
import {
  RelaySecureChannel,
  TunnelFragmentJoiner,
  decodeControlFrame,
  decodeTunnelFrame,
  encodeControlFrame,
  encodeTunnelFrame,
  encodeUtf8,
  finishInitiatorHandshake,
  fragmentTunnelFrame,
  fromBase64Url,
  RELAY_CODE_HEADER,
  RELAY_DEFAULT_MAX_MESSAGE_BYTES,
  RELAY_PROTOCOL_VERSION,
  relayErrorAdvice,
  resolveRelayPairing,
  startInitiatorHandshake,
  tunnelFrameLimit,
  type RelayInitiatorState,
  type RelayPairingPayload,
  type TunnelHeader,
} from '@goodvibes/engine/transport-core/relay';

/** Minimal structural WebSocket shape the relay client needs (browser/Bun/Node). */
export interface RelayWebSocketLike {
  binaryType: string;
  send(data: string | Uint8Array | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: unknown) => void): void;
}

/** Options for {@link createRelayClient}. */
export interface RelayClientOptions {
  /** Pairing payload (object or the `gvrelay1.` encoded string) identifying the daemon. */
  readonly pairing: RelayPairingPayload | string;
  /** WebSocket constructor override (defaults to `globalThis.WebSocket`). */
  readonly webSocketImpl?: (url: string) => RelayWebSocketLike;
  /** Milliseconds to wait for the pipe + handshake before failing connect (default 15000). */
  readonly connectTimeoutMs?: number;
  /** Unary timeout (default 30000); judgment waits until its caller or connection cancels. */
  readonly requestTimeoutMs?: number;
}

/** A live relay client: a relay-backed `fetch` plus explicit lifecycle. */
export interface RelayClient {
  /** A `fetch` implementation to hand to the platform as `fetchImpl`. */
  readonly fetch: FetchLike;
  /** Establish the pipe + E2E handshake. Idempotent; the fetch auto-connects too. */
  connect(): Promise<void>;
  /** Tear down the relay connection. */
  close(): void;
  /** True once the E2E channel is ready. */
  readonly ready: boolean;
}

const MAX_QUEUED_FRAMES = 1024;
const MAX_QUEUED_FRAME_BYTES = 64 * 1024 * 1024;
interface FrameQueue { tail: Promise<void>; count: number; bytes: number; }

interface PendingRequest {
  resolve(response: Response): void;
  reject(error: unknown): void;
}

interface PendingStream {
  readonly path: string;
  readonly body: ReadableStream<Uint8Array>;
  readonly controller: ReadableStreamDefaultController<Uint8Array>;
  readonly detachAbort: () => void;
  /** Ends the stream here with `failure` and tells the daemon to stop sending it. */
  cancel?: ((failure?: { readonly error: unknown }) => Promise<void>) | undefined;
  closed: boolean;
  /** Settles the caller's fetch once the daemon answers with the stream's status and headers. */
  answer?: { resolve(response: Response): void; reject(error: unknown): void } | undefined;
}

/** Largest JSON request body read for `"stream": true`; larger bodies are sent as plain requests. */
const STREAM_FLAG_SCAN_BYTES = 64 * 1024;

/**
 * Whether the caller asked for a streamed answer: an Accept naming an event
 * stream or audio, or a JSON body with `"stream": true` (the compatible chat
 * and Home Assistant conversation convention). Decided before the request
 * leaves, so the daemon never runs a request it then cannot deliver.
 */
function wantsStreamedAnswer(request: Request, body: Uint8Array<ArrayBuffer>): boolean {
  const accept = request.headers.get('accept') ?? '';
  if (accept.includes('text/event-stream') || accept.includes('audio/')) return true;
  if (body.length === 0 || body.length > STREAM_FLAG_SCAN_BYTES) return false;
  if (!(request.headers.get('content-type') ?? '').includes('json')) return false;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    return typeof parsed === 'object' && parsed !== null && (parsed as { stream?: unknown }).stream === true;
  } catch {
    return false;
  }
}

/** Why the daemon ended a tunneled stream, for the reasons that mean it never delivered (or stopped delivering) events. */
const STREAM_CLOSE_FAILURES: Readonly<Record<string, string>> = {
  'stream-limit': 'the daemon already has the maximum number of event streams open on this connection',
  'no-stream': 'the daemon had no event stream to open for this request',
  'source-error': 'the daemon\'s event source failed',
};

function streamCloseFailure(reason: string | undefined): GoodVibesError | undefined {
  const explanation = reason === undefined ? undefined : STREAM_CLOSE_FAILURES[reason];
  if (explanation === undefined) return undefined;
  return new GoodVibesError(`The relay event stream was closed by the daemon (${reason}): ${explanation}.`, {
    category: 'service',
    source: 'transport',
    recoverable: true,
  });
}

function defaultWebSocket(url: string): RelayWebSocketLike {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => RelayWebSocketLike }).WebSocket;
  if (!Ctor) {
    throw new GoodVibesError('No WebSocket implementation is available in this runtime.', {
      category: 'config',
      source: 'transport',
      recoverable: false,
      hint: 'Provide options.webSocketImpl, or run where globalThis.WebSocket exists.',
    });
  }
  return new Ctor(url);
}

function toBytes(data: unknown): Uint8Array<ArrayBuffer> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) return new Uint8Array(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  throw new GoodVibesError('Relay received a non-binary data frame.', { category: 'protocol', source: 'transport', recoverable: false });
}

/** Cancellation stops waiting without cancelling another caller's shared connection attempt. */
async function whileActive<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

/**
 * Create a relay client for a paired daemon. The returned `fetch` transparently
 * tunnels every request through the zero-knowledge channel.
 */
export function createRelayClient(options: RelayClientOptions): RelayClient {
  const pairing = resolveRelayPairing(options.pairing);
  const daemonPubRaw = fromBase64Url(pairing.daemonPublicKey);
  const ridBytes = encodeUtf8(pairing.rid);
  const connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const makeSocket = options.webSocketImpl ?? defaultWebSocket;

  let socket: RelayWebSocketLike | null = null;
  let channel: RelaySecureChannel | null = null;
  let initiatorState: RelayInitiatorState | null = null;
  let connectPromise: Promise<void> | null = null;
  let cancelConnection: ((error: unknown) => void) | undefined;
  const pending = new Map<string, PendingRequest>();
  const streams = new Map<string, PendingStream>();
  const outgoing = new WeakMap<RelaySecureChannel, FrameQueue>();
  const incoming = new WeakMap<RelayWebSocketLike, FrameQueue>();
  const joiners = new WeakMap<RelaySecureChannel, TunnelFragmentJoiner>();
  // The largest tunnel frame one relay message carries; the relay states its limit when it connects us.
  let frameLimit = tunnelFrameLimit(RELAY_DEFAULT_MAX_MESSAGE_BYTES);

  /** Keep encrypted request/cancel/stream frames in counter order through async crypto. */
  function sendFrame(frame: Uint8Array<ArrayBuffer>, activeChannel: RelaySecureChannel, activeSocket: RelayWebSocketLike,
    wanted: () => boolean = () => true, sending: () => void = () => {}): Promise<void> {
    const current = () => channel === activeChannel && socket === activeSocket && wanted();
    if (!current()) return Promise.resolve();
    const queue = outgoing.get(activeChannel) ?? { tail: Promise.resolve(), count: 0, bytes: 0 };
    if (queue.count >= MAX_QUEUED_FRAMES || queue.bytes + frame.byteLength > MAX_QUEUED_FRAME_BYTES) {
      const error = new GoodVibesError('Relay outgoing frame queue limit exceeded.', { category: 'protocol', source: 'transport', recoverable: true });
      teardown(error); return Promise.reject(error);
    }
    // A frame larger than one relay message goes as consecutive fragments, queued together.
    const parts = fragmentTunnelFrame(frame, frameLimit);
    queue.count++; queue.bytes += frame.byteLength;
    const work = queue.tail.then(async () => {
      for (const part of parts) {
        if (!current()) return;
        const sealed = await activeChannel.seal(part);
        if (!current()) return;
        sending(); activeSocket.send(sealed);
      }
    });
    queue.tail = work.then(() => {}, () => {}).finally(() => { queue.count--; queue.bytes -= frame.byteLength; });
    outgoing.set(activeChannel, queue);
    return work;
  }

  /** WebSocket order must survive asynchronous AEAD open/counter validation. */
  function receiveFrame(bytes: Uint8Array<ArrayBuffer>, ws: RelayWebSocketLike, markReady: () => void): Promise<void> {
    if (socket !== ws) return Promise.resolve();
    const queue = incoming.get(ws) ?? { tail: Promise.resolve(), count: 0, bytes: 0 };
    if (queue.count >= MAX_QUEUED_FRAMES || queue.bytes + bytes.byteLength > MAX_QUEUED_FRAME_BYTES) {
      const error = new GoodVibesError('Relay incoming frame queue limit exceeded.', { category: 'protocol', source: 'transport', recoverable: true });
      teardown(error); return Promise.reject(error);
    }
    queue.count++; queue.bytes += bytes.byteLength;
    const work = queue.tail.then(async () => { if (socket === ws) await onBinary(bytes, ws, markReady); });
    queue.tail = work.then(() => {}, () => {}).finally(() => { queue.count--; queue.bytes -= bytes.byteLength; });
    incoming.set(ws, queue);
    return work;
  }

  function closeStream(id: string, failure?: { readonly error: unknown }): void {
    const stream = streams.get(id);
    if (!stream) return;
    streams.delete(id);
    stream.detachAbort();
    const answer = stream.answer;
    stream.answer = undefined;
    answer?.reject(failure?.error ?? new GoodVibesError('The daemon ended the stream before answering.', { category: 'service', source: 'transport', recoverable: true }));
    if (stream.closed) return;
    stream.closed = true;
    try {
      if (failure) stream.controller.error(failure.error);
      else stream.controller.close();
    } catch {
      // controller already closed
    }
  }

  function failAll(error: unknown): void {
    for (const [, p] of pending) {
      p.reject(error);
    }
    pending.clear();
    for (const id of [...streams.keys()]) closeStream(id, { error });
  }

  function teardown(error: unknown = new GoodVibesError('Relay connection closed.', { category: 'network', source: 'transport', recoverable: true })): void {
    failAll(error);
    const previous = socket;
    const cancel = cancelConnection;
    cancelConnection = undefined;
    socket = null;
    channel = null;
    initiatorState = null;
    connectPromise = null;
    cancel?.(error);
    try { previous?.close(); } catch { /* already disconnected */ }
  }

  async function onBinary(bytes: Uint8Array<ArrayBuffer>, ws: RelayWebSocketLike, markReady: () => void): Promise<void> {
    if (!channel) {
      // First binary is the handshake response (message2).
      if (!initiatorState) throw new GoodVibesError('Unexpected relay frame before handshake start.', { category: 'protocol', source: 'transport', recoverable: false });
      const keys = await finishInitiatorHandshake(initiatorState, bytes);
      if (socket !== ws) return;
      channel = new RelaySecureChannel(keys, 'client');
      markReady();
      return;
    }
    const activeChannel = channel;
    let framed: { readonly header: TunnelHeader; readonly body: Uint8Array<ArrayBuffer> } | null = decodeTunnelFrame(await activeChannel.open(bytes));
    if (!framed || socket !== ws || channel !== activeChannel) return;
    if (framed.header.kind === 'fragment') {
      const joiner = joiners.get(activeChannel) ?? new TunnelFragmentJoiner(MAX_QUEUED_FRAME_BYTES);
      joiners.set(activeChannel, joiner);
      const joined = joiner.push(framed.header, framed.body);
      if (joined.kind === 'pending') return;
      if (joined.kind !== 'frame') {
        const error = new GoodVibesError(joined.kind === 'too-large'
          ? `A relay response exceeded ${MAX_QUEUED_FRAME_BYTES} bytes and was dropped.`
          : 'A relay response arrived out of order and was dropped.', { category: 'protocol', source: 'transport', recoverable: true });
        pending.get(joined.id)?.reject(error);
        closeStream(joined.id, { error });
        return;
      }
      framed = joined;
    } else {
      joiners.get(activeChannel)?.interrupt();
    }
    const header = framed.header;
    if (header.kind === 'response') {
      const waiting = pending.get(header.id);
      if (!waiting) {
        // A stream's answer: its status and headers before its bytes. A refusal
        // (rejected token, unknown route) is answered as that status and body.
        const stream = streams.get(header.id);
        const answer = stream?.answer;
        if (!stream || !answer) return;
        stream.answer = undefined;
        const headers = header.headers.map(([k, v]) => [k, v] as [string, string]);
        if (header.status >= 200 && header.status < 300) {
          answer.resolve(new Response(stream.body, { status: header.status, headers }));
        } else {
          answer.resolve(new Response(framed.body.length > 0 ? framed.body : null, { status: header.status, headers }));
          closeStream(header.id);
        }
        return;
      }
      waiting.resolve(new Response(framed.body.length > 0 ? framed.body : null, {
        status: header.status,
        headers: header.headers.map(([k, v]) => [k, v] as [string, string]),
      }));
      return;
    }
    if (header.kind === 'stream-data') {
      const stream = streams.get(header.id);
      // A daemon that sends no answer frame first: the stream is an event stream.
      if (stream?.answer) {
        const answer = stream.answer;
        stream.answer = undefined;
        answer.resolve(new Response(stream.body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
      }
      if (stream && !stream.closed && framed.body.length > 0) {
        try { stream.controller.enqueue(framed.body); } catch { /* consumer cancelled */ }
      }
      return;
    }
    if (header.kind === 'stream-overflow') {
      const stream = streams.get(header.id);
      if (stream && !stream.closed) {
        // Chunks were dropped: the body ends here with a typed gap, never with
        // text written into it (which would corrupt an audio or completion
        // stream) and never carrying on with a hole. An event stream reconnects
        // from its last event id and is replayed what was lost.
        const failure = { error: new StreamGapError(header.dropped) };
        if (stream.cancel) void stream.cancel(failure);
        else closeStream(header.id, failure);
      }
      return;
    }
    if (header.kind === 'stream-close') {
      // A refusal or source failure must not read as a clean end of stream.
      const failure = streamCloseFailure(header.reason);
      closeStream(header.id, failure ? { error: failure } : undefined);
      return;
    }
  }

  function connect(): Promise<void> {
    if (channel) return Promise.resolve();
    if (connectPromise) return connectPromise;
    connectPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const cancelled = (error: unknown): void => {
        if (settled) return;
        settled = true; clearTimeout(timer); reject(error);
      };
      cancelConnection = cancelled;
      const done = (err?: unknown): void => {
        if (settled) { if (err && socket === ws) teardown(err); return; }
        if (cancelConnection === cancelled) cancelConnection = undefined;
        settled = true;
        clearTimeout(timer);
        if (err) {
          teardown(err);
          reject(err);
        } else {
          resolve();
        }
      };
      const timer = setTimeout(() => done(new GoodVibesError('Timed out establishing the relay connection.', {
        category: 'timeout',
        source: 'transport',
        recoverable: true,
        hint: 'The daemon may be offline or the relay unreachable.',
      })), connectTimeoutMs);

      let ws: RelayWebSocketLike;
      try { ws = makeSocket(pairing.relayUrl); }
      catch (error) { done(error); return; }
      ws.binaryType = 'arraybuffer';
      socket = ws;
      ws.addEventListener('open', () => {
        ws.send(encodeControlFrame({ t: 'connect', role: 'client', protocol: RELAY_PROTOCOL_VERSION, rid: pairing.rid }));
      });
      ws.addEventListener('message', (event) => {
        if (socket !== ws) return;
        const data = (event as { data: unknown }).data;
        void (async () => {
          try {
            if (typeof data === 'string') {
              const frame = decodeControlFrame(data);
              if (!frame) return;
              if (frame.t === 'connected') {
                frameLimit = tunnelFrameLimit(frame.maxMessageBytes ?? RELAY_DEFAULT_MAX_MESSAGE_BYTES);
                const started = await startInitiatorHandshake(daemonPubRaw, ridBytes);
                if (socket !== ws) return;
                initiatorState = started.state;
                ws.send(started.message1);
              } else if (frame.t === 'error') {
                const advice = relayErrorAdvice(frame.code);
                done(new GoodVibesError(`Relay refused the connection: ${frame.message}`, {
                  category: frame.code === 'daemon-offline' ? 'not_found' : 'service',
                  source: 'transport',
                  code: `RELAY_${frame.code.toUpperCase().replace(/-/g, '_')}`,
                  recoverable: advice.retryable,
                  state: advice.state,
                  next: advice.next,
                }));
              } else if (frame.t === 'pipe-close') {
                done(new GoodVibesError('Relay pipe closed.', { category: 'network', source: 'transport', recoverable: true }));
              }
              return;
            }
            await receiveFrame(toBytes(data), ws, () => done());
          } catch (err) {
            if (socket === ws) done(err);
          }
        })();
      });
      ws.addEventListener('close', () => {
        if (socket !== ws) return;
        done(new GoodVibesError('Relay connection closed.', { category: 'network', source: 'transport', recoverable: true }));
      });
      ws.addEventListener('error', () => {
        if (socket !== ws) return;
        done(new GoodVibesError('Relay WebSocket error.', { category: 'network', source: 'transport', recoverable: true }));
      });
    });
    const attempt = connectPromise;
    // A failure that settles inside the executor (a socket that cannot be constructed)
    // runs teardown before this assignment, which would leave the rejected promise
    // cached for every later connect().
    attempt.catch(() => { if (connectPromise === attempt) connectPromise = null; });
    return attempt;
  }

  async function openStream(
    method: string,
    path: string,
    headers: Array<[string, string]>,
    requestBody: Uint8Array<ArrayBuffer>,
    activeChannel: RelaySecureChannel,
    activeSocket: RelayWebSocketLike,
    signal: AbortSignal,
  ): Promise<Response> {
    const id = createUuidV4();
    let owner: PendingStream | undefined;
    let sent = false;
    let closing: Promise<void> | undefined;
    const current = (): boolean => owner !== undefined && streams.get(id) === owner && !owner.closed;
    const cancel = (failure?: { readonly error: unknown }): Promise<void> => {
      if (!current()) return closing ?? Promise.resolve();
      closeStream(id, failure);
      if (!sent) return Promise.resolve();
      const frame = encodeTunnelFrame({ id, kind: 'stream-close' }, new Uint8Array(0));
      closing = sendFrame(frame, activeChannel, activeSocket).catch(() => { /* socket already gone */ });
      return closing;
    };
    const abort = (): void => { void cancel({ error: signal.reason }); };
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
      cancel: () => cancel(),
    });
    const answered = new Promise<Response>((resolve, reject) => {
      owner = { path, body, controller, closed: false, answer: { resolve, reject }, cancel, detachAbort: () => signal.removeEventListener('abort', abort) };
      streams.set(id, owner);
    });
    answered.catch(() => { /* observed through the await below */ });
    signal.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (signal.aborted) abort();
      signal.throwIfAborted();
      const openFrame = encodeTunnelFrame({ id, kind: 'stream-open', method, path, headers }, requestBody);
      await whileActive(sendFrame(openFrame, activeChannel, activeSocket, current, () => { sent = true; }), signal);
      signal.throwIfAborted();
      if (channel !== activeChannel || socket !== activeSocket) {
        throw new GoodVibesError('Relay connection changed.', { category: 'network', source: 'transport', recoverable: true });
      }
      // The daemon answers with the stream's status and headers as soon as its handler responds.
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new GoodVibesError('The daemon did not answer the relay stream in time.', { category: 'timeout', source: 'transport', recoverable: true })), requestTimeoutMs);
      });
      return await whileActive(Promise.race([answered, deadline]), signal);
    } catch (error) {
      void cancel({ error });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  const relayFetch: FetchLike = async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    request.signal.throwIfAborted();
    await whileActive(connect(), request.signal);
    request.signal.throwIfAborted();
    if (!channel || !socket) throw new GoodVibesError('Relay channel is not ready.', { category: 'network', source: 'transport', recoverable: true });
    const activeChannel = channel;
    const activeSocket = socket;
    const url = new URL(request.url, 'http://relay.local');
    const headers: Array<[string, string]> = [];
    request.headers.forEach((value, key) => { if (key.toLowerCase() !== RELAY_CODE_HEADER) headers.push([key, value]); });
    // This device's relay code, on every tunneled request: the daemon refuses one it did not issue or has revoked.
    headers.push([RELAY_CODE_HEADER, pairing.code]);
    const body = request.method === 'GET' || request.method === 'HEAD' ? new Uint8Array(0) : new Uint8Array(await whileActive(request.arrayBuffer(), request.signal));
    request.signal.throwIfAborted();
    // A request whose caller wants a streamed answer is opened as a tunneled
    // stream rather than a unary call, so its bytes arrive as they are produced
    // (an event stream's body never ends). The existing SSE connector, which
    // just calls fetch and reads the streaming body, works over the relay.
    if (wantsStreamedAnswer(request, body)) {
      return openStream(request.method, `${url.pathname}${url.search}`, headers, body, activeChannel, activeSocket, request.signal);
    }
    const id = createUuidV4();
    const frame = encodeTunnelFrame(
      { id, kind: 'request', method: request.method, path: `${url.pathname}${url.search}`, headers },
      body,
    );
    if (channel !== activeChannel || socket !== activeSocket) throw new GoodVibesError('Relay connection changed.', { category: 'network', source: 'transport', recoverable: true });
    return new Promise<Response>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let sent = false;
      const cleanup = (): boolean => {
        if (!pending.delete(id)) return false;
        clearTimeout(timer);
        request.signal.removeEventListener('abort', cancel);
        return true;
      };
      const cancelRemote = (): void => {
        if (!sent || channel !== activeChannel || socket !== activeSocket) return;
        void (async () => {
          try {
            const cancelled = encodeTunnelFrame({ id, kind: 'request-cancel' }, new Uint8Array(0));
            await sendFrame(cancelled, activeChannel, activeSocket);
          } catch { if (socket === activeSocket) teardown(); }
        })();
      };
      const fail = (error: unknown): void => { if (cleanup()) reject(error); };
      const cancel = (): void => { cancelRemote(); fail(request.signal.reason); };
      pending.set(id, { resolve: (response) => { if (cleanup()) resolve(response); }, reject: fail });
      request.signal.addEventListener('abort', cancel, { once: true });
      // This exact closed-schema route borrows Jev's one central retry owner.
      // Other unary calls retain the ordinary request timeout. Neither branch
      // changes source/reference expiry or authorization checks in the daemon.
      if (request.method !== 'POST' || url.pathname !== '/api/judgment/batteries/run' || url.search !== '') {
        timer = setTimeout(() => {
          cancelRemote();
          fail(new GoodVibesError('Relay request timed out.', { category: 'timeout', source: 'transport', recoverable: true }));
        }, requestTimeoutMs);
      }
      if (request.signal.aborted) { cancel(); return; }
      void sendFrame(frame, activeChannel, activeSocket, () => pending.has(id), () => { sent = true; }).catch(fail);
    });
  };

  return {
    fetch: relayFetch,
    connect,
    close: () => teardown(),
    get ready(): boolean {
      return channel !== null;
    },
  };
}
