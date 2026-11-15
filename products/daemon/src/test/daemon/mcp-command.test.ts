import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { MCP_USAGE, runMcpCommand, type RunMcpCommandInput } from '../../daemon/mcp-command.js';
import { runDaemonCli } from '../../cli/run.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

function config() {
  const values: Record<string, unknown> = {
    'controlPlane.hostMode': 'local',
    'controlPlane.host': '127.0.0.1',
    'controlPlane.port': 3421,
  };
  return { get: (key: string): never => values[key] as never };
}

/** An inbound stream that yields the given lines and then ends, like a client closing stdin. */
function inputOf(...frames: unknown[]): AsyncIterable<string> {
  return (async function* () {
    for (const frame of frames) yield `${JSON.stringify(frame)}\n`;
  })();
}

function sinkOf(): { readonly written: string[]; readonly sink: { write(chunk: string): void } } {
  const written: string[] = [];
  return { written, sink: { write: (chunk) => { written.push(chunk); } } };
}

function frames(written: readonly string[]): Record<string, unknown>[] {
  return written.join('').split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
}

const SKILLS_BODY = { skills: [{ name: 'fixture-skill', description: 'A fixture skill', metadata: {} }] };

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };
const listTools = { jsonrpc: '2.0', id: 2, method: 'tools/list' };

function setup(overrides: Partial<RunMcpCommandInput> = {}) {
  const out = sinkOf();
  const stderr: string[] = [];
  const requests: { url: string; authorization: string | null }[] = [];
  const fetchImpl: RunMcpCommandInput['fetchImpl'] = async (input, init) => {
    const url = String(input);
    requests.push({ url, authorization: new Headers(init?.headers).get('authorization') });
    if (url.endsWith('/api/skills')) return Response.json(SKILLS_BODY);
    return Response.json({ version: '0.0.0-test' });
  };
  const input: RunMcpCommandInput = {
    configManager: config(),
    daemonHomeDir: '/unused',
    flags: { host: undefined, port: undefined, token: undefined },
    args: ['serve'],
    input: inputOf(initialize, listTools),
    output: out.sink,
    stderr: (line) => { stderr.push(line); },
    fetchImpl,
    readToken: () => JSON.stringify({ token: 'operator-token-fixture' }),
    ...overrides,
  };
  return { input, written: out.written, stderr, requests };
}

