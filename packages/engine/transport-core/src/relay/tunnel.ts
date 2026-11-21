// relay/tunnel.ts
//
// The application framing that rides inside the E2E secure channel: whole HTTP
// request/response pairs AND live event subscriptions, tunneled opaquely between
// a surface and the daemon. Because the operator protocol is contract-driven
// REST-over-JSON, tunneling HTTP is all it takes for the existing typed client
// to work unchanged over the relay, the client's transport just swaps its
// `fetch` for one that serializes the Request here, and the daemon replays it
// against its own route dispatcher.
//
// Frame layout (this is what the secure channel seals, never the relay's
// business):
//   [ headerLen : 4 bytes BE ][ header JSON (UTF-8) ][ raw body bytes ]
// Keeping the body as raw bytes (not base64 inside JSON) avoids inflating
// payloads and keeps binary bodies exact.
//
// Streaming frames (an answer the caller reads as it is produced: Server-Sent
// Events, streamed speech, a streamed chat completion) reuse the same
// sealed-frame layout and multiplex over the same pipe by a shared `id`:
//   - `stream-open`     surface → daemon: a request (any method, with its body)
//                       whose answer is streamed.
//   - `response`        daemon → surface: the answer's status and headers, sent
//                       before its first `stream-data`.
//   - `stream-data`     daemon → surface: one chunk of the answer's bytes.
//   - `stream-overflow` daemon → surface: the bounded send buffer dropped N
//                       chunks, an honest notice, never a silent gap.
//   - `stream-close`    either direction: clean teardown (surface unsubscribes,
//                       or the daemon's source ended/errored).
//
// A relay forwards binary messages up to a size it states (`maxMessageBytes`
// in its `registered` / `connected` frame). A sealed frame larger than that is
// sent as consecutive `fragment` frames carrying slices of the whole encoded
// frame; the receiver joins them and decodes the frame as if it came whole.

import { concatBytes, decodeUtf8, encodeUtf8 } from './crypto.js';

/** A tunneled HTTP request (surface → daemon). */
export interface TunnelRequestHeader {
  readonly id: string;
  readonly kind: 'request';
  readonly method: string;
  /** Path + query only (no host); the daemon resolves it against its local base. */
  readonly path: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
}

/** Cancel one owned unary request (surface → daemon). No reason or credential crosses this boundary. */
export interface TunnelRequestCancelHeader {
  readonly id: string;
  readonly kind: 'request-cancel';
}

/** A tunneled HTTP response (daemon → surface). */
export interface TunnelResponseHeader {
  readonly id: string;
  readonly kind: 'response';
  readonly status: number;
  readonly headers: ReadonlyArray<readonly [string, string]>;
}

/** A request whose answer is streamed (surface → daemon). Shape mirrors a request; the frame body is the request body. */
export interface TunnelStreamOpenHeader {
  readonly id: string;
  readonly kind: 'stream-open';
  readonly method: string;
  readonly path: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
}

/** One chunk of a subscription's event bytes (daemon → surface). */
export interface TunnelStreamDataHeader {
  readonly id: string;
  readonly kind: 'stream-data';
  /** Monotonic per-stream sequence number (gaps after an overflow notice are expected). */
  readonly seq: number;
}

/** The bounded send buffer dropped chunks, an honest overflow notice (daemon → surface). */
export interface TunnelStreamOverflowHeader {
  readonly id: string;
  readonly kind: 'stream-overflow';
  /** How many chunks were dropped since the previous notice. */
  readonly dropped: number;
}

/** Clean subscription teardown (either direction). */
export interface TunnelStreamCloseHeader {
  readonly id: string;
  readonly kind: 'stream-close';
  readonly reason?: string;
}

/**
 * One slice of a tunnel frame too large for one relay message. `id` is the
 * whole frame's id; slices arrive in order, `index` 0 to `count - 1`.
 */
export interface TunnelFragmentHeader {
  readonly id: string;
  readonly kind: 'fragment';
  readonly index: number;
  readonly count: number;
}

