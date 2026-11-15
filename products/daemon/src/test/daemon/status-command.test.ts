import { describe, expect, test } from 'bun:test';
import type { DaemonFetch } from '@goodvibes-jev/engine/terminal-shell';
import type { LocalStateIo } from '../../daemon/local-daemon-state.js';
import { localDaemonStatePaths } from '../../daemon/local-daemon-state.js';
import { runStatusCommand, runUpdateCommand } from '../../daemon/status-command.js';

const CONFIG_DIR = '/home/x/.goodvibes';
const PATHS = localDaemonStatePaths(CONFIG_DIR);

/** Config values the remote-target resolver reads. */
function config(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'controlPlane.hostMode': 'local',
    'controlPlane.host': '127.0.0.1',
    'controlPlane.port': 3421,
    ...overrides,
  };
  return { get: (key: string): never => values[key] as never };
}

/**
 * A fetch that answers a fixed map of paths, in the SAME envelopes a real
 * daemon uses: `/api/cluster/*` wraps its answer in `{ ok, data }`, and
 * `/status`, `/api/health` and `/api/channels/status` answer with the payload
 * itself. Reading one as the other turned a healthy 200 into "the daemon
 * refused the request" against a live daemon, so the doubles here reproduce the
 * distinction rather than flattening it.
 */
function fakeFetch(routes: Record<string, unknown>, options: { readonly missing?: readonly string[] } = {}): {
  fetchImpl: DaemonFetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl: DaemonFetch = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path.startsWith('/api/control-plane/methods/')) return gateway(path, init);
    if (options.missing?.includes(path)) {
      return new Response(JSON.stringify({ ok: false, error: 'not here' }), { status: 404 });
    }
    const body = routes[path];
    if (body === undefined) {
      return new Response(JSON.stringify({ ok: false, error: `no route ${path}` }), { status: 500 });
    }
    const wrapped = path.startsWith('/api/cluster/');
    return new Response(JSON.stringify(wrapped ? { ok: true, data: body } : body), { status: 200 });
  };
  return { fetchImpl, calls };
}

/**
 * The daemon's side of the generic gateway route the hosted-session and update
 * verbs go through. `fakeGateway` sets the answer for the next command; the
 * fetch above hands every `/api/control-plane/methods/{id}/invoke` call to it.
 */
let gateway: (path: string, init: RequestInit | undefined) => Response = () => new Response('{}', { status: 500 });

function fakeGateway(answer: { ok: boolean; body?: unknown; status?: number }): {
  headers: Record<string, string>[];
  methodIds: string[];
  bodies: unknown[];
} {
  const headers: Record<string, string>[] = [];
  const methodIds: string[] = [];
  const bodies: unknown[] = [];
  gateway = (path, init) => {
    headers.push({ ...(init?.headers as Record<string, string>) });
    methodIds.push(decodeURIComponent(/\/methods\/([^/]+)\/invoke$/.exec(path)?.[1] ?? ''));
    bodies.push((JSON.parse(String(init?.body ?? '{}')) as { body?: unknown }).body);
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? (answer.ok ? 200 : 400) });
  };
  return { headers, methodIds, bodies };
}

function io(files: Record<string, string>): LocalStateIo {
  return { read: (path: string) => files[path] ?? null };
}

const HEALTHY_ROUTES = {
  '/status': {
    status: 'running',
    version: '1.28.0',
    cluster: { enabled: true, role: 'master', nodeId: 'n1', heldSurfaceCount: 3, consumersRunning: true },
  },
  '/api/health': {
    overall: 'healthy',
    degradedDomains: [],
    providerProblems: [],
    integrationProblems: [],
    mcpProblems: { degraded: [], quarantined: [] },
    network: { controlPlane: { host: '127.0.0.1', port: 3421, scheme: 'http', ready: true, errors: [] } },
  },
  '/api/channels/status': { channels: [{ id: 'telegram', label: 'Telegram', state: 'ready', enabled: true }] },
  '/api/cluster/status': { membership: 'member', groupName: 'the workshop', groupId: 'g1', memberCount: 3 },
};

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    configManager: config(),
    daemonHomeDir: '/home/x/.goodvibes/daemon',
    controlPlaneConfigDir: CONFIG_DIR,
    readToken: () => JSON.stringify({ token: 'op-token' }),
    now: () => 1_000_000,
    localStateIo: io({}),
    ...overrides,
  };
}

