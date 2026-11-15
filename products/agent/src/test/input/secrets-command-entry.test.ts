import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerLocalRuntimeCommands } from '../../input/commands/local-runtime.ts';

function rig(options: { readonly masked: boolean }) {
  const out: string[] = [];
  const sets: Array<readonly [string, string]> = [];
  const prompts: Array<{ readonly onSubmit: (value: string) => void | Promise<void> }> = [];
  const registry = new CommandRegistry();
  registerLocalRuntimeCommands(registry);
  const ctx = {
    print: (text: string) => { out.push(text); },
    platform: {
      secretsManager: {
        set: async (key: string, value: string) => { sets.push([key, value]); },
        get: async () => null,
        delete: async () => {},
      },
    },
    ...(options.masked ? { beginConcealedInput: (request: (typeof prompts)[number]) => { prompts.push(request); } } : {}),
  } as unknown as CommandContext;
  return { out, sets, prompts, run: (args: string[]) => registry.get('secrets')!.handler(args, ctx) };
}

describe('/secrets set without a value', () => {
  test('asks for the value masked instead of storing an empty one', async () => {
    const { run, sets, prompts, out } = rig({ masked: true });
    await run(['set', 'OPENAI_API_KEY', '--yes']);
    expect(sets).toEqual([]);
    expect(prompts).toHaveLength(1);
    expect(out.join('\n')).toContain('input is masked');
    await prompts[0]!.onSubmit('sk-entered-masked');
    await Promise.resolve();
    expect(sets.map(([key, value]) => [key, value])).toEqual([['OPENAI_API_KEY', 'sk-entered-masked']]);
  });

  test('where no masked prompt exists nothing is stored and the usage is shown', async () => {
    const { run, sets, out } = rig({ masked: false });
    await run(['set', 'OPENAI_API_KEY', '--yes']);
    expect(sets).toEqual([]);
    expect(out.join('\n')).toContain('Usage');
    expect(out.join('\n')).not.toContain('Stored');
  });
});
