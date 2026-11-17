// Proves: A daemon embedded in another program replaces that program's executable or exits it; or a standalone daemon stops itself to hand over to the service manager before a successor is ready, leaving nothing running.
// Red when: An embedded daemon starts the update loop or installs a service unit and exits, or a standalone daemon stops or exits before the user service manager answered and the unit was installed and reloaded.
// Proves: The running daemon installs a download whose bytes do not match the release's checksums, swaps its programs while work is running, or reinstalls the release a rollback rejected.
// Red when: The update loop skips the checksum comparison, swaps while the daemon is not idle, or ignores the version a crash-loop rollback rejected.
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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonLifecycleRuntime, type DaemonLifecycleRuntimeOptions } from '../platform/src/platform/daemon/facade-lifecycle.ts';
import type { ServiceCommandRunner } from '../platform/src/platform/daemon/service-handover.ts';
import { dirname } from 'node:path';
import { DaemonAutoUpdater } from '../platform/src/platform/daemon/auto-updater.ts';
import { DaemonReceiptStore } from '../platform/src/platform/daemon/receipts.ts';
import { PREVIOUS_FILE_SUFFIX, sha256 } from '../platform/src/platform/runtime/self-update.ts';
import { nativeCohortFixture } from './_helpers/daemon-native-cohort.ts';

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

describe('the update loop', () => {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const installed = nativeCohortFixture({ version: '1.0.0', daemonBytes: 'daemon 1.0.0', arch });
  const release = nativeCohortFixture({ version: '2.0.0', daemonBytes: 'daemon 2.0.0', arch });
  const LATEST = 'https://releases.invalid/goodvibes/releases/latest';
  const DOWNLOAD = 'https://releases.invalid/goodvibes/releases/download/v2.0.0';
  const daemonAsset = `goodvibes-daemon-linux-${arch}`;

  /** The release host: the latest tag, the checksum file, and the assets, with any asset replaced. */
  function releaseHost(replaced: Record<string, Buffer> = {}) {
    const requested: string[] = [];
    const sums = Object.entries(release.assets).map(([name, bytes]) => `${sha256(bytes)}  ${name}`).join('\n') + '\n';
    const fetchImpl = async (url: string): Promise<Response> => {
      requested.push(url);
      if (url === LATEST) return Object.defineProperty(new Response(null, { status: 302, headers: { location: 'https://releases.invalid/goodvibes/releases/tag/v2.0.0' } }), 'url', { value: LATEST });
      const name = url.startsWith(`${DOWNLOAD}/`) ? url.slice(DOWNLOAD.length + 1) : '';
      if (name === 'SHA256SUMS.txt') return new Response(sums);
      const bytes = replaced[name] ?? release.assets[name];
      return bytes ? new Response(new Uint8Array(bytes)) : new Response('missing', { status: 404 });
    };
    return { fetchImpl, requested };
  }

  /** A real installation directory holding 1.0.0, and an updater over it with the given release host. */
  function updaterFor(host: ReturnType<typeof releaseHost>, options: { idle?: () => boolean; rejected?: string } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'update-loop-'));
    scratchDirs.push(root);
    const execPath = join(root, 'gv', 'goodvibes-daemon');
    const files = installed.installation(execPath);
    // The installation lists the members in order, then the installation receipt.
    for (const [index, [path, bytes]] of Object.entries(files).entries()) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
      chmodSync(path, installed.members[index]?.mode ?? 0o644);
    }
    const restarts: number[] = [];
    const updater = new DaemonAutoUpdater({
      currentVersion: '1.0.0', execPath, platform: 'linux', arch, releasesLatestUrl: LATEST,
      downloadBaseUrl: () => DOWNLOAD, fetchImpl: host.fetchImpl as never,
      isIdle: options.idle ?? (() => true),
      rejectedVersion: () => options.rejected ?? null,
      serviceActions: { isSupervised: () => true, adoptIntoService: () => {}, restartService: () => { restarts.push(1); return { status: 'accepted' }; } },
      receipts: new DaemonReceiptStore(join(root, 'receipts.json')),
      stopGracefully: () => {}, exitProcess: () => {}, stderr: { write: () => {} },
      setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>, clearTimer: () => {},
    });
    const unchanged = () => Object.entries(files).every(([path, bytes]) => readFileSync(path).equals(bytes)) && !existsSync(execPath + PREVIOUS_FILE_SUFFIX);
    return { updater, restarts, unchanged, execPath };
  }

  test('one tick installs only a checksum-true release, only while idle, and never the release a rollback rejected', async () => {
    // A download altered together with its build record, the checksum file left as published.
    const altered = Buffer.from('daemon 2.0.0, altered');
    const record = JSON.parse(release.assets[`${daemonAsset}.ci-artifact.json`]!.toString()) as { files: Array<{ path: string; sha256: string; size: number }> };
    record.files[0] = { ...record.files[0]!, sha256: sha256(altered), size: altered.length };
    const rows = [
      { name: 'bytes that do not match the checksum file', host: releaseHost({ [daemonAsset]: altered, [`${daemonAsset}.ci-artifact.json`]: Buffer.from(JSON.stringify(record)) }), options: {} },
      // Idle when the check starts, busy by the time the download is ready to be put in place.
      { name: 'work started during the download', host: releaseHost(), options: { idle: (() => { let calls = 0; return () => calls++ === 0; })() } },
      { name: 'the rollback rejected 2.0.0', host: releaseHost(), options: { rejected: '2.0.0' } },
    ];
    for (const row of rows) {
      const { updater, restarts, unchanged } = updaterFor(row.host, row.options);
      await updater.tick();
      expect({ row: row.name, unchanged: unchanged(), applied: updater.snapshot().appliedVersion ?? null, restarts: restarts.length })
        .toEqual({ row: row.name, unchanged: true, applied: null, restarts: 0 });
      if (row.options.rejected) expect(row.host.requested).toEqual([LATEST]);
    }

    // The control: the same feed, idle, is installed and handed over once.
    const good = updaterFor(releaseHost());
    await good.updater.tick();
    expect(good.updater.snapshot().appliedVersion).toBe('2.0.0');
    expect(readFileSync(good.execPath, 'utf8')).toBe('daemon 2.0.0');
    expect(readFileSync(good.execPath + PREVIOUS_FILE_SUFFIX, 'utf8')).toBe('daemon 1.0.0');
    expect(good.restarts).toEqual([1]);
  });
});
