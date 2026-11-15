import { describe, expect, test } from 'bun:test';
import type { DaemonFetch } from '@goodvibes-jev/engine/terminal-shell';
import { isSessionsSubcommand, runSessionsCommand } from '../../daemon/sessions-command.js';

function config() {
  const values: Record<string, unknown> = {
    'controlPlane.hostMode': 'local',
    'controlPlane.host': '127.0.0.1',
    'controlPlane.port': 3421,
  };
  return { get: (key: string): never => values[key] as never };
}

/**
 * The daemon's side of the generic gateway route,
 * `POST /api/control-plane/methods/{methodId}/invoke`: record the call and
 * answer with a canned body and status.
 */
function fakeGatewayFetch(answer: { ok: boolean; body?: unknown; status?: number } | { authFails: true }): {
  factory: DaemonFetch;
  methodIds: string[];
  bodies: unknown[];
  urls: string[];
  headers: Record<string, string>[];
} {
  const methodIds: string[] = [];
  const bodies: unknown[] = [];
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const factory: DaemonFetch = async (url, init) => {
    urls.push(url);
    headers.push({ ...(init?.headers as Record<string, string>) });
    if ('authFails' in answer) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    const match = /\/api\/control-plane\/methods\/([^/]+)\/invoke$/.exec(new URL(url).pathname);
    methodIds.push(match ? decodeURIComponent(match[1] as string) : '');
    bodies.push((JSON.parse(String(init?.body ?? '{}')) as { body?: unknown }).body);
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? (answer.ok ? 200 : 400) });
  };
  return { factory, methodIds, bodies, urls, headers };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    configManager: config(),
    daemonHomeDir: '/home/x/.goodvibes/daemon',
    controlPlaneConfigDir: '/home/x/.goodvibes',
    readToken: () => JSON.stringify({ token: 'op-token' }),
    now: () => 1_000_000,
    flags: { host: undefined, port: undefined, token: undefined, json: false, all: false },
    args: ['list'],
    ...overrides,
  };
}

describe('sessions arguments', () => {
  test('only list and kill are sessions subcommands', () => {
    expect(isSessionsSubcommand('list')).toBe(true);
    expect(isSessionsSubcommand('kill')).toBe(true);
    expect(isSessionsSubcommand('ls')).toBe(false);
    expect(isSessionsSubcommand(undefined)).toBe(false);
  });

  test('no subcommand is a usage refusal, exit 2', async () => {
    const { factory } = fakeGatewayFetch({ ok: true, body: { sessions: [] } });
    const result = await runSessionsCommand({ ...baseInput({ args: [] }), fetchImpl: factory });
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('sessions list');
  });

  test('an unrecognized subcommand names the two that exist', async () => {
    const { factory } = fakeGatewayFetch({ ok: true, body: { sessions: [] } });
    const result = await runSessionsCommand({ ...baseInput({ args: ['stop'] }), fetchImpl: factory });
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('try list or kill');
  });

  test('kill with no id is refused rather than treated as "kill everything"', async () => {
    const { factory, methodIds } = fakeGatewayFetch({ ok: true, body: {} });
    const result = await runSessionsCommand({ ...baseInput({ args: ['kill'] }), fetchImpl: factory });
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('kill needs the session to end');
    expect(methodIds).toEqual([]);
  });

  test('a stray extra argument is refused', async () => {
    const { factory } = fakeGatewayFetch({ ok: true, body: { sessions: [] } });
    expect((await runSessionsCommand({ ...baseInput({ args: ['list', 'x'] }), fetchImpl: factory })).exitCode).toBe(2);
    expect((await runSessionsCommand({ ...baseInput({ args: ['kill', 'a', 'b'] }), fetchImpl: factory })).exitCode).toBe(2);
  });

  test('a usage refusal in --json mode is still one JSON document', async () => {
    const { factory } = fakeGatewayFetch({ ok: true, body: {} });
    const result = await runSessionsCommand({
      ...baseInput({ args: ['kill'], flags: { host: undefined, port: undefined, token: undefined, json: true, all: false } }),
      fetchImpl: factory,
    });
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.lines[0] as string)).toMatchObject({ ok: false });
  });
});