describe('status talks to a running daemon over the remote-target convention', () => {
  test('defaults to this machine and authenticates with the operator token', async () => {
    const { fetchImpl, calls } = fakeFetch(HEALTHY_ROUTES);
    const { headers } = fakeGateway({ ok: true, body: { sessions: [] } });

    const result = await runStatusCommand({
      ...baseDeps(),
      fetchImpl,
      flags: { host: undefined, port: undefined, token: undefined, json: false },
    });

    expect(result.exitCode).toBe(0);
    expect(calls).toContain('/status');
    expect(calls).toContain('/api/health');
    expect(calls).toContain('/api/channels/status');
    expect(calls).toContain('/api/cluster/status');
    expect(headers[0]?.['Authorization']).toBe('Bearer op-token');
    expect(result.lines[0]).toContain('this machine');
  });

  test('--host/--port/--token aim it at another machine', async () => {
    const seen: string[] = [];
    const fetchImpl: DaemonFetch = async (url, init) => {
      seen.push(url);
      expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer other-token');
      const path = new URL(url).pathname;
      const body = (HEALTHY_ROUTES as Record<string, unknown>)[path];
      const wrapped = path.startsWith('/api/cluster/');
      return new Response(JSON.stringify(wrapped ? { ok: true, data: body } : body), { status: 200 });
    };
    fakeGateway({ ok: true, body: { sessions: [] } });

    const result = await runStatusCommand({
      ...baseDeps(),
      fetchImpl,
      flags: { host: 'http://10.0.0.7', port: 4321, token: 'other-token', json: false },
    });

    expect(result.exitCode).toBe(0);
    expect(seen[0]).toBe('http://10.0.0.7:4321/status');
    expect(result.lines[0]).toContain('http://10.0.0.7:4321');
  });

  test('reports version, health, binding, channels, cluster role and hosted sessions', async () => {
    const { fetchImpl } = fakeFetch(HEALTHY_ROUTES);
    fakeGateway({ ok: true, body: { sessions: [{ id: 'a' }, { id: 'b' }] } });

    const result = await runStatusCommand({
      ...baseDeps(),
      fetchImpl,
      flags: { host: undefined, port: undefined, token: undefined, json: false },
    });

    const text = result.lines.join('\n');
    expect(text).toContain('1.28.0');
    expect(text).toContain('health:   healthy');
    expect(text).toContain('bound:    http://127.0.0.1:3421');
    expect(text).toContain('1 of 1 switched on');
    expect(text).toContain('master in "the workshop" of 3');
    expect(text).toContain('2 hosted by this daemon');
  });

  test('a node that fell back to reading everything, or has a fenced surface, does not just say "master"', async () => {
    const { fetchImpl } = fakeFetch({
      ...HEALTHY_ROUTES,
      '/status': {
        status: 'running',
        version: '1.28.0',
        cluster: {
          enabled: true, coordination: 'ungated-fallback', role: 'master', nodeId: 'n1',
          surfaces: [{ role: 'master' }, { role: 'fenced' }],
        },
      },
    });
    fakeGateway({ ok: true, body: { sessions: [] } });

    const result = await runStatusCommand({
      ...baseDeps(),
      fetchImpl,
      flags: { host: undefined, port: undefined, token: undefined, json: false },
    });

    const text = result.lines.join('\n');
    expect(text).not.toContain('master in "the workshop"');
    expect(text).toContain('reading every inbound surface itself');
    expect(text).toContain('may be answered twice');
    expect(text).toContain('1 inbound surface fenced');
    expect(text).toContain('until the daemon restarts');
  });

  test('reports uptime, receipts, the rejected version and a rollback for a local daemon', async () => {
    const { fetchImpl } = fakeFetch(HEALTHY_ROUTES);
    fakeGateway({ ok: true, body: { sessions: [] } });

    const result = await runStatusCommand({
      ...baseDeps({
        localStateIo: io({
          [PATHS.markerPath]: JSON.stringify({
            state: 'running',
            at: 400_000,
            failedStarts: 2,
            rejectedVersion: '1.27.9',
            autoRollbackAt: 900_000,
          }),
          [PATHS.receiptsPath]: JSON.stringify([{ id: 'r1', text: 'updated to 1.28.0', at: 500_000 }]),
        }),
      }),
      fetchImpl,
      flags: { host: undefined, port: undefined, token: undefined, json: false },
    });

    const text = result.lines.join('\n');
    expect(text).toContain('uptime:   10m 0s');
    expect(text).toContain('2 consecutive start attempts');
    expect(text).toContain('rejected: 1.27.9');
    expect(text).toContain('rollback: an automatic rollback is in force');
    expect(text).toContain('updated to 1.28.0');
  });

  test('for a remote daemon those lines say they cannot be read from here', async () => {
    const { fetchImpl } = fakeFetch(HEALTHY_ROUTES);
    fakeGateway({ ok: true, body: { sessions: [] } });

    const result = await runStatusCommand({
      ...baseDeps(),
      fetchImpl,
      flags: { host: 'http://10.0.0.7', port: undefined, token: 'other', json: false },
    });

    expect(result.lines.join('\n')).toContain('run this command on that machine');
  });

  test('an unreachable daemon is the one failure that fails the command', async () => {
    const fetchImpl: DaemonFetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    fakeGateway({ ok: true, body: { sessions: [] } });

    const result = await runStatusCommand({
      ...baseDeps(),
      fetchImpl,
      flags: { host: undefined, port: undefined, token: undefined, json: false },
    });

    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('could not reach');
    expect(result.lines.join('\n')).toContain('service-status');
  });

  test('one broken sub-question is a line, not a failed command', async () => {
    const { fetchImpl } = fakeFetch(HEALTHY_ROUTES, { missing: ['/api/channels/status'] });
    fakeGateway({ ok: false, status: 404, body: { error: 'Unknown gateway method: sessions.hosted.list', code: 'METHOD_NOT_FOUND' } });

    const result = await runStatusCommand({
      ...baseDeps(),
      fetchImpl,
      flags: { host: undefined, port: undefined, token: undefined, json: false },
    });

    expect(result.exitCode).toBe(0);
    const text = result.lines.join('\n');
    expect(text).toContain('channels: could not read');
    expect(text).toContain('sessions: could not read');
    expect(text).toContain('does not know this command');
  });

  test('a missing operator token is refused with the fix, not attempted anonymously', async () => {
    const { fetchImpl, calls } = fakeFetch(HEALTHY_ROUTES);
    fakeGateway({ ok: true, body: { sessions: [] } });

    const result = await runStatusCommand({
      ...baseDeps({ readToken: () => undefined }),
      fetchImpl,
      flags: { host: undefined, port: undefined, token: undefined, json: false },
    });

    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('no operator token');
    expect(calls).toEqual([]);
  });

  test('--json is one document carrying every part', async () => {
    const { fetchImpl } = fakeFetch(HEALTHY_ROUTES);
    fakeGateway({ ok: true, body: { sessions: [{ id: 'a' }] } });

    const result = await runStatusCommand({
      ...baseDeps(),
      fetchImpl,
      flags: { host: undefined, port: undefined, token: undefined, json: true },
    });

    expect(result.lines.length).toBe(1);
    const parsed = JSON.parse(result.lines[0] as string) as {
      ok: boolean;
      data: Record<string, unknown>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data['isLocal']).toBe(true);
    expect((parsed.data['identity'] as { version: string }).version).toBe('1.28.0');
    expect((parsed.data['hostedSessions'] as { count: number }).count).toBe(1);
    expect(parsed.data['cluster']).toBeDefined();
  });

  test('the hosted-session count comes from the list verb, by name', async () => {
    const { fetchImpl } = fakeFetch(HEALTHY_ROUTES);
    const { methodIds } = fakeGateway({ ok: true, body: { sessions: [] } });

    await runStatusCommand({
      ...baseDeps(),
      fetchImpl,
      flags: { host: undefined, port: undefined, token: undefined, json: false },
    });

    expect(methodIds).toEqual(['sessions.hosted.list']);
  });
});

