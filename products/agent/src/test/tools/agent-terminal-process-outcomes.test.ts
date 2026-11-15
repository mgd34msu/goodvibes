import { describe, expect, test } from 'bun:test';
import { ProcessManager } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CommandContext } from '../../input/command-registry.ts';
import { createAgentProcessTool, createAgentTerminalTool } from '../../tools/agent-terminal-process-tools.ts';

function context(manager?: ProcessManager): CommandContext {
  return { workspace: { ...(manager ? { processManager: manager } : {}) } } as unknown as CommandContext;
}

describe('terminal and process report an action that did nothing as a failure', () => {
  test('terminal with no process manager is a failed call, with the reason in error and the body kept', async () => {
    const result = await createAgentTerminalTool(context()).execute({ command: 'echo hi', background: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain('unavailable');
    expect(result.error).toContain('ProcessManager is not wired');
    expect(JSON.parse(result.output!).status).toBe('unavailable');
  });

  test('terminal with pty requested is a failed call: nothing started', async () => {
    const result = await createAgentTerminalTool(context(new ProcessManager())).execute({ command: 'echo hi', background: true, pty: true });
    expect(result.success).toBe(false);
    expect(JSON.parse(result.output!).status).toBe('unsupported');
  });

  test('process wait on an id nothing tracks returns at once as a failed call that names the id', async () => {
    const result = await createAgentProcessTool(context(new ProcessManager())).execute({ action: 'wait', processId: 'no-such-process', timeoutMs: 0 });
    expect(result.success).toBe(false);
    expect(result.error).toContain('"no-such-process"');
  });

  test('both process-class descriptions say what an omitted class means when Jev is not reading commands', () => {
    const terminal = createAgentTerminalTool(context()).definition.parameters.properties as Record<string, { description: string }>;
    const processTool = createAgentProcessTool(context()).definition.parameters.properties as Record<string, { description: string }>;
    for (const description of [terminal.processClass!.description, processTool.processClass!.description]) {
      expect(description).toContain('Classic');
      expect(description).toContain('omitted class is command');
    }
  });

  test('process capabilities is still a successful read', async () => {
    const result = await createAgentProcessTool(context(new ProcessManager())).execute({ action: 'capabilities' });
    expect(result.success).toBe(true);
  });

  test('an unknown process action is refused with the process tool\'s own action names', async () => {
    const result = await createAgentProcessTool(context(new ProcessManager())).execute({ action: 'bogus' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown process action "bogus"');
    expect(result.error).toContain('kill');
    expect(result.error).not.toContain('processAction');
  });

  test('the schema states the wait and start timeout rules', () => {
    const properties = createAgentProcessTool(context()).definition.parameters.properties as Record<string, { description: string }>;
    expect(properties.timeoutMs!.description).toContain('default 30000');
    expect(properties.timeoutMs!.description).toContain('0 returns the current status');
    expect(properties.timeoutMs!.description).toContain('2147483647');
  });
});
