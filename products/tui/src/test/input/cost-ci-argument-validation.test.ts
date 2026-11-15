import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerCostRuntimeCommands } from '../../input/commands/cost-runtime.ts';
import { registerCiRuntimeCommands } from '../../input/commands/ci-runtime.ts';

function makeCtx(printed: string[]): CommandContext {
  return {
    print: (text: string) => { printed.push(text); },
    renderRequest: () => {},
    workspace: {},
    platform: { configManager: { get: (key: string) => (key === 'daemon.enabled' ? false : undefined) } },
  } as unknown as CommandContext;
}

async function run(register: (registry: CommandRegistry) => void, name: string, args: string[]): Promise<string> {
  const registry = new CommandRegistry();
  register(registry);
  const printed: string[] = [];
  await registry.execute(name, args, makeCtx(printed));
  return printed.join('\n');
}

describe('argument validation is not silent coercion', () => {
  test('/cost attribution 30d is refused, not treated as 24h', async () => {
    const text = await run(registerCostRuntimeCommands, 'cost', ['attribution', '30d']);
    expect(text).toContain('Unknown or conflicting option(s): 30d');
    expect(text).not.toContain('[cost attribution] ');
  });

  test('/cost attribution with both windows is refused', async () => {
    expect(await run(registerCostRuntimeCommands, 'cost', ['attribution', '24h', '7d'])).toContain('conflicting');
  });

  test('/ci watch refuses an unknown flag', async () => {
    const text = await run(registerCiRuntimeCommands, 'ci', ['watch', 'owner/repo', 'slack', '--fix-sesion']);
    expect(text).toContain('Unknown option(s): --fix-sesion');
  });

  test('/ci watch does not read --fix-session as the delivery channel', async () => {
    const text = await run(registerCiRuntimeCommands, 'ci', ['watch', 'owner/repo', '--fix-session']);
    expect(text).toContain('Usage: /ci watch');
  });
});
