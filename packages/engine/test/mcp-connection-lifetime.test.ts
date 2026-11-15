import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpClient } from '../platform/src/platform/mcp/client.js';
import { McpRegistry } from '../platform/src/platform/mcp/registry.js';
import { createMcpApi } from '../platform/src/platform/mcp/mcp-api.js';
import { MCP_STATELESS_REVISION } from '../platform/src/platform/mcp/protocol.js';
import { SandboxSessionRegistry } from '../platform/src/platform/runtime/sandbox/session-registry.js';
import type { McpPermissionManager } from '../platform/src/platform/runtime/mcp/permissions.js';
import { withExternalOperationSource } from '../platform/src/platform/permissions/external-operation-scope.js';
import { useGateReadings, READ_ONLY } from './_helpers/gate-readings.ts';

useGateReadings([['synthetic', READ_ONLY]]);

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function newRegistry(): McpRegistry {
  const registry = new McpRegistry({ sandboxSessions: new SandboxSessionRegistry('/synthetic/mcp-lifetime'),
    hookDispatcher: { async fire() { return { ok: true }; } } });
  cleanup.push(async () => { await registry.disconnectAll(); });
  return registry;
}

const tool = (name: string) => ({ name, description: `Synthetic ${name}.`, inputSchema: { type: 'object', additionalProperties: true },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } });

interface Loopback { readonly url: string; readonly requests: { readonly method: string; readonly headers: Headers; readonly params: Record<string, unknown> }[] }
/** A modern-era HTTP MCP server whose answer to each method is supplied by the test. */
function modernServer(answer: (method: string, params: Record<string, unknown>, headers: Headers) => unknown): Loopback {
  const requests: Loopback['requests'][number][] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const body = await request.json() as { id: number; method: string; params?: Record<string, unknown> };
    requests.push({ method: body.method, headers: request.headers, params: body.params ?? {} });
    const result = body.method === 'server/discover' ? { supportedProtocolVersions: [MCP_STATELESS_REVISION], capabilities: { tools: {} } }
      : answer(body.method, body.params ?? {}, request.headers);
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  } });
  cleanup.push(async () => { server.stop(true); });
  return { url: `http://127.0.0.1:${server.port}/mcp`, requests };
}

test('a tool call that finished is delivered even when its caller is no longer current afterwards', async () => {
  let retired = false;
  const server = modernServer((method) => {
    if (method === 'tools/list') return { tools: [tool('synthetic')] };
    if (method === 'tools/call') { retired = true; return { content: [{ type: 'text', text: 'done' }] }; }
    return {};
  });
  const registry = newRegistry();
  await registry.connectServer({ name: 'synthetic', url: server.url, trustMode: 'allow-all' });
  const api = createMcpApi(registry);
  const options = { assertCurrent() { if (retired) throw new Error('caller retired'); } };
  await expect(api.callTool?.('mcp:synthetic:synthetic', {}, options)).resolves.toEqual({ content: [{ type: 'text', text: 'done' }] });
  // The call ran, so the server is not marked as having failed it.
  expect(registry.listServerSecurity().find(entry => entry.name === 'synthetic')?.schemaFreshness).toBe('fresh');
});

test('over HTTP, a call made for an autonomous turn is delivered when the turn is no longer current afterwards', async () => {
  let retired = false;
  const server = modernServer((method) => {
    if (method === 'tools/list') return { tools: [tool('synthetic')] };
    if (method === 'tools/call') { retired = true; return { content: [{ type: 'text', text: 'done' }] }; }
    return {};
  });
  const registry = newRegistry();
  await registry.connectServer({ name: 'synthetic', url: server.url, trustMode: 'allow-all' });
  const api = createMcpApi(registry);
  const operation = { sourceOf: () => ({ goal: 'Run the synthetic tool', criteria: [] }), inputFacts: [], assertCurrent() { if (retired) throw new Error('caller retired'); } };
  await expect(withExternalOperationSource(operation, () => api.callTool!('mcp:synthetic:synthetic', {}))).resolves.toEqual({ content: [{ type: 'text', text: 'done' }] });
});

test('tools/list pages are followed, so tools beyond the first page are listed and callable', async () => {
  const server = modernServer((method, params) => {
    if (method === 'tools/list') {
      return params.cursor === 'page-2' ? { tools: [tool('second')] } : { tools: [tool('first')], nextCursor: 'page-2' };
    }
    return { content: [{ type: 'text', text: 'ok' }] };
  });
  const registry = newRegistry();
  await registry.connectServer({ name: 'synthetic', url: server.url, trustMode: 'allow-all' });
  expect((await registry.listAllTools()).map(entry => entry.toolName)).toEqual(['first', 'second']);
  expect(await registry.getToolSchema('mcp:synthetic:second')).toMatchObject({ name: 'second' });
});

