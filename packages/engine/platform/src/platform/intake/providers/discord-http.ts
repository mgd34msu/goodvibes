import { assertSynchronousJudgmentGuard } from '@goodvibes-jev/judgment/decisions';
/** Private account-scoped Discord HTTP owner. Never exported by an platform barrel. */
import { Client, interceptors, type Dispatcher } from 'undici/index.js';
import { responseStream } from '../../security/source-screening/direct-client.js';
import { POLL_CADENCE_MS } from '../provider-adapter.js';
import type { DiscordInboxHttp } from './discord.js';
import type { InboxHttpFailure, InboxHttpResult } from './inbox-http.js';
import { VERSION } from '../../version.js';

const ORIGIN = 'https://discord.com';
const USER_AGENT = `DiscordBot (https://github.com/mgd34msu/goodvibes, ${VERSION})`;
const RESPONSE_LIMIT = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 120_000;
type Method = 'self' | 'channel' | 'history';
const snowflake = (value: string): boolean => /^[1-9]\d{0,19}$/.test(value) && BigInt(value) < (1n << 64n);
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const addListener = EventTarget.prototype.addEventListener;
const removeListener = EventTarget.prototype.removeEventListener;
const isAborted = (signal: AbortSignal): boolean => abortedGetter.call(signal) as boolean;
const onAbort = (signal: AbortSignal, listener: () => void): void => addListener.call(signal, 'abort', listener, { once: true });
const offAbort = (signal: AbortSignal, listener: () => void): void => removeListener.call(signal, 'abort', listener);

// Fixed failures by private identity; an external rejection is never inspected.
const failures = new WeakMap<object, { readonly reason: InboxHttpFailure; readonly retryAt?: number }>();
function failure(reason: InboxHttpFailure, retryAt?: number): Error {
  const error = new Error(`Discord HTTP ${reason}`);
  failures.set(error, { reason, ...(retryAt === undefined ? {} : { retryAt }) });
  return error;
}
const invalid = () => failure('not-allowed');
const failed = () => failure('unavailable');
const cancelled = () => failure('cancelled');
const timedOut = () => failure('timed-out');
const unauthorized = () => failure('not-current');
const oversized = () => failure('too-large');

/** Presence only: proxy URLs themselves can contain credentials. */
function requireDirectRoute(): void {
  const names = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
    ...Object.getOwnPropertyNames(process.env).filter(name => ['http_proxy', 'https_proxy', 'all_proxy'].includes(name.toLowerCase()))]);
  if ([...names].some(name => process.env[name] !== undefined && process.env[name] !== '')) {
    throw failure('proxy');
  }
}

function exactKeys(value: object, allowed: readonly string[]): void {
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))) throw invalid();
}

function capture(input: URL, request: Parameters<DiscordInboxHttp>[1], channels: ReadonlySet<string>) {
  try {
    // Read a native URL snapshot; caller accessors cannot change the origin,
    // path or query after validation or smuggle a Request/fetch option through.
    const address = URL.prototype.toString.call(input);
    const url = new URL(address);
    if (url.origin !== ORIGIN || url.username || url.password || address.includes('#')) throw invalid();
    const match = /^\/api\/v10\/channels\/([1-9]\d{0,19})(\/messages)?$/.exec(url.pathname);
    const method: Method = url.pathname === '/api/v10/users/@me' ? 'self' : match?.[2] ? 'history' : 'channel';
    if (method !== 'self' && (!match || !snowflake(match[1]!) || !channels.has(match[1]!))) throw invalid();
    const allowed = method === 'history' ? ['limit', 'before', 'after'] : [];
    const query = new Map<string, string>();
    for (const [key, value] of url.searchParams) {
      if (!allowed.includes(key) || query.has(key)) throw invalid();
      query.set(key, value);
    }
    // History pages one way: newest first `before` a snowflake, or oldest first `after` one (0 for the channel's start).
    const before = query.get('before'), after = query.get('after');
    if (method === 'history' && (query.get('limit') !== '100' || (before === undefined) === (after === undefined)
      || (before !== undefined && !snowflake(before)) || (after !== undefined && after !== '0' && !snowflake(after)))) throw invalid();
    exactKeys(request, ['method', 'headers', 'signal']);
    const { method: verb, headers, signal } = request;
    exactKeys(headers, ['Authorization', 'Accept']);
    const { Authorization: authorization, Accept: accept } = headers;
    if (verb !== 'GET' || accept !== 'application/json' || typeof authorization !== 'string'
      || !/^Bot [A-Za-z0-9._-]{1,4096}$/.test(authorization)) throw invalid();
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw invalid();
    if (signal !== undefined) isAborted(signal); // Validate the native brand without invoking caller accessors.
    return { method, path: `${url.pathname}${url.search}`, authorization, signal };
  } catch { throw invalid(); }
}