/** Any tunnel frame header. */
export type TunnelHeader =
  | TunnelFragmentHeader
  | TunnelRequestHeader
  | TunnelRequestCancelHeader
  | TunnelResponseHeader
  | TunnelStreamOpenHeader
  | TunnelStreamDataHeader
  | TunnelStreamOverflowHeader
  | TunnelStreamCloseHeader;

/** Encode a tunnel header + body into a single frame for the secure channel. */
export function encodeTunnelFrame(header: TunnelHeader, body: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const headerBytes = encodeUtf8(JSON.stringify(header));
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, headerBytes.length, false);
  return concatBytes(prefix, headerBytes, body);
}

/** Decode a tunnel frame into its header and raw body. Returns null if malformed. */
export function decodeTunnelFrame(
  frame: Uint8Array<ArrayBuffer>,
): { readonly header: TunnelHeader; readonly body: Uint8Array<ArrayBuffer> } | null {
  if (frame.length < 4) return null;
  const headerLen = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, false);
  if (frame.length < 4 + headerLen) return null;
  let header: unknown;
  try {
    header = JSON.parse(decodeUtf8(frame.subarray(4, 4 + headerLen)));
  } catch {
    return null;
  }
  if (!isTunnelHeader(header)) return null;
  return { header: withoutDaemonOwnedHeaders(header), body: frame.subarray(4 + headerLen).slice() };
}

/**
 * The daemon marks requests that arrived over the relay with this header. It is
 * owned by the daemon, so a surface-supplied copy is dropped on decode rather
 * than merged with the daemon's own value.
 */
const RELAY_VIA_HEADER_NAME = 'x-goodvibes-via-relay';

function withoutDaemonOwnedHeaders(header: TunnelHeader): TunnelHeader {
  if (header.kind !== 'request' && header.kind !== 'stream-open') return header;
  return { ...header, headers: header.headers.filter(([name]) => name.toLowerCase() !== RELAY_VIA_HEADER_NAME) };
}

function isHeaderPairs(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => Array.isArray(entry) && entry.length === 2
    && typeof entry[0] === 'string' && typeof entry[1] === 'string');
}

/** Path and query only: one leading slash, so resolving it against the local base can never change the host. */
function isLocalPath(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')
    // eslint-disable-next-line no-control-regex -- URL parsing drops tab/newline, so "/\t/host" would resolve to another host
    && !/[\u0000-\u0020\u007f]/.test(value);
}

function isTunnelHeader(value: unknown): value is TunnelHeader {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['id'] !== 'string') return false;
  if (v['kind'] === 'request' || v['kind'] === 'stream-open') {
    return isHeaderPairs(v['headers']) && typeof v['method'] === 'string' && isLocalPath(v['path']);
  }
  if (v['kind'] === 'request-cancel') return true;
  if (v['kind'] === 'response') return isHeaderPairs(v['headers']) && typeof v['status'] === 'number';
  if (v['kind'] === 'stream-data') return typeof v['seq'] === 'number';
  if (v['kind'] === 'stream-overflow') return typeof v['dropped'] === 'number';
  if (v['kind'] === 'stream-close') return v['reason'] === undefined || typeof v['reason'] === 'string';
  if (v['kind'] === 'fragment') {
    const { index, count } = v as { index?: unknown; count?: unknown };
    return Number.isSafeInteger(index) && Number.isSafeInteger(count)
      && (count as number) >= 2 && (count as number) <= MAX_TUNNEL_FRAGMENTS && (index as number) >= 0 && (index as number) < (count as number);
  }
  return false;
}

// ─── Fragments ────────────────────────────────────────────────────────────────

/** Most fragments one frame may be split into (bounds a receiver's bookkeeping, not the frame size). */
const MAX_TUNNEL_FRAGMENTS = 65_536;

/**
 * Bytes a relay message carries beyond a tunnel frame: the pipe-id prefix, the
 * secure channel's counter and tag, and a fragment header, with room to spare.
 */
