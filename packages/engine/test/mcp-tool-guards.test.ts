/** The mcp tool does not answer with a false zero, and a change to an unknown server touches nothing. */
import { describe, expect, test } from 'bun:test';
import { createMcpTool } from '../platform/src/platform/tools/mcp/index.ts';
import type { McpRegistry } from '../platform/src/platform/mcp/registry.ts';

function harness() {
  const calls: string[] = [];
  const registry = {
    listServerSecurity: () => [{ name: 'docs', schemaFreshness: 'fresh', allowedPaths: [], allowedHosts: [] }],
    setServerTrustMode: (server: string, mode: string) => { calls.push(`trust ${server} ${mode}`); },
    setServerRole: (server: string, role: string) => { calls.push(`role ${server} ${role}`); },
  } as unknown as McpRegistry;
  return { tool: createMcpTool(registry), calls };
}

describe('mcp changes', () => {
  test('an unknown server is refused before the registry is touched', async () => {
    const { tool, calls } = harness();
    for (const args of [
      { mode: 'set-trust', serverName: 'dcos', trustMode: 'allow-all' },
      { mode: 'set-role', serverName: 'dcos', role: 'git' },
    ]) {
      const result = await tool.execute(args);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown MCP server: dcos');
      expect(result.error).toContain('Known servers: docs');
    }
    expect(calls).toEqual([]);
  });

  test('set-role reports the role that was stored, and what was asked when they differ', async () => {
    const { tool, calls } = harness();
    const result = await tool.execute({ mode: 'set-role', serverName: 'docs', role: 'deploy' });
    expect(JSON.parse(result.output!)).toEqual({ serverName: 'docs', role: 'ops', requested: 'deploy' });
    expect(calls).toEqual(['role docs ops']);
    const same = await tool.execute({ mode: 'set-role', serverName: 'docs', role: 'git' });
    expect(JSON.parse(same.output!)).toEqual({ serverName: 'docs', role: 'git' });
  });

  test('set-trust on a known server applies it', async () => {
    const { tool, calls } = harness();
    expect((await tool.execute({ mode: 'set-trust', serverName: 'docs', trustMode: 'blocked' })).success).toBe(true);
    expect(calls).toEqual(['trust docs blocked']);
  });
});

describe('mcp resources', () => {
  test('is not answered with zero resources it cannot know about', async () => {
    const { tool } = harness();
    const result = await tool.execute({ mode: 'resources' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot say whether a server has any');
  });
});
