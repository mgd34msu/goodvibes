/**
 * Overlapping tool refreshes, and a refresh that finishes after the modal closed.
 *
 * Each refresh used to clear `loadingTools` and publish its own result no matter
 * who else was in flight, so the first of two refreshes switched the spinner off
 * while the second was still running, and a refresh finishing after close()
 * wrote a status line into a modal nobody was looking at.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { McpWorkspace } from '../../input/mcp-workspace.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { createShellPathService } from '../../runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function deferredTools() {
  const pending: Array<(tools: readonly unknown[]) => void> = [];
  const listAllTools = () => new Promise<readonly unknown[]>((resolve) => { pending.push(resolve); });
  return { listAllTools, pending };
}

function makeContext(listAllTools: () => Promise<readonly unknown[]>): CommandContext {
  const root = makeProjectTempDir('gv-mcp-workspace-refresh');
  const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  return {
    session: {} as never,
    provider: {} as never,
    workspace: { shellPaths } as never,
    platform: {} as never,
    ops: {} as never,
    extensions: {} as never,
    clients: {
      mcpApi: {
        getEffectiveConfig: () => ({
          servers: [],
          locations: [{ scope: 'project', kind: 'project', path: join(root, '.goodvibes', 'mcp.json'), writable: true }],
        }),
        listServerSecurity: () => [],
        listAllTools,
      } as never,
    },
    renderRequest: () => {},
    print: () => {},
    exit: () => {},
    executeCommand: async () => true,
  } as unknown as CommandContext;
}

const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('McpWorkspace tool refresh', () => {
  test('the first of two overlapping refreshes does not clear loading or publish', async () => {
    const tools = deferredTools();
    const workspace = new McpWorkspace();
    workspace.open(makeContext(tools.listAllTools));
    const second = workspace.refreshTools();
    await tick();
    expect(tools.pending).toHaveLength(2);
    expect(workspace.loadingTools).toBe(true);

    tools.pending[0]!([{ name: 'stale' }]);
    await tick();
    expect(workspace.loadingTools).toBe(true);
    expect(workspace.status).not.toContain('Tool list refreshed');

    tools.pending[1]!([{ name: 'a' }, { name: 'b' }]);
    await second;
    expect(workspace.loadingTools).toBe(false);
    expect(workspace.status).toContain('Tool list refreshed: 2 tool(s)');
    expect(workspace.tools).toHaveLength(2);
  });

  test('a refresh that finishes after the older one keeps the newer result', async () => {
    const tools = deferredTools();
    const workspace = new McpWorkspace();
    workspace.open(makeContext(tools.listAllTools));
    const second = workspace.refreshTools();
    await tick();
    tools.pending[1]!([{ name: 'new' }]);
    await second;
    tools.pending[0]!([{ name: 'old-1' }, { name: 'old-2' }, { name: 'old-3' }]);
    await tick();
    expect(workspace.tools).toHaveLength(1);
    expect(workspace.status).toContain('Tool list refreshed: 1 tool(s)');
  });

  test('a refresh that finishes after close publishes nothing and leaves loading cleared', async () => {
    const tools = deferredTools();
    const workspace = new McpWorkspace();
    workspace.open(makeContext(tools.listAllTools));
    await tick();
    expect(workspace.loadingTools).toBe(true);
    const before = workspace.status;

    workspace.close();
    expect(workspace.loadingTools).toBe(false);
    tools.pending[0]!([{ name: 'late' }]);
    await tick();
    expect(workspace.status).toBe(before);
    expect(workspace.status).not.toContain('Tool list refreshed');
  });
});
