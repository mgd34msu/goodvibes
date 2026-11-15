import { expect, test } from 'bun:test';
import { McpRegistry } from '../platform/src/platform/mcp/registry.js';
import { SandboxSessionRegistry } from '../platform/src/platform/runtime/sandbox/session-registry.js';
import { MCP_STATELESS_REVISION } from '../platform/src/platform/mcp/protocol.js';
import { withExternalOperationSource } from '../platform/src/platform/permissions/external-operation-scope.js';
import { useGateReadings } from './_helpers/gate-readings.ts';

useGateReadings();
test('McpRegistry blocks real loopback tool transport when its pre-call hook returns ok false', async () => {
  let called = false;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || !('method' in body) || !('id' in body)) return new Response(null, { status: 400 });
    const result = body.method === 'server/discover' ? { supportedProtocolVersions: [MCP_STATELESS_REVISION], capabilities: { tools: {} } }
      : body.method === 'tools/list' ? { tools: [{ name: 'write_file', description: 'Synthetic intercepted write.', inputSchema: { type: 'object' } }] }
      : body.method === 'tools/call' ? (called = true, { ok: true }) : {};
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  } });
  const registry = new McpRegistry({ hookDispatcher: { fire: async () => ({ ok: false, error: 'policy rejected call' }) },
    sandboxSessions: new SandboxSessionRegistry('/synthetic/mcp-prehook') });
  try {
    await registry.connectServer({ name: 'server', url: `http://127.0.0.1:${server.port}/mcp`, trustMode: 'allow-all' });
    await expect(registry.callTool('mcp:server:write_file', {})).rejects.toThrow('pre-call hook failed'); expect(called).toBe(false);
  } finally { await registry.disconnectAll(); server.stop(true); }
});

test('McpRegistry does not quarantine a healthy server after three aborted calls', async () => {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || !('method' in body) || !('id' in body)) return new Response(null, { status: 400 });
    const result = body.method === 'server/discover' ? { supportedProtocolVersions: [MCP_STATELESS_REVISION], capabilities: { tools: {} } }
      : body.method === 'tools/list' ? { tools: [{ name: 'read_thing', description: 'Synthetic read.', inputSchema: { type: 'object' } }] }
      : body.method === 'tools/call' ? { ok: true } : {};
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  } });
  const registry = new McpRegistry({ hookDispatcher: { fire: async () => ({ ok: true }) },
    sandboxSessions: new SandboxSessionRegistry('/synthetic/mcp-abort') });
  try {
    await registry.connectServer({ name: 'server', url: `http://127.0.0.1:${server.port}/mcp`, trustMode: 'allow-all' });
    for (let i = 0; i < 3; i++) {
      const controller = new AbortController(); controller.abort();
      await expect(registry.callTool('mcp:server:read_thing', {}, { signal: controller.signal })).rejects.toThrow();
    }
    await expect(registry.callTool('mcp:server:read_thing', {})).resolves.toBeDefined();
  } finally { await registry.disconnectAll(); server.stop(true); }
});

test('McpRegistry does not quarantine a healthy server when the operation source stops being current at any check', async () => {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || !('method' in body) || !('id' in body)) return new Response(null, { status: 400 });
    const result = body.method === 'server/discover' ? { supportedProtocolVersions: [MCP_STATELESS_REVISION], capabilities: { tools: {} } }
      : body.method === 'tools/list' ? { tools: [{ name: 'read_thing', description: 'Synthetic read.', inputSchema: { type: 'object' } }] }
      : body.method === 'tools/call' ? { ok: true } : {};
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  } });
  const registry = new McpRegistry({ hookDispatcher: { fire: async () => ({ ok: true }) },
    sandboxSessions: new SandboxSessionRegistry('/synthetic/mcp-source') });
  let checks = 0; let failAt = 0;
  // The source's own check fails without aborting any signal, as a caller-side currency failure does.
  const source = { sourceOf: () => ({ goal: 'Read the thing', criteria: [] }), inputFacts: [],
    assertCurrent() { if (++checks === failAt) throw new Error('caller no longer current'); } };
  const call = () => withExternalOperationSource(source, () => registry.callTool('mcp:server:read_thing', {}));
  try {
    await registry.connectServer({ name: 'server', url: `http://127.0.0.1:${server.port}/mcp`, trustMode: 'allow-all' });
    await call(); checks = 0; await call(); const total = checks;
    expect(total).toBeGreaterThan(0);
    // Fail the source check at every position a call makes it, covering the registry's own checks and
    // the ones the client runs through the operation it is handed.
    for (let position = 1; position <= total; position++) {
      checks = 0; failAt = position;
      await expect(call()).rejects.toThrow('caller no longer current');
    }
    failAt = 0;
    await expect(call()).resolves.toBeDefined();
  } finally { await registry.disconnectAll(); server.stop(true); }
});
