/** Public factory lifecycle regressions using real constructor-owned graphs.
 * Source authored only; execution is deferred until source naming freezes.
 * Instance spies model the factory's start/stop outcome boundaries, while the
 * original server teardown always drains the actual isolated runtime owners. */
import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootDaemon, type BootDaemonOptions, type BootedDaemon } from '../platform/src/platform/daemon/boot.ts';
import { DaemonServer } from '../platform/src/platform/daemon/facade.ts';
import type { DaemonLifecycleRuntime } from '../platform/src/platform/daemon/facade-lifecycle.ts';
import { seedBenchmarkCache } from './_helpers/benchmark-cache.ts';
import { withTestTimeout } from './_helpers/test-timeout.ts';

const originalCreate = DaemonServer.create;
const originalStop = DaemonServer.prototype.stop;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { return Promise.withResolvers<void>(); }
function observed(promise: Promise<BootedDaemon>) {
  let settled = false;
  const outcome = promise.then(value => { settled = true; return { kind: 'handle' as const, value }; },
    (error: unknown) => { settled = true; return { kind: 'error' as const, error }; });
  return { outcome, settled: () => settled };
}
function rejection(result: Awaited<ReturnType<typeof observed>['outcome']>): unknown {
  if (result.kind !== 'error') throw new Error('Factory returned a serving handle after failed or handed-over startup');
  return result.error;
}

function fixture(configure: (server: DaemonServer, restore: (action: () => void) => void) => void = () => {}) {
  const home = mkdtempSync(join(tmpdir(), 'boot-lifecycle-'));
  const work = join(home, 'work'); mkdirSync(work);
  seedBenchmarkCache(home, 'goodvibes');
  let server: DaemonServer | undefined;
  const restores: Array<() => void> = [];
  // Keep real asynchronous project preparation and actual server construction.
  // Match this fixture's selected root so unrelated creates retain their owner.
  const create = spyOn(DaemonServer, 'create').mockImplementation(async config => {
    const created = await originalCreate.call(DaemonServer, config);
    if (config?.homeDirectory === home) {
      server = created;
      configure(created, action => restores.push(action));
    }
    return created;
  });
  const options: BootDaemonOptions = { homeDirectory: home, workingDir: work,
    daemonHomeDir: join(home, 'daemon'), host: '127.0.0.1', port: 0, token: 'boot-lifecycle-fixture' };
  return {
    options,
    server() { if (!server) throw new Error('Original server was not constructed'); return server; },
    async close() {
      for (const restore of restores.reverse()) restore();
      create.mockRestore();
      try { if (server) await originalStop.call(server); }
      finally { rmSync(home, { recursive: true, force: true }); }
    },
  };
}

for (const action of ['stop', 'fence'] as const) for (const handedOver of [false, true]) {
  test(`external ${action} retires pending native startup returning ${handedOver}`, async () => {
    const entered = deferred(), release = deferred(), drainEntered = deferred(), drainRelease = deferred();
    let binds = 0, delegated = 0, draining = false;
    const f = fixture((server, restore) => {
      const owner = server as unknown as { lifecycle: DaemonLifecycleRuntime; surfaceActionHelper: { startDelegatedTelegram(): void } };
      const start = spyOn(owner.lifecycle, 'onStarting').mockImplementation(async () => {
        entered.resolve(); await release.promise; return handedOver;
      });
      const originalDrain = owner.lifecycle.drainHandovers.bind(owner.lifecycle);
      const drain = spyOn(owner.lifecycle, 'drainHandovers').mockImplementation(async forHandover => {
        draining = true; drainEntered.resolve(); await drainRelease.promise; await originalDrain(forHandover);
      });
      const delegatedStart = spyOn(owner.surfaceActionHelper, 'startDelegatedTelegram').mockImplementation(() => { delegated++; });
      restore(() => start.mockRestore()); restore(() => drain.mockRestore()); restore(() => delegatedStart.mockRestore());
    });
    const serveFactory: typeof Bun.serve = () => { binds++; throw new Error('Retired native startup must never bind'); };
    const boot = observed(bootDaemon({ ...f.options, serveFactory }));
    let stopping: Promise<void> | undefined;
    let fencedDrain: Promise<void> | undefined;
    let fenceDrained = false;
    try {
      await withTestTimeout(entered.promise);
      if (action === 'stop') stopping = f.server().stop();
      else {
        f.server().fenceRestartAdmission();
        fencedDrain = f.server().waitForRestart().then(() => { fenceDrained = true; });
      }
      release.resolve();
      await withTestTimeout(drainEntered.promise); await flush();
      expect(draining).toBe(true); expect(boot.settled()).toBe(false);
      if (action === 'fence') expect(fenceDrained).toBe(false);
      expect(delegated).toBe(0); expect(binds).toBe(0);
      drainRelease.resolve(); await stopping; await fencedDrain;
      const error = rejection(await withTestTimeout(boot.outcome));
      expect(String(error)).not.toContain('handed over to a managed replacement');
      expect(delegated).toBe(0); expect(binds).toBe(0); expect(f.server().isRunning).toBe(false);
    } finally {
      release.resolve(); drainRelease.resolve();
      try { await Promise.allSettled([stopping, fencedDrain, boot.outcome]); }
      finally { await f.close(); }
    }
  }, 60_000);
}

