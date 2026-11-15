import { expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerWorktreeRuntimeCommands } from '../../input/commands/worktree-runtime.ts';

test('attaching a path that is no worktree prints the refusal and no success line', async () => {
  const printed: string[] = [];
  const ctx = {
    print: (text: string) => { printed.push(text); },
    renderRequest: () => {},
    workspace: {
      shellPaths: { workingDirectory: '/tmp/goodvibes-worktree-attach' },
      worktreeRegistry: {
        attach: () => { throw new Error('No worktree exists at /tmp/typo, so nothing was attached.'); },
      },
    },
  } as unknown as CommandContext;
  const registry = new CommandRegistry();
  registerWorktreeRuntimeCommands(registry);

  await registry.get('worktree')!.handler(['attach', '/tmp/typo', 'session', 'abc'], ctx);

  expect(printed).toHaveLength(1);
  expect(printed[0]).toContain('No worktree exists at /tmp/typo');
  expect(printed[0]).not.toContain('Attached');
});
