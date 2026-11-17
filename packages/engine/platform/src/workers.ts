/**
 * The GoodVibes Cloudflare Worker: the one implementation.
 *
 * `createGoodVibesCloudflareWorker` is the entry for a Worker deployed by hand,
 * and `buildGoodVibesCloudflareWorkerModule` turns the same code into the module
 * text platform provisioning uploads. The whole runtime lives in
 * `goodVibesWorkerRuntime` so that one function's source is a complete Worker:
 * it may use only Worker globals (fetch, Request, Response, Headers, URL,
 * crypto, TextEncoder, TextDecoder, console), never an import or a value from
 * this file outside it.
 */

export interface GoodVibesCloudflareQueue<Body = unknown> {
  send(message: Body): Promise<void>;
}

export interface GoodVibesCloudflareQueueMessage<Body = unknown> {
  readonly body: Body;
  /** Delivery attempt, 1 on the first delivery. */
  readonly attempts?: number | undefined;
  ack?(): void;
  retry?(): void;
}

export interface GoodVibesCloudflareMessageBatch<Body = unknown> {
  readonly messages: readonly GoodVibesCloudflareQueueMessage<Body>[];
}

export interface GoodVibesCloudflareExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** The slice of a KV namespace binding the Worker uses (queued-job status records). */
export interface GoodVibesCloudflareKvNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { readonly expirationTtl?: number }): Promise<void>;
}

/** The slice of an R2 bucket binding the Worker uses (job bodies kept out of the queue). */
export interface GoodVibesCloudflareR2Bucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string): Promise<unknown>;
  delete(key: string): Promise<void>;
}

/** A Secrets Store binding: the secret is read with `get()`. */
export interface GoodVibesCloudflareSecretBinding {
  get(): Promise<string | null | undefined>;
}

/** The slice of a Durable Object namespace binding the Worker uses (the queue budget counter). */
export interface GoodVibesCloudflareDurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(url: string, init?: RequestInit): Promise<Response> };
}

/** The slice of Durable Object state the coordinator uses. */
export interface GoodVibesCloudflareDurableObjectState {
  readonly storage: {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
  };
}

export interface GoodVibesCloudflareWorkerEnv {
  GOODVIBES_DAEMON_URL?: string | undefined;
  /** `true` allows an `http:` daemon URL. */
  GOODVIBES_ALLOW_INSECURE_DAEMON_URL?: string | undefined;
  /** `true` allows a private, loopback or link-local daemon host (a deliberate tunnel or private network). */
  GOODVIBES_ALLOW_PRIVATE_DAEMON_URL?: string | undefined;
  GOODVIBES_OPERATOR_TOKEN?: string | undefined;
  /** Secrets Store binding for the operator token; read before `GOODVIBES_OPERATOR_TOKEN`. */
  GOODVIBES_OPERATOR_TOKEN_STORE?: GoodVibesCloudflareSecretBinding | undefined;
  GOODVIBES_WORKER_TOKEN?: string | undefined;
  GOODVIBES_QUEUE_JOB_PAYLOADS?: string | undefined;
  /** `true` keeps job bodies out of the queue: they go to R2 and the queue carries only the key. */
  GOODVIBES_FREE_TIER_MODE?: string | undefined;
  /** The daemon's `batch.maxQueuePayloadBytes`; provisioning sets it. */
  GOODVIBES_MAX_QUEUE_PAYLOAD_BYTES?: string | undefined;
  GOODVIBES_MAX_QUEUE_OPS_PER_DAY?: string | undefined;
  GOODVIBES_MAX_QUEUE_MESSAGES_PER_DAY?: string | undefined;
  /** Cloudflare Access service token, sent to the daemon when its hostname is behind Access. */
  GOODVIBES_ACCESS_CLIENT_ID?: string | undefined;
  GOODVIBES_ACCESS_CLIENT_SECRET?: string | undefined;
  GOODVIBES_ACCESS_CLIENT_SECRET_STORE?: GoodVibesCloudflareSecretBinding | undefined;
  GOODVIBES_BATCH_QUEUE?: GoodVibesCloudflareQueue<GoodVibesCloudflareQueuePayload> | undefined;
  GOODVIBES_KV?: GoodVibesCloudflareKvNamespace | undefined;
  GOODVIBES_ARTIFACTS?: GoodVibesCloudflareR2Bucket | undefined;
  GOODVIBES_COORDINATOR?: GoodVibesCloudflareDurableObjectNamespace | undefined;
}

export type GoodVibesCloudflareQueuePayload =
  | {
      readonly type: 'batch.tick';
      readonly force?: boolean | undefined;
      readonly enqueuedAt?: number | undefined;
    }
  | {
      readonly type: 'batch.job.create';
      /** The job body, when it travels in the queue message. */
      readonly body?: Record<string, unknown> | undefined;
      /** The R2 key of the job body, when it was kept out of the queue. */
      readonly payloadKey?: string | undefined;
      /** Stable id minted when the job is queued; every redelivery sends the same one as `source.id` unless the body names its own `id`. */
      readonly jobId?: string | undefined;
      readonly enqueuedAt?: number | undefined;
    };