test('configured headers reach every request, and a protocol header is never replaced by one of the same name', async () => {
  const server = modernServer((method) => method === 'tools/list' ? { tools: [tool('synthetic')] } : {});
  const registry = newRegistry();
  await registry.connectServer({ name: 'synthetic', url: server.url, trustMode: 'allow-all',
    headers: { Authorization: 'Bearer synthetic-token', 'content-type': 'text/plain' } });
  await registry.listAllTools();
  expect(server.requests.length).toBeGreaterThan(1);
  for (const request of server.requests) {
    expect(request.headers.get('authorization')).toBe('Bearer synthetic-token');
    expect(request.headers.get('content-type')).toBe('application/json');
  }
});

test('an expired legacy HTTP session is replaced and the request is sent again on it', async () => {
  let session = 0;
  const issued: string[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    if (request.method === 'DELETE') return new Response(null, { status: 200 });
    const body = await request.json() as { id?: number; method: string };
    if (body.method === 'server/discover') return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'unknown method' } });
    if (body.method === 'initialize') {
      const id = `session-${++session}`; issued.push(id);
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'synthetic', version: '1' } } },
        { headers: { 'Mcp-Session-Id': id } });
    }
    if (body.id === undefined) return new Response(null, { status: 202 });
    // Only the newest session is valid: the older one has expired on the server.
    if (request.headers.get('mcp-session-id') !== issued[issued.length - 1]) return new Response('unknown session', { status: 404 });
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { tools: [tool('synthetic')] } });
  } });
  cleanup.push(async () => { server.stop(true); });
  const registry = newRegistry();
  await registry.connectServer({ name: 'synthetic', url: `http://127.0.0.1:${server.port}/mcp`, trustMode: 'allow-all' });
  issued.push('server-side-rotation'); // the session the client holds is no longer the valid one
  // The 404 means the request was not run, so it is sent once more on the renewed session.
  expect(await registry.getToolSchema('mcp:synthetic:synthetic')).toMatchObject({ name: 'synthetic' });
  expect(issued).toHaveLength(3);
  expect((await registry.listAllTools()).map(entry => entry.toolName)).toEqual(['synthetic']);
});

test('an expired legacy HTTP session answered with a JSON-RPC 404 body is replaced too', async () => {
  let session = 0;
  const issued: string[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    if (request.method === 'DELETE') return new Response(null, { status: 200 });
    const body = await request.json() as { id?: number; method: string };
    if (body.method === 'server/discover') return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'unknown method' } });
    if (body.method === 'initialize') {
      const id = `session-${++session}`; issued.push(id);
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'synthetic', version: '1' } } },
        { headers: { 'Mcp-Session-Id': id } });
    }
    if (body.id === undefined) return new Response(null, { status: 202 });
    if (request.headers.get('mcp-session-id') !== issued[issued.length - 1]) {
      return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32001, message: 'Session not found' } }, { status: 404 });
    }
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { tools: [tool('synthetic')] } });
  } });
  cleanup.push(async () => { server.stop(true); });
  const registry = newRegistry();
  await registry.connectServer({ name: 'synthetic', url: `http://127.0.0.1:${server.port}/mcp`, trustMode: 'allow-all' });
  issued.push('server-side-rotation');
  // The 404 means the request was not run, so it is sent once more on the renewed session.
  expect(await registry.getToolSchema('mcp:synthetic:synthetic')).toMatchObject({ name: 'synthetic' });
  expect(issued).toHaveLength(3);
  expect((await registry.listAllTools()).map(entry => entry.toolName)).toEqual(['synthetic']);
});

test('a reload reports why a server did not connect', async () => {
  const closed = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(null, { status: 500 }) });
  const url = `http://127.0.0.1:${closed.port}/mcp`;
  closed.stop(true);
  const registry = newRegistry();
  const result = await registry.applyConfig([{ name: 'down', url }]);
  expect(result.servers).toEqual([expect.objectContaining({ name: 'down', connected: false, error: expect.any(String) })]);
});

