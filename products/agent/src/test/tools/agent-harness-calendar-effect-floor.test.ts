import { expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { runCommand } from '../../tools/agent-harness-command-runner.ts';
import { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { CALENDAR_VERBS } from '../../input/commands/calendar-runtime.ts';
import { withCommandVerbs } from '../../input/commands/command-verbs.ts';

function scene() {
  const registry = new CommandRegistry();
  const ran: string[][] = [];
  registry.register(withCommandVerbs({ name: 'calendar', aliases: ['cal'], description: 'calendar', handler: async (args) => { ran.push([...args]); } }, CALENDAR_VERBS));
  const deps = { commandRegistry: registry, commandContext: { print() {} } as unknown as CommandContext, toolRegistry: new ToolRegistry() };
  return { deps, ran };
}

test('a model reads the calendar without an outward grant, but a verb that reaches out is held', async () => {
  const { deps, ran } = scene();
  for (const args of [[], ['list'], ['upcoming', '--days', '3'], ['subscriptions'], ['accounts']]) {
    const result = await runCommand(deps, { commandName: 'calendar', args });
    expect(result.success).toBe(true);
  }
  expect(ran).toHaveLength(5);
  for (const args of [['subscribe', 'http://127.0.0.1:1/', '--yes'], ['refresh'], ['export', '--dest', '/tmp/x', '--yes']]) {
    await expect(runCommand(deps, { commandName: 'calendar', args })).rejects.toMatchObject({ problem: 'held' });
  }
  // Signing an account in is the owner's to type: refused before any admission, nothing ran.
  for (const args of [['connect', 'google'], ['unsubscribe', 'feed', '--yes']]) {
    const refused = await runCommand(deps, { commandName: 'calendar', args });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('only counts when the owner types it');
  }
  expect(ran).toHaveLength(5);
});
