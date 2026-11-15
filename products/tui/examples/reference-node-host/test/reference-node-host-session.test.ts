import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReferenceNodeHostClient, createDefaultReferenceNodeHostConfig } from '../src/index.ts';
import { makeProjectTempDir } from '../../../src/test/helpers/project-temp.ts';

const peer = { id: 'peer-1', kind: 'node', label: 'n', requestedId: 'n', status: 'connected', pairedAt: 1, lastSeenAt: 1, tokens: [], capabilities: [], commands: [], metadata: {} };
const contract = { schemaVersion: 1, transport: 'http-json', basePath: '/api/remote', peerKinds: ['node'], workTypes: [], scopes: [], recommendedHeartbeatMs: 10, recommendedWorkPullMs: 10, endpoints: [], workCompletionStatuses: ['completed'], metadata: {} };

describe('ReferenceNodeHostClient credential handling', () => {
  let server: ReturnType<typeof Bun.serve>;
  let dir = '';
  let statePath = '';
  let heartbeatStatuses: number[] = [];
  let heartbeats = 0;

  beforeEach(() => {
    dir = makeProjectTempDir('gv-reference-node-session');
    statePath = join(dir, 'state.json');
    heartbeats = 0;
    heartbeatStatuses = [];
    server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        if (path === '/api/remote/node-host/contract') return Response.json({ contract });
        if (path === '/api/remote/heartbeat') {
          heartbeats += 1;
          const status = heartbeatStatuses.shift() ?? 200;
          return status === 200 ? Response.json({ peer }) : new Response('no', { status });
        }
        if (path === '/api/remote/work/pull') return Response.json({ work: [] });
        return new Response('not found', { status: 404 });
      },
    });
  });
  afterEach(() => {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  function client(extra: { heartbeatIntervalMs?: number } = {}): ReferenceNodeHostClient {
    return new ReferenceNodeHostClient(createDefaultReferenceNodeHostConfig({
      baseUrl: `http://127.0.0.1:${server.port}`,
      statePath,
      workPullIntervalMs: 1,
      ...extra,
    }));
  }
  const seedToken = () => writeFileSync(statePath, JSON.stringify({ contract, token: { value: 'peer-token' } }));
  const storedToken = () => (JSON.parse(readFileSync(statePath, 'utf-8')) as { token?: { value: string } }).token?.value;

  test('a transient host failure keeps the stored token', async () => {
    seedToken();
    heartbeatStatuses = [503];
    await expect(client().runOnce()).rejects.toThrow('503');
    expect(storedToken()).toBe('peer-token');
  });

  test('a refused credential discards the stored token', async () => {
    seedToken();
    heartbeatStatuses = [401];
    await expect(client().runOnce()).rejects.toThrow();
    expect(storedToken()).toBeUndefined();
  });

  test('the heartbeat interval holds between runs', async () => {
    seedToken();
    const c = client({ heartbeatIntervalMs: 3_600_000 });
    const first = await c.runOnce();
    const second = await c.runOnce();
    expect(first.heartbeated).toBe(true);
    expect(second.heartbeated).toBe(false);
    expect(heartbeats).toBe(1);
  });

  test('the state file holding the token is owner-only', async () => {
    seedToken();
    await client().runOnce();
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
  });

  test('an unreadable state file is kept aside, not silently replaced', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(statePath, '{"token":');
    const c = client();
    await c.loadState();
    expect(c.getState().lastError).toContain('could not be read');
    expect(readdirSync(dir).some((name) => name.startsWith('state.json.corrupt-'))).toBe(true);
  });
});
