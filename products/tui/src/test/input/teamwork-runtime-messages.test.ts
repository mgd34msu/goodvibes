import { expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerTeamworkRuntimeCommands } from '../../input/commands/teamwork-runtime.ts';

function registry(): CommandRegistry {
  const commands = new CommandRegistry();
  registerTeamworkRuntimeCommands(commands);
  return commands;
}

test('create-mode says the task is a queued record that nothing starts', async () => {
  const output: string[] = [];
  const ctx = {
    clients: { opsApi: { tasks: { create: () => ({ id: 'task-1' }) } } },
    print: (line: string) => { output.push(line); },
  } as unknown as CommandContext;
  await registry().execute('teamwork', ['create-mode', 'local-engineer', 'Fix', 'the', 'build'], ctx);
  expect(output).toHaveLength(1);
  expect(output[0]).toContain('Created teamwork task task-1');
  expect(output[0]).toContain('queued record only');
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
