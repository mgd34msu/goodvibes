import { describe, expect, test } from 'bun:test';
import {
  createGoodVibesCloudflareWorker,
  type GoodVibesCloudflareQueuePayload,
} from '../platform/src/workers.js';

describe('Cloudflare Worker batch bridge', () => {
  test('proxies batch job creation directly to the daemon by default', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), ...(init !== undefined ? { init } : {}) });
      return Response.json({ job: { id: 'batch-job-1' } }, { status: 202 });
    }) as typeof fetch;
    try {
      const worker = createGoodVibesCloudflareWorker();
      const res = await worker.fetch(
        new Request('https://worker.example/batch/jobs', {
          method: 'POST',
          headers: { Authorization: 'Bearer worker-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ request: { messages: [{ role: 'user', content: 'hi' }] } }),
        }),
        {
          GOODVIBES_DAEMON_URL: 'https://daemon.example',
          GOODVIBES_OPERATOR_TOKEN: 'token',
          GOODVIBES_WORKER_TOKEN: 'worker-token',
        },
        { waitUntil: () => undefined },
      );
      expect(res.status).toBe(202);
      expect(calls[0]?.url).toBe('https://daemon.example/api/batch/jobs');
      expect(calls[0]?.init?.method).toBe('POST');
      const headers = calls[0]?.init?.headers as Headers;
      expect(headers.get('Authorization')).toBe('Bearer token');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('queues tick signals without queueing prompt payloads', async () => {
    const messages: GoodVibesCloudflareQueuePayload[] = [];
    const worker = createGoodVibesCloudflareWorker();
    const res = await worker.fetch(
      new Request('https://worker.example/batch/tick/enqueue', {
        method: 'POST',
        headers: { Authorization: 'Bearer worker-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      }),
      {
        GOODVIBES_WORKER_TOKEN: 'worker-token',
        GOODVIBES_BATCH_QUEUE: {
          async send(message) {
            messages.push(message);
          },
        },
      },
      { waitUntil: () => undefined },
    );
    expect(res.status).toBe(202);
    expect(messages).toHaveLength(1);
    const message = messages[0];
    expect(message?.type).toBe('batch.tick');
    if (message?.type !== 'batch.tick') throw new Error('expected a batch.tick queue payload');
    expect(message.force).toBe(true);
    expect(typeof message.enqueuedAt).toBe('number');
  });

  test.each(['/batch/tick/enqueue', '/batch/jobs/enqueue'])('honors the body limit before queue publication at %s', async path => {
    let sends = 0;
    const worker = createGoodVibesCloudflareWorker({ maxRequestBodyBytes: 8, queueJobPayloads: true });
    const response = await worker.fetch(new Request(`https://worker.example${path}`, {
      method: 'POST', headers: { Authorization: 'Bearer worker-token' }, body: '{"force":true}',
    }), { GOODVIBES_WORKER_TOKEN: 'worker-token', GOODVIBES_BATCH_QUEUE: { async send() { sends++; } } }, { waitUntil() {} });
    expect(response.status).toBe(413);
    expect(sends).toBe(0);
  });

  test.each([0, -1, NaN, Infinity, 1.5])('rejects an invalid body limit %s', maxRequestBodyBytes => {
    expect(() => createGoodVibesCloudflareWorker({ maxRequestBodyBytes })).toThrow();
  });

  test('requires a worker token for non-health endpoints by default', async () => {
    const worker = createGoodVibesCloudflareWorker();
    const res = await worker.fetch(
      new Request('https://worker.example/batch/tick/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
      {},
      { waitUntil: () => undefined },
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'WORKER_AUTH_TOKEN_REQUIRED' });
  });
});

describe('Cloudflare Worker scheduled and queue handlers', () => {
  const env = { GOODVIBES_DAEMON_URL: 'https://daemon.example', GOODVIBES_OPERATOR_TOKEN: 'token' };
  const ctx = { waitUntil: () => undefined };

  async function withFetch<T>(handler: (url: string, init?: RequestInit) => Response, run: () => Promise<T>): Promise<T> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
    try {
      return await run();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  test('a cron tick the daemon rejects fails the invocation', async () => {
    const worker = createGoodVibesCloudflareWorker();
    await withFetch(() => new Response('unauthorized', { status: 401 }), async () => {
      await expect(worker.scheduled({}, env, ctx)).rejects.toThrow('401');
    });
  });

  test('a cron tick the daemon accepts resolves', async () => {
    const worker = createGoodVibesCloudflareWorker();
    await withFetch(() => Response.json({ ok: true }), async () => {
      await expect(worker.scheduled({}, env, ctx)).resolves.toBeUndefined();
    });
  });

  test('a missing daemon url fails the cron invocation', async () => {
    const worker = createGoodVibesCloudflareWorker();
    await expect(worker.scheduled({}, {}, ctx)).rejects.toThrow('503');
  });

  function runQueue(status: number, body: GoodVibesCloudflareQueuePayload, bodies: string[] = []) {
    const calls: string[] = [];
    const worker = createGoodVibesCloudflareWorker();
    const message = { body, ack: () => { calls.push('ack'); }, retry: () => { calls.push('retry'); } };
    return withFetch((_url, init) => { bodies.push(String(init?.body)); return new Response('x', { status }); },
      async () => { await worker.queue({ messages: [message] }, env, ctx); return calls; });
  }

  const job: GoodVibesCloudflareQueuePayload = { type: 'batch.job.create', body: { request: {} }, jobId: 'job-1' };

  test('a daemon 400 is acknowledged, not redelivered', async () => {
    expect(await runQueue(400, job)).toEqual(['ack']);
  });

  test('a daemon 500 is redelivered with the same job id', async () => {
    const bodies: string[] = [];
    expect(await runQueue(500, job, bodies)).toEqual(['retry']);
    expect(await runQueue(500, job, bodies)).toEqual(['retry']);
    const ids = bodies.map((b) => (JSON.parse(b) as { source: { id: string } }).source.id);
    expect(ids).toEqual(['job-1', 'job-1']);
  });

  test('a rotated operator token (401) is redelivered so the job is not lost', async () => {
    expect(await runQueue(401, job)).toEqual(['retry']);
  });

  test('a message of an unknown type is acknowledged without calling the daemon', async () => {
    const bodies: string[] = [];
    expect(await runQueue(500, { type: 'bogus' } as unknown as GoodVibesCloudflareQueuePayload, bodies)).toEqual(['ack']);
    expect(bodies).toEqual([]);
  });

  test('queued job payloads get a minted id that the delivered message carries', async () => {
    const messages: GoodVibesCloudflareQueuePayload[] = [];
    const worker = createGoodVibesCloudflareWorker({ queueJobPayloads: true });
    const res = await worker.fetch(
      new Request('https://worker.example/batch/jobs/enqueue', {
        method: 'POST',
        headers: { Authorization: 'Bearer w', 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: {} }),
      }),
      { GOODVIBES_WORKER_TOKEN: 'w', GOODVIBES_BATCH_QUEUE: { async send(m) { messages.push(m); } } },
      ctx,
    );
    expect(res.status).toBe(202);
    const queued = messages[0];
    expect(queued?.type === 'batch.job.create' && typeof queued.jobId === 'string' && queued.jobId.length > 0).toBe(true);
  });
});