describe('sessions list', () => {
  const RECORD = {
    id: 'hs-1',
    title: 'refactor the parser',
    workspaceRoot: '/srv/project',
    status: 'idle',
    effectiveDetachPolicy: 'survive',
    attachedClients: 1,
    turnCount: 7,
    updatedAt: 940_000,
  };

  test('calls the list verb on the gateway route with the operator token', async () => {
    const { factory, methodIds, bodies, urls, headers } = fakeGatewayFetch({ ok: true, body: { sessions: [RECORD] } });
    const result = await runSessionsCommand({ ...baseInput(), fetchImpl: factory });

    expect(result.exitCode).toBe(0);
    expect(methodIds).toEqual(['sessions.hosted.list']);
    expect(bodies).toEqual([{ includeTerminated: false }]);
    expect(urls[0]).toBe('http://127.0.0.1:3421/api/control-plane/methods/sessions.hosted.list/invoke');
    expect(headers[0]?.['Authorization']).toBe('Bearer op-token');
  });

  test('renders id, status, title, workspace and the facts that matter', async () => {
    const { factory } = fakeGatewayFetch({ ok: true, body: { sessions: [RECORD] } });
    const result = await runSessionsCommand({ ...baseInput(), fetchImpl: factory });
    const text = result.lines.join('\n');
    expect(text).toContain('hs-1');
    expect(text).toContain('idle');
    expect(text).toContain('refactor the parser');
    expect(text).toContain('/srv/project');
    expect(text).toContain('7 turns');
    expect(text).toContain('1 client attached');
    expect(text).toContain('on last detach: survive');
    expect(text).toContain('1m ago');
  });

  test('--all asks for terminated sessions too', async () => {
    const { factory, bodies } = fakeGatewayFetch({ ok: true, body: { sessions: [] } });
    await runSessionsCommand({
      ...baseInput({ flags: { host: undefined, port: undefined, token: undefined, json: false, all: true } }),
      fetchImpl: factory,
    });
    expect(bodies).toEqual([{ includeTerminated: true }]);
  });

  test('an empty list says so, and points at --all', async () => {
    const { factory } = fakeGatewayFetch({ ok: true, body: { sessions: [] } });
    const result = await runSessionsCommand({ ...baseInput(), fetchImpl: factory });
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain('hosting no sessions');
    expect(result.lines.join('\n')).toContain('--all');
  });

  test('a daemon that does not know the verb says exactly that', async () => {
    const { factory } = fakeGatewayFetch({ ok: false, status: 404, body: { error: 'Unknown gateway method: sessions.hosted.list', code: 'METHOD_NOT_FOUND' } });
    const result = await runSessionsCommand({ ...baseInput(), fetchImpl: factory });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('does not know this command');
  });

  test('a refused token is reported as a token problem, not a missing daemon', async () => {
    const { factory } = fakeGatewayFetch({ authFails: true });
    const result = await runSessionsCommand({ ...baseInput(), fetchImpl: factory });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('refused the operator token');
  });

  test('--json returns the daemon\'s own record', async () => {
    const { factory } = fakeGatewayFetch({ ok: true, body: { sessions: [RECORD] } });
    const result = await runSessionsCommand({
      ...baseInput({ flags: { host: undefined, port: undefined, token: undefined, json: true, all: false } }),
      fetchImpl: factory,
    });
    const parsed = JSON.parse(result.lines[0] as string) as { ok: boolean; data: { sessions: unknown[] } };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.sessions.length).toBe(1);
  });
});

describe('sessions kill', () => {
  test('calls the ws-only kill verb with the named id', async () => {
    const { factory, methodIds, bodies } = fakeGatewayFetch({
      ok: true,
      body: { session: { id: 'hs-1', status: 'terminated', terminatedReason: 'killed' } },
    });
    const result = await runSessionsCommand({ ...baseInput({ args: ['kill', 'hs-1'] }), fetchImpl: factory });

    expect(result.exitCode).toBe(0);
    expect(methodIds).toEqual(['sessions.hosted.kill']);
    expect(bodies).toEqual([{ sessionId: 'hs-1' }]);
    expect(result.lines.join('\n')).toContain('ended hs-1');
    expect(result.lines.join('\n')).toContain('ended: killed');
    expect(result.lines.join('\n')).toContain('retention window');
  });

  test('a refusal from the daemon is reported with its own fix line', async () => {
    const { factory } = fakeGatewayFetch({
      ok: false,
      status: 400,
      body: { error: 'no session hs-9', fix: 'run sessions list' },
    });
    const result = await runSessionsCommand({ ...baseInput({ args: ['kill', 'hs-9'] }), fetchImpl: factory });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('no session hs-9');
    expect(result.lines.join('\n')).toContain('run sessions list');
  });
});

describe('sessions against another machine', () => {
  test('--host/--port build the URL for that machine', async () => {
    const { factory, urls, headers } = fakeGatewayFetch({ ok: true, body: { sessions: [] } });
    await runSessionsCommand({
      ...baseInput({ flags: { host: 'http://10.0.0.7', port: 4321, token: 'other-token', json: false, all: false } }),
      fetchImpl: factory,
    });
    expect(urls[0]).toBe('http://10.0.0.7:4321/api/control-plane/methods/sessions.hosted.list/invoke');
    expect(headers[0]?.['Authorization']).toBe('Bearer other-token');
  });
});
