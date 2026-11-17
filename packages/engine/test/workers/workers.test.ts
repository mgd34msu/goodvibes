/**
 * Cloudflare Workers, in the real workerd isolate (Miniflare), from source,
 * with no build:
 *
 * - The GoodVibes Cloudflare Worker: the exact module text platform
 *   provisioning uploads (`buildGoodVibesCloudflareWorkerModule`) loads and
 *   answers; a caller without the Worker token is refused and nothing reaches
 *   the daemon; an authorised batch call reaches the daemon carrying the
 *   operator token, never the caller's Worker token. The daemon is
 *   Miniflare's outbound service, which records what arrived.
 * - A Worker-hosted operator client: the platform's ./web entry, bundled by
 *   esbuild from source into `worker.ts`, loads, keeps its auth token, makes a
 *   real HTTP round trip, maps a 5xx to the typed `service` kind, and delivers
 *   SSE events without the EventSource global production Workers lack.
 */
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Miniflare, Response as MiniflareResponse, type Request as MiniflareRequest, type RequestInit as MiniflareRequestInit } from 'miniflare';
import { buildGoodVibesCloudflareWorkerModule } from '../../platform/src/workers.ts';

const ENGINE = join(import.meta.dir, '..', '..');
const DAEMON_URL = 'https://daemon.example.test';
const WORKER_TOKEN = 'worker-client-token';
const OPERATOR_TOKEN = 'daemon-operator-token';

// esbuild is a dependency of wrangler, not of the engine: resolve the copy wrangler uses.
// The engine does not depend on esbuild, so its types are not resolvable here.
interface EsbuildBundleOptions {
  readonly entryPoints: readonly string[];
  readonly bundle: boolean;
  readonly platform: 'browser';
  readonly format: 'esm';
  readonly target: string;
  readonly external: readonly string[];
  readonly conditions: readonly string[];
  readonly absWorkingDir: string;
  readonly outfile: string;
  readonly logLevel: 'silent';
}
function loadEsbuild(): { build: (options: EsbuildBundleOptions) => Promise<unknown> } {
  const fromHere = createRequire(import.meta.url);
  return createRequire(fromHere.resolve('wrangler'))('esbuild');
}

interface Arrived { readonly url: string; readonly method: string; readonly authorization: string | null; readonly body: string }
const arrived: Arrived[] = [];

let mf: Miniflare;
let tmpDir = '';

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'goodvibes-workers-'));
  const client = join(tmpDir, 'client-worker.mjs');
  // One self-contained module: bare specifiers (zod/v4, the workspace packages through their
  // `bun` source condition) are inlined; the two Node built-ins stay external for nodejs_compat.
  await loadEsbuild().build({
    entryPoints: [join(import.meta.dir, 'worker.ts')],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    external: ['fs', 'path', 'node:fs', 'node:path'],
    conditions: ['bun'],
    absWorkingDir: ENGINE,
    outfile: client,
    logLevel: 'silent',
  });

  mf = new Miniflare({
    workers: [
      {
        name: 'goodvibes',
        modules: [{ type: 'ESModule', path: join(tmpDir, 'goodvibes-worker.mjs'), contents: buildGoodVibesCloudflareWorkerModule() }],
        modulesRoot: tmpDir,
        compatibilityDate: '2026-04-01',
        bindings: { GOODVIBES_DAEMON_URL: DAEMON_URL, GOODVIBES_WORKER_TOKEN: WORKER_TOKEN, GOODVIBES_OPERATOR_TOKEN: OPERATOR_TOKEN },
        outboundService: async (request: MiniflareRequest) => {
          arrived.push({ url: request.url, method: request.method, authorization: request.headers.get('authorization'), body: await request.text() });
          return new MiniflareResponse(JSON.stringify({ job: { id: 'daemon-job-1' } }), { status: 201, headers: { 'Content-Type': 'application/json' } });
        },
      },
      {
        name: 'client',
        modules: true,
        scriptPath: client,
        modulesRoot: tmpDir,
        modulesRules: [{ type: 'ESModule', include: ['**/*.js', '**/*.mjs'] }],
        compatibilityDate: '2026-04-01',
        compatibilityFlags: ['nodejs_compat'],
      },
    ],
  });
  await mf.ready;
});

afterAll(async () => {
  await mf?.dispose();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

/** A request to the GoodVibes Worker, the first worker, as a caller on the internet sends it. */
function goodvibes(path: string, init?: MiniflareRequestInit) {
  return mf.dispatchFetch(`https://worker.example.test${path}`, init);
}

async function client(path: string): Promise<Record<string, unknown>> {
  const worker = await mf.getWorker('client');
  const res = await worker.fetch(`http://workers.test${path}`);
  expect(res.status).toBe(200);
  return await res.json() as Record<string, unknown>;
}

describe('the GoodVibes Cloudflare Worker, as provisioning uploads it', () => {
  test('loads and answers its health check', async () => {
    const res = await goodvibes('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  test('a caller without the Worker token is refused and nothing reaches the daemon', async () => {
    arrived.length = 0;
    const res = await goodvibes('/batch/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(arrived).toEqual([]);
  });

  test('an authorised batch call reaches the daemon with the operator token, not the caller\'s', async () => {
    arrived.length = 0;
    const res = await goodvibes('/batch/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER_TOKEN}` }, body: JSON.stringify({ prompt: 'nightly report' }),
    });
    expect(res.status).toBe(201);
    expect(arrived).toEqual([{ url: `${DAEMON_URL}/api/batch/jobs`, method: 'POST', authorization: `Bearer ${OPERATOR_TOKEN}`, body: JSON.stringify({ prompt: 'nightly report' }) }]);
  });
});

describe('a Worker-hosted operator client (the ./web entry)', () => {
  test('the platform loads and its factory builds the operator, auth and realtime surfaces', async () => {
    const body = await client('/smoke');
    expect(body).toMatchObject({ ok: true, hasOperator: true, hasAuth: true, hasRealtime: true });
  });

  test('the auth token is stored and read back inside the isolate', async () => {
    expect(await client('/auth')).toMatchObject({ ok: true, tokenMatches: true, storedToken: 'workers-auth-token-abc123' });
  });

  test('an HTTP round trip returns the daemon\'s answer', async () => {
    const body = await client('/transport-success');
    expect(body).toMatchObject({ ok: true, kind: null });
    const result = body.result as { sessions: Array<Record<string, unknown>> };
    expect(result.sessions[0]).toMatchObject({ kind: 'tui', lastActivityAt: 1700000000000 });
  });

  test('a 5xx is a typed service error, and the error classes load', async () => {
    expect(await client('/transport-error')).toMatchObject({ ok: true, result: null, kind: 'service' });
    expect(await client('/errors')).toMatchObject({ ok: true, engineErrorWorks: true });
  });

  test('SSE realtime delivers an event when EventSource is absent from the isolate', async () => {
    const body = await client('/realtime-without-eventsource');
    expect(body).toMatchObject({ eventSourceAbsent: true, constructionError: null, errors: [] });
    expect(body.delivered).toEqual({ type: 'TURN_SUBMITTED', sessionId: 'workers-sse-session' });
  });
});