test('a native startup handover preserves its own orderly stop admission', async () => {
  let binds = 0;
  const f = fixture((server, restore) => {
    const owner = server as unknown as { lifecycle: DaemonLifecycleRuntime; stopRuntime(forHandover: boolean): Promise<void> };
    const start = spyOn(owner.lifecycle, 'onStarting').mockImplementation(async () => {
      await owner.stopRuntime(true); return true;
    });
    restore(() => start.mockRestore());
  });
  const serveFactory: typeof Bun.serve = () => { binds++; throw new Error('Native handover must not bind'); };
  try {
    const error = rejection(await withTestTimeout(observed(bootDaemon({ ...f.options, serveFactory })).outcome));
    expect(String(error)).toContain('handed over to a managed replacement');
    expect(binds).toBe(0); expect(f.server().isRunning).toBe(false);
  } finally { await f.close(); }
}, 60_000);

test('failed listener bind waits for the actual constructor-owned stop drain before rejecting', async () => {
  const entered = deferred(), release = deferred();
  const bindFailure = new Error('fixture listener bind failed');
  let stopCalls = 0, drained = false, binds = 0;
  const f = fixture((server, restore) => {
    const stop = spyOn(server, 'stop').mockImplementation(async () => {
      stopCalls++; entered.resolve(); await release.promise;
      await originalStop.call(server); drained = true;
    });
    restore(() => stop.mockRestore());
  });
  const serveFactory: typeof Bun.serve = () => { binds++; throw bindFailure; };
  const boot = observed(bootDaemon({ ...f.options, serveFactory }));
  try {
    const first = await withTestTimeout(Promise.race([
      entered.promise.then(() => 'cleanup'), boot.outcome.then(() => 'settled'),
    ]));
    expect(first).toBe('cleanup'); expect(binds).toBe(1);
    expect(stopCalls).toBe(1); expect(boot.settled()).toBe(false); expect(drained).toBe(false);
    release.resolve();
    expect(rejection(await withTestTimeout(boot.outcome))).toBe(bindFailure);
    expect(drained).toBe(true); expect(f.server().isRunning).toBe(false);
  } finally {
    release.resolve(); await boot.outcome; await f.close();
  }
}, 60_000);

for (const failed of [false, true]) test(`startup handover awaits its ${failed ? 'failed' : 'successful'} drain and never returns a local serving handle`, async () => {
  const started = deferred(), handover = deferred();
  const drainFailure = new Error('fixture replacement drain failed');
  let stopCalls = 0, binds = 0, drained = false;
  const f = fixture((server, restore) => {
    const start = spyOn(server, 'start').mockImplementation(async () => {
      started.resolve();
      return { state: 'handover' as const, drain: handover.promise, cancel() {} };
    });
    const stop = spyOn(server, 'stop').mockImplementation(async () => {
      stopCalls++; await originalStop.call(server); drained = true;
    });
    restore(() => start.mockRestore()); restore(() => stop.mockRestore());
  });
  const serveFactory: typeof Bun.serve = () => { binds++; throw new Error('Handover must not bind a local listener'); };
  const boot = observed(bootDaemon({ ...f.options, serveFactory }));
  try {
    await withTestTimeout(started.promise); await flush();
    expect(boot.settled()).toBe(false); expect(stopCalls).toBe(0); expect(binds).toBe(0);
    if (failed) handover.reject(drainFailure); else handover.resolve();
    const error = rejection(await withTestTimeout(boot.outcome));
    if (failed) expect(error).toBe(drainFailure);
    else expect(String(error)).toContain('handed over to a managed replacement');
    expect(stopCalls).toBe(1); expect(drained).toBe(true); expect(f.server().isRunning).toBe(false);
  } finally {
    handover.resolve(); await boot.outcome; await f.close();
  }
}, 60_000);

test('failed boot reports both its original listener error and incomplete cleanup', async () => {
  const bindFailure = new Error('fixture bind primary'), cleanupFailure = new Error('fixture stop incomplete');
  let stopCalls = 0, drained = false;
  const f = fixture((server, restore) => {
    const stop = spyOn(server, 'stop').mockImplementation(async () => {
      stopCalls++; await originalStop.call(server); drained = true;
      // A reported stop failure remains a failure even when other real owners
      // have already drained; the factory cannot silently acknowledge it.
      throw cleanupFailure;
    });
    restore(() => stop.mockRestore());
  });
  const serveFactory: typeof Bun.serve = () => { throw bindFailure; };
  try {
    const error = rejection(await withTestTimeout(observed(bootDaemon({ ...f.options, serveFactory })).outcome));
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error('Missing boot/cleanup aggregate');
    expect(error.errors).toEqual([bindFailure, cleanupFailure]);
    expect(stopCalls).toBe(1); expect(drained).toBe(true);
  } finally { await f.close(); }
}, 60_000);

test('a returned public stop handle waits for and propagates an incomplete actual server drain', async () => {
  const entered = deferred(), release = deferred(), cleanupFailure = new Error('fixture returned stop incomplete');
  let drained = false;
  const f = fixture((server, restore) => {
    const stop = spyOn(server, 'stop').mockImplementation(async () => {
      entered.resolve(); await release.promise;
      await originalStop.call(server); drained = true; throw cleanupFailure;
    });
    restore(() => stop.mockRestore());
  });
  let stopping: Promise<unknown> | undefined;
  try {
    const daemon = await withTestTimeout(bootDaemon(f.options));
    expect(daemon.server).toBe(f.server()); expect(daemon.server.isRunning).toBe(true);
    expect(daemon.port).toBeGreaterThan(0);
    let settled = false;
    stopping = daemon.stop().then(() => { settled = true; return null; }, (error: unknown) => { settled = true; return error; });
    await withTestTimeout(entered.promise);
    expect(settled).toBe(false); expect(drained).toBe(false);
    release.resolve();
    expect(await withTestTimeout(stopping)).toBe(cleanupFailure);
    expect(drained).toBe(true); expect(daemon.server.isRunning).toBe(false);
  } finally { release.resolve(); await stopping; await f.close(); }
}, 60_000);