describe('update asks the daemon about its own updates', () => {
  const UPDATE_STATUS = {
    armed: true, offReason: '', currentVersion: '1.28.0', releasesUrl: 'https://example.invalid/releases',
    checkIntervalMs: 3_600_000, firstCheckDelayMs: 60_000, failedCheckCount: 2, lastCheckFailure: 'release index unreachable',
    pendingVersion: null, rejectedVersion: '1.27.9',
  };

  test('reads update.status from the daemon and the receipts from this machine', async () => {
    const { fetchImpl } = fakeFetch({ '/status': { status: 'running', version: '1.28.0' } });
    const { methodIds } = fakeGateway({ ok: true, body: UPDATE_STATUS });

    const result = await runUpdateCommand({
      ...baseDeps({
        localStateIo: io({
          [PATHS.markerPath]: JSON.stringify({ state: 'running', at: 400_000, failedStarts: 0, autoRollbackAt: 1 }),
          [PATHS.receiptsPath]: JSON.stringify([{ id: 'r', text: 'swapped in 1.28.0', at: 2 }]),
        }),
      }),
      fetchImpl,
      flags: { host: undefined, port: undefined, token: undefined, json: false, check: false },
    });

    expect(result.exitCode).toBe(0);
    expect(methodIds).toEqual(['update.status']);
    const text = result.lines.join('\n');
    expect(text).toContain('updates:  on, checking every 1h 0m');
    expect(text).toContain('2 checks in a row failed: release index unreachable');
    expect(text).toContain('rejected: 1.27.9');
    expect(text).toContain('rollback: an automatic rollback is in force');
    expect(text).toContain('swapped in 1.28.0');
  });

  test('--check runs update.check and reports what the check did', async () => {
    const { fetchImpl } = fakeFetch({ '/status': { status: 'running', version: '1.28.0' } });
    const { methodIds } = fakeGateway({ ok: true, body: { ...UPDATE_STATUS, check: 'ran' } });

    const result = await runUpdateCommand({
      ...baseDeps(),
      fetchImpl,
      flags: { host: undefined, port: undefined, token: undefined, json: true, check: true },
    });

    expect(result.exitCode).toBe(0);
    expect(methodIds).toEqual(['update.check']);
    const parsed = JSON.parse(result.lines[0] as string) as { data: Record<string, unknown> };
    expect(parsed.data['check']).toBe('ran');
  });

  test('a daemon on this machine that does not answer still shows what its files say', async () => {
    const fetchImpl: DaemonFetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    fakeGateway({ ok: false, status: 503 });
    const result = await runUpdateCommand({
      ...baseDeps({
        localStateIo: io({
          [PATHS.markerPath]: JSON.stringify({ state: 'running', at: 400_000, failedStarts: 3, rejectedVersion: '1.27.9' }),
          [PATHS.receiptsPath]: JSON.stringify([{ id: 'r', text: 'rolled back from 1.27.9', at: 2 }]),
        }),
      }),
      fetchImpl,
      flags: { host: undefined, port: undefined, token: undefined, json: false, check: false },
    });
    expect(result.exitCode).toBe(1);
    const text = result.lines.join('\n');
    expect(text).toContain('rejected: 1.27.9');
    expect(text).toContain('rolled back from 1.27.9');
  });

  test('an unreachable daemon fails with the reason', async () => {
    const fetchImpl: DaemonFetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await runUpdateCommand({
      ...baseDeps(),
      fetchImpl,
      flags: { host: undefined, port: undefined, token: undefined, json: false, check: false },
    });
    expect(result.exitCode).toBe(1);
  });
});
