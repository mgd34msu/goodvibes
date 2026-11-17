/**
 * A daemon replaces or hands itself over only when it owns the artifact and a
 * successor is ready:
 *
 * - Embedded default (no artifact identity): even with update.auto=true and a
 *   releases URL configured, no update loop starts and no service promotion
 *   exits the process, so the host's own executable is never replaced and the
 *   host is never killed.
 * - With a host-provided artifact identity, the loop compares and swaps the
 *   HOST's artifact, never the platform package.
 * - A boot promotion to the service manager stops this daemon only after the
 *   unit is installed and the manager reloaded; any refusal leaves it serving.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonLifecycleRuntime, type DaemonLifecycleRuntimeOptions } from '../platform/src/platform/daemon/facade-lifecycle.ts';
import type { ServiceCommandRunner } from '../platform/src/platform/daemon/service-handover.ts';
import { VERSION } from '../platform/src/platform/version.ts';
import { prepareServiceHandover } from '../platform/src/platform/daemon/service-handover-preflight.js';

const scratchDirs: string[] = [];

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

interface LifecycleHarness {
  readonly runtime: DaemonLifecycleRuntime;
  readonly installs: number[];
  readonly exits: number[];
}

function lifecycleWith(
  updateArtifact?: DaemonLifecycleRuntimeOptions['updateArtifact'],
  overrides: {
    readonly install?: (() => object) | undefined;
    readonly runner?: ServiceCommandRunner | undefined;
    readonly platform?: NodeJS.Platform | undefined;
    readonly timeoutMs?: number | undefined;
    readonly configOverrides?: Record<string, unknown>;
    readonly status?: (() => { installed: boolean; running: boolean; platform?: string; serviceName?: string; path?: string; pid?: number; contents?: string }) | undefined;
    readonly isIdle?: (() => boolean) | undefined;
    readonly promotionRetryMs?: number | undefined;
    readonly isCompiledBinary?: (() => boolean) | undefined;
    readonly stopGracefully?: DaemonLifecycleRuntimeOptions['stopGracefully'];
    readonly hasOverriddenHome?: boolean | undefined;
    readonly reserveLaunchdHandover?: DaemonLifecycleRuntimeOptions['reserveLaunchdHandover'];
  } = {},
): LifecycleHarness {
  const scratch = mkdtempSync(join(tmpdir(), 'update-artifact-'));
  scratchDirs.push(scratch);
  const config = new Map<string, unknown>([
    ['update.auto', true],
    ['update.releasesUrl', 'https://releases.invalid/latest'],
    ['update.intervalMinutes', 60],
    ['service.serviceName', 'goodvibes-test'],
    ...Object.entries(overrides.configOverrides ?? {}),
  ]);
  const configManager = {
    get: (key: string) => config.get(key),
    getControlPlaneConfigDir: () => scratch,
  } as unknown as DaemonLifecycleRuntimeOptions['configManager'];
  const installs: number[] = [];
  const exits: number[] = [];
  const platformServiceManager = {
    serviceName: () => String(config.get('service.serviceName')),
    status: () => ({ platform: 'systemd', ...(overrides.status?.() ?? { installed: false, running: false }) }),
    install: () => { installs.push(Date.now()); return overrides.install?.() ?? {}; },
  } as unknown as DaemonLifecycleRuntimeOptions['platformServiceManager'];
  const runtime = new DaemonLifecycleRuntime({
    configManager,
    platformServiceManager,
    servicePlatform: overrides.platform ?? 'linux',
    serviceCommandRunner: overrides.runner ?? (async () => ({ status: 'accepted' })),
    serviceCommandTimeoutMs: overrides.timeoutMs ?? 100,
    stderr: { write: () => {} },
    isIdle: overrides.isIdle ?? (() => true),
    // Boot promotion hands over by exiting, tests OBSERVE the exit.
    exitProcess: (code: number) => { exits.push(code); },
    // These tests simulate a COMPILED daemon promoting; the bun-test process is
    // itself a source run, so default the seam to compiled and let a dev-gate
    // test flip it to false.
    isCompiledBinary: overrides.isCompiledBinary ?? (() => true),
    ...(overrides.stopGracefully ? { stopGracefully: overrides.stopGracefully } : {}),
    ...(overrides.hasOverriddenHome === undefined ? {} : { hasOverriddenHome: overrides.hasOverriddenHome }),
    ...(overrides.reserveLaunchdHandover ? { reserveLaunchdHandover: overrides.reserveLaunchdHandover } : {}),
    ...(overrides.promotionRetryMs !== undefined ? { promotionRetryMs: overrides.promotionRetryMs } : {}),
    ...(updateArtifact !== undefined ? { updateArtifact } : {}),
  });
  return { runtime, installs, exits };
}

function updaterOf(runtime: DaemonLifecycleRuntime): { readonly options: { currentVersion: string; execPath: string } } | null {
  return (runtime as unknown as { autoUpdater: { readonly options: { currentVersion: string; execPath: string } } | null }).autoUpdater;
}

describe('daemon update artifact identity', () => {
  test('embedded default: update.auto=true but no artifact identity: no loop starts', async () => {
    const { runtime } = lifecycleWith(undefined);
    runtime.onStarted();
    try {
      expect(updaterOf(runtime)).toBeNull();
    } finally {
      await runtime.onStopping(false);
    }
  });

  test('a host artifact identity drives the comparison: never the platform package version', async () => {
    const { runtime } = lifecycleWith({ version: '999.0.0-host-artifact', execPath: '/opt/host/bin/host-app' });
    runtime.onStarted();
    try {
      const updater = updaterOf(runtime);
      expect(updater).not.toBeNull();
      expect(updater!.options.currentVersion).toBe('999.0.0-host-artifact');
      // The embedder's identity is what gets compared and swapped, the platform
      // package version must play no part when a host names its artifact.
      expect(updater!.options.currentVersion).not.toBe(VERSION);
      expect(updater!.options.execPath).toBe('/opt/host/bin/host-app');
    } finally {
      await runtime.onStopping(false);
    }
  });

  test('an artifact identity without execPath swaps the running executable by default', async () => {
    const { runtime } = lifecycleWith({ version: '999.0.0-host-artifact' });
    runtime.onStarted();
    try {
      expect(updaterOf(runtime)!.options.execPath).toBe(process.execPath);
    } finally {
      await runtime.onStopping(false);
    }
  });
});

describe('boot-edge service promotion (independent of updates)', () => {
  const artifact = { version: '999.0.0-host-artifact' };

  test('a standalone unsupervised idle daemon installs the unit and hands over at boot', async () => {
    const { runtime, installs, exits } = lifecycleWith(artifact);
    runtime.onStarted();
    try {
      await runtime.drainHandovers();
      expect(installs).toHaveLength(1);
      expect(exits).toEqual([0]);
    } finally {
      await runtime.onStopping(false);
    }
  });

  test('an embedded daemon (no artifact identity) never self-promotes: exiting would kill the host', async () => {
    const { runtime, installs, exits } = lifecycleWith(undefined);
    runtime.onStarted();
    try {
      expect(installs).toHaveLength(0);
      expect(exits).toHaveLength(0);
    } finally {
      await runtime.onStopping(false);
    }
  });

  test('an already-supervised daemon is left alone', async () => {
    const { runtime, installs, exits } = lifecycleWith(artifact, { status: () => ({ installed: true, running: true }) });
    runtime.onStarted();
    try {
      expect(installs).toHaveLength(0);
      expect(exits).toHaveLength(0);
    } finally {
      await runtime.onStopping(false);
    }
  });

  test.each([['darwin', 'launchd'], ['win32', 'windows'], ['linux', 'manual'], ['linux', 'launchd']] as const)(
    'unsupported %s/%s promotion preserves the live native runtime before any cleanup', async (platform, managerPlatform) => {
    const listener = Bun.serve({ hostname: '127.0.0.1', port: 0,
      fetch: () => Response.json({ ok: true, version: '3.1.2' }),
    });
    const stops: number[] = [], commands: string[][] = [];
    const h = lifecycleWith({ version: '3.1.2', execPath: '/opt/goodvibes/goodvibes-daemon', suite: true }, {
      platform, hasOverriddenHome: false, isCompiledBinary: () => true,
      configOverrides: { 'service.enabled': true },
      status: () => ({ installed: false, running: false, platform: managerPlatform }),
      stopGracefully: async () => { stops.push(1); await listener.stop(true); },
      runner: async argv => { commands.push([...argv]); return { status: 'accepted' }; },
    });
    try {
      h.runtime.onStarted(true);
      expect(h.runtime.activateNativeLifecycle()).toBeUndefined();
      await h.runtime.drainHandovers();
      expect(stops).toEqual([]); expect(h.installs).toEqual([]);
      expect(commands).toEqual([]); expect(h.exits).toEqual([]);
      const response = await fetch(`http://127.0.0.1:${listener.port}/status`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, version: '3.1.2' });
      expect(h.runtime.activateNativeLifecycle()).toBeUndefined();
      await h.runtime.drainHandovers();
      expect(stops).toEqual([]); expect(h.installs).toEqual([]); expect(h.exits).toEqual([]);
    } finally {
      await h.runtime.onStopping(false);
      await listener.stop(true);
    }
  });

  test('service.enabled=false keeps the daemon session-only (opt-out honored)', async () => {
    const { runtime, installs, exits } = lifecycleWith(artifact, { configOverrides: { 'service.enabled': false } });
    runtime.onStarted();
    try {
      expect(installs).toHaveLength(0);
      expect(exits).toHaveLength(0);
    } finally {
      await runtime.onStopping(false);
    }
  });

  test('a platform without a service manager is left alone', async () => {
    const { runtime, installs, exits } = lifecycleWith(artifact, { status: () => { throw new Error('unsupported'); } });
    runtime.onStarted();
    try {
      expect(installs).toHaveLength(0);
      expect(exits).toHaveLength(0);
    } finally {
      await runtime.onStopping(false);
    }
  });

  test('a source/dev run never self-promotes (no unit written, no handover)', async () => {
    // Everything else says "promote" (artifact identity, idle, not installed),
    // only the compiled-binary gate stops it, because a dev unit would fail on
    // the next boot.
    const { runtime, installs, exits } = lifecycleWith(artifact, { isCompiledBinary: () => false });
    runtime.onStarted();
    try {
      expect(installs).toHaveLength(0);
      expect(exits).toHaveLength(0);
    } finally {
      await runtime.onStopping(false);
    }
  });

  test('a busy daemon does not install a unit or hand over at boot', async () => {
    const { runtime, installs, exits } = lifecycleWith(artifact, { isIdle: () => false });
    runtime.onStarted();
    try {
      await runtime.drainHandovers();
      expect(installs).toHaveLength(0);
      expect(exits).toHaveLength(0);
    } finally {
      await runtime.onStopping(false);
    }
  });
});


test('host-deferred native activation starts neither updater nor promotion until ready, then drains its original stop without self-wait', async () => {
  const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>(); const sequence: string[] = [];
  const h = lifecycleWith({ version: '999.0.0-host-artifact' }, {
    stopGracefully: async () => { sequence.push('stop'); entered.resolve(); await released.promise; await h.runtime.onStopping(false, true); sequence.push('drained'); },
    runner: async () => { sequence.push('service'); return { status: 'accepted' }; },
  });
  h.runtime.onStarted(true);
  expect(updaterOf(h.runtime)).toBeNull(); expect(h.runtime.updateStatus().armed).toBe(false); expect(h.installs).toEqual([]);
  const outcome = h.runtime.activateNativeLifecycle(); expect(outcome && outcome.state).toBe('handover');
  if (!outcome) throw new Error('Expected one actual native activation owner');
  expect(h.runtime.activateNativeLifecycle()).toBe(outcome);
  try {
    // The unit is installed and the manager probed and reloaded while the runtime still serves; only enable follows the stop.
    await entered.promise; expect(h.installs).toHaveLength(1); expect(h.exits).toEqual([]);
    released.resolve(); await outcome.drain;
    expect(sequence).toEqual(['service', 'service', 'stop', 'drained', 'service']); expect(h.installs).toHaveLength(1); expect(h.exits).toEqual([0]);
    expect(h.runtime.activateNativeLifecycle()).toBe(outcome); expect(updaterOf(h.runtime)).toBeNull();
  } finally { released.resolve(); await h.runtime.onStopping(false); }
});

test('boot promotion never enables or exits after failed original cleanup, and preserves a value-free failure receipt', async () => {
  let inspections = 0; const commands: string[][] = [];
  const failure = { get message() { inspections++; return 'private promotion owner'; }, toString() { inspections++; return 'private promotion owner'; } };
  const h = lifecycleWith({ version: '999.0.0-host-artifact' }, { configOverrides: { 'update.auto': false },
    stopGracefully: async () => { throw failure; }, runner: async argv => { commands.push([...argv]); return { status: 'accepted' }; },
  });
  h.runtime.onStarted(true); const outcome = h.runtime.activateNativeLifecycle(); if (!outcome) throw new Error('Expected actual promotion attempt');
  try {
    await outcome.drain;
    expect(h.installs).toHaveLength(1); expect(commands).toEqual([['systemctl', '--user', 'show-environment'], ['systemctl', '--user', 'daemon-reload']]); expect(h.exits).toEqual([]); expect(inspections).toBe(0);
    expect(h.runtime.activateNativeLifecycle()).toBe(outcome);
  } finally { await h.runtime.onStopping(false, false, false); }
});

for (const cancellation of ['stop', 'handle'] as const) test(`external ${cancellation} cancels and drains promotion while its original cleanup is still pending`, async () => {
  const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>(); const commands: string[][] = [];
  const h = lifecycleWith({ version: '999.0.0-host-artifact' }, { configOverrides: { 'update.auto': false },
    stopGracefully: async () => { entered.resolve(); await released.promise; },
    runner: async argv => { commands.push([...argv]); return { status: 'accepted' }; },
  });
  h.runtime.onStarted(true); const outcome = h.runtime.activateNativeLifecycle(); if (!outcome) throw new Error('Expected actual promotion attempt');
  await entered.promise; if (cancellation === 'handle') outcome.cancel();
  let completed = false; const closed = h.runtime.onStopping(false).then(() => { completed = true; });
  try {
    await Promise.resolve(); expect(completed).toBe(false); expect(h.installs).toHaveLength(1);
    released.resolve(); await closed; await outcome.drain;
    expect(commands.some(argv => argv.includes('enable'))).toBe(false); expect(h.exits).toEqual([]);
  } finally { released.resolve(); await closed; }
});

test('an externally stopped deferred host cannot later activate updater or promotion', async () => {
  const h = lifecycleWith({ version: '999.0.0-host-artifact' }); h.runtime.onStarted(true); await h.runtime.onStopping(false);
  expect(h.runtime.activateNativeLifecycle()).toBeUndefined(); expect(updaterOf(h.runtime)).toBeNull(); expect(h.installs).toEqual([]); expect(h.exits).toEqual([]);
});

test('launchd reservation holds when the status text is a redacted view of the plist, and rejects an edited plist', async () => {
  const root = mkdtempSync(join(tmpdir(), 'launchd-redacted-handover-')); scratchDirs.push(root);
  const path = join(root, 'sh.goodvibes.daemon.plist');
  writeFileSync(path, '<plist><key>GOODVIBES_DAEMON_TOKEN</key><string>secret</string></plist>', { mode: 0o600 });
  const h = lifecycleWith({ version: '3.1.2', execPath: '/opt/goodvibes/goodvibes-daemon', suite: true }, {
    platform: 'darwin', hasOverriddenHome: false,
    configOverrides: { 'service.serviceName': 'goodvibes' },
    status: () => ({ platform: 'launchd', serviceName: 'sh.goodvibes.daemon', path, installed: true, running: true,
      pid: process.pid, contents: '<plist><key>GOODVIBES_DAEMON_TOKEN</key><string>&lt;redacted&gt;</string></plist>' }),
    reserveLaunchdHandover: async (input) => {
      input.assertServiceCurrent();
      return { exitRequired: true, assertCurrent: input.assertServiceCurrent,
        async commit() { return { status: 'accepted' }; }, async cancel() {},
      };
    },
  });
  const actions = (h.runtime as unknown as { buildServiceActions(): import('../platform/src/platform/daemon/auto-updater.js').AutoUpdateServiceActions }).buildServiceActions();
  const prepared = prepareServiceHandover(actions);
  if (!prepared) throw new Error('Expected the actual launchd action adapter');
  try {
    await prepared.reserve(new AbortController().signal);
    prepared.assertCurrent();
    writeFileSync(path, '<plist><key>GOODVIBES_DAEMON_TOKEN</key><string>other</string></plist>', { mode: 0o600 });
    expect(() => prepared.assertCurrent()).toThrow();
  } finally { await prepared.cancel(); await h.runtime.onStopping(false); }
});

for (const label of ['sh.goodvibes.daemon', 'custom.goodvibes']) {
  test(`launchd reservation retains the resolved ${label} identity and rejects a same-byte plist replacement`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'launchd-resolved-handover-')); scratchDirs.push(root);
    const path = join(root, label + '.plist'), contents = '<plist><dict><key>Label</key><string>' + label + '</string></dict></plist>';
    writeFileSync(path, contents, { mode: 0o644 });
    let reservations = 0, cancelled = 0;
    const h = lifecycleWith({ version: '3.1.2', execPath: '/opt/goodvibes/goodvibes-daemon', suite: true }, {
      platform: 'darwin', hasOverriddenHome: false,
      configOverrides: { 'service.serviceName': label === 'sh.goodvibes.daemon' ? 'goodvibes' : label },
      status: () => ({ platform: 'launchd', serviceName: label, path, installed: true, running: true,
        pid: process.pid, contents: readFileSync(path, 'utf8') }),
      reserveLaunchdHandover: async (input, signal) => {
        expect(signal?.aborted).toBe(false);
        expect(input.serviceName).toBe(label); expect(input.servicePath).toBe(path); expect(input.pid).toBe(process.pid);
        expect(input.executablePath).toBe('/opt/goodvibes/goodvibes-daemon'); input.assertServiceCurrent(); reservations++;
        return { exitRequired: true, assertCurrent: input.assertServiceCurrent,
          async commit() { return { status: 'accepted' }; }, async cancel() { cancelled++; },
        };
      },
    });
    const actions = (h.runtime as unknown as { buildServiceActions(): import('../platform/src/platform/daemon/auto-updater.js').AutoUpdateServiceActions }).buildServiceActions();
    const prepared = prepareServiceHandover(actions);
    if (!prepared) throw new Error('Expected the actual launchd action adapter');
    try {
      await prepared.reserve(new AbortController().signal);
      expect(reservations).toBe(1); expect(prepared.exitRequired).toBe(true); prepared.assertCurrent();
      writeFileSync(path + '.incoming', contents, { mode: 0o644 }); renameSync(path + '.incoming', path);
      expect(() => prepared.assertCurrent()).toThrow();
      expect(h.installs).toEqual([]); expect(h.exits).toEqual([]);
    } finally { await prepared.cancel(); expect(cancelled).toBe(1); await h.runtime.onStopping(false); }
  });
}

describe('observed service handover', () => {
  const artifact = { version: '999.0.0-host-artifact' };
  for (const thrown of [new Error('install unavailable'), undefined]) {
    test(`install throwing ${String(thrown)} never exits`, async () => {
      const commands: string[][] = [];
      const h = lifecycleWith(artifact, { install: () => { throw thrown; }, runner: async (argv) => { commands.push([...argv]); return { status: 'accepted' }; } });
      h.runtime.onStarted();
      await h.runtime.drainHandovers();
      expect(h.exits).toEqual([]);
      // The unit is installed first; nothing runs after a failed install.
      expect(commands).toEqual([]);
      await h.runtime.onStopping(false);
    });
  }
  for (const outcome of ['failed', 'unknown', 'unsupported'] as const) {
    test(`reload ${outcome} never enables or exits`, async () => {
      const commands: string[][] = [];
      const h = lifecycleWith(artifact, { runner: async (argv) => { commands.push([...argv]); return { status: argv.includes('daemon-reload') ? outcome : 'accepted' }; } });
      h.runtime.onStarted();
      await h.runtime.drainHandovers();
      expect(h.exits).toEqual([]);
      expect(commands).toEqual([['systemctl', '--user', 'show-environment'], ['systemctl', '--user', 'daemon-reload']]);
      await h.runtime.onStopping(false);
    });
  }
  test('reload is completed before start enqueue; duplicate starts make one handover', async () => {
    let release!: (outcome: { status: 'accepted' }) => void;
    const reloading = Promise.withResolvers<void>();
    const commands: string[][] = [];
    const h = lifecycleWith(artifact, { runner: async (argv) => {
      commands.push([...argv]);
      if (argv.includes('daemon-reload')) { reloading.resolve(); return new Promise((resolve) => { release = resolve; }); }
      return { status: 'accepted' };
    } });
    h.runtime.onStarted();
    h.runtime.onStarted();
    await reloading.promise;
    expect(commands).toHaveLength(2);
    expect(h.exits).toEqual([]);
    release({ status: 'accepted' });
    await h.runtime.drainHandovers();
    expect(commands).toEqual([['systemctl', '--user', 'show-environment'], ['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', '--no-block', 'enable', '--now', 'goodvibes-test.service']]);
    expect(h.installs).toHaveLength(1);
    expect(h.exits).toEqual([0]);
    h.runtime.onStarted();
    await h.runtime.drainHandovers();
    expect(h.exits).toEqual([0]);
    await h.runtime.onStopping(false);
  });
  for (const stage of ['reload', 'start'] as const) {
    for (const failure of ['failed', 'throw'] as const) {
      test(`${stage} ${failure} stays alive and owns errors`, async () => {
        let calls = 0;
        const h = lifecycleWith(artifact, { timeoutMs: 10, runner: async () => {
          calls++;
          if (stage === 'start' && calls === 1) return { status: 'accepted' };
          if (failure === 'throw') throw new Error('spawn failed');
          return { status: 'failed', detail: 'nonzero' };
        } });
        h.runtime.onStarted();
        await h.runtime.drainHandovers();
        expect(h.exits).toEqual([]);
        expect(calls).toBe(stage === 'start' ? 2 : 1);
        await h.runtime.onStopping(false);
      });
    }
  }
  test('unsupported platform never installs a unit or exits', async () => {
    const h = lifecycleWith(artifact, { platform: 'win32' });
    h.runtime.onStarted();
    await h.runtime.drainHandovers();
    expect(h.installs).toEqual([]);
    expect(h.exits).toEqual([]);
    await h.runtime.onStopping(false);
  });
  test('close cancels and drains pending reload, owns late rejection, never starts or exits', async () => {
    let reject!: (reason: unknown) => void;
    let commands = 0;
    let aborted = false;
    const requested = Promise.withResolvers<void>();
    const h = lifecycleWith(artifact, { runner: (_argv, signal) => {
      commands++;
      signal.addEventListener('abort', () => { aborted = true; });
      requested.resolve();
      return new Promise((_resolve, rejectPromise) => { reject = rejectPromise; });
    } });
    h.runtime.onStarted();
    await requested.promise;
    await h.runtime.onStopping(false);
    expect(aborted).toBe(true);
    reject(new Error('late error after cancellation'));
    await h.runtime.drainHandovers();
    expect(commands).toBe(1);
    expect(h.exits).toEqual([]);
  });
});

test('early shutdown fence cancels promotion before slower shutdown hooks drain', async () => {
  let release!: (outcome: { status: 'accepted' }) => void;
  const requested = Promise.withResolvers<void>();
  const h = lifecycleWith({ version: '999.0.0-host-artifact' }, { runner: () => { requested.resolve(); return new Promise((resolve) => { release = resolve; }); } });
  h.runtime.onStarted();
  await requested.promise;
  h.runtime.beginStopping();
  release({ status: 'accepted' });
  await h.runtime.drainHandovers(); // The facade awaiting other shutdown hooks.
  expect(h.exits).toEqual([]);
  await h.runtime.onStopping(false);
});

describe('boot promotion is prepared while the runtime still serves', () => {
  const artifact = { version: '999.0.0-host-artifact' };

  test('a user manager that does not answer leaves a serving daemon: nothing is stopped or exited, no enable runs, and the host keeps starting', async () => {
    const stops: number[] = [], commands: string[][] = [];
    const h = lifecycleWith(artifact, {
      stopGracefully: async () => { stops.push(1); },
      runner: async argv => { commands.push([...argv]); return { status: 'failed', detail: 'no user bus' }; },
    });
    h.runtime.onStarted(true);
    const outcome = h.runtime.activateNativeLifecycle();
    if (!outcome) throw new Error('Expected a promotion attempt');
    try {
      expect(outcome.resumed?.()).toBe(false);
      await outcome.drain;
      expect(outcome.resumed?.()).toBe(true);
      expect(stops).toEqual([]); expect(h.exits).toEqual([]);
      expect(commands).toEqual([['systemctl', '--user', 'show-environment']]);
    } finally { await h.runtime.onStopping(false); }
  });

  test('a unit that cannot be installed leaves a serving daemon', async () => {
    const stops: number[] = [];
    const h = lifecycleWith(artifact, { install: () => { throw new Error('read-only home'); }, stopGracefully: async () => { stops.push(1); } });
    h.runtime.onStarted(true);
    const outcome = h.runtime.activateNativeLifecycle();
    if (!outcome) throw new Error('Expected a promotion attempt');
    try {
      await outcome.drain;
      expect(outcome.resumed?.()).toBe(true); expect(stops).toEqual([]); expect(h.exits).toEqual([]);
    } finally { await h.runtime.onStopping(false); }
  });

  test('once prepared, only enable follows the stop', async () => {
    const sequence: string[] = [];
    const h = lifecycleWith(artifact, {
      stopGracefully: async () => { sequence.push('stop'); },
      runner: async argv => { sequence.push(argv.includes('enable') ? 'enable' : argv.at(-1)!); return { status: 'accepted' }; },
    });
    h.runtime.onStarted(true);
    const outcome = h.runtime.activateNativeLifecycle();
    if (!outcome) throw new Error('Expected a promotion attempt');
    await outcome.drain;
    expect(sequence).toEqual(['show-environment', 'daemon-reload', 'stop', 'enable']);
    expect(outcome.resumed?.()).toBe(false); expect(h.exits).toEqual([0]);
    await h.runtime.onStopping(false);
  });
});
