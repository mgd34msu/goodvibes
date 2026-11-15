/**
 * The MCP workspace reports what `/mcp` did, including a failure it printed rather than threw.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { McpWorkspace } from '../../input/mcp-workspace.ts';
import { capturedOutputReportsFailure } from '../../input/workspace-command-output.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { createShellPathService } from '../../runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeContext(run: (print: (text: string) => void) => Promise<boolean>) {
  const root = makeProjectTempDir('gv-mcp-workspace-outcome');
  const printed: string[] = [];
  const context = {
    session: {} as never,
    provider: {} as never,
    workspace: { shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }) } as never,
    platform: {} as never,
    ops: {} as never,
    extensions: {} as never,
    clients: {
      mcpApi: {
        getEffectiveConfig: () => ({ servers: [], locations: [{ scope: 'project', kind: 'project', path: join(root, '.goodvibes', 'mcp.json'), writable: true }] }),
        listServerSecurity: () => [],
        listAllTools: async () => [],
      } as never,
    },
    renderRequest: () => {},
    print: (text: string) => { printed.push(text); },
    exit: () => {},
    executeCommand: async () => run((text) => context.print(text)),
  } as unknown as CommandContext;
  return { context, printed };
}

describe('McpWorkspace command outcome', () => {
  test('a /mcp command that prints its failure and returns is shown as failed, and the text reaches the transcript', async () => {
    const { context, printed } = makeContext(async (print) => {
      print('MCP add failed Invalid role "bogus"');
      return true;
    });
    const workspace = new McpWorkspace();
    workspace.open(context);
    await workspace.reloadRuntime();
    expect(workspace.status).toContain('failed');
    expect(workspace.status).toContain('Invalid role');
    expect(workspace.lastError).toContain('MCP add failed');
    expect(printed).toEqual(['MCP add failed Invalid role "bogus"']);
  });

  test('a command that reports success is shown as completed', async () => {
    const { context } = makeContext(async (print) => {
      print('MCP runtime reloaded');
      return true;
    });
    const workspace = new McpWorkspace();
    workspace.open(context);
    await workspace.reloadRuntime();
    expect(workspace.status).toContain('completed');
    expect(workspace.lastError).toBeNull();
  });

  test('a failed save keeps the form and what was typed; a good one closes it', async () => {
    let fail = true;
    const { context } = makeContext(async (print) => {
      print(fail ? 'MCP add failed a server named docs already exists' : 'MCP server "docs" saved');
      return true;
    });
    const workspace = new McpWorkspace();
    workspace.open(context);
    workspace.openAddForm();
    workspace.form.name = 'docs';
    workspace.form.command = 'docs-server';
    workspace.form.confirm = 'yes';
    await workspace.saveForm();
    expect(workspace.mode).toBe('form');
    expect(workspace.form.name).toBe('docs');
    expect(workspace.status).toContain('failed');
    fail = false;
    await workspace.saveForm();
    expect(workspace.mode).toBe('browse');
    expect(workspace.status).toContain('completed');
  });

  test.each([
    ['usage line', 'Usage: /mcp add <name> <command>'],
    ['refusal without --yes', 'Refusing to remove MCP server docs without --yes.\nUsage: /mcp remove <server> [--scope project|global] --yes'],
    ['missing flag value', 'Missing value after --role.'],
    ['remove of an absent server', 'No project MCP server named "docs" exists in /tmp/x/mcp.json.\nIf it still appears, it is coming from another config scope or external MCP config.'],
  ])('the real /mcp %s output is read as a failure', (_name, text) => {
    expect(capturedOutputReportsFailure([text])).toBe(true);
  });

  test('a /mcp remove of an absent server is shown as failed in the workspace', async () => {
    const { context } = makeContext(async (print) => {
      print('No project MCP server named "docs" exists in /tmp/x/mcp.json.');
      return true;
    });
    const workspace = new McpWorkspace();
    workspace.open(context);
    await workspace.reloadRuntime();
    expect(workspace.status).toContain('failed');
    expect(workspace.lastError).not.toBeNull();
  });

  test('an ordinary success line is not read as a failure', () => {
    expect(capturedOutputReportsFailure(['Removed MCP server "docs" from project config /tmp/x. Reload +0 ~0 -1, unchanged 2.'])).toBe(false);
  });
});
