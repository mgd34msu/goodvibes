import { describe, expect, test } from 'bun:test';

import { dispatchMcpRoutes } from '../platform/src/platform/daemon/http/mcp-routes.ts';
import type { McpEffectiveConfig } from '../platform/src/platform/mcp/config.ts';
import {
  MCP_CONFIG_RESPONSE_SCHEMA,
  MCP_REVEAL_RESPONSE_SCHEMA,
  MCP_SERVER_CONFIG_SCHEMA,
} from '../platform/src/platform/control-plane/method-catalog-runtime-mcp.ts';
import { firstJsonSchemaFailure } from '../transport-http/src/index.js';

const LOCATION = { scope: 'project' as const, kind: 'project-goodvibes' as const, path: '/tmp/mcp.json', writable: true };
const EFFECTIVE: McpEffectiveConfig = {
  locations: [LOCATION],
  servers: [
    { server: { name: 'stdio-one', command: 'billing-mcp', args: [] }, source: LOCATION },
    { server: { name: 'remote-one', url: 'https://mcp.example.com/mcp?key=abc', args: [] }, source: LOCATION },
  ],
};

const context = {
  mcpRegistry: {
    getEffectiveConfig: () => EFFECTIVE,
    reload: async () => ({}),
    upsertServerConfig: async () => ({}),
    removeServerConfig: async () => ({}),
    listServers: () => [],
    listServerSecurity: () => [],
    listServerSandboxBindings: () => [],
    listAllTools: async () => [],
  },
  roots: { workingDirectory: '/tmp', homeDirectory: '/tmp' },
  parseJsonBody: async () => ({}),
  parseOptionalJsonBody: async () => null,
  requireAdmin: () => null,
} as unknown as Parameters<typeof dispatchMcpRoutes>[1];

async function read(path: string): Promise<unknown> {
  const res = await dispatchMcpRoutes(new Request(`http://localhost${path}`), context);
  return res!.json();
}

describe('MCP server schemas describe HTTP servers', () => {
  test('the config and reveal responses for a url server validate, and a stdio server still does', async () => {
    const config = await read('/api/mcp/config') as { servers: Array<{ name: string; command: string | null; url: string | null }> };
    expect(config.servers.find((s) => s.name === 'remote-one')).toMatchObject({ command: null });
    expect(firstJsonSchemaFailure(MCP_CONFIG_RESPONSE_SCHEMA, config)).toBeUndefined();
    const revealed = await read('/api/mcp/servers/reveal');
    expect(firstJsonSchemaFailure(MCP_REVEAL_RESPONSE_SCHEMA, revealed)).toBeUndefined();
  });

  test('the upsert server accepts a command or a url and refuses neither', () => {
    expect(firstJsonSchemaFailure(MCP_SERVER_CONFIG_SCHEMA, { name: 'a', command: 'x' })).toBeUndefined();
    expect(firstJsonSchemaFailure(MCP_SERVER_CONFIG_SCHEMA, { name: 'a', url: 'https://mcp.example.com/mcp' })).toBeUndefined();
    expect(firstJsonSchemaFailure(MCP_SERVER_CONFIG_SCHEMA, { name: 'a' })).toBeDefined();
  });
});