export interface GoodVibesCloudflareWorkerOptions {
  readonly daemonUrl?: string | undefined;
  readonly authToken?: string | undefined;
  readonly workerAuthToken?: string | undefined;
  readonly queueJobPayloads?: boolean | undefined;
  /**
   * Explicitly allow unauthenticated non-health endpoints.
   * Default is false: GOODVIBES_WORKER_TOKEN or workerAuthToken is required.
   */
  readonly allowUnauthenticated?: boolean | undefined;
  /** Largest request body the Worker reads. Default: the daemon's batch request limit, 4 MiB. */
  readonly maxRequestBodyBytes?: number | undefined;
  /**
   * Largest job body that travels in a queue message. Default: GOODVIBES_MAX_QUEUE_PAYLOAD_BYTES,
   * else 16 KiB (the daemon's default `batch.maxQueuePayloadBytes`). Keep it equal to the daemon's setting.
   */
  readonly maxQueuePayloadBytes?: number | undefined;
}

export interface GoodVibesCloudflareWorker {
  fetch(request: Request, env: GoodVibesCloudflareWorkerEnv, ctx?: GoodVibesCloudflareExecutionContext): Promise<Response>;
  queue(batch: GoodVibesCloudflareMessageBatch<GoodVibesCloudflareQueuePayload>, env: GoodVibesCloudflareWorkerEnv, ctx?: GoodVibesCloudflareExecutionContext): Promise<void>;
  scheduled(event: unknown, env: GoodVibesCloudflareWorkerEnv, ctx?: GoodVibesCloudflareExecutionContext): Promise<void>;
}

/** The Durable Object class that counts the daily queue budget. */
export interface GoodVibesCoordinatorInstance {
  fetch(request: Request): Promise<Response>;
}

export type GoodVibesCoordinatorClass = new (
  state: GoodVibesCloudflareDurableObjectState,
  env?: unknown,
) => GoodVibesCoordinatorInstance;

interface GoodVibesWorkerRuntime {
  readonly createWorker: (options?: GoodVibesCloudflareWorkerOptions) => GoodVibesCloudflareWorker;
  readonly GoodVibesCoordinator: GoodVibesCoordinatorClass;
}

type DaemonUrlResolution = { readonly baseUrl: string } | { readonly refusal: Response };
type BudgetAnswer = {
  readonly allowed: boolean;
  readonly unmetered?: boolean;
  readonly used?: { readonly ops: number; readonly messages: number };
  readonly limits?: { readonly ops: number; readonly messages: number };
  readonly resetsAt?: number;
  /** What this reservation charged to the coordinator's counter; released when nothing was queued. */
  readonly reserved?: { readonly ops: number; readonly messages: number };
};

