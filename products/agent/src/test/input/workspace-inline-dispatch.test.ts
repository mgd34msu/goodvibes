/**
 * Inline workspace commands: what the result pane shows, and what happens to
 * `context.print` while a command runs.
 */
import { describe, expect, test } from 'bun:test';
import { AgentWorkspace } from '../../input/agent-workspace.ts';
import { createAgentWorkspaceProviderCommandEditor } from '../../input/agent-workspace-provider-command-editors.ts';
import { InputHandler } from '../../input/handler.ts';
import type { CommandContext } from '../../input/command-registry.ts';

const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Harness {
  readonly workspace: AgentWorkspace;
  readonly context: CommandContext;
  readonly printed: string[];
  readonly originalPrint: (text: string) => void;
  dispatch(command: string, display?: string): void;
}

function harness(executeCommand: CommandContext['executeCommand']): Harness {
  const printed: string[] = [];
  const originalPrint = (text: string): void => { printed.push(text); };
  const context = { print: originalPrint, executeCommand } as unknown as CommandContext;
  const workspace = new AgentWorkspace();
  const stub = { agentWorkspace: workspace, requestRender: () => {} };
  const dispatchInline = InputHandler.prototype.dispatchAgentWorkspaceCommand.bind(stub as unknown as InputHandler);
  workspace.open(context, (command, behavior, display) => dispatchInline(command, context, behavior, display));
  return { workspace, context, printed, originalPrint, dispatch: (command, display) => dispatchInline(command, context, 'inline', display) };
}

describe('inline workspace dispatch', () => {
  test('two commands that settle out of order leave context.print as it was, and later prints reach it', async () => {
    const settle: Array<() => void> = [];
    const h = harness(() => new Promise<boolean>((resolve) => { settle.push(() => resolve(true)); }));
    h.dispatch('/routines reconcile');
    h.dispatch('/schedule list');
    expect(settle).toHaveLength(2);
    settle[1]!();
    await nextTick();
    settle[0]!();
    await nextTick();
    expect(h.context.print).toBe(h.originalPrint);
    h.context.print('after both');
    expect(h.printed).toEqual(['after both']);
  });

  test('output from the command is captured, a notice printed by something else meanwhile is not', async () => {
    let finish: () => void = () => {};
    const h = harness(async () => {
      h.context.print('line from the command');
      await new Promise<void>((resolve) => { finish = resolve; });
      return true;
    });
    h.dispatch('/mcp list');
    // Something unrelated prints while the command is still running.
    const background = h.context.print;
    // Called outside the command's async chain.
    await nextTick();
    background('background notice');
    expect(h.printed).toEqual(['background notice']);
    finish();
    await nextTick();
    expect(h.workspace.lastActionResult?.detail).toContain('line from the command');
    expect(h.workspace.lastActionResult?.detail).not.toContain('background notice');
    expect(h.context.print).toBe(h.originalPrint);
  });

  test('a command that prints its failure and returns is not reported as a success', async () => {
    const h = harness(async () => {
      h.context.print('MCP add failed server name is taken');
      return true;
    });
    h.dispatch('/mcp add bad');
    await nextTick();
    expect(h.workspace.lastActionResult?.kind).toBe('error');
    expect(h.workspace.lastActionResult?.detail).toContain('MCP add failed');
  });

  test('a command that prints only its result is reported as dispatched', async () => {
    const h = harness(async () => {
      h.context.print('MCP server "docs" saved');
      return true;
    });
    h.dispatch('/mcp add docs');
    await nextTick();
    expect(h.workspace.lastActionResult?.kind).toBe('dispatched');
  });

  test('an unknown command is an error result', async () => {
    const h = harness(async () => false);
    h.dispatch('/nosuch');
    await nextTick();
    expect(h.workspace.lastActionResult?.kind).toBe('error');
    expect(h.workspace.lastActionResult?.title).toContain('Unknown command');
  });

  test('the result pane shows the display command, never the command that carried a secret', async () => {
    const h = harness(async () => true);
    h.dispatch('/secrets set TOKEN sk-test-secret --yes', '/secrets set TOKEN <redacted> --yes');
    await nextTick();
    expect(JSON.stringify(h.workspace.lastActionResult)).not.toContain('sk-test-secret');
    expect(h.workspace.lastActionResult?.command).toBe('/secrets set TOKEN <redacted> --yes');
  });

  test('a failing command with a secret does not put the secret in its failure title either', async () => {
    const h = harness(async () => { throw new Error('host refused'); });
    h.dispatch('/provider add local http://x sk-test-secret --yes', '/provider add local http://x <redacted-api-key> --yes');
    await nextTick();
    expect(h.workspace.lastActionResult?.kind).toBe('error');
    expect(JSON.stringify(h.workspace.lastActionResult)).not.toContain('sk-test-secret');
  });

  test('a custom provider added from the workspace runs with the key and shows only the redacted command', async () => {
    const executed: string[][] = [];
    const h = harness(async (_name, args) => {
      executed.push(args);
      return true;
    });
    h.workspace.localEditor = createAgentWorkspaceProviderCommandEditor('provider-add');
    for (const value of ['local_llm', 'http://127.0.0.1:8000/v1', 'sk-test', 'yes']) {
      h.workspace.appendEditorText(value);
      h.workspace.submitEditorFieldOrForm();
    }
    await nextTick();
    expect(executed.flat()).toContain('sk-test');
    expect(JSON.stringify(h.workspace.lastActionResult)).not.toContain('sk-test');
    expect(h.workspace.lastActionResult?.command).toContain('<redacted-api-key>');
  });
});
