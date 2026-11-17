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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonLifecycleRuntime, type DaemonLifecycleRuntimeOptions } from '../platform/src/platform/daemon/facade-lifecycle.ts';
import type { ServiceCommandRunner } from '../platform/src/platform/daemon/service-handover.ts';

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

describe('daemon update artifact identity', () => {
  test('embedded default: update.auto=true but no artifact identity: no loop starts', async () => {
    const { runtime } = lifecycleWith(undefined);
    runtime.onStarted();
    try {
      expect(runtime.updateStatus().armed).toBe(false);
    } finally {
      await runtime.onStopping(false);
    }
  });
});

describe('boot-edge service promotion (independent of updates)', () => {
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