// Everything the Worker runs. Its source text is the deployed module, so
// nothing inside may reach outside this function (see the file header).
function goodVibesWorkerRuntime(): GoodVibesWorkerRuntime {
  const JOB_RECORD_TTL_SECONDS = 7 * 24 * 60 * 60;
  const QUEUE_OP_CHUNK_BYTES = 64 * 1024;
  // The daemon's batch request limit: a body the daemon accepts is never refused here for size.
  const DEFAULT_MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
  // The daemon's default `batch.maxQueuePayloadBytes`; provisioning passes the configured value.
  const DEFAULT_MAX_QUEUE_PAYLOAD_BYTES = 16 * 1024;

  // CORS is intentionally absent: the Worker serves server-to-server calls.
  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /** `1` and `true` (any case) are on; anything else is off, so a typo never turns a switch on. */
  function envFlag(value: unknown): boolean {
    const normalized = String(value == null ? '' : value).trim().toLowerCase();
    return normalized === '1' || normalized === 'true';
  }

  function envNumber(value: unknown): number {
    const parsed = Number(String(value == null ? '' : value).trim());
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  }

  function toRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  function utf8Bytes(text: string): number {
    return new TextEncoder().encode(text).byteLength;
  }

  /** The body as text, refused with 413 past `maxBytes` before more of it is read. */
  async function readBody(request: Request, maxBytes: number): Promise<string | Response> {
    const tooLarge = () => json({
      error: `The request body is larger than the ${maxBytes} byte limit`,
      code: 'PAYLOAD_TOO_LARGE',
      next: ['Send a smaller body, or split the job'],
    }, 413);
    const contentLength = Number.parseInt(request.headers.get('content-length') ?? '0', 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) return tooLarge();
    if (!request.body) return '';
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let text = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel('Payload too large').catch(() => undefined);
          return tooLarge();
        }
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }

  /** An empty body is `{}`; text that is not JSON is refused with 400. */
  function parseJsonBody(text: string): unknown {
    if (!text.trim()) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return json({ error: 'The request body is not valid JSON', code: 'INVALID_JSON' }, 400);
    }
  }

  function isPrivateDaemonHost(hostname: string): boolean {
    const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    // The IPv6 unique-local and link-local prefixes only mean something in an IPv6
    // literal; a DNS name that merely starts with fc or fd is an ordinary host.
    if (host === '::1' || (host.includes(':') && (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')))) return true;
    const parts = host.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [a = -1, b = -1] = parts;
    return a === 10
      || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)
      || a === 0;
  }

  // The operator token is attached to every proxied call, so the daemon URL must
  // be https and public unless the deployment says otherwise.
  function resolveDaemonUrl(env: GoodVibesCloudflareWorkerEnv, options: GoodVibesCloudflareWorkerOptions): DaemonUrlResolution {
    const raw = String(options.daemonUrl ?? env.GOODVIBES_DAEMON_URL ?? '').trim();
    if (!raw) {
      return { refusal: json({ error: 'GOODVIBES_DAEMON_URL is not configured', code: 'DAEMON_URL_REQUIRED', next: ['Set GOODVIBES_DAEMON_URL, or provision the Worker again'] }, 503) };
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { refusal: json({ error: 'GOODVIBES_DAEMON_URL is not a valid URL', code: 'DAEMON_URL_INVALID' }, 400) };
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && envFlag(env.GOODVIBES_ALLOW_INSECURE_DAEMON_URL))) {
      return { refusal: json({ error: 'GOODVIBES_DAEMON_URL must use https unless GOODVIBES_ALLOW_INSECURE_DAEMON_URL=true', code: 'DAEMON_URL_INSECURE' }, 400) };
    }
    if (!envFlag(env.GOODVIBES_ALLOW_PRIVATE_DAEMON_URL) && isPrivateDaemonHost(url.hostname)) {
      return { refusal: json({ error: 'GOODVIBES_DAEMON_URL targets a private, loopback, or link-local host. Set GOODVIBES_ALLOW_PRIVATE_DAEMON_URL=true only for an intentional tunnel/private deployment.', code: 'DAEMON_URL_PRIVATE_HOST' }, 403) };
    }
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return { baseUrl: url.toString().replace(/\/+$/, '') };
  }

  function toDaemonBatchPath(pathname: string): string | null {
    if (pathname.startsWith('/api/batch')) return pathname;
    if (pathname.startsWith('/batch/')) return `/api${pathname}`;
    if (pathname === '/batch') return '/api/batch';
    return null;
  }

  /** Constant-time comparison that does not reveal the expected token's length early. */
  function constantTimeEqual(a: string, b: string): boolean {
    let diff = a.length ^ b.length;
    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index++) {
      diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
    }
    return diff === 0;
  }

  function requireWorkerAuth(request: Request, env: GoodVibesCloudflareWorkerEnv, options: GoodVibesCloudflareWorkerOptions): Response | null {
    const expected = String(options.workerAuthToken ?? env.GOODVIBES_WORKER_TOKEN ?? '');
    // allowUnauthenticated opens the whole Worker; only for one behind another trusted auth layer.
    if (!expected && options.allowUnauthenticated === true) return null;
    // No token means no way to tell the daemon's callers from anyone else, and
    // this Worker attaches the operator credential to what it proxies.
    if (!expected) {
      return json({
        error: 'GOODVIBES_WORKER_TOKEN is not configured on this Worker',
        code: 'WORKER_AUTH_NOT_CONFIGURED',
        next: ['Provision the Worker again to set the client token', 'Or set the GOODVIBES_WORKER_TOKEN secret by hand'],
      }, 503);
    }
    const auth = request.headers.get('authorization') ?? '';
    if (constantTimeEqual(auth, `Bearer ${expected}`)) return null;
    return json({ error: 'Worker authorization required', code: 'WORKER_AUTH_REQUIRED' }, 401);
  }

  // A Secrets Store binding is read with get(); a script secret is a plain string.
  async function readSecret(binding: GoodVibesCloudflareSecretBinding | undefined, plain: string | undefined): Promise<string> {
    if (binding && typeof binding.get === 'function') {
      try {
        const value = await binding.get();
        if (value) return String(value);
      } catch {
        // fall back to the script secret
      }
    }
    return String(plain ?? '');
  }

  async function proxyDaemonJson(
    env: GoodVibesCloudflareWorkerEnv,
    options: GoodVibesCloudflareWorkerOptions,
    path: string,
    init: { readonly method: string; readonly body?: string | undefined; readonly search?: string | undefined },
  ): Promise<Response> {
    const daemon = resolveDaemonUrl(env, options);
    if ('refusal' in daemon) return daemon.refusal;
    const headers = new Headers();
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    const token = options.authToken ?? await readSecret(env.GOODVIBES_OPERATOR_TOKEN_STORE, env.GOODVIBES_OPERATOR_TOKEN);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    // The daemon hostname may sit behind a Cloudflare Access application whose
    // only policy admits this service token.
    const accessId = String(env.GOODVIBES_ACCESS_CLIENT_ID ?? '');
    const accessSecret = accessId ? await readSecret(env.GOODVIBES_ACCESS_CLIENT_SECRET_STORE, env.GOODVIBES_ACCESS_CLIENT_SECRET) : '';
    if (accessId && accessSecret) {
      headers.set('CF-Access-Client-Id', accessId);
      headers.set('CF-Access-Client-Secret', accessSecret);
    }
    return fetch(`${daemon.baseUrl}${path}${init.search ?? ''}`, {
      method: init.method,
      headers,
      body: init.body ?? null,
    });
  }

  function isRetryableStatus(status: number): boolean {
    // 401 and 403 are retried too: an operator who rotates the daemon token fixes them, and acking would lose the job.
    return status === 408 || status === 429 || status === 401 || status === 403 || status >= 500;
  }

  function utcDay(now: number): string {
    return new Date(now).toISOString().slice(0, 10);
  }

  function nextUtcMidnight(now: number): number {
    const date = new Date(now);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  }

  function queueOpsFor(bytes: number): number {
    // One write per 64 KB, one read and one delete per delivered message.
    return Math.max(1, Math.ceil(bytes / QUEUE_OP_CHUNK_BYTES)) + 2;
  }

  // The daily queue budget is counted in the coordinator Durable Object: one
  // instance per Worker, so concurrent requests see one counter.
  async function coordinatorCall(env: GoodVibesCloudflareWorkerEnv, path: string, body: unknown): Promise<Record<string, unknown> | null> {
    const namespace = env.GOODVIBES_COORDINATOR;
    if (!namespace) return null;
    const stub = namespace.get(namespace.idFromName('queue-budget'));
    const response = await stub.fetch(`https://coordinator${path}`, { method: 'POST', body: JSON.stringify(body) });
    return toRecord(await response.json());
  }

  async function reserveQueue(env: GoodVibesCloudflareWorkerEnv, bytes: number): Promise<BudgetAnswer> {
    const limits = {
      ops: envNumber(env.GOODVIBES_MAX_QUEUE_OPS_PER_DAY),
      messages: envNumber(env.GOODVIBES_MAX_QUEUE_MESSAGES_PER_DAY),
    };
    if (limits.ops === 0 && limits.messages === 0) return { allowed: true };
    const reserved = { ops: queueOpsFor(bytes), messages: 1 };
    const answer = await coordinatorCall(env, '/budget/reserve', { ...reserved, limits });
    if (!answer) return { allowed: true, unmetered: true };
    return answer['allowed'] === true ? { ...(answer as BudgetAnswer), reserved } : answer as BudgetAnswer;
  }

  /** Gives back a reservation for a message that was never queued. */
  async function releaseQueue(env: GoodVibesCloudflareWorkerEnv, answer: BudgetAnswer): Promise<boolean> {
    if (!answer.reserved) return true;
    const released = await coordinatorCall(env, '/budget/release', answer.reserved).catch(() => null);
    return released !== null;
  }

  /**
   * Puts the R2 body (when there is one) and sends the queue message. When
   * either step fails nothing is left behind: the R2 body is deleted, the
   * budget reservation is given back, and the caller is told nothing was queued.
   */
  async function sendQueued(
    env: GoodVibesCloudflareWorkerEnv,
    queue: GoodVibesCloudflareQueue<GoodVibesCloudflareQueuePayload>,
    message: GoodVibesCloudflareQueuePayload,
    budget: BudgetAnswer,
    r2Body?: { readonly key: string; readonly text: string; readonly bucket: GoodVibesCloudflareR2Bucket },
  ): Promise<Response | null> {
    let step = r2Body ? 'store the job body in R2' : 'send the queue message';
    try {
      if (r2Body) await r2Body.bucket.put(r2Body.key, r2Body.text);
      step = 'send the queue message';
      await queue.send(message);
      return null;
    } catch (error) {
      if (r2Body) await r2Body.bucket.delete(r2Body.key).catch(() => undefined);
      const released = await releaseQueue(env, budget);
      console.warn('GoodVibes worker could not queue a message', { step, error: String(error) });
      return json({
        error: `Nothing was queued: the Worker could not ${step} (${String(error)})`,
        code: 'QUEUE_SEND_FAILED',
        state: released
          ? 'nothing was queued and the daily queue budget was not charged'
          : 'nothing was queued; the daily queue budget reservation could not be given back and stays counted until midnight UTC',
        next: [
          'Send the request again',
          'Post /batch/jobs to send the job straight to the daemon without the queue',
          'Check the queue and R2 bindings in the Cloudflare dashboard',
        ],
      }, 503);
    }
  }

  function budgetRefusal(answer: BudgetAnswer): Response {
    const used = answer.used ?? { ops: 0, messages: 0 };
    const limits = answer.limits ?? { ops: 0, messages: 0 };
    const resetsAt = answer.resetsAt ?? 0;
    return json({
      error: 'The daily Cloudflare queue budget is used up',
      code: 'QUEUE_BUDGET_EXHAUSTED',
      state: `used ${used.ops} of ${limits.ops || 'unlimited'} queue operations and ${used.messages} of ${limits.messages || 'unlimited'} messages today (UTC)`,
      next: [
        'Post /batch/jobs to send the job straight to the daemon without the queue',
        `Wait until ${new Date(resetsAt).toISOString()} when the budget resets`,
        'Raise cloudflare.maxQueueOpsPerDay or batch.maxQueueMessagesPerDay and provision again',
      ],
      resetsAt,
    }, 429);
  }

  async function kvPut(env: GoodVibesCloudflareWorkerEnv, key: string, value: unknown): Promise<void> {
    if (!env.GOODVIBES_KV) return;
    try {
      await env.GOODVIBES_KV.put(key, JSON.stringify(value), { expirationTtl: JOB_RECORD_TTL_SECONDS });
    } catch {
      // The status record is a convenience; a full KV write quota must not lose the job.
    }
  }

  async function kvGet(env: GoodVibesCloudflareWorkerEnv, key: string): Promise<Record<string, unknown> | null> {
    if (!env.GOODVIBES_KV) return null;
    try {
      const text = await env.GOODVIBES_KV.get(key);
      return text ? toRecord(JSON.parse(text)) : null;
    } catch {
      return null;
    }
  }

  function payloadKey(jobId: string): string {
    return `batch-payloads/${jobId}.json`;
  }

  /** The id the daemon files the job under (`source.id`): the body's own `id`, else the minted one. */
  function sourceIdFor(body: Record<string, unknown>, jobId: string): string {
    return typeof body['id'] === 'string' && body['id'] ? body['id'] : jobId;
  }

  /** Exactly the body the daemon receives for a queued job; its size is what the daemon's queue limit measures. */
  function daemonJobBody(body: Record<string, unknown>, jobId: string, viaR2: boolean): Record<string, unknown> {
    return {
      ...body,
      // The daemon's queue-size limit is for bodies that travelled in the queue.
      ...(viaR2 ? { metadata: { ...toRecord(body['metadata']), 'goodvibes.payload': 'r2' } } : {}),
      source: { kind: 'cloudflare-queue', id: sourceIdFor(body, jobId) },
    };
  }

  async function readJobBody(env: GoodVibesCloudflareWorkerEnv, payload: { readonly body?: unknown; readonly payloadKey?: unknown }): Promise<Record<string, unknown> | null> {
    if (typeof payload.payloadKey !== 'string' || !payload.payloadKey) return toRecord(payload.body);
    if (!env.GOODVIBES_ARTIFACTS) throw new Error('GOODVIBES_ARTIFACTS is not bound');
    const object = await env.GOODVIBES_ARTIFACTS.get(payload.payloadKey);
    if (!object) return null;
    return toRecord(JSON.parse(await object.text()));
  }

  async function handleQueuePayload(
    payload: Record<string, unknown>,
    env: GoodVibesCloudflareWorkerEnv,
    options: GoodVibesCloudflareWorkerOptions,
  ): Promise<Response> {
    if (payload['type'] === 'batch.tick') {
      return proxyDaemonJson(env, options, '/api/batch/tick', {
        method: 'POST',
        body: JSON.stringify({ force: payload['force'] === true }),
      });
    }
    const body = await readJobBody(env, payload);
    if (body === null) return json({ error: 'The queued job body is no longer in R2', code: 'PAYLOAD_MISSING' }, 410);
    const viaR2 = typeof payload['payloadKey'] === 'string' && payload['payloadKey'] !== '';
    return proxyDaemonJson(env, options, '/api/batch/jobs', {
      method: 'POST',
      body: JSON.stringify(daemonJobBody(body, String(payload['jobId'] ?? ''), viaR2)),
    });
  }

  async function enqueueTick(request: Request, env: GoodVibesCloudflareWorkerEnv, maxRequestBodyBytes: number): Promise<Response> {
    const queue = env.GOODVIBES_BATCH_QUEUE;
    if (!queue) return json({ error: 'GOODVIBES_BATCH_QUEUE is not bound', code: 'QUEUE_NOT_CONFIGURED' }, 503);
    const text = await readBody(request, maxRequestBodyBytes);
    if (text instanceof Response) return text;
    const body = parseJsonBody(text);
    if (body instanceof Response) return body;
    const message = { type: 'batch.tick' as const, force: toRecord(body)['force'] === true, enqueuedAt: Date.now() };
    const budget = await reserveQueue(env, utf8Bytes(JSON.stringify(message)));
    if (!budget.allowed) return budgetRefusal(budget);
    const failed = await sendQueued(env, queue, message, budget);
    if (failed) return failed;
    return json({ queued: true }, 202);
  }

  async function enqueueJob(
    request: Request,
    env: GoodVibesCloudflareWorkerEnv,
    options: GoodVibesCloudflareWorkerOptions,
    maxRequestBodyBytes: number,
  ): Promise<Response> {
    const queue = env.GOODVIBES_BATCH_QUEUE;
    if (!queue) return json({ error: 'GOODVIBES_BATCH_QUEUE is not bound', code: 'QUEUE_NOT_CONFIGURED' }, 503);
    const text = await readBody(request, maxRequestBodyBytes);
    if (text instanceof Response) return text;
    const parsed = parseJsonBody(text);
    if (parsed instanceof Response) return parsed;
    const body = toRecord(parsed);
    const jobId = crypto.randomUUID();
    const maxQueueBytes = options.maxQueuePayloadBytes ?? (envNumber(env.GOODVIBES_MAX_QUEUE_PAYLOAD_BYTES) || DEFAULT_MAX_QUEUE_PAYLOAD_BYTES);
    // Measured as the daemon will measure it, so a job accepted here is never
    // refused by the daemon for size after the caller was told it is queued.
    const bodyBytes = utf8Bytes(JSON.stringify(daemonJobBody(body, jobId, false)));
    const freeTier = envFlag(env.GOODVIBES_FREE_TIER_MODE);
    const artifacts = env.GOODVIBES_ARTIFACTS;
    // Free-tier mode keeps job bodies out of the queue: the body goes to R2 and
    // the queue carries only its key. Without free-tier mode a body that fits
    // the queue limit travels in the message.
    const useR2 = artifacts !== undefined && (freeTier || bodyBytes > maxQueueBytes);
    if (!useR2 && freeTier) {
      return json({
        error: 'Free-tier mode keeps job bodies out of the queue and no R2 bucket is bound to hold them',
        code: 'QUEUE_PAYLOADS_NEED_R2',
        next: ['Post /batch/jobs to send the job straight to the daemon', 'Provision the r2 component', 'Turn cloudflare.freeTierMode off and provision again'],
      }, 409);
    }
    if (!useR2 && bodyBytes > maxQueueBytes) {
      return json({
        error: `The job body is ${bodyBytes} bytes, above the daemon's ${maxQueueBytes} byte queue message limit`,
        code: 'QUEUE_PAYLOAD_TOO_LARGE',
        next: ['Post /batch/jobs to send the job straight to the daemon', 'Provision the r2 component so large bodies are kept in R2'],
      }, 413);
    }
    const enqueuedAt = Date.now();
    const message: GoodVibesCloudflareQueuePayload = useR2
      ? { type: 'batch.job.create', jobId, payloadKey: payloadKey(jobId), enqueuedAt }
      : { type: 'batch.job.create', body, jobId, enqueuedAt };
    const budget = await reserveQueue(env, utf8Bytes(JSON.stringify(message)));
    if (!budget.allowed) return budgetRefusal(budget);
    const failed = await sendQueued(env, queue, message, budget,
      useR2 && artifacts ? { key: payloadKey(jobId), text: JSON.stringify(body), bucket: artifacts } : undefined);
    if (failed) return failed;
    await kvPut(env, `job:${jobId}`, { state: 'queued', enqueuedAt, payload: useR2 ? 'r2' : 'queue' });
    return json({
      queued: true,
      jobId,
      // The daemon finds a delivered job by this id (404 until it is delivered).
      jobPath: `/batch/jobs/${encodeURIComponent(sourceIdFor(body, jobId))}`,
      ...(env.GOODVIBES_KV ? { statusPath: `/batch/queue/jobs/${jobId}` } : {}),
    }, 202);
  }

  class GoodVibesCoordinator implements GoodVibesCoordinatorInstance {
    readonly state: GoodVibesCloudflareDurableObjectState;

    constructor(state: GoodVibesCloudflareDurableObjectState, _env?: unknown) {
      this.state = state;
    }

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === '/health') {
        return json({ ok: true, service: 'goodvibes-cloudflare-coordinator' });
      }
      if (request.method === 'POST' && (url.pathname === '/budget/reserve' || url.pathname === '/budget/record')) {
        const parsed = parseJsonBody(await request.text());
        const body = parsed instanceof Response ? {} : toRecord(parsed);
        const now = Date.now();
        const day = utcDay(now);
        const stored = toRecord(await this.state.storage.get('budget'));
        const used = stored['day'] === day
          ? { ops: Number(stored['ops']) || 0, messages: Number(stored['messages']) || 0 }
          : { ops: 0, messages: 0 };
        const limits = toRecord(body['limits']);
        const limitOps = Math.max(0, Number(limits['ops']) || 0);
        const limitMessages = Math.max(0, Number(limits['messages']) || 0);
        const ops = Math.max(0, Math.floor(Number(body['ops']) || 0));
        const messages = Math.max(0, Math.floor(Number(body['messages']) || 0));
        const answer = { day, used, limits: { ops: limitOps, messages: limitMessages }, resetsAt: nextUtcMidnight(now) };
        if (url.pathname === '/budget/reserve'
          && ((limitOps > 0 && used.ops + ops > limitOps) || (limitMessages > 0 && used.messages + messages > limitMessages))) {
          return json({ allowed: false, ...answer });
        }
        const next = { day, ops: used.ops + ops, messages: used.messages + messages };
        await this.state.storage.put('budget', next);
        return json({ allowed: true, ...answer, used: { ops: next.ops, messages: next.messages } });
      }
      if (request.method === 'POST' && url.pathname === '/budget/release') {
        // A reservation for a message that was never queued is given back, never below zero.
        const parsed = parseJsonBody(await request.text());
        const body = parsed instanceof Response ? {} : toRecord(parsed);
        const day = utcDay(Date.now());
        const stored = toRecord(await this.state.storage.get('budget'));
        if (stored['day'] !== day) return json({ released: false, day });
        const ops = Math.max(0, Math.floor(Number(body['ops']) || 0));
        const messages = Math.max(0, Math.floor(Number(body['messages']) || 0));
        const next = {
          day,
          ops: Math.max(0, (Number(stored['ops']) || 0) - ops),
          messages: Math.max(0, (Number(stored['messages']) || 0) - messages),
        };
        await this.state.storage.put('budget', next);
        return json({ released: true, day, used: { ops: next.ops, messages: next.messages } });
      }
      if (request.method === 'GET' && url.pathname === '/budget') {
        const stored = toRecord(await this.state.storage.get('budget'));
        const day = utcDay(Date.now());
        return json(stored['day'] === day ? { day, ops: stored['ops'], messages: stored['messages'] } : { day, ops: 0, messages: 0 });
      }
      return json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
    }
  }

  function createWorker(options: GoodVibesCloudflareWorkerOptions = {}): GoodVibesCloudflareWorker {
    for (const [name, value] of [['maxRequestBodyBytes', options.maxRequestBodyBytes], ['maxQueuePayloadBytes', options.maxQueuePayloadBytes]] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new RangeError(`${name} must be a positive safe integer`);
      }
    }
    const maxRequestBodyBytes = options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
    return {
      async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname === '/health' || url.pathname === '/batch/health') {
          return json({ ok: true, service: 'goodvibes-cloudflare-worker' });
        }

        const authError = requireWorkerAuth(request, env, options);
        if (authError) return authError;

        if (url.pathname === '/batch/tick/enqueue' && request.method === 'POST') {
          return enqueueTick(request, env, maxRequestBodyBytes);
        }

        if (url.pathname === '/batch/queue/budget' && request.method === 'GET') {
          const namespace = env.GOODVIBES_COORDINATOR;
          if (!namespace) return json({ error: 'No coordinator is bound, so queue use is not counted', code: 'BUDGET_NOT_COUNTED' }, 404);
          const stub = namespace.get(namespace.idFromName('queue-budget'));
          const used = toRecord(await (await stub.fetch('https://coordinator/budget')).json());
          return json({
            ...used,
            limits: { ops: envNumber(env.GOODVIBES_MAX_QUEUE_OPS_PER_DAY), messages: envNumber(env.GOODVIBES_MAX_QUEUE_MESSAGES_PER_DAY) },
          });
        }

        if (url.pathname.startsWith('/batch/queue/jobs/') && request.method === 'GET') {
          if (!env.GOODVIBES_KV) return json({ error: 'No KV namespace is bound, so queued jobs are not tracked', code: 'JOB_STATUS_NOT_TRACKED', next: ['Read the job from the daemon at the jobPath the enqueue answer gave'] }, 404);
          const jobId = decodeURIComponent(url.pathname.slice('/batch/queue/jobs/'.length));
          const record = await kvGet(env, `job:${jobId}`);
          return record ? json({ jobId, ...record }) : json({ error: 'No queued job with that id is known', code: 'NOT_FOUND' }, 404);
        }

        const daemonPath = toDaemonBatchPath(url.pathname);
        if (!daemonPath) return json({ error: 'Not found', code: 'NOT_FOUND' }, 404);

        if (url.pathname === '/batch/jobs/enqueue' && request.method === 'POST') {
          if (!options.queueJobPayloads && !envFlag(env.GOODVIBES_QUEUE_JOB_PAYLOADS)) {
            return json({
              error: 'Queueing full batch job payloads is disabled',
              code: 'QUEUE_PAYLOADS_DISABLED',
              next: ['Post /batch/jobs to send the job straight to the daemon', 'Or turn on queueJobPayloads (GOODVIBES_QUEUE_JOB_PAYLOADS=true)'],
            }, 409);
          }
          return enqueueJob(request, env, options, maxRequestBodyBytes);
        }

        // The caller's Authorization header is not forwarded: it carries the
        // Worker token, and proxyDaemonJson attaches the daemon operator token.
        let body: string | undefined;
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          const contentType = request.headers.get('content-type') ?? '';
          if (contentType && !contentType.toLowerCase().includes('application/json')) {
            return json({ error: 'Only application/json batch payloads are supported', code: 'UNSUPPORTED_MEDIA_TYPE' }, 415);
          }
          const text = await readBody(request, maxRequestBodyBytes);
          if (text instanceof Response) return text;
          body = text;
        }
        return proxyDaemonJson(env, options, daemonPath, { method: request.method, body, search: url.search });
      },

      async queue(batch, env) {
        let redelivered = 0;
        for (const message of batch.messages) {
          try {
            const payload = toRecord(message.body);
            const type = payload['type'];
            if (type !== 'batch.tick' && type !== 'batch.job.create') {
              // A message of an unknown shape can never succeed; redelivering it only loops.
              console.warn('GoodVibes worker queue message dropped: unknown type', { type });
              message.ack?.();
              continue;
            }
            if ((message.attempts ?? 1) > 1) redelivered += 1;
            const jobId = type === 'batch.job.create' && typeof payload['jobId'] === 'string' ? payload['jobId'] : '';
            if (jobId) {
              const known = await kvGet(env, `job:${jobId}`);
              // Delivered before and the ack was lost: the daemon already has it.
              if (known && known['state'] === 'delivered') {
                message.ack?.();
                continue;
              }
            }
            const response = await handleQueuePayload(payload, env, options);
            if (response.ok) {
              if (jobId) {
                const created = toRecord(await response.json().catch(() => ({})));
                const daemonJob = toRecord(created['job'] ?? created);
                await kvPut(env, `job:${jobId}`, { state: 'delivered', daemonJobId: typeof daemonJob['id'] === 'string' ? daemonJob['id'] : undefined, deliveredAt: Date.now() });
                const key = payload['payloadKey'];
                if (typeof key === 'string' && key && env.GOODVIBES_ARTIFACTS) await env.GOODVIBES_ARTIFACTS.delete(key).catch(() => undefined);
              }
              message.ack?.();
            } else if (isRetryableStatus(response.status)) {
              message.retry?.();
            } else {
              // Any other 4xx (a bad body) fails the same way every time.
              const refusal = toRecord(await response.json().catch(() => ({})));
              const code = typeof refusal['code'] === 'string' ? refusal['code'] : undefined;
              console.warn('GoodVibes worker queue message rejected by the daemon', { status: response.status, code, jobId: jobId || undefined });
              if (jobId) await kvPut(env, `job:${jobId}`, { state: 'rejected', status: response.status, code, rejectedAt: Date.now() });
              message.ack?.();
            }
          } catch (error) {
            // Not re-thrown: retry() asks Cloudflare to deliver it again, toward the dead-letter queue.
            console.warn('GoodVibes worker queue message failed', { error: String(error) });
            message.retry?.();
          }
        }
        // Each redelivery is one more queue read against the daily budget.
        if (redelivered > 0) {
          await coordinatorCall(env, '/budget/record', { ops: redelivered, messages: 0 }).catch(() => undefined);
        }
      },

      async scheduled(_event, env) {
        const response = await proxyDaemonJson(env, options, '/api/batch/tick', {
          method: 'POST',
          body: JSON.stringify({ force: false }),
        });
        if (!response.ok) {
          // Thrown so a refused tick shows up as a failed cron invocation in Cloudflare.
          const excerpt = (await response.text().catch(() => '')).slice(0, 200);
          throw new Error(`GoodVibes batch tick was refused by the daemon with status ${response.status}${excerpt ? `: ${excerpt}` : ''}`);
        }
      },
    };
  }

  return { createWorker, GoodVibesCoordinator };
}

