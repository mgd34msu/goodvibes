/** Request-level guards of the daemon HTTP route classes: what a malformed or
 * unauthorised request is answered with, and what a reader without the admin
 * role can no longer see or change. Services are stubs; the route code is real. */
import { describe, expect, test } from 'bun:test';
import type { DaemonBatchManager } from '../platform/src/platform/batch/index.js';
import { resolveGatewayPathTemplate } from '../platform/src/platform/daemon/helpers.js';
import { dispatchBatchRoutes } from '../platform/src/platform/daemon/http/batch-routes.js';
import { dispatchCloudflareRoutes } from '../platform/src/platform/daemon/http/cloudflare-routes.js';
import { HomeGraphRoutes } from '../platform/src/platform/daemon/http/home-graph-routes.js';
import { dispatchMcpRoutes, redactMcpArgs, redactMcpUrl } from '../platform/src/platform/daemon/http/mcp-routes.js';
import { dispatchModelRoutes } from '../platform/src/platform/daemon/http/model-routes.js';
import { ProjectPlanningRoutes } from '../platform/src/platform/daemon/http/project-planning-routes.js';
import { parseDaemonJsonBody, parseOptionalDaemonJsonBody } from '../platform/src/platform/daemon/http/router-request-body.js';

const denyAdmin = () => Response.json({ error: 'Admin role required' }, { status: 403 });
const allowAdmin = () => null;