export const RELAY_FRAME_OVERHEAD_BYTES = 1024;

/** The largest sealed-frame plaintext that fits one relay message of `maxMessageBytes`. */
export function tunnelFrameLimit(maxMessageBytes: number): number {
  return Math.max(4096, maxMessageBytes - RELAY_FRAME_OVERHEAD_BYTES);
}

/**
 * Split an encoded tunnel frame into fragment frames of at most `maxFrameBytes`
 * each, or return it alone when it fits. The frame's own id is read only when
 * it has to be split, so a frame that fits costs one length compare.
 */
export function fragmentTunnelFrame(frame: Uint8Array<ArrayBuffer>, maxFrameBytes: number): Uint8Array<ArrayBuffer>[] {
  if (frame.length <= maxFrameBytes) return [frame];
  const decoded = decodeTunnelFrame(frame);
  if (!decoded) throw new Error('Cannot fragment a malformed tunnel frame.');
  const slice = maxFrameBytes - 256;
  const count = Math.ceil(frame.length / slice);
  if (count > MAX_TUNNEL_FRAGMENTS) throw new Error('Tunnel frame is too large to fragment.');
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for (let index = 0; index < count; index += 1) {
    parts.push(encodeTunnelFrame({ id: decoded.header.id, kind: 'fragment', index, count }, frame.slice(index * slice, (index + 1) * slice)));
  }
  return parts;
}

/** What {@link TunnelFragmentJoiner.push} made of one fragment. */
export type TunnelFragmentResult =
  | { readonly kind: 'pending' }
  | { readonly kind: 'frame'; readonly header: TunnelHeader; readonly body: Uint8Array<ArrayBuffer> }
  | { readonly kind: 'too-large'; readonly id: string }
  | { readonly kind: 'malformed'; readonly id: string };

/**
 * Joins the fragments of one direction of one secure channel. Fragments of a
 * frame arrive consecutively and in order (the sender queues them together and
 * the channel keeps order), so at most one partial frame is held, bounded by
 * `maxBytes`. A sender stops between fragments when the frame is no longer
 * wanted (its request was cancelled), so any other frame arriving means the
 * held partial was abandoned: a fragment of another frame replaces it, and the
 * receiver calls {@link interrupt} for every whole frame it decodes.
 */
export class TunnelFragmentJoiner {
  private partial: { readonly id: string; readonly count: number; next: number; bytes: number; readonly parts: Uint8Array<ArrayBuffer>[] } | undefined;

  constructor(private readonly maxBytes: number) {}

  push(header: TunnelFragmentHeader, body: Uint8Array<ArrayBuffer>): TunnelFragmentResult {
    let entry = this.partial?.id === header.id ? this.partial : undefined;
    if (!entry) {
      this.partial = undefined;
      if (header.index !== 0) return { kind: 'malformed', id: header.id };
      entry = { id: header.id, count: header.count, next: 0, bytes: 0, parts: [] };
      this.partial = entry;
    }
    if (header.index !== entry.next || header.count !== entry.count) {
      this.partial = undefined;
      return { kind: 'malformed', id: header.id };
    }
    if (entry.bytes + body.length > this.maxBytes) {
      this.partial = undefined;
      return { kind: 'too-large', id: header.id };
    }
    entry.parts.push(body);
    entry.bytes += body.length;
    entry.next += 1;
    if (entry.next < entry.count) return { kind: 'pending' };
    this.partial = undefined;
    const whole = decodeTunnelFrame(concatBytes(...entry.parts));
    if (!whole || whole.header.kind === 'fragment' || whole.header.id !== header.id) return { kind: 'malformed', id: header.id };
    return { kind: 'frame', header: whole.header, body: whole.body };
  }

  /** A whole frame arrived: a partial frame held now was abandoned by its sender and is discarded. */
  interrupt(): void {
    this.partial = undefined;
  }
}
