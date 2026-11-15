import { expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerTeamworkRuntimeCommands } from '../../input/commands/teamwork-runtime.ts';

function registry(): CommandRegistry {
  const commands = new CommandRegistry();
  registerTeamworkRuntimeCommands(commands);
  return commands;
}

test('create-mode starts the agent the mode describes', async () => {
  const output: string[] = [];
  const spawned: unknown[] = [];
  const ctx = {
    ops: { agentManager: { spawn: (input: unknown) => { spawned.push(input); return { id: 'agent-1' }; } } },
    print: (line: string) => { output.push(line); },
  } as unknown as CommandContext;
  await registry().execute('teamwork', ['create-mode', 'local-engineer', 'Fix', 'the', 'build'], ctx);
  expect(spawned).toEqual([{ mode: 'spawn', task: 'Fix the build', template: 'engineer', executionProtocol: 'gather-plan-apply' }]);
  expect(output[0]).toContain('Started agent agent-1');
});

test('a failure in a non-archetype subcommand reports its own cause', async () => {
  const output: string[] = [];
  let first = true;
  const ctx = {
    print: (line: string) => {
      if (first) { first = false; throw new Error('read models are not wired'); }
      output.push(line);
    },
  } as unknown as CommandContext;
  await registry().execute('teamwork', ['modes'], ctx);
  expect(output).toHaveLength(1);
  expect(output[0]).toContain('read models are not wired');
  expect(output[0]).not.toContain('archetype reading');
});
