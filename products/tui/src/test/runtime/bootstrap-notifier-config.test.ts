import { expect, spyOn, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { Notifier } from '@goodvibes-jev/engine/platform/platform/integrations';
import { TuiConfigManager } from '../../config/host-settings.ts';
import { bootstrapRuntime } from '../../runtime/bootstrap.ts';
import { closeE2EFixture, makeHome, startStubModel } from '../e2e/harness.ts';

test('bootstrap builds the notifier from the stored configuration and secrets', async () => {
  const model = startStubModel(() => ({ text: 'unused' }));
  const stops: Array<() => void | Promise<void>> = [];
  let ownedHome: Awaited<ReturnType<typeof makeHome>> | null = null;
  try {
    const home = await makeHome(model); ownedHome = home;
    const configManager = new TuiConfigManager({ configDir: join(home.home, '.goodvibes/tui'), homeDir: home.home, workingDir: home.workspace, surfaceRoot: 'tui' });
    const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30, isTTY: true }) as unknown as NodeJS.WriteStream;
    stops.push(() => { stdout.destroy(); });
    stdout.resume();
    const original = Notifier.fromConfig;
    const calls: Array<Parameters<typeof Notifier.fromConfig>[1]> = [];
    const spy = spyOn(Notifier, 'fromConfig').mockImplementation(async (registry, options) => {
      calls.push(options);
      return original(registry, options);
    });
    stops.unshift(() => { spy.mockRestore(); });
    const ctx = await bootstrapRuntime(stdout, { configManager, workingDir: home.workspace, homeDirectory: home.home });
    stops.unshift(async () => { await ctx.shutdown({ messages: [] }); });
    // A bot token saved by account setup is a goodvibes://secrets reference; the
    // notifier can only read it through the same secrets manager and config the runtime owns.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.configManager).toBe(configManager);
    expect(calls[0]?.secretsManager).toBe(ctx.services.secretsManager);
  } finally {
    await closeE2EFixture(ownedHome, ...stops, () => model.stop());
  }
}, 30_000);
