// Proves: The Cloudflare Worker that provisioning uploads holds the daemon's operator token and is reachable from the internet; a caller without the Worker token must reach nothing.
// Red when: The uploaded module forwards a request without the Worker token to the daemon, where it would arrive with the operator token.
/**
 * The GoodVibes Cloudflare Worker, in the real workerd isolate (Miniflare),
 * from source, with no build: the exact module text platform provisioning
 * uploads (`buildGoodVibesCloudflareWorkerModule`) loads and answers, and a
 * caller without the Worker token is refused and nothing reaches the daemon.
 * The daemon is Miniflare's outbound service, which records what arrived.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Miniflare, Response as MiniflareResponse, type Request as MiniflareRequest, type RequestInit as MiniflareRequestInit } from 'miniflare';
import { buildGoodVibesCloudflareWorkerModule } from '../../platform/src/workers.ts';

const DAEMON_URL = 'https://daemon.example.test';
const WORKER_TOKEN = 'worker-client-token';
const OPERATOR_TOKEN = 'daemon-operator-token';

interface Arrived { readonly url: string; readonly method: string; readonly authorization: string | null; readonly body: string }
const arrived: Arrived[] = [];

let mf: Miniflare;
let tmpDir = '';

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'goodvibes-workers-'));
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

describe('the GoodVibes Cloudflare Worker, as provisioning uploads it', () => {
  test('a caller without the Worker token is refused and nothing reaches the daemon', async () => {
    arrived.length = 0;
    const res = await goodvibes('/batch/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(arrived).toEqual([]);
  });
});
