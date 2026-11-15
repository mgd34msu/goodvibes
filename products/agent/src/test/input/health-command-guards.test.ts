import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerHealthRuntimeCommands } from '../../input/commands/health-runtime.ts';

const MODEL = { id: 'm', provider: 'p', contextWindow: 1_000_000 };

function rig(knownWindow: number | null) {
  const out: string[] = [];
  const registry = new CommandRegistry();
  registerHealthRuntimeCommands(registry);
  const ctx = {
    print: (text: string) => { out.push(text); },
    session: {
      conversationManager: { getMessagesForLLM: () => [{ role: 'user', content: 'x'.repeat(4000) }] },
      sessionMemoryStore: { list: () => [] },
    },
    provider: {
      providerRegistry: {
        getCurrentModel: () => MODEL,
        getKnownContextWindowForModel: (model: unknown) => (model === MODEL ? knownWindow : null),
      },
    },
    platform: {
      configManager: { get: () => undefined },
      readModels: { session: { getSnapshot: () => ({ session: { id: 'session-health' } }) } },
    },
  } as unknown as CommandContext;
  return { out, registry, ctx };
}

describe('/health subcommands', () => {
  test('an unknown subcommand prints the usage instead of running the full review', async () => {
    const { out, registry, ctx } = rig(200_000);
    await registry.execute('health', ['maintanence'], ctx);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Unknown /health subcommand maintanence');
    expect(out[0]).toContain('maintenance');
    expect(out[0]).not.toContain('Health Review');
  });

  test('maintenance reports usage against the known context window, not the definition\'s own number', async () => {
    const small = rig(200_000);
    await small.registry.execute('health', ['maintenance'], small.ctx);
    const large = rig(null);
    await large.registry.execute('health', ['maintenance'], large.ctx);
    // The definition says 1,000,000 tokens; the registry's resolved window is the one both
    // the footer meter and /context use, so a known window gives a stable reading and an
    // unresolved one says the window is unknown rather than borrowing the definition's.
    expect(small.out.join('\n')).toContain('Session maintenance is stable');
    expect(large.out.join('\n')).toContain('Context window unavailable');
  });
});