/** Discord specifies Retry-After in seconds. Never schedule a retry here. */
function cooldownMs(value: string | string[] | undefined): number {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return POLL_CADENCE_MS.realtime;
  const milliseconds = Number(value) * 1_000;
  // An excessive server delay must not wrap, overflow, or resume early.
  return Number.isFinite(milliseconds) ? Math.ceil(milliseconds) : Infinity;
}

interface DiscordInboxHttpOwnerOptions {
  /** Immutable intended channel membership supplied by the account owner. */
  readonly channelIds: readonly string[];
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  readonly timeoutMs?: number;
  /** Fence cached identity immediately on received auth denial, before drainage. */
  readonly onAuthenticationDenied?: () => void;
  /** Private constructor seam for owned loopback tests; production omits it. */
  readonly createClient?: (origin: typeof ORIGIN, options: Client.Options) => Client;
}

/**
 * Fixed-origin, GET-only HTTP/1.1 with an owned npm Undici client. No global
 * dispatcher or fetch, ambient proxy, redirects, request body or routing knobs.
 * HTTP settlement and close both await actual work and cancellation cleanup.
 */
export function createDiscordInboxHttpOwner(options: DiscordInboxHttpOwnerOptions): { http: DiscordInboxHttp; close(): Promise<void> } {
  const { timeoutMs, sourceSignal, assertCurrent, createClient, onAuthenticationDenied } = (() => {
    try {
      const { signal, assertCurrent, timeoutMs = DEFAULT_TIMEOUT_MS, createClient, onAuthenticationDenied } = options;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS
        || !(signal instanceof AbortSignal) || typeof assertCurrent !== 'function'
        || (createClient !== undefined && typeof createClient !== 'function')
        || (onAuthenticationDenied !== undefined && typeof onAuthenticationDenied !== 'function')) throw invalid();
      isAborted(signal);
      return { timeoutMs, sourceSignal: signal, assertCurrent, onAuthenticationDenied,
        createClient: createClient ?? ((origin: typeof ORIGIN, settings: Client.Options) => new Client(origin, settings)) };
    } catch { throw invalid(); }
  })();
  const channels = new Set(options.channelIds);
  if (channels.size < 1 || channels.size > 200 || [...channels].some(id => !snowflake(id))) throw invalid();
  const lifetime = new AbortController();
  const active = new Set<Promise<InboxHttpResult>>();
  // Wall-clock end of the rate-limit wait Discord asked for.
  let cooldownUntil = 0;
  let client: Client | undefined;
  let dispatcher: Dispatcher | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let preceding: Promise<void> = Promise.resolve();
  const stop = () => lifetime.abort(cancelled());
  onAbort(sourceSignal, stop);
  if (isAborted(sourceSignal)) stop();

  function check(signal?: AbortSignal): void {
    if (closed || isAborted(sourceSignal) || lifetime.signal.aborted) throw cancelled();
    if (signal?.aborted) throw signal.reason;
    try {
      assertSynchronousJudgmentGuard(assertCurrent, () => unauthorized());
    } catch { throw unauthorized(); }
    if (closed || isAborted(sourceSignal) || lifetime.signal.aborted) throw cancelled();
    if (signal?.aborted) throw signal.reason;
  }

  const http: DiscordInboxHttp = async (url, request) => {
    let captured: ReturnType<typeof capture>;
    try { captured = capture(url, request, channels); } catch { return { ok: false, reason: 'not-allowed' }; }
    const controller = new AbortController();
    const deadline = performance.now() + timeoutMs;
    const ensureCurrent = () => {
      if (performance.now() >= deadline) controller.abort(timedOut());
      check(controller.signal);
      if (performance.now() >= deadline) controller.abort(timedOut());
      if (controller.signal.aborted) throw controller.signal.reason;
    };
    const abort = () => controller.abort(cancelled());
    lifetime.signal.addEventListener('abort', abort, { once: true });
    if (captured.signal) onAbort(captured.signal, abort);
    if (lifetime.signal.aborted || (captured.signal && isAborted(captured.signal))) abort();
    const timer = setTimeout(() => controller.abort(timedOut()), timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancellation: Promise<void> | undefined;
    let bodyFinished = false;
    const cancelBody = () => {
      if (reader && !bodyFinished && !cancellation) {
        try { cancellation = reader.cancel().then(() => {}, () => {}); }
        catch { cancellation = Promise.resolve(); }
      }
    };
    controller.signal.addEventListener('abort', cancelBody, { once: true });
    // Register the complete operation before any caller hook or async work.
    const turn = preceding;
    const work = Promise.resolve().then(async () => {
      let bytes: Uint8Array;
      try {
        try {
          await turn;
          ensureCurrent();
          if (cooldownUntil > Date.now()) throw failure('rate-limited', cooldownUntil);
          if (!client) {
            client = createClient(ORIGIN, { pipelining: 0, allowH2: false,
              connect: { rejectUnauthorized: true }, maxHeaderSize: 16 * 1024,
              connectTimeout: timeoutMs, headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
            dispatcher = client.compose(interceptors.decompress({ maxSize: RESPONSE_LIMIT }));
          }
          ensureCurrent();
          // Check after the last owner hook and immediately before dispatch.
          requireDirectRoute();
          const response = await dispatcher!.request({ path: captured.path, method: 'GET',
            headers: { authorization: captured.authorization, accept: 'application/json', 'user-agent': USER_AGENT }, signal: controller.signal });
          reader = responseStream(response.body).getReader();
          // Capture a received rate limit even if cancellation wins next.
          if (response.statusCode === 429) {
            cooldownUntil = Date.now() + cooldownMs(response.headers['retry-after']);
            throw failure('rate-limited', cooldownUntil);
          }
          // A refused credential is a fact about the account only on the
          // identity route; a 403 on one channel is about that channel.
          if (response.statusCode === 401 || (response.statusCode === 403 && captured.method === 'self')) {
            onAuthenticationDenied?.();
            throw failure('denied');
          }
          if (response.statusCode === 403) throw failure('denied');
          if (response.statusCode === 404) throw failure('not-found');
          ensureCurrent();
          // No redirect interceptor exists; all non-success bodies are retired
          // without decoding or exposing status text, headers or raw content.
          if (response.statusCode < 200 || response.statusCode >= 300) throw failed();
          const chunks: Uint8Array[] = [];
          let size = 0;
          for (;;) {
            ensureCurrent();
            const next = await reader.read();
            ensureCurrent();
            if (next.done) { bodyFinished = true; break; }
            if (!(next.value instanceof Uint8Array) || next.value.byteLength > RESPONSE_LIMIT - size) throw oversized();
            size += next.value.byteLength;
            chunks.push(next.value.slice());
          }
          bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        } finally {
          cancelBody();
          // A late underlying response and asynchronous cancellation remain
          // owned. Neither HTTP completion nor close is a timeout race.
          await cancellation;
          reader?.releaseLock();
        }
        ensureCurrent();
        const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        ensureCurrent();
        return { ok: true, body } as const;
      } catch (error) {
        // Every failure resolves with its fixed reason; nothing is thrown past this owner.
        const known = error !== null && (typeof error === 'object' || typeof error === 'function') ? failures.get(error) : undefined;
        if (known?.reason === 'rate-limited' || known?.reason === 'proxy' || known?.reason === 'denied' || known?.reason === 'not-found') {
          return { ok: false, reason: known.reason, ...(known.retryAt === undefined ? {} : { retryAt: known.retryAt }) } as const;
        }
        if (controller.signal.aborted) {
          const reason = controller.signal.reason !== null && typeof controller.signal.reason === 'object' ? failures.get(controller.signal.reason)?.reason : undefined;
          return { ok: false, reason: reason ?? 'cancelled' } as const;
        }
        return { ok: false, reason: known?.reason ?? 'unavailable' } as const;
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', cancelBody);
        lifetime.signal.removeEventListener('abort', abort);
        if (captured.signal) offAbort(captured.signal, abort);
      }
    });
    preceding = work.then(() => {}, () => {});
    active.add(work);
    const release = () => { active.delete(work); };
    void work.then(release, release);
    return work;
  };

  return {
    http,
    close() {
      if (!closing) {
        closed = true;
        let resolve!: () => void;
        let reject!: (error: unknown) => void;
        closing = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
        stop();
        offAbort(sourceSignal, stop);
        void Promise.allSettled([...active]).then(async () => {
          try { await client?.destroy(); }
          catch { throw failed(); }
          finally { client = undefined; dispatcher = undefined; cooldownUntil = 0; }
        }).then(resolve, reject);
      }
      return closing;
    },
  };
}
