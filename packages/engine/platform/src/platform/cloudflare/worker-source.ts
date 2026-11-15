export const GOODVIBES_CLOUDFLARE_WORKER_MODULE = `
const JOB_RECORD_TTL_SECONDS = 7 * 24 * 60 * 60;
const QUEUE_OP_CHUNK_BYTES = 64 * 1024;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function envFlag(value) {
  const normalized = String(value == null ? '' : value).trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

function envNumber(value) {
  const parsed = Number(String(value == null ? '' : value).trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function toRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function optionalJson(request) {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { __goodvibesInvalidJson: true };
  }
}

function resolveDaemonUrl(env) {
  const raw = String(env.GOODVIBES_DAEMON_URL || '').trim();
  if (!raw) return { error: 'GOODVIBES_DAEMON_URL is not configured', code: 'DAEMON_URL_REQUIRED', status: 503 };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { error: 'GOODVIBES_DAEMON_URL is not a valid URL', code: 'DAEMON_URL_INVALID', status: 400 };
  }
  const allowInsecure = envFlag(env.GOODVIBES_ALLOW_INSECURE_DAEMON_URL);
  const allowPrivate = envFlag(env.GOODVIBES_ALLOW_PRIVATE_DAEMON_URL);
  if (url.protocol !== 'https:' && !(allowInsecure && (url.protocol === 'http:'))) {
    return { error: 'GOODVIBES_DAEMON_URL must use https unless GOODVIBES_ALLOW_INSECURE_DAEMON_URL=true', code: 'DAEMON_URL_INSECURE', status: 400 };
  }
  if (!allowPrivate && isPrivateDaemonHost(url.hostname)) {
    return { error: 'GOODVIBES_DAEMON_URL targets a private, loopback, or link-local host. Set GOODVIBES_ALLOW_PRIVATE_DAEMON_URL=true only for an intentional tunnel/private deployment.', code: 'DAEMON_URL_PRIVATE_HOST', status: 403 };
  }
  url.pathname = url.pathname.replace(/\\/+$/, '');
  url.search = '';
  url.hash = '';
  return { baseUrl: url.toString().replace(/\\/+$/, '') };
}

function isPrivateDaemonHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\\[|\\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // The IPv6 unique-local and link-local prefixes only mean something in an IPv6
  // literal; a DNS name that merely starts with fc or fd is an ordinary host.
  if (host === '::1' || (host.includes(':') && (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')))) return true;
  const parts = host.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || a === 0;
}

function toDaemonBatchPath(pathname) {
  if (pathname.startsWith('/api/batch')) return pathname;
  if (pathname.startsWith('/batch/')) return '/api' + pathname;
  if (pathname === '/batch') return '/api/batch';
  return null;
}

function constantTimeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return diff === 0;
}

function requireWorkerAuth(request, env) {
  const expected = String(env.GOODVIBES_WORKER_TOKEN || '');
  // No token configured means no way to tell the daemon's callers from anyone
  // else, and this Worker attaches the daemon's operator credential to what it
  // proxies, so it refuses instead of running open.
  if (!expected) {
    return json({ error: 'GOODVIBES_WORKER_TOKEN is not configured on this Worker; provision it again to set the client token', code: 'WORKER_AUTH_NOT_CONFIGURED' }, 503);
  }
  const auth = request.headers.get('authorization') || '';
  if (constantTimeEqual(auth, 'Bearer ' + expected)) return null;
  return json({ error: 'Worker authorization required', code: 'WORKER_AUTH_REQUIRED' }, 401);
}

// A Secrets Store binding is read with get(); a script secret is a plain string.
async function readSecret(storeBinding, plain) {
  if (storeBinding && typeof storeBinding.get === 'function') {
    try {
      const value = await storeBinding.get();
      if (value) return String(value);
    } catch {
      // fall back to the script secret
    }
  }
  return String(plain || '');
}

async function proxyDaemonJson(env, path, init) {
  const daemon = resolveDaemonUrl(env);
  if (daemon.error) {
    return json({ error: daemon.error, code: daemon.code }, daemon.status);
  }
  const headers = new Headers();
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  const token = await readSecret(env.GOODVIBES_OPERATOR_TOKEN_STORE, env.GOODVIBES_OPERATOR_TOKEN);
  if (token) headers.set('Authorization', 'Bearer ' + token);
  // The daemon hostname may sit behind a Cloudflare Access application whose
  // only policy admits this service token.
  const accessId = String(env.GOODVIBES_ACCESS_CLIENT_ID || '');
  const accessSecret = accessId ? await readSecret(env.GOODVIBES_ACCESS_CLIENT_SECRET_STORE, env.GOODVIBES_ACCESS_CLIENT_SECRET) : '';
  if (accessId && accessSecret) {
    headers.set('CF-Access-Client-Id', accessId);
    headers.set('CF-Access-Client-Secret', accessSecret);
  }
  return fetch(daemon.baseUrl + path + (init.search || ''), {
    method: init.method,
    headers,
    body: init.body,
  });
}

function isRetryableStatus(status) {
  // 401 and 403 are retried too: an operator who rotates the daemon token fixes them, and acking would lose the job.
  return status === 408 || status === 429 || status === 401 || status === 403 || status >= 500;
}

function utcDay(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function nextUtcMidnight(now) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

function queueOpsFor(bytes) {
  // One write per 64 KB, one read and one delete per delivered message.
  return Math.max(1, Math.ceil(bytes / QUEUE_OP_CHUNK_BYTES)) + 2;
}

// The daily queue budget is counted in the coordinator Durable Object: one
// instance per Worker, so concurrent requests see one counter.
async function coordinatorCall(env, path, body) {
  const namespace = env.GOODVIBES_COORDINATOR;
  if (!namespace) return null;
  const stub = namespace.get(namespace.idFromName('queue-budget'));
  const response = await stub.fetch('https://coordinator' + path, { method: 'POST', body: JSON.stringify(body) });
  return response.json();
}

async function reserveQueue(env, bytes) {
  const limits = {
    ops: envNumber(env.GOODVIBES_MAX_QUEUE_OPS_PER_DAY),
    messages: envNumber(env.GOODVIBES_MAX_QUEUE_MESSAGES_PER_DAY),
  };
  if (limits.ops === 0 && limits.messages === 0) return { allowed: true };
  const answer = await coordinatorCall(env, '/budget/reserve', { ops: queueOpsFor(bytes), messages: 1, limits });
  return answer || { allowed: true, unmetered: true };
}

function budgetRefusal(answer) {
  return json({
    error: 'The daily Cloudflare queue budget is used up',
    code: 'QUEUE_BUDGET_EXHAUSTED',
    state: 'used ' + answer.used.ops + ' of ' + (answer.limits.ops || 'unlimited') + ' queue operations and ' + answer.used.messages + ' of ' + (answer.limits.messages || 'unlimited') + ' messages today (UTC)',
    next: [
      'Post /batch/jobs to send the job straight to the daemon without the queue',
      'Wait until ' + new Date(answer.resetsAt).toISOString() + ' when the budget resets',
      'Raise cloudflare.maxQueueOpsPerDay or batch.maxQueueMessagesPerDay and provision again',
    ],
    resetsAt: answer.resetsAt,
  }, 429);
}

async function kvPut(env, key, value) {
  if (!env.GOODVIBES_KV) return;
  try {
    await env.GOODVIBES_KV.put(key, JSON.stringify(value), { expirationTtl: JOB_RECORD_TTL_SECONDS });
  } catch {
    // The status record is a convenience; a full KV write quota must not lose the job.
  }
}

async function kvGet(env, key) {
  if (!env.GOODVIBES_KV) return null;
  try {
    const text = await env.GOODVIBES_KV.get(key);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function payloadKey(jobId) {
  return 'batch-payloads/' + jobId + '.json';
}

async function readJobBody(env, payload) {
  if (!payload.payloadKey) return toRecord(payload.body);
  if (!env.GOODVIBES_ARTIFACTS) throw new Error('GOODVIBES_ARTIFACTS is not bound');
  const object = await env.GOODVIBES_ARTIFACTS.get(payload.payloadKey);
  if (!object) return null;
  return toRecord(JSON.parse(await object.text()));
}

async function handleQueuePayload(payload, env) {
  if (payload.type === 'batch.tick') {
    return proxyDaemonJson(env, '/api/batch/tick', {
      method: 'POST',
      body: JSON.stringify({ force: payload.force === true }),
    });
  }
  const body = await readJobBody(env, payload);
  if (body === null) return json({ error: 'The queued job body is no longer in R2', code: 'PAYLOAD_MISSING' }, 410);
  const metadata = toRecord(body.metadata);
  return proxyDaemonJson(env, '/api/batch/jobs', {
    method: 'POST',
    body: JSON.stringify({
      ...body,
      // The daemon's queue-size limit is for bodies that travelled in the queue.
      ...(payload.payloadKey ? { metadata: { ...metadata, 'goodvibes.payload': 'r2' } } : {}),
      source: {
        kind: 'cloudflare-queue',
        id: typeof payload.body?.id === 'string' ? payload.body.id : payload.jobId,
      },
    }),
  });
}

async function enqueueJob(request, env) {
  const queue = env.GOODVIBES_BATCH_QUEUE;
  if (!queue) return json({ error: 'GOODVIBES_BATCH_QUEUE is not bound', code: 'QUEUE_NOT_CONFIGURED' }, 503);
  const text = await request.text();
  let body = {};
  if (text.trim()) {
    try {
      body = toRecord(JSON.parse(text));
    } catch {
      return json({ error: 'Invalid JSON request body', code: 'INVALID_JSON' }, 400);
    }
  }
  const jobId = crypto.randomUUID();
  const bodyBytes = new TextEncoder().encode(JSON.stringify(body)).length;
  const maxQueueBytes = envNumber(env.GOODVIBES_MAX_QUEUE_PAYLOAD_BYTES) || 16 * 1024;
  const freeTier = envFlag(env.GOODVIBES_FREE_TIER_MODE);
  // Free-tier mode keeps job bodies out of the queue: the body goes to R2 and
  // the queue carries only its key. Without free-tier mode a body that fits
  // the queue limit travels in the message.
  const useR2 = Boolean(env.GOODVIBES_ARTIFACTS) && (freeTier || bodyBytes > maxQueueBytes);
  if (!useR2 && freeTier) {
    return json({
      error: 'Free-tier mode keeps job bodies out of the queue and no R2 bucket is bound to hold them',
      code: 'QUEUE_PAYLOADS_NEED_R2',
      next: ['Post /batch/jobs to send the job straight to the daemon', 'Provision the r2 component', 'Turn cloudflare.freeTierMode off and provision again'],
    }, 409);
  }
  if (!useR2 && bodyBytes > maxQueueBytes) {
    return json({
      error: 'The job body is ' + bodyBytes + ' bytes, above the ' + maxQueueBytes + ' byte queue message limit',
      code: 'QUEUE_PAYLOAD_TOO_LARGE',
      next: ['Post /batch/jobs to send the job straight to the daemon', 'Provision the r2 component so large bodies are kept in R2'],
    }, 413);
  }
  const message = useR2
    ? { type: 'batch.job.create', jobId, payloadKey: payloadKey(jobId), enqueuedAt: Date.now() }
    : { type: 'batch.job.create', body, jobId, enqueuedAt: Date.now() };
  const budget = await reserveQueue(env, new TextEncoder().encode(JSON.stringify(message)).length);
  if (!budget.allowed) return budgetRefusal(budget);
  if (useR2) await env.GOODVIBES_ARTIFACTS.put(payloadKey(jobId), JSON.stringify(body));
  await queue.send(message);
  await kvPut(env, 'job:' + jobId, { state: 'queued', enqueuedAt: message.enqueuedAt, payload: useR2 ? 'r2' : 'queue' });
  return json({ queued: true, jobId, ...(env.GOODVIBES_KV ? { statusPath: '/batch/queue/jobs/' + jobId } : {}) }, 202);
}

export class GoodVibesCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return json({ ok: true, service: 'goodvibes-cloudflare-coordinator' });
    }
    if (request.method === 'POST' && (url.pathname === '/budget/reserve' || url.pathname === '/budget/record')) {
      const body = toRecord(await optionalJson(request));
      const now = Date.now();
      const day = utcDay(now);
      const stored = toRecord(await this.state.storage.get('budget'));
      const used = stored.day === day ? { ops: Number(stored.ops) || 0, messages: Number(stored.messages) || 0 } : { ops: 0, messages: 0 };
      const limits = toRecord(body.limits);
      const limitOps = Math.max(0, Number(limits.ops) || 0);
      const limitMessages = Math.max(0, Number(limits.messages) || 0);
      const ops = Math.max(0, Math.floor(Number(body.ops) || 0));
      const messages = Math.max(0, Math.floor(Number(body.messages) || 0));
      const answer = { day, used, limits: { ops: limitOps, messages: limitMessages }, resetsAt: nextUtcMidnight(now) };
      if (url.pathname === '/budget/reserve'
        && ((limitOps > 0 && used.ops + ops > limitOps) || (limitMessages > 0 && used.messages + messages > limitMessages))) {
        return json({ allowed: false, ...answer });
      }
      const next = { day, ops: used.ops + ops, messages: used.messages + messages };
      await this.state.storage.put('budget', next);
      return json({ allowed: true, ...answer, used: { ops: next.ops, messages: next.messages } });
    }
    if (request.method === 'GET' && url.pathname === '/budget') {
      const stored = toRecord(await this.state.storage.get('budget'));
      const day = utcDay(Date.now());
      return json(stored.day === day ? { day, ops: stored.ops, messages: stored.messages } : { day, ops: 0, messages: 0 });
    }
    return json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' || url.pathname === '/batch/health') {
      return json({ ok: true, service: 'goodvibes-cloudflare-worker' });
    }

    const authError = requireWorkerAuth(request, env);
    if (authError) return authError;

    if (url.pathname === '/batch/tick/enqueue' && request.method === 'POST') {
      const queue = env.GOODVIBES_BATCH_QUEUE;
      if (!queue) return json({ error: 'GOODVIBES_BATCH_QUEUE is not bound', code: 'QUEUE_NOT_CONFIGURED' }, 503);
      const body = await optionalJson(request);
      if (body.__goodvibesInvalidJson === true) return json({ error: 'Invalid JSON request body', code: 'INVALID_JSON' }, 400);
      const message = {
        type: 'batch.tick',
        force: toRecord(body).force === true,
        enqueuedAt: Date.now(),
      };
      const budget = await reserveQueue(env, JSON.stringify(message).length);
      if (!budget.allowed) return budgetRefusal(budget);
      await queue.send(message);
      return json({ queued: true }, 202);
    }

    if (url.pathname === '/batch/queue/budget' && request.method === 'GET') {
      if (!env.GOODVIBES_COORDINATOR) return json({ error: 'No coordinator is bound, so queue use is not counted', code: 'BUDGET_NOT_COUNTED' }, 404);
      const stub = env.GOODVIBES_COORDINATOR.get(env.GOODVIBES_COORDINATOR.idFromName('queue-budget'));
      const used = await (await stub.fetch('https://coordinator/budget')).json();
      return json({
        ...used,
        limits: { ops: envNumber(env.GOODVIBES_MAX_QUEUE_OPS_PER_DAY), messages: envNumber(env.GOODVIBES_MAX_QUEUE_MESSAGES_PER_DAY) },
      });
    }

    if (url.pathname.startsWith('/batch/queue/jobs/') && request.method === 'GET') {
      if (!env.GOODVIBES_KV) return json({ error: 'No KV namespace is bound, so queued jobs are not tracked', code: 'JOB_STATUS_NOT_TRACKED' }, 404);
      const jobId = decodeURIComponent(url.pathname.slice('/batch/queue/jobs/'.length));
      const record = await kvGet(env, 'job:' + jobId);
      return record ? json({ jobId, ...record }) : json({ error: 'No queued job with that id is known', code: 'NOT_FOUND' }, 404);
    }

    const daemonPath = toDaemonBatchPath(url.pathname);
    if (!daemonPath) return json({ error: 'Not found', code: 'NOT_FOUND' }, 404);

    if (url.pathname === '/batch/jobs/enqueue' && request.method === 'POST') {
      if (!envFlag(env.GOODVIBES_QUEUE_JOB_PAYLOADS)) {
        return json({
          error: 'Queueing full batch job payloads is disabled. Post /batch/jobs to proxy directly to the daemon, or enable queueJobPayloads explicitly.',
          code: 'QUEUE_PAYLOADS_DISABLED',
        }, 409);
      }
      return enqueueJob(request, env);
    }

    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
    return proxyDaemonJson(env, daemonPath, {
      method: request.method,
      body,
      search: url.search,
    });
  },

  async queue(batch, env) {
    let redelivered = 0;
    for (const message of batch.messages) {
      try {
        const type = message.body?.type;
        if (type !== 'batch.tick' && type !== 'batch.job.create') {
          // A message of an unknown shape can never succeed; redelivering it only loops.
          message.ack?.();
          continue;
        }
        if ((message.attempts || 1) > 1) redelivered += 1;
        const jobId = type === 'batch.job.create' ? String(message.body.jobId || '') : '';
        if (jobId) {
          const known = await kvGet(env, 'job:' + jobId);
          // Delivered before and the ack was lost: the daemon already has it.
          if (known && known.state === 'delivered') {
            message.ack?.();
            continue;
          }
        }
        const response = await handleQueuePayload(message.body, env);
        if (response.ok) {
          if (jobId) {
            const created = toRecord(await response.json().catch(() => ({})));
            const daemonJob = toRecord(created.job || created);
            await kvPut(env, 'job:' + jobId, { state: 'delivered', daemonJobId: typeof daemonJob.id === 'string' ? daemonJob.id : undefined, deliveredAt: Date.now() });
            if (message.body.payloadKey && env.GOODVIBES_ARTIFACTS) await env.GOODVIBES_ARTIFACTS.delete(message.body.payloadKey).catch(() => undefined);
          }
          message.ack?.();
        } else if (!isRetryableStatus(response.status)) {
          // Any other 4xx (a bad body) fails the same way every time.
          if (jobId) await kvPut(env, 'job:' + jobId, { state: 'rejected', status: response.status, rejectedAt: Date.now() });
          message.ack?.();
        } else {
          message.retry?.();
        }
      } catch {
        message.retry?.();
      }
    }
    // Each redelivery is one more queue read against the daily budget.
    if (redelivered > 0) {
      await coordinatorCall(env, '/budget/record', { ops: redelivered, messages: 0 }).catch(() => undefined);
    }
  },

  async scheduled(_event, env) {
    const response = await proxyDaemonJson(env, '/api/batch/tick', {
      method: 'POST',
      body: JSON.stringify({ force: false }),
    });
    // Thrown so a refused tick shows up as a failed cron invocation in Cloudflare.
    if (!response.ok) throw new Error('Scheduled batch tick was refused by the daemon with status ' + response.status);
  },
};
`.trim();
