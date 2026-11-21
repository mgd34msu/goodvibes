/**
 * idempotent-replay.ts, a caller's retry key for a write that must not happen
 * twice.
 *
 * A write that takes money, sends a message or starts work, and that has no
 * retry key of its own, declares this one (`IDEMPOTENCY_KEY_REPLAY`): the
 * caller sends an `Idempotency-Key` header (over the method-invoke envelope
 * or a WebSocket call frame, an `idempotencyKey` field), and a repeat of the
 * same request under the same key, by the same principal, is answered with
 * the first answer instead of acting again. The SDK sends one generated key
 * on every attempt of such a call.
 *
 * Each key is one small file, written durably before the call runs (so a
 * retry after a crash in the middle is told the outcome is unknown instead of
 * acting twice) and again with the answer. A refusal (4xx) changed nothing,
 * so its key is forgotten and the same key may be sent again. Keys are kept
 * for `retentionMs` (a day). Costs two durable small-file writes per keyed
 * call and nothing for a call without a key.
 */
import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createReadStream, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describeArtifactUpload, isArtifactUploadRequest, type ArtifactUploadDescription } from '@goodvibes/engine/daemon-api/artifact-upload';
import { isOperationKey, OPERATION_KEY_RULE } from '@goodvibes/engine/errors';
import type { ContractReplayKey } from '../types/foundation-contract.js';
import { writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** How long a key is remembered. */
export const IDEMPOTENT_REPLAY_RETENTION_MS = 24 * 60 * 60_000;
/** The answer kept for a replay is bounded; a larger answer is not kept and its repeat says so. */
const MAX_KEPT_BODY_BYTES = 256 * 1024;

/**
 * The retry key every method without one of its own declares when a repeat
 * would take money, send a message or start work a second time.
 */
export const IDEMPOTENCY_KEY_REPLAY: ContractReplayKey = Object.freeze({
  in: 'header',
  name: 'Idempotency-Key',
  behavior: `Send a key (${OPERATION_KEY_RULE}) chosen once per logical request, and the same key on every retry: a repeat of the same request (for a multipart or raw upload: the same fields and file content, whatever the encoding) under the same key by the same credential, within a day and across a daemon restart, returns the first answer (with the Idempotent-Replayed: true header) instead of acting again. The same key with a different request is 409 IDEMPOTENCY_KEY_REUSED; a repeat while the first is still running is 409 IDEMPOTENCY_KEY_IN_FLIGHT (send it again with the same key after the Retry-After header's seconds, also in the body as retryAfterMs; the SDK does this within its retries); a repeat after the daemon stopped in the middle of the first is 409 IDEMPOTENCY_OUTCOME_UNKNOWN, and a repeat of a first request that failed partway is 500 IDEMPOTENCY_OUTCOME_UNKNOWN (either way: check the state, do not send again). A refusal (4xx) is not remembered, so the same key may be sent again. Over the method-invoke envelope or a WebSocket call frame the key may be sent as \`idempotencyKey\` beside \`body\`.`,
});

/** One request's answer, as the transport sends it. */
export interface ReplayableAnswer {
  readonly status: number;
  readonly body: unknown;
  /** The route's answer headers a caller acts on ({@link KEPT_ANSWER_HEADERS}), kept and replayed with the answer. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/** The answer headers kept with a keyed answer and sent again on its replay: the wait a route states, and where a created thing is. */
export const KEPT_ANSWER_HEADERS = ['Retry-After', 'Location'] as const;

/** The wait an IDEMPOTENCY_KEY_IN_FLIGHT answer states, in the header and in the body's `retryAfterMs`. */
const IN_FLIGHT_RETRY_AFTER_MS = 1000;
const IN_FLIGHT_HEADERS = Object.freeze({ 'Retry-After': String(Math.ceil(IN_FLIGHT_RETRY_AFTER_MS / 1000)) });

export interface IdempotentReplayRequest {
  readonly principalId: string;
  readonly methodId: string;
  readonly key: string;
  /** What makes two requests the same request: the method's arguments as sent. */
  readonly request: unknown;
}

interface KeptEntry {
  readonly fingerprint: string;
  readonly state: 'running' | 'done';
  readonly at: number;
  readonly status?: number;
  readonly body?: unknown;
  readonly bodyWithheld?: true;
  /** The kept answer headers; absent in entries written before they were kept, which replay without them. */
  readonly headers?: Readonly<Record<string, string>>;
}

function refusal(status: number, code: string, error: string, extra: Record<string, unknown> = {}): ReplayableAnswer {
  return { status, body: { error, code, status, ...extra } };
}

/** What every repeat of a request whose first run threw (in a running daemon) is answered. */
const FAILED_PARTWAY = refusal(500, 'IDEMPOTENCY_OUTCOME_UNKNOWN',
  'The first request under this Idempotency-Key failed partway, so whether it acted is unknown. Nothing was done again; check the state before sending a new request.',
  { recoverable: false });

/** JSON with object keys sorted, so the same request in another key order is the same request. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export class IdempotentReplayStore {
  private readonly inFlight = new Set<string>();
  private lastSweepAt = 0;

  constructor(
    private readonly directory: string,
    private readonly retentionMs: number = IDEMPOTENT_REPLAY_RETENTION_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** A key the caller sent, or the refusal for one that is not usable. */
  static readKey(raw: unknown): string | ReplayableAnswer | undefined {
    if (raw === undefined || raw === null) return undefined;
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!isOperationKey(key)) {
      return refusal(400, 'INVALID_ARGUMENT', `Idempotency-Key must be ${OPERATION_KEY_RULE}. Nothing was done.`, { field: 'Idempotency-Key' });
    }
    return key;
  }

  /**
   * Run `execute` once per key: the first request runs, a repeat is answered
   * from what the first answered. `replayed` says which happened.
   */
  async run(input: IdempotentReplayRequest, execute: () => Promise<ReplayableAnswer>): Promise<ReplayableAnswer & { readonly replayed: boolean }> {
    const id = createHash('sha256').update(`${input.principalId}\u0000${input.methodId}\u0000${input.key}`).digest('hex');
    const fingerprint = createHash('sha256').update(canonical(input.request)).digest('hex');
    const file = join(this.directory, `${id}.json`);
    const kept = this.read(file);
    if (kept) {
      if (kept.fingerprint !== fingerprint) {
        return { ...refusal(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request. Nothing was done; use a new key for a new request.'), replayed: false };
      }
      if (kept.state === 'running') {
        return this.inFlight.has(id)
          ? { ...refusal(409, 'IDEMPOTENCY_KEY_IN_FLIGHT', 'The first request under this Idempotency-Key is still running. Nothing was done twice; send it again in a moment for its answer.', { recoverable: true, retryAfterMs: IN_FLIGHT_RETRY_AFTER_MS }), headers: IN_FLIGHT_HEADERS, replayed: false }
          : { ...refusal(409, 'IDEMPOTENCY_OUTCOME_UNKNOWN', 'The first request under this Idempotency-Key was taken, but the daemon stopped before it answered, so whether it acted is unknown. Nothing was done again; check the state before sending a new request.', { recoverable: false }), replayed: false };
      }
      if (kept.bodyWithheld) {
        return { ...refusal(409, 'IDEMPOTENCY_ANSWER_NOT_KEPT', `The first request under this Idempotency-Key was done (HTTP ${String(kept.status ?? 200)}), but its answer was too large to keep. Nothing was done again; read the result instead.`), replayed: true };
      }
      return { status: kept.status ?? 200, body: kept.body ?? null, ...(kept.headers ? { headers: kept.headers } : {}), replayed: true };
    }
    if (this.inFlight.has(id)) {
      return { ...refusal(409, 'IDEMPOTENCY_KEY_IN_FLIGHT', 'The first request under this Idempotency-Key is still running; send it again in a moment for its answer.', { recoverable: true, retryAfterMs: IN_FLIGHT_RETRY_AFTER_MS }), headers: IN_FLIGHT_HEADERS, replayed: false };
    }
    this.inFlight.add(id);
    try {
      this.sweep();
      this.write(file, { fingerprint, state: 'running', at: this.now() });
      let answer: ReplayableAnswer;
      try {
        answer = await execute();
      } catch (error) {
        // A throw before an answer is an unknown outcome while the daemon is up: the key says so to every repeat.
        try {
          this.write(file, { fingerprint, state: 'done', at: this.now(), status: FAILED_PARTWAY.status, body: FAILED_PARTWAY.body });
        } catch (writeError) {
          logger.warn('[idempotent-replay] the outcome of a request that failed partway could not be kept', { error: summarizeError(writeError) });
        }
        throw error;
      }
      if (answer.status >= 400 && answer.status < 500) {
        // A refusal changed nothing: the key is free for the corrected request.
        this.remove(file);
      } else {
        const serialized = JSON.stringify(answer.body ?? null);
        const headers = answer.headers && Object.keys(answer.headers).length > 0 ? { headers: answer.headers } : {};
        this.write(file, Buffer.byteLength(serialized) > MAX_KEPT_BODY_BYTES
          ? { fingerprint, state: 'done', at: this.now(), status: answer.status, bodyWithheld: true, ...headers }
          : { fingerprint, state: 'done', at: this.now(), status: answer.status, body: answer.body, ...headers });
      }
      return { ...answer, replayed: false };
    } finally {
      this.inFlight.delete(id);
    }
  }

  /**
   * Write a request body to a file beside the keys as it arrives, a chunk at a
   * time. Stops reading (and says `oversize`) past `maxBytes`. The caller
   * removes the file with `remove`.
   */
  async spoolBody(body: ReadableStream<Uint8Array>, maxBytes: number | undefined): Promise<{ readonly path: string; readonly oversize: boolean; remove(): void }> {
    const directory = join(this.directory, 'spool');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${randomUUID()}.body`);
    const remove = (): void => { try { unlinkSync(path); } catch { /* absent is removed */ } };
    const handle = await open(path, 'wx', 0o600);
    const reader = body.getReader();
    let written = 0;
    let oversize = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        written += value.byteLength;
        if (maxBytes !== undefined && written > maxBytes) {
          oversize = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
        await handle.write(value);
      }
    } catch (error) {
      await handle.close().catch(() => undefined);
      remove();
      throw error;
    } finally {
      try { reader.releaseLock(); } catch { /* released by cancel */ }
    }
    await handle.close();
    return { path, oversize, remove };
  }

  private read(file: string): KeptEntry | null {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as KeptEntry;
      if (!parsed || typeof parsed.fingerprint !== 'string' || typeof parsed.at !== 'number') return null;
      return this.now() - parsed.at > this.retentionMs ? null : parsed;
    } catch {
      return null;
    }
  }

  private write(file: string, entry: KeptEntry): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    writeJsonFileAtomic(file, entry, { durable: true, mode: 0o600, indent: null });
  }

  private remove(file: string): void {
    try { unlinkSync(file); } catch { /* absent is removed */ }
  }

  /** Remove keys past their retention, at most once an hour. */
  private sweep(): void {
    const at = this.now();
    if (at - this.lastSweepAt < 60 * 60_000) return;
    this.lastSweepAt = at;
    // A body spooled for a call the daemon did not live to finish.
    const spool = join(this.directory, 'spool');
    let spooled: string[] = [];
    try { spooled = readdirSync(spool); } catch { /* no spool yet */ }
    for (const name of spooled) {
      const file = join(spool, name);
      try { if (at - statSync(file).mtimeMs > 60 * 60_000) unlinkSync(file); } catch { /* removed meanwhile */ }
    }
    let names: string[];
    try { names = readdirSync(this.directory); } catch { return; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = join(this.directory, name);
      try {
        if (at - statSync(file).mtimeMs > this.retentionMs) unlinkSync(file);
      } catch (error) {
        logger.debug('[idempotent-replay] a retired key could not be removed', { file, error: summarizeError(error) });
      }
    }
  }
}

/** Whether a method takes the shared `Idempotency-Key` (and so this store answers its repeats). */
export function takesIdempotencyKey(descriptor: { readonly replay?: ContractReplayKey | undefined } | null | undefined): boolean {
  return descriptor?.replay === IDEMPOTENCY_KEY_REPLAY;
}

/**
 * One keyed REST request, start to answer: the request's method, path and body
 * are what make a repeat the same request. A JSON answer is kept; a replayed
 * answer carries `Idempotent-Replayed: true`.
 *
 * An upload (a multipart or raw body, not JSON) is the same request when its
 * fields and its file's content are the same, however it is encoded: a client
 * that re-encodes the same file with another multipart boundary gets the first
 * answer. Its body is spooled to a file beside the keys as it arrives (never
 * held in memory twice), described from that file (fields plus a SHA-256 of
 * the file part), and the route reads it back from that file; the spool is
 * removed when the call ends.
 */
export async function replayKeyedRequest(
  store: IdempotentReplayStore,
  input: {
    readonly principalId: string;
    readonly methodId: string;
    readonly key: string;
    readonly req: Request;
    /** The largest file an upload route accepts; an upload over it is refused before anything runs. */
    readonly uploadMaxBytes?: number | undefined;
    /** The same request with its body replaced, keeping what the listener bound to the original. */
    readonly withBody: (from: Request, body: ReadableStream<Uint8Array>) => Request;
  },
  dispatch: (req: Request) => Promise<Response>,
): Promise<Response> {
  const url = new URL(input.req.url);
  const run = async (request: unknown, served: () => Request): Promise<Response> => {
    const answer = await store.run({ principalId: input.principalId, methodId: input.methodId, key: input.key, request }, async () => {
      const response = await dispatch(served());
      const text = await response.text();
      let body: unknown = text;
      try { body = text ? JSON.parse(text) : null; } catch { /* a non-JSON answer is kept as text */ }
      const headers: Record<string, string> = {};
      for (const name of KEPT_ANSWER_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      return { status: response.status, body, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
    });
    return Response.json(answer.body, {
      status: answer.status,
      headers: { ...answer.headers, ...(answer.replayed ? { 'Idempotent-Replayed': 'true' } : {}) },
    });
  };
  if (!input.req.body || !isArtifactUploadRequest(input.req)) {
    const bodyText = input.req.body ? await input.req.clone().text() : '';
    return run({ method: input.req.method, path: url.pathname, query: url.search, body: bodyText }, () => input.req);
  }
  const spool = await store.spoolBody(input.req.body, input.uploadMaxBytes === undefined ? undefined : input.uploadMaxBytes + MAX_UPLOAD_BODY_OVERHEAD_BYTES);
  try {
    if (spool.oversize) {
      return Response.json({ error: `Artifact exceeds the ${String(input.uploadMaxBytes)}-byte limit.`, code: 'ARTIFACT_UPLOAD_TOO_LARGE', status: 413 }, { status: 413 });
    }
    const fromSpool = (): Request => input.withBody(input.req, readSpool(spool.path));
    let upload: ArtifactUploadDescription;
    try {
      upload = await describeArtifactUpload(fromSpool(), input.uploadMaxBytes);
    } catch {
      // A body the upload routes cannot read is refused by them, and a refusal keeps no key.
      return await dispatch(fromSpool());
    }
    const contentType = (input.req.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    return await run({
      method: input.req.method, path: url.pathname, query: url.search, contentType, upload,
    }, fromSpool);
  } finally {
    spool.remove();
  }
}

/** Multipart framing and fields around the file part, as the upload routes allow it. */
const MAX_UPLOAD_BODY_OVERHEAD_BYTES = 1024 * 1024;

function readSpool(path: string): ReadableStream<Uint8Array> {
  return Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>;
}
