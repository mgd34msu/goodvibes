// The mcp tool's approve-quarantine records who approved from the turn the
// call belongs to (the owner, or the surface the turn arrived on), never from
// an operatorId the model writes into the arguments.
import { describe, expect, test } from 'bun:test';
import { createMcpTool } from '../platform/src/platform/tools/mcp/index.ts';
import { withTurnSurface } from '../platform/src/platform/security/turn-boundary.ts';
import type { McpRegistry } from '../platform/src/platform/mcp/registry.ts';

function toolWithRecorder(schemaFreshness = 'quarantined') {
  const approvals: Array<[string, string]> = [];
  const registry = {
    listServerSecurity: () => [{ name: 'docs', schemaFreshness }],
    approveSchemaQuarantine: (server: string, operator: string) => { approvals.push([server, operator]); },
  } as unknown as McpRegistry;
  return { tool: createMcpTool(registry), approvals };
}

describe('mcp approve-quarantine approver', () => {
  test('owner-direct input records the owner', async () => {
    const { tool, approvals } = toolWithRecorder();
    const result = await tool.execute({ mode: 'approve-quarantine', serverName: 'docs' });
    expect(result.success).toBe(true);
    expect(approvals).toEqual([['docs', 'owner']]);
  });

  test('a turn from a surface records that surface', async () => {
    const { tool, approvals } = toolWithRecorder();
    await withTurnSurface({ surface: 'telegram' }, () => tool.execute({ mode: 'approve-quarantine', serverName: 'docs' }));
    expect(approvals).toEqual([['docs', 'surface:telegram']]);
  });

  test('an operatorId in the arguments is not a parameter and names no one', async () => {
    const { tool, approvals } = toolWithRecorder();
    expect(tool.definition.parameters.properties).not.toHaveProperty('operatorId');
    await tool.execute({ mode: 'approve-quarantine', serverName: 'docs', operatorId: 'operator-henry' });
    expect(approvals.map(([, operator]) => operator)).not.toContain('operator-henry');
  });

  test('a server that is not quarantined is refused without calling the registry', async () => {
    const { tool, approvals } = toolWithRecorder('fresh');
    const result = await tool.execute({ mode: 'approve-quarantine', serverName: 'docs' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('is not quarantined');
    expect(approvals).toEqual([]);
  });

  test('an unknown server is refused with the known names', async () => {
    const { tool, approvals } = toolWithRecorder();
    const result = await tool.execute({ mode: 'approve-quarantine', serverName: 'nope' });
    expect(result.error).toContain('Known servers: docs');
    expect(approvals).toEqual([]);
  });
});

describe('mcp schema refusal', () => {
  test('an unknown tool names why and how to list current names', async () => {
    const registry = { listServerSecurity: () => [{ name: 'docs', schemaFreshness: 'fresh' }], getToolSchema: async () => null } as unknown as McpRegistry;
    const tool = createMcpTool(registry);
    expect((await tool.execute({ mode: 'schema', qualifiedName: 'search' })).error).toContain('not a qualified name');
    expect((await tool.execute({ mode: 'schema', qualifiedName: 'mcp:other:search' })).error).toContain("no MCP server named 'other'");
    expect((await tool.execute({ mode: 'schema', qualifiedName: 'mcp:docs:search' })).error).toContain('mode=tools');
  });
});
