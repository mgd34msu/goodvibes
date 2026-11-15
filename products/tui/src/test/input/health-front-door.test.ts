/**
 * /health has no single modal that owns its data, so bare `/health` and
 * `/health report` stay a transcript report and `/health provider` (also
 * `open` / `panel`) jumps to the providers modal. This file covers that jump
 * and the metrics report's daemon-disabled refusal; the bare report reads
 * about ten subsystems and is not exercised here.
 */
import { describe, test, expect } from 'bun:test';
import { registerHealthRuntimeCommands } from '../../input/commands/health-runtime.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import type { CommandContext } from '../../input/command-registry.ts';

describe('/health front door', () => {
  function getCommand() {
    const registry = new CommandRegistry();
    registerHealthRuntimeCommands(registry);
    return registry.get('health')!;
  }

  function makeContext(): { ctx: CommandContext; opened: string[] } {
    const opened: string[] = [];
    const ctx = {
      platform: { readModels: {} as never, configManager: {} as never },
      openModal: (name: string) => opened.push(name),
      print: () => {},
    } as unknown as CommandContext;
    return { ctx, opened };
  }

  test('/health provider opens the providers modal ', async () => {
    const cmd = getCommand();
    const { ctx, opened } = makeContext();
    await cmd.handler(['provider'], ctx);
    expect(opened).toEqual(['providers-modal']);
  });

  test('/health open and /health panel are synonyms for the same modal jump', async () => {
    const cmd = getCommand();
    for (const sub of ['open', 'panel']) {
      const { ctx, opened } = makeContext();
      await cmd.handler([sub], ctx);
      expect(opened).toEqual(['providers-modal']);
    }
  });

  test('/health metrics reports the daemon-disabled reason plainly (never zeros)', async () => {
    const cmd = getCommand();
    const printed: string[] = [];
    const ctx = {
      platform: {
        readModels: {} as never,
        configManager: { get: (key: string) => (key === 'daemon.enabled' ? false : undefined) } as never,
      },
      session: { runtime: { provider: 'anthropic' } },
      print: (s: string) => printed.push(s),
    } as unknown as CommandContext;
    await cmd.handler(['metrics'], ctx);
    const out = printed.join('\n');
    expect(out).toContain('Health Review: Runtime Metrics');
    expect(out).toContain('unavailable:');
    expect(out).toContain('daemon is disabled');
    expect(out).not.toMatch(/counters: 0/);
  });
});
