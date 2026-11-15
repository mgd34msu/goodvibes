import { afterEach, expect, test } from 'bun:test';
import { McpRegistry } from '../platform/src/platform/mcp/registry.js';
import { createMcpApi } from '../platform/src/platform/mcp/mcp-api.js';
import { SandboxSessionRegistry } from '../platform/src/platform/runtime/sandbox/session-registry.js';
import { MCP_STATELESS_REVISION } from '../platform/src/platform/mcp/protocol.js';
import { useGateReadings, READ_ONLY } from './_helpers/gate-readings.ts';

useGateReadings([['synthetic', READ_ONLY]]);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function loopback() {
  const calls: string[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || !('method' in body) || !('id' in body)) return new Response(null, { status: 400 });
    const result = body.method === 'server/discover' ? { supportedProtocolVersions: [MCP_STATELESS_REVISION], capabilities: { tools: {} } }
      : body.method === 'tools/list' ? { tools: [{ name: 'synthetic', description: 'Synthetic loopback-only fixture.',
        inputSchema: { type: 'object', additionalProperties: true }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }] }
      : body.method === 'tools/call' ? (calls.push('tools/call'), { content: [{ type: 'text', text: 'loopback-result' }] }) : {};
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  } });
  let onHook: (() => void) | undefined;
  const registry = new McpRegistry({ sandboxSessions: new SandboxSessionRegistry('/synthetic/mcp-currentness'),
    hookDispatcher: { async fire(event) { if (event.path === 'Pre:mcp:call') onHook?.(); return { ok: true }; } } });
  cleanup.push(async () => { try { await registry.disconnectAll(); } finally { server.stop(true); } });
  return { registry, calls, api: createMcpApi(registry), url: `http://127.0.0.1:${server.port}/mcp`, onHook(callback: () => void) { onHook = callback; } };
}

test('real MCP API carries exact caller currentness through to the loopback transport', async () => {
  const f = loopback(); await f.registry.connectServer({ name: 'synthetic', url: f.url, trustMode: 'allow-all' });
  let checks = 0; const options = { assertCurrent() { checks++; } };
  const schema = await f.api.getToolSchema?.('mcp:synthetic:synthetic', options);
  expect(schema?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  const result = await f.api.callTool?.('mcp:synthetic:synthetic', {}, options);
  expect(result).toEqual({ content: [{ type: 'text', text: 'loopback-result' }] }); expect(f.calls).toEqual(['tools/call']); expect(checks).toBeGreaterThan(3);
});

test.each(['revoked', 'cancelled'] as const)('real MCP pre-call async boundary refuses %s before transport write', async failure => {
  const f = loopback(); await f.registry.connectServer({ name: 'synthetic', url: f.url, trustMode: 'allow-all' });
  await f.api.getToolSchema?.('mcp:synthetic:synthetic');
  let current = true; const controller = new AbortController();
  const options = { signal: controller.signal, assertCurrent() { if (!current) throw new Error('Synthetic caller retired'); } };
  f.onHook(() => {
    if (failure === 'revoked') current = false;
    if (failure === 'cancelled') controller.abort();
  });

  await expect(f.api.callTool?.('mcp:synthetic:synthetic', {}, options)).rejects.toThrow(); expect(f.calls).toEqual([]);
});

test('a schema read before the server changed its tool list is refused before dispatch', async () => {
  const f = loopback(); await f.registry.connectServer({ name: 'synthetic', url: f.url, trustMode: 'allow-all' });
  const selected = await f.api.getToolSchema?.('mcp:synthetic:synthetic');
  expect(selected).not.toBeNull();
  const client = f.registry.getClient('synthetic') as unknown as { _handleNotification(n: { jsonrpc: '2.0'; method: string }): void };
  client._handleNotification({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  const refreshed = await f.api.getToolSchema?.('mcp:synthetic:synthetic');
  expect(refreshed).not.toBe(selected); expect(refreshed).toEqual(selected);
  await expect(f.api.callTool?.('mcp:synthetic:synthetic', {}, { expectedSchema: selected ?? undefined })).rejects.toThrow('changed after it was read');
  expect(f.calls).toEqual([]);
  await expect(f.api.callTool?.('mcp:synthetic:synthetic', {}, { expectedSchema: refreshed ?? undefined })).resolves.toEqual({ content: [{ type: 'text', text: 'loopback-result' }] });
  expect(f.calls).toEqual(['tools/call']);
});