function post(path: string, body?: unknown, init: { rawBody?: string } = {}): Request {
  return new Request(`http://daemon.local${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(init.rawBody !== undefined ? { body: init.rawBody } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe('batch routes', () => {
  function batchContext() {
    const calls: string[] = [];
    const manager = {
      createJob: async () => { calls.push('create'); return { id: 'job-1' }; },
      cancelJob: async (id: string) => { calls.push(`cancel:${id}`); return { id }; },
      getJob: async (id: string) => { calls.push(`get:${id}`); return null; },
      tick: async () => { calls.push('tick'); return { ok: true }; },
      listJobs: async () => [],
      describeRuntime: async () => ({}),
    } as unknown as DaemonBatchManager;
    return {
      calls,
      context: {
        batchManager: manager,
        parseJsonBody: parseDaemonJsonBody,
        parseOptionalJsonBody: parseOptionalDaemonJsonBody,
      },
    };
  }

  test('a message that is not an object with a role and content is a 400 and queues nothing', async () => {
    const { calls, context } = batchContext();
    const response = await dispatchBatchRoutes(post('/api/batch/jobs', { request: { messages: [1] } }), context);
    expect(response?.status).toBe(400);
    expect(await response!.json()).toMatchObject({ code: 'INVALID_BATCH_REQUEST' });
    expect(calls).toEqual([]);
  });

  test('a tool definition without a name and parameters is a 400', async () => {
    const { calls, context } = batchContext();
    const response = await dispatchBatchRoutes(post('/api/batch/jobs', {
      request: { messages: [{ role: 'user', content: 'hi' }], tools: [{ description: 'no name' }] },
    }), context);
    expect(response?.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test('a well-formed job is accepted', async () => {
    const { calls, context } = batchContext();
    const response = await dispatchBatchRoutes(post('/api/batch/jobs', {
      request: {
        messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yes' }],
        tools: [{ name: 'lookup', description: 'look it up', parameters: { type: 'object' } }],
      },
    }), context);
    expect(response?.status).toBe(202);
    expect(calls).toEqual(['create']);
  });

  test('a malformed percent escape in the job id is a 400 on read and on cancel', async () => {
    const { calls, context } = batchContext();
    const read = await dispatchBatchRoutes(new Request('http://daemon.local/api/batch/jobs/%E0%A4%A'), context);
    const cancel = await dispatchBatchRoutes(post('/api/batch/jobs/%E0%A4%A/cancel'), context);
    expect(read?.status).toBe(400);
    expect(cancel?.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('MCP routes redact credentials outside env', () => {
  test('redactMcpUrl drops userinfo and query values and keeps the shape', () => {
    expect(redactMcpUrl('https://user:pw@mcp.example.com/sse?key=abc&mode=x')).toBe('https://***:***@mcp.example.com/sse?key=***&mode=***');
    expect(redactMcpUrl('https://mcp.example.com/sse')).toBe('https://mcp.example.com/sse');
  });

  test('redactMcpArgs hides the value of credential-looking flags in both forms', () => {
    expect(redactMcpArgs(['--port', '80', '--api-key=abc', '--token', 'xyz', '--verbose', '-y', 'pkg'])).toEqual([
      '--port', '80', '--api-key=***', '--token', '***', '--verbose', '-y', 'pkg',
    ]);
    expect(redactMcpArgs(['https://h.example/x?token=abc'])).toEqual(['https://h.example/x?token=***']);
  });

  const server = { name: 'files', command: 'npx', args: ['srv', '--token', 'sekret'], env: { A: 'b' } };
  const urlServer = { name: 'remote', url: 'https://mcp.example.com/sse?key=sekret', args: [] as string[] };
  const config = {
    locations: [],
    servers: [server, urlServer].map((entry) => ({ server: entry, source: { scope: 'project', kind: 'file', path: '/x', writable: true } })),
  };
  const context = {
    mcpRegistry: { getEffectiveConfig: () => config } as never,
    roots: {} as never,
    parseJsonBody: parseDaemonJsonBody,
    parseOptionalJsonBody: parseOptionalDaemonJsonBody,
    requireAdmin: allowAdmin,
  };

  test('config answers withhold args and url secrets', async () => {
    const response = await dispatchMcpRoutes(new Request('http://daemon.local/api/mcp/config'), context);
    const text = await response!.text();
    expect(text).not.toContain('sekret');
    const body = JSON.parse(text) as { servers: Array<{ args: string[]; url: string | null }> };
    expect(body.servers[0]!.args).toEqual(['srv', '--token', '***']);
    expect(body.servers[1]!.url).toBe('https://mcp.example.com/sse?key=***');
  });

  test('the admin reveal route returns them whole so an edit can resend them', async () => {
    const response = await dispatchMcpRoutes(new Request('http://daemon.local/api/mcp/servers/reveal'), context);
    const body = await response!.json() as { servers: Array<{ args: string[]; url: string | null }> };
    expect(body.servers[0]!.args).toEqual(['srv', '--token', 'sekret']);
    expect(body.servers[1]!.url).toBe('https://mcp.example.com/sse?key=sekret');
  });

  test('a malformed percent escape in a server name is a 400', async () => {
    const response = await dispatchMcpRoutes(new Request('http://daemon.local/api/mcp/config/servers/%E0%A4%A', { method: 'DELETE' }), context);
    expect(response?.status).toBe(400);
  });
});

describe('gateway path templates', () => {
  test('a dot segment value is refused instead of collapsing into the parent path', () => {
    for (const value of ['..', '.']) {
      const result = resolveGatewayPathTemplate('/api/sessions/{id}/messages', { id: value });
      expect(result.path).toBeNull();
      expect(result.missing).toEqual(['id']);
      expect(result.invalid).toEqual(['id']);
    }
  });

  test('ordinary values are encoded as before', () => {
    expect(resolveGatewayPathTemplate('/api/sessions/{id}', { id: 'a/b' }).path).toBe('/api/sessions/a%2Fb');
    expect(resolveGatewayPathTemplate('/api/sessions/{id}', { id: 'a..b' }).path).toBe('/api/sessions/a..b');
  });
});

describe('planning and home graph routes answer body failures with the body\'s own status', () => {
  const unusedPlanning = {} as never;

  test('invalid JSON on an admin planning write is a 400 with the parser\'s message', async () => {
    const routes = new ProjectPlanningRoutes({
      projectPlanningService: unusedPlanning,
      parseJsonBody: parseDaemonJsonBody,
      parseOptionalJsonBody: parseOptionalDaemonJsonBody,
      requireAdmin: allowAdmin,
    });
    const response = await routes.handle(post('/api/projects/planning/state', undefined, { rawBody: '{not json' }));
    expect(response?.status).toBe(400);
    expect(await response!.json()).toMatchObject({ error: 'Invalid JSON body' });
  });

  test('an oversized body on a home graph write is a 413, not a 400', async () => {
    const routes = new HomeGraphRoutes({
      artifactStore: {} as never,
      homeGraphService: {} as never,
      parseJsonBody: async () => Response.json({ error: 'Request body too large' }, { status: 413 }),
      parseOptionalJsonBody: async () => null,
      requireAdmin: allowAdmin,
    });
    const response = await routes.handle(post('/api/homeassistant/home-graph/ingest/note', { title: 'x' }));
    expect(response?.status).toBe(413);
    expect(await response!.json()).toMatchObject({ error: 'Request body too large' });
  });

  test('a service refusal that names no status stays a 400, one that names a status keeps it', async () => {
    const make = (error: unknown) => new HomeGraphRoutes({
      artifactStore: {} as never,
      homeGraphService: { ingestNote: async () => { throw error; } } as never,
      parseJsonBody: async () => ({}),
      parseOptionalJsonBody: async () => null,
      requireAdmin: allowAdmin,
    });
    const plain = await make(new Error('title is required')).handle(post('/api/homeassistant/home-graph/ingest/note', {}));
    const limited = await make(Object.assign(new Error('slow down'), { status: 429 })).handle(post('/api/homeassistant/home-graph/ingest/note', {}));
    expect(plain?.status).toBe(400);
    expect(limited?.status).toBe(429);
  });

  test('a disk fault with an errno code answers 500, not a client error', async () => {
    const routes = new HomeGraphRoutes({
      artifactStore: {} as never,
      homeGraphService: { ingestNote: async () => { throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }); } } as never,
      parseJsonBody: async () => ({}),
      parseOptionalJsonBody: async () => null,
      requireAdmin: allowAdmin,
    });
    const response = await routes.handle(post('/api/homeassistant/home-graph/ingest/note', {}));
    expect(response?.status).toBe(500);
  });
});

describe('home graph ask and export', () => {
  function graph(requireAdmin: (req: Request) => Response | null) {
    const asked: Array<Record<string, unknown>> = [];
    const exported: unknown[] = [];
    const routes = new HomeGraphRoutes({
      artifactStore: {} as never,
      homeGraphService: {
        ask: async (input: Record<string, unknown>) => { asked.push(input); return { ok: true }; },
        exportSpace: async (input: unknown) => { exported.push(input); return { ok: true }; },
      } as never,
      parseJsonBody: async (req) => await req.json() as Record<string, unknown>,
      parseOptionalJsonBody: async () => null,
      requireAdmin,
    });
    return { routes, asked, exported };
  }

  test('a caller without the admin role asks read-only', async () => {
    const { routes, asked } = graph(denyAdmin);
    const response = await routes.handle(post('/api/homeassistant/home-graph/ask', { query: 'battery?' }));
    expect(response?.status).toBe(200);
    expect(asked).toEqual([{ query: 'battery?', readOnly: true }]);
  });

  test('an admin asks with the service free to refresh pages', async () => {
    const { routes, asked } = graph(allowAdmin);
    await routes.handle(post('/api/homeassistant/home-graph/ask', { query: 'battery?' }));
    expect(asked).toEqual([{ query: 'battery?' }]);
  });

  test('exporting the whole space needs the admin role', async () => {
    const denied = graph(denyAdmin);
    const response = await denied.routes.handle(post('/api/homeassistant/home-graph/export', {}));
    expect(response?.status).toBe(403);
    expect(denied.exported).toEqual([]);
  });
});

describe('model switch', () => {
  test('PATCH /api/models/current needs the admin role and reads nothing first', async () => {
    let bodyRead = false;
    const response = await dispatchModelRoutes(
      new Request('http://daemon.local/api/models/current', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ registryKey: 'openai:gpt-4o' }),
      }),
      {
        providerRegistry: {} as never,
        configManager: {} as never,
        runtimeBus: {} as never,
        parseJsonBody: async () => { bodyRead = true; return {}; },
        requireAdmin: denyAdmin,
      },
    );
    expect(response?.status).toBe(403);
    expect(bodyRead).toBe(false);
  });
});

describe('cloudflare routes', () => {
  test('a JSON null body is a 400, not a server error', async () => {
    const response = await dispatchCloudflareRoutes(post('/api/cloudflare/provision', undefined, { rawBody: 'null' }), {
      configManager: { get: () => undefined, set: () => {} } as never,
      parseJsonBody: parseDaemonJsonBody,
      parseOptionalJsonBody: parseOptionalDaemonJsonBody,
    });
    expect(response?.status).toBe(400);
    expect(await response!.json()).toMatchObject({ code: 'INVALID_JSON' });
  });
});
