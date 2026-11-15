import { describe, expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { McpWorkspace } from '../../input/mcp-workspace.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { createShellPathService } from '../../runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeContext(calls: {
  readonly reload: ReturnType<typeof mock>;
  readonly upsertServerConfig: ReturnType<typeof mock>;
  readonly removeServerConfig: ReturnType<typeof mock>;
  readonly executeCommand: ReturnType<typeof mock>;
}): CommandContext {
  const root = makeProjectTempDir('gv-mcp-workspace-policy');
  const shellPaths = createShellPathService({
    workingDirectory: root,
    homeDirectory: root,
  });
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
          servers: [{
            server: {
              name: 'filesystem',
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
              role: 'filesystem',
              trustMode: 'constrained',
            },
            source: { scope: 'project', kind: 'project', path: join(root, '.goodvibes', 'mcp.json') },
          }],
          locations: [{
            scope: 'project',
            kind: 'project',
            path: join(root, '.goodvibes', 'mcp.json'),
            writable: true,
          }],
        }),
        listServerSecurity: () => [{
          name: 'filesystem',
          connected: true,
          role: 'filesystem',
          trustMode: 'constrained',
          schemaFreshness: 'fresh',
          allowedPaths: ['.'],
          allowedHosts: [],
        }],
        listAllTools: async () => [],
        reload: calls.reload,
        upsertServerConfig: calls.upsertServerConfig,
        removeServerConfig: calls.removeServerConfig,
      } as never,
    },
    renderRequest: () => {},
    print: () => {},
    exit: () => {},
    executeCommand: calls.executeCommand,
  } as unknown as CommandContext;
}

describe('McpWorkspace Agent policy', () => {
  test('writes and reloads MCP config only after workspace confirmation', async () => {
    const calls = {
      reload: mock(async () => ({ added: 0, changed: 0, removed: 0, unchanged: 1 })),
      upsertServerConfig: mock(async () => ({ path: 'mcp.json', reload: { added: 0, changed: 0, removed: 0, unchanged: 1 } })),
      removeServerConfig: mock(async () => ({ removed: true, path: 'mcp.json', reload: { added: 0, changed: 0, removed: 1, unchanged: 0 } })),
      executeCommand: mock(async () => true),
    };
    const workspace = new McpWorkspace();
    workspace.open(makeContext(calls));

    workspace.requestReload();
    expect(calls.reload).toHaveBeenCalledTimes(0);
    await workspace.reloadRuntime();
    expect(calls.reload).toHaveBeenCalledTimes(1);

    workspace.openAddForm();
    workspace.form.name = 'docs';
    workspace.form.command = 'npx';
    workspace.form.args = '-y @modelcontextprotocol/server-filesystem docs';
    await workspace.saveForm();
    expect(calls.upsertServerConfig).toHaveBeenCalledTimes(0);
    expect(workspace.mode).toBe('form');

    workspace.form.confirm = 'yes';
    await workspace.saveForm();
    expect(calls.upsertServerConfig).toHaveBeenCalledTimes(1);
    const [, scope, server] = calls.upsertServerConfig.mock.calls[0] as unknown as [unknown, string, { name: string; command: string; args: string[] }];
    expect(scope).toBe('project');
    expect(server).toMatchObject({ name: 'docs', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'docs'] });
    expect(workspace.mode).toBe('browse');

    workspace.requestDelete('filesystem');
    expect(calls.removeServerConfig).toHaveBeenCalledTimes(0);
    await workspace.confirmDelete();
    expect(calls.removeServerConfig).toHaveBeenCalledTimes(1);
    expect(calls.executeCommand).toHaveBeenCalledTimes(0);
  });

  test('a save the config writer refuses keeps the form and what was typed', async () => {
    const calls = {
      reload: mock(async () => ({ added: 0, changed: 0, removed: 0, unchanged: 1 })),
      upsertServerConfig: mock(async () => { throw new Error('the project config is not writable'); }),
      removeServerConfig: mock(async () => ({ removed: false, path: 'mcp.json', reload: { added: 0, changed: 0, removed: 0, unchanged: 1 } })),
      executeCommand: mock(async () => true),
    };
    const workspace = new McpWorkspace();
    workspace.open(makeContext(calls));
    workspace.openAddForm();
    workspace.form.name = 'docs';
    workspace.form.command = 'docs-server';
    workspace.form.confirm = 'yes';
    await workspace.saveForm();
    expect(workspace.mode).toBe('form');
    expect(workspace.form.name).toBe('docs');
    expect(workspace.statusTone).toBe('error');
    expect(workspace.lastError).toContain('not writable');
  });
});
