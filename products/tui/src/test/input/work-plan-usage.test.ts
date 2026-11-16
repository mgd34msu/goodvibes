import { expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerWorkPlanRuntimeCommands } from '../../input/commands/work-plan-runtime.ts';
import { readRefusal } from '@goodvibes-jev/engine/errors';

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
  expect(words).toContain('in_progress');
  for (const word of words) {
    printed.length = 0;
    // The fake store has no methods, so a handled word may still refuse; it must not refuse as unknown.
    const reason = await (async () => command.handler([word], ctx))().then(() => '', (error: unknown) => readRefusal(error)?.reason ?? String(error));
    expect(reason).not.toContain('Unknown work-plan subcommand');
  }
  const unknown = await (async () => command.handler(['nonsense'], ctx))().then(() => undefined, (error: unknown) => readRefusal(error));
  expect(unknown?.reason).toContain('Unknown work-plan subcommand');
});
