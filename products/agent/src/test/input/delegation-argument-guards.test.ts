import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerDelegationRuntimeCommands } from '../../input/commands/delegation-runtime.ts';

function rig() {
  const printed: string[] = [];
  const submitted: Record<string, unknown>[] = [];
  const registry = new CommandRegistry();
  registerDelegationRuntimeCommands(registry);
  const ctx = {
    print: (line: string) => { printed.push(line); },
    session: { runtime: { sessionId: 'agent-session-1' } },
    clients: {
      operator: {
        sessions: {
          ensureSession: async () => ({ id: 'shared-session-1' }),
          submitMessage: async (input: Record<string, unknown>) => { submitted.push(input); return { id: 'submission-1' }; },
        },
      },
    },
  } as unknown as CommandContext;
  return { printed, submitted, registry, ctx };
}

describe('/delegate arguments', () => {
  test('a mistyped option is refused with the usage and nothing is delegated', async () => {
    const { printed, submitted, registry, ctx } = rig();
    await registry.execute('delegate', ['--reasn', 'because', 'Fix release blocker'], ctx);
    expect(submitted).toEqual([]);
    expect(printed.join('\n')).toContain('Unknown option --reasn');
    expect(printed.join('\n')).toContain('Usage: /delegate');
  });

  test('an option that is missing its value, or whose value is another option, is refused', async () => {
    const { printed, submitted, registry, ctx } = rig();
    await registry.execute('delegate', ['Fix release blocker', '--reason'], ctx);
    await registry.execute('delegate', ['--reason', '--review', 'Fix release blocker'], ctx);
    expect(submitted).toEqual([]);
    expect(printed.filter((line) => line.includes('needs a value'))).toHaveLength(2);
  });

  test('a bare -- ends the options so a task can mention one', async () => {
    const { submitted, registry, ctx } = rig();
    await registry.execute('delegate', ['--reason', 'flaky', '--', 'Fix', 'the', '--verbose', 'flag'], ctx);
    expect(submitted).toHaveLength(1);
    expect(String(submitted[0]?.body)).toContain('Fix the --verbose flag');
    expect(String(submitted[0]?.body)).toContain('flaky');
  });
  test('`status` reads delegations instead of delegating, and -- lets a task be that word', async () => {
    const { submitted, registry, ctx } = rig();
    await registry.execute('delegate', ['status'], ctx);
    await registry.execute('delegate', ['status', 'shared-session-1'], ctx);
    expect(submitted).toEqual([]);
    await registry.execute('delegate', ['--', 'status'], ctx);
    expect(submitted).toHaveLength(1);
  });
});