test('a removed server leaves no permission record, so a server re-added under its name starts clean', async () => {
  const server = modernServer((method) => method === 'tools/list' ? { tools: [tool('synthetic')] } : {});
  const registry = newRegistry();
  const permissions = (registry as unknown as { permissions: McpPermissionManager }).permissions;
  await registry.applyConfig([{ name: 'reused', url: server.url }]);
  permissions.allowTool('reused', 'dangerous');
  expect(permissions.getServerPermissions('reused')?.toolOverrides.size).toBe(1);
  await registry.applyConfig([]);
  await registry.applyConfig([{ name: 'reused', url: server.url }]);
  expect(permissions.getServerPermissions('reused')?.toolOverrides.size).toBe(0);
});

// A stdio fake: legacy handshake, one tool, and a ping that reports every cancellation it was sent.
const scratch = mkdtempSync(join(tmpdir(), 'mcp-lifetime-'));
const script = join(scratch, 'server.ts');
beforeAll(() => {
  writeFileSync(script, `
const cancelled: unknown[] = [];
let buffer = '';
const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\\n');
process.stdin.on('data', (chunk: Buffer) => {
  buffer += chunk.toString('utf8');
  let index: number;
  while ((index = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'notifications/cancelled') { cancelled.push(message.params); continue; }
    if (message.id === undefined) continue;
    if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
    else if (message.method === 'ping') send({ jsonrpc: '2.0', id: message.id, result: { cancelled } });
    else if (message.method === 'tools/list') send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }] } });
    else if (message.method === 'tools/call') continue; // never answers: a slow tool
    else send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method' } });
  }
});
`);
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const stdioConfig = { name: 'fake', command: process.execPath, args: [script] };
const fakeHost = () => {
  const invalidations = new Set<() => void>();
  const host = { port: { model: 'synthetic', ask: async () => { throw new Error('no judgment is made while connecting'); } }, workspaceTrust: null,
    permissionManager: {}, signal: new AbortController().signal,
    config: { onDidInvalidate(listener: () => void) { invalidations.add(listener); return () => { invalidations.delete(listener); }; } } };
  return { host, invalidations };
};

test('a configuration write does not end a connected stdio server under a permission host', async () => {
  const registry = newRegistry();
  const { host, invalidations } = fakeHost();
  registry.setPermissionHost(host as never);
  await registry.connectServer(stdioConfig);
  expect(registry.listServers().find(entry => entry.name === 'fake')?.connected).toBe(true);
  for (const invalidate of [...invalidations]) invalidate();
  expect(await registry.getToolSchema('mcp:fake:echo')).toMatchObject({ name: 'echo' });
  expect((await registry.listAllTools()).map(entry => entry.toolName)).toEqual(['echo']);
});

test('a request that times out or is aborted tells the stdio server to cancel it', async () => {
  const client = new McpClient(stdioConfig, { timeout: 0 });
  cleanup.push(() => client.disconnect());
  await client.connect();
  const raw = client as unknown as { _rawRequest(method: string, params?: unknown, timeoutMs?: number, beforeSend?: () => void, signal?: AbortSignal): Promise<unknown> };
  const controller = new AbortController();
  const slow = raw._rawRequest('tools/call', { name: 'echo' }, undefined, undefined, controller.signal);
  const outcome = slow.then(() => 'answered', () => 'rejected');
  controller.abort(new Error('caller gave up'));
  expect(await outcome).toBe('rejected');
  const ping = await raw._rawRequest('ping') as { cancelled: { requestId: number; reason: string }[] };
  expect(ping.cancelled).toHaveLength(1);
  expect(ping.cancelled[0]).toMatchObject({ reason: 'request aborted' });
});

test('one tools/list fills the catalog, and error answers from a tool never quarantine its server', async () => {
  let lists = 0;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const body = await request.json() as { id: number; method: string };
    if (body.method === 'server/discover') return Response.json({ jsonrpc: '2.0', id: body.id, result: { supportedProtocolVersions: [MCP_STATELESS_REVISION], capabilities: { tools: {} } } });
    if (body.method === 'tools/list') { lists += 1; return Response.json({ jsonrpc: '2.0', id: body.id, result: { tools: [tool('synthetic')] } }); }
    return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Invalid params' } });
  } });
  cleanup.push(async () => { server.stop(true); });
  const registry = newRegistry();
  await registry.connectServer({ name: 'synthetic', url: `http://127.0.0.1:${server.port}/mcp`, trustMode: 'allow-all' });
  expect((await registry.listAllTools()).map(entry => entry.toolName)).toEqual(['synthetic']);
  for (let attempt = 0; attempt < 3; attempt++) {
    await expect(registry.callTool('mcp:synthetic:synthetic', {})).rejects.toThrow('Invalid params');
  }
  expect(lists).toBe(1);
  expect(registry.listServerSecurity()[0]).toMatchObject({ name: 'synthetic', schemaFreshness: 'fresh' });
});
