import { describe, it, expect } from 'bun:test';
import { getBuiltinSetupSchema } from '@goodvibes-jev/engine/platform/platform/channels';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { CommandContext } from '../../input/command-registry.ts';
import { PAIRABLE_SURFACES, runChannelPairing } from '../../input/commands/channel-pairing.ts';

function makeCtx() {
  const store = new Map<string, unknown>();
  const printed: string[] = [];
  const configManager = {
    get: (k: string) => store.get(k),
    setDynamic: (k: string, v: unknown) => store.set(k, v),
  } as unknown as ConfigManager;
  const ctx = {
    platform: { configManager, secretsManager: undefined },
    print: (t: string) => printed.push(t),
    renderRequest: () => {},
    // Concealed input intentionally absent to keep the test non-interactive.
    beginConcealedInput: undefined,
  } as unknown as CommandContext;
  return { ctx, store, printed, text: () => printed.join('\n') };
}

describe('/channel pair', () => {
  it('lists every pairable surface with the label from the platform setup schema', async () => {
    const { ctx, text } = makeCtx();
    await runChannelPairing([], ctx);
    expect(text()).toContain('Channel adapters');
    expect(PAIRABLE_SURFACES.length).toBeGreaterThan(0);
    for (const surface of PAIRABLE_SURFACES) {
      const row = text().split('\n').find(line => line.trimStart().startsWith(`${surface} `));
      expect(row).toBeDefined();
      expect(row).toContain(getBuiltinSetupSchema(surface).label);
    }
  });

  it('rejects an unknown surface with the list of valid ones', async () => {
    const { ctx, text } = makeCtx();
    await runChannelPairing(['not-a-channel'], ctx);
    expect(text()).toContain('Unknown channel');
    expect(text()).toContain('slack');
  });

  it('shows a surface\'s declared credentials and marks them not set initially', async () => {
    const { ctx, text } = makeCtx();
    await runChannelPairing(['slack'], ctx);
    expect(text()).toContain('Slack');
    expect(text()).toContain('Declared credentials');
    expect(text()).toContain('not set');
  });

  it('verify marks only required values as missing, then passes once they are set', async () => {
    const { ctx, store, printed, text } = makeCtx();
    await runChannelPairing(['signal', 'verify'], ctx);
    expect(text()).toContain('[missing]');
    // No control-plane base URL is configured in this stub, so the live
    // round-trip is honestly reported as unavailable rather than skipped silently.
    expect(text()).toContain('Cannot perform a live round-trip');

    for (const field of getBuiltinSetupSchema('signal').fields) {
      if (field.required && field.configKey && field.kind !== 'boolean') store.set(field.configKey, 'value');
    }
    printed.length = 0;
    await runChannelPairing(['signal', 'verify'], ctx);
    expect(text()).not.toContain('[missing]');
    expect(text()).toContain('Every required value is set');
  });

  describe('secret entry chain', () => {
    type Concealed = { label: string; onSubmit: (value: string) => void };

    /** A surface context whose concealed prompts are answered from `answers` in order. */
    function makeChainCtx(storeSecrets: boolean) {
      const base = makeCtx();
      const prompts: Concealed[] = [];
      const secretsManager = storeSecrets ? { set: async () => {} } : undefined;
      const ctx = {
        ...(base.ctx as unknown as Record<string, unknown>),
        platform: { configManager: base.ctx.platform.configManager, secretsManager },
        beginConcealedInput: (options: Concealed) => { prompts.push(options); },
      } as unknown as CommandContext;
      return { ...base, ctx, prompts };
    }

    async function drain(done: () => boolean): Promise<void> {
      for (let i = 0; i < 200 && !done(); i++) await Promise.resolve();
    }

    async function answerAll(prompts: Concealed[], answer: (index: number) => string, finished: () => boolean): Promise<void> {
      let answered = 0;
      while (!finished()) {
        await drain(() => prompts.length > answered || finished());
        if (finished() || prompts.length <= answered) break;
        prompts[answered]!.onSubmit(answer(answered));
        answered++;
      }
    }

    const enabledKeyOf = (surface: 'signal' | 'ntfy' | 'telegram') =>
      getBuiltinSetupSchema(surface).fields.find((f) => f.id === 'enabled')?.configKey as string;

    it('asks for every missing required value, plain ones included, and enables the surface once they are set', async () => {
      const { ctx, store, text, prompts } = makeChainCtx(true);
      await runChannelPairing(['signal'], ctx);
      // Required values are asked first; the optional token is skipped with an empty answer.
      await answerAll(prompts, (index) => (index < 2 ? 'https://bridge.example.test' : ''), () => text().includes('Verify with'));
      expect(store.get('surfaces.signal.bridgeUrl')).toBe('https://bridge.example.test');
      expect(store.get(enabledKeyOf('signal'))).toBe(true);
      expect(text()).toContain('The surface is enabled');
    });

    it('does not enable the surface while a required value is left empty, and names it', async () => {
      const { ctx, store, text, prompts } = makeChainCtx(true);
      await runChannelPairing(['signal'], ctx);
      await answerAll(prompts, () => '', () => text().includes('was NOT enabled'));
      expect(store.get(enabledKeyOf('signal'))).not.toBe(true);
      expect(text()).toContain('was NOT enabled: still missing');
    });

    it('a skipped optional value does not block enabling', async () => {
      const { ctx, store, text, prompts } = makeChainCtx(true);
      await runChannelPairing(['ntfy'], ctx);
      await answerAll(prompts, () => '', () => text().includes('Verify with'));
      expect(store.get(enabledKeyOf('ntfy'))).toBe(true);
    });

    it('does not enable the surface when a required secret could not be stored', async () => {
      const { ctx, store, text, prompts } = makeChainCtx(false);
      await runChannelPairing(['telegram'], ctx);
      await answerAll(prompts, () => 'a-secret-value', () => text().includes('was NOT enabled'));
      expect(text()).toContain('Failed to store');
      expect(store.get(enabledKeyOf('telegram'))).not.toBe(true);
    });
  });
});