describe('goodvibes-daemon mcp serve', () => {
  test('answers initialize and tools/list with nothing but protocol frames on stdout, then ends when input closes', async () => {
    const { input, written, stderr, requests } = setup();
    expect(await runMcpCommand(input)).toBe(0);

    const replies = frames(written);
    expect(replies.map((reply) => reply['id'])).toEqual([1, 2]);
    expect(replies.every((reply) => reply['jsonrpc'] === '2.0')).toBe(true);
    const tools = (replies[1]!['result'] as { tools: { name: string }[] }).tools;
    expect(tools.some((tool) => tool.name === 'skills_list')).toBe(false);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain(`serving ${tools.length} tools`);
    // The daemon was checked with the operator token before the first frame.
    expect(requests[0]).toEqual({ url: 'http://127.0.0.1:3421/status', authorization: 'Bearer operator-token-fixture' });
  });

  test('by default it serves the agent slice: reads and the session lifecycle, nothing destructive', async () => {
    const { input, written } = setup();
    expect(await runMcpCommand(input)).toBe(0);
    const names = (frames(written)[1]!['result'] as { tools: { name: string }[] }).tools.map((tool) => tool.name);
    expect(names.slice(0, 3)).toEqual(['sessions_create', 'sessions_get', 'sessions_messages_create']);
    expect(names).toContain('tasks_list');
    expect(names).not.toContain('sessions_delete');
    expect(names.length).toBeLessThan(40);
  });

  test('--allow-write, --categories and --allow-destructive widen what is served', async () => {
    const narrow = setup({ flags: { host: undefined, port: undefined, token: undefined, categories: ['sessions'], allowWrite: true } });
    expect(await runMcpCommand(narrow.input)).toBe(0);
    const sessionNames = (frames(narrow.written)[1]!['result'] as { tools: { name: string }[] }).tools.map((tool) => tool.name);
    expect(sessionNames).toContain('sessions_delete');
    expect(sessionNames.every((name) => name.startsWith('sessions_'))).toBe(true);

    const every = setup({ flags: { host: undefined, port: undefined, token: undefined, categories: ['all'], allowWrite: true, allowDestructive: true } });
    expect(await runMcpCommand(every.input)).toBe(0);
    const everyCount = (frames(every.written)[1]!['result'] as { tools: unknown[] }).tools.length;
    expect(everyCount).toBeGreaterThan(sessionNames.length);
  });

  test('an unknown family is refused before any frame', async () => {
    const { input, written, stderr } = setup({ flags: { host: undefined, port: undefined, token: undefined, categories: ['no-such-family'] } });
    expect(await runMcpCommand(input)).toBe(1);
    expect(written).toEqual([]);
    expect(stderr[0]).toContain('no-such-family');
  });

  test('a client cancel aborts the call to the daemon and gets no response', async () => {
    let aborted = false;
    const { input, written } = setup({
      input: inputOf(
        initialize,
        { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'tasks_list', arguments: {} } },
        { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } },
      ),
      fetchImpl: async (request, init) => {
        if (!String(request).endsWith('/api/tasks')) return Response.json({ version: '0.0.0-test' });
        return await new Promise<Response>((_resolve, reject) => {
          const stop = (): void => { aborted = true; reject(init?.signal?.reason); };
          if (init?.signal?.aborted) stop();
          else init?.signal?.addEventListener('abort', stop);
        });
      },
    });
    expect(await runMcpCommand(input)).toBe(0);
    expect(aborted).toBe(true);
    expect(frames(written).map((frame) => frame['id'])).toEqual([1]);
  });

  test('a tool call reaches the daemon with the operator token', async () => {
    const { input, written, requests } = setup({
      flags: { host: undefined, port: undefined, token: undefined, categories: ['skills'] },
      input: inputOf(initialize, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'skills_list', arguments: {} } }),
    });
    expect(await runMcpCommand(input)).toBe(0);

    const reply = frames(written).find((frame) => frame['id'] === 3)!;
    const result = reply['result'] as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual(SKILLS_BODY);
    const call = requests.find((request) => request.url.endsWith('/api/skills'));
    expect(call?.authorization).toBe('Bearer operator-token-fixture');
  });

  test('a method published for the WebSocket only is invoked through the invoke-by-id endpoint', async () => {
    const posted: { url: string; body: unknown }[] = [];
    const { input, written } = setup({
      flags: { host: undefined, port: undefined, token: undefined, categories: ['checkpoints'] },
      input: inputOf(initialize, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'checkpoints_list', arguments: {} } }),
      fetchImpl: async (request, init) => {
        const url = String(request);
        if (url.includes('/invoke')) {
          posted.push({ url, body: JSON.parse(String(init?.body)) });
          return Response.json({ checkpoints: [] });
        }
        return Response.json({ version: '0.0.0-test' });
      },
    });
    expect(await runMcpCommand(input)).toBe(0);
    const result = frames(written).find((frame) => frame['id'] === 4)!['result'] as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ checkpoints: [] });
    expect(posted).toEqual([{ url: 'http://127.0.0.1:3421/api/control-plane/methods/checkpoints.list/invoke', body: { body: {} } }]);
  });

  test('without an operator token it names the missing pairing on one stderr line and writes nothing to stdout', async () => {
    const { input, written, stderr, requests } = setup({ readToken: () => undefined });
    expect(await runMcpCommand(input)).toBe(1);
    expect(written).toEqual([]);
    expect(requests).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain('no operator token was found');
    expect(stderr[0]).toContain('start the daemon once');
  });

  test('with no daemon running it names the unreachable daemon on one stderr line', async () => {
    const { input, written, stderr } = setup({
      fetchImpl: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:3421'); },
    });
    expect(await runMcpCommand(input)).toBe(1);
    expect(written).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain('could not reach the daemon on this machine');
    expect(stderr[0]).toContain('goodvibes-daemon service-status');
  });

  test('a daemon that refuses the token is reported as such', async () => {
    const { input, written, stderr } = setup({ fetchImpl: async () => new Response('no', { status: 401 }) });
    expect(await runMcpCommand(input)).toBe(1);
    expect(written).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain('refused the operator token');
  });

  test('anything other than `serve` is a usage error and touches nothing', async () => {
    const { input, written, stderr, requests } = setup({ args: [] });
    expect(await runMcpCommand(input)).toBe(2);
    expect(written).toEqual([]);
    expect(requests).toEqual([]);
    expect(stderr).toEqual([MCP_USAGE]);
  });
});

describe('goodvibes-daemon mcp serve through the CLI dispatcher', () => {
  test('connects to the daemon named by --port/--token and serves frames over the supplied stdio', async () => {
    const seen: { path: string; authorization: string | null }[] = [];
    const daemon = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        seen.push({ path, authorization: request.headers.get('authorization') });
        return Response.json(path === '/api/skills' ? SKILLS_BODY : { version: '0.0.0-test' });
      },
    });
    try {
      const root = makeOwnedTempDir('daemon-mcp-serve');
      const out = sinkOf();
      const stderr: string[] = [];
      const code = await runDaemonCli(
        ['mcp', 'serve', '--categories', 'skills', '--port', String(daemon.port), '--token', 'cli-token-fixture', '--daemon-home', join(root, 'daemon')],
        {
          env: { HOME: root, GOODVIBES_HOME: join(root, 'home') },
          cwd: root,
          stdout() { throw new Error('mcp serve must not print through the line writer'); },
          stderr: (line) => { stderr.push(line); },
          mcpStdio: {
            input: inputOf(initialize, listTools, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'skills_list', arguments: {} } }),
            output: out.sink,
          },
        },
      );
      expect(code).toBe(0);
      expect(stderr).toHaveLength(1);
      expect(stderr[0]).toContain('serving');
      const replies = frames(out.written);
      expect(replies.map((frame) => frame['id'])).toEqual([1, 2, 3]);
      expect((replies[2]!['result'] as { isError?: boolean }).isError).toBeUndefined();
      expect(seen.map((request) => request.path)).toEqual(['/status', '/api/skills']);
      expect(seen.every((request) => request.authorization === 'Bearer cli-token-fixture')).toBe(true);
    } finally {
      await daemon.stop(true);
    }
  });
});