const runtime = goodVibesWorkerRuntime();

/**
 * Build the Worker for a manual deployment: `export default createGoodVibesCloudflareWorker()`.
 * Reads GOODVIBES_DAEMON_URL, GOODVIBES_OPERATOR_TOKEN and GOODVIBES_WORKER_TOKEN
 * (and the other GOODVIBES_* bindings) from the Worker environment.
 */
export function createGoodVibesCloudflareWorker(
  options: GoodVibesCloudflareWorkerOptions = {},
): GoodVibesCloudflareWorker {
  return runtime.createWorker(options);
}

/**
 * The Durable Object class that counts the daily queue budget. A manual
 * deployment that binds GOODVIBES_COORDINATOR exports it from its main module.
 */
export const GoodVibesCoordinator: GoodVibesCoordinatorClass = runtime.GoodVibesCoordinator;

/**
 * The ES module text of the Worker, as platform provisioning uploads it: the
 * runtime above, `GoodVibesCoordinator`, and `createGoodVibesCloudflareWorker()`
 * with every setting read from the Worker environment.
 */
export function buildGoodVibesCloudflareWorkerModule(): string {
  return [
    `const runtime = (${goodVibesWorkerRuntime.toString()})();`,
    'export const GoodVibesCoordinator = runtime.GoodVibesCoordinator;',
    'export default runtime.createWorker({});',
    '',
  ].join('\n');
}
