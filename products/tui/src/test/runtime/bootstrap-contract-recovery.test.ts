import { expect, spyOn, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import * as contractRuntime from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { TuiConfigManager } from '../../config/host-settings.ts';
import { bootstrapRuntime, type BootstrapContext } from '../../runtime/bootstrap.ts';
import { closeE2EFixture, makeHome, startStubModel } from '../e2e/harness.ts';

test('TUI bootstrap returns during contract recovery and shutdown stops then drains it', async () => {
  const model = startStubModel(() => ({ text: 'unused' }));
  let ownedHome: Awaited<ReturnType<typeof makeHome>> | null = null;
  let failure: { error: unknown } | undefined;
  let releaseRecovery: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const stops: Array<() => void | Promise<void>> = [];
  try {
    const home = await makeHome(model); ownedHome = home;
    const configManager = new TuiConfigManager({ configDir: join(home.home, '.goodvibes/tui'), homeDir: home.home, workingDir: home.workspace, surfaceRoot: 'tui' });
    const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30, isTTY: true }) as unknown as NodeJS.WriteStream;
    stops.push(() => { stdout.destroy(); });
    stdout.resume();
    const recovery = new Promise<void>(resolve => { releaseRecovery = resolve; });
    const resume = spyOn(contractRuntime, 'resumeContracts').mockImplementation(async () => {
      await recovery;
      return { resumed: [], queued: [], reaped: [], skipped: [] };
    });
    stops.unshift(() => { resume.mockRestore(); });
    const boot = bootstrapRuntime(stdout, { configManager, workingDir: home.workspace, homeDirectory: home.home });
    let ctx: BootstrapContext | undefined;
    let restoreDispose: (() => void) | undefined;
    stops.unshift(async () => { ctx ??= await boot; await ctx.shutdown({ messages: [] }); }, () => { restoreDispose?.(); });
    ctx = await Promise.race([boot, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Bootstrap waited for unfinished contract recovery')), 10_000);
    })]);
    clearTimeout(timeout);
    expect(resume).toHaveBeenCalledWith(ctx.services.contractRunner, home.workspace);
    expect(ctx.commandContext).toBeDefined();
    let stopped!: () => void;
    const stopping = new Promise<void>(resolve => { stopped = resolve; });
    const dispose = ctx.services.contractRunner.dispose;
    const spy = spyOn(ctx.services.contractRunner, 'dispose').mockImplementation(() => { dispose(); stopped(); });
    restoreDispose = () => spy.mockRestore();
    let finished = false;
    const closing = ctx.shutdown({ messages: [] }).then(() => { finished = true; });
    await stopping;
    await Promise.resolve();
    expect(finished).toBe(false);
    releaseRecovery?.();
    await closing;
    expect(finished).toBe(true);
  } catch (error) { failure = { error }; throw error; }
  finally {
    clearTimeout(timeout); releaseRecovery?.();
    try { await closeE2EFixture(ownedHome, ...stops, () => model.stop()); }
    catch (cleanup) {
      if (failure) throw new AggregateError([failure.error, cleanup], 'Bootstrap recovery assertion/setup and cleanup failed');
      throw cleanup;
    }
  }
}, 30_000);
