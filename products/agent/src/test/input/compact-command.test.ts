import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerShellCoreCommands } from '../../input/commands/shell-core.ts';

function setup(options: { generating?: boolean; receipt?: { messagesBefore: number; messagesAfter: number } | undefined }) {
  const printed: string[] = [];
  let compacted = 0;
  const ctx = {
    print: (text: string) => { printed.push(text); },
    renderRequest: () => {},
    isGenerating: () => options.generating === true,
    provider: { providerRegistry: {} },
    session: {
      runtime: { model: 'm', provider: 'p' },
      conversationManager: { compact: async () => { compacted += 1; return options.receipt; } },
    },
  } as unknown as CommandContext;
  const registry = new CommandRegistry();
  registerShellCoreCommands(registry);
  return { printed, ctx, registry, compacted: () => compacted };
}

describe('/compact', () => {
  test('says what happened to the conversation', async () => {
    const f = setup({ receipt: { messagesBefore: 40, messagesAfter: 6 } });
    await f.registry.execute('compact', [], f.ctx);
    expect(f.printed.join('\n')).toContain('Conversation compacted (40 to 6 messages).');
  });

  test('does not claim success when nothing was compacted', async () => {
    const f = setup({ receipt: undefined });
    await f.registry.execute('compact', [], f.ctx);
    expect(f.printed.join('\n')).not.toContain('Conversation compacted');
    expect(f.printed.join('\n')).toContain('Nothing was compacted');
  });

  test('refuses while a turn runs without touching the conversation', async () => {
    const f = setup({ generating: true, receipt: { messagesBefore: 1, messagesAfter: 1 } });
    await f.registry.execute('compact', [], f.ctx);
    expect(f.compacted()).toBe(0);
    expect(f.printed.join('\n')).toContain('A turn is still running');
  });
});
