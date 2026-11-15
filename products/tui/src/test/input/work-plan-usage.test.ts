import { expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerWorkPlanRuntimeCommands } from '../../input/commands/work-plan-runtime.ts';

test('every subcommand the help usage names is handled, and cycle and edit --source are named', async () => {
  const registry = new CommandRegistry();
  registerWorkPlanRuntimeCommands(registry);
  const command = registry.get('work-plan')!;
  const usage = command.usage ?? '';
  expect(usage).toContain('cycle <id>');
  expect(usage).toContain('edit <id> [<new title>] [--owner name] [--source label] [--notes text]');

  const words = usage.replace(/^\[|\]$/g, '').split('|').map((entry) => entry.trim().split(/\s+/)[0]!.toLowerCase()).filter(Boolean);
  const printed: string[] = [];
  const ctx = {
    workspace: { workPlanStore: {} },
    print: (text: string) => { printed.push(text); },
    renderRequest: () => {},
    openModal: () => {},
  } as unknown as CommandContext;
  for (const word of words) {
    printed.length = 0;
    await command.handler([word], ctx);
    expect(printed.join('\n')).not.toContain('Unknown workplan subcommand');
  }
});
