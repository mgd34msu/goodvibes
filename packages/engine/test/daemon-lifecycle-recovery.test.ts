/**
 * Crash-loop rollback scoping, handovers that cannot finish after the runtime
 * stopped, and transaction claims held by another live updater.
 *
 * Every filesystem, service command and process exit is an in-memory seam:
 * no binary is swapped, no service manager runs and no process exits.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProcessIdentityProbe, readLifecycleMarker, recordDaemonAutoRollback, recordDaemonCleanShutdown, recordDaemonStart, recordDaemonStartAttempt, type LifecycleMarkerIo, type ProcessIdentityProbe } from '../platform/src/platform/daemon/lifecycle-marker.ts';
import { DaemonLifecycleRuntime, type DaemonLifecycleRuntimeOptions } from '../platform/src/platform/daemon/facade-lifecycle.ts';
import { DaemonAutoUpdater, defaultDownloadBaseUrl } from '../platform/src/platform/daemon/auto-updater.ts';
import { DaemonReceiptStore } from '../platform/src/platform/daemon/receipts.ts';
import { PlatformServiceManager } from '../platform/src/platform/daemon/service-manager.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import {
  PREVIOUS_FILE_SUFFIX, UpdateTransactionContendedError, UpdateTransactionError, describeTransactionRecovery, swapFileAtomically,
  type UpdateFetchLike,
} from '../platform/src/platform/runtime/self-update.ts';
import { fixtureStrings, nativeCohortFixture, nativeCohortReleaseFixture, nativeMemoryIo } from './_helpers/daemon-native-cohort.ts';

const EXEC_PATH = '/opt/gv/goodvibes-daemon';
const scratchDirs: string[] = [];
afterEach(() => { while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true }); });

function memoryMarkerIo(): { io: LifecycleMarkerIo; files: Map<string, string> } {
  const files = new Map<string, string>();
  return { files, io: { read: (path) => files.get(path) ?? null, write: (path, contents) => void files.set(path, contents) } };
}

const cohort = (version: string) => nativeCohortFixture({ version, daemonBytes: `daemon-${version}` });

interface Harness {
  readonly runtime: DaemonLifecycleRuntime;
  readonly files: Map<string, Buffer>;
  readonly exits: number[];
  readonly stops: number[];
  readonly stderr: string[];
  readonly receipts: () => string[];
  readonly marker: { io: LifecycleMarkerIo; files: Map<string, string> };
  readonly scratch: string;
}

function harness(options: {
  readonly version: string;
  readonly current: string;
  readonly previous?: string;
  readonly marker?: Harness['marker'];
  readonly scratch?: string;
  readonly runner?: DaemonLifecycleRuntimeOptions['serviceCommandRunner'];
  readonly supervised?: boolean;
  readonly endOnIncomplete?: boolean;
  readonly configOverrides?: Record<string, unknown>;
  readonly markerProcessIdentity?: ProcessIdentityProbe;
}): Harness {
  const scratch = options.scratch ?? mkdtempSync(join(tmpdir(), 'lifecycle-recovery-'));
  if (options.scratch === undefined) scratchDirs.push(scratch);
  const config = new Map<string, unknown>([
    ['update.auto', false], ['service.enabled', false], ['service.serviceName', 'goodvibes-recovery-test'],
    ['update.rollbackAfterFailedStarts', 3], ...Object.entries(options.configOverrides ?? {}),
  ]);
  const marker = options.marker ?? memoryMarkerIo();
  const { io: rollbackIo, files } = nativeMemoryIo(Object.fromEntries(Object.entries(fixtureStrings({
    ...cohort(options.current).installation(EXEC_PATH),
    ...(options.previous ? cohort(options.previous).installation(EXEC_PATH, PREVIOUS_FILE_SUFFIX) : {}),
  })).map(([path, bytes]) => [path, Buffer.from(bytes)])));
  const exits: number[] = [], stops: number[] = [], stderr: string[] = [];
  const runtime = new DaemonLifecycleRuntime({
    configManager: { get: (key: string) => config.get(key), getControlPlaneConfigDir: () => scratch } as unknown as DaemonLifecycleRuntimeOptions['configManager'],
    platformServiceManager: {
      status: () => ({ installed: options.supervised ?? true, running: options.supervised ?? true, platform: 'systemd', path: join(scratch, 'unit') }),
      install: () => ({}),
    } as unknown as DaemonLifecycleRuntimeOptions['platformServiceManager'],
    servicePlatform: 'linux',
    serviceCommandRunner: options.runner ?? (async () => ({ status: 'accepted' })),
    serviceCommandTimeoutMs: 20,
    isIdle: () => true,
    markerIo: marker.io,
    ...(options.markerProcessIdentity ? { markerProcessIdentity: options.markerProcessIdentity } : {}),
    rollbackIo,
    stderr: { write: (chunk: string) => void stderr.push(chunk) },
    exitProcess: (code: number) => { exits.push(code); },
    stopGracefully: () => { stops.push(1); },
    isCompiledBinary: () => true,
    alertOwner: () => {},
    updateArtifact: { version: options.version, execPath: EXEC_PATH },
    ...(options.endOnIncomplete ? { onIncompleteHandover: () => { exits.push(1); } } : {}),
  });
  return { runtime, files, exits, stops, stderr, marker, scratch, receipts: () => runtime.receiptStore().list().map(row => row.text) };
}

describe('a build that has fully started here is never rolled back for later failed starts', () => {
  test('repeated failed starts of the proven version leave the binary and the rejection record alone', async () => {
    const first = harness({ version: '2.0.0', current: '2.0.0', previous: '1.0.0' });
    expect(first.runtime.onStarting()).toBe(false);
    first.runtime.onStarted();
    // Three later boots of the same build fail before full startup (a port in use).
    for (let boot = 0; boot < 3; boot++) {
      const failing = harness({ version: '2.0.0', current: '2.0.0', previous: '1.0.0', marker: first.marker, scratch: first.scratch });
      expect(failing.runtime.onStarting()).toBe(false);
    }
    const fourth = harness({ version: '2.0.0', current: '2.0.0', previous: '1.0.0', marker: first.marker, scratch: first.scratch });
    expect(fourth.runtime.onStarting()).toBe(false);
    await fourth.runtime.drainHandovers();
    expect(fourth.files.get(EXEC_PATH)?.toString()).toBe('daemon-2.0.0');
    expect(fourth.stops).toEqual([]);
    expect(readLifecycleMarker([...first.marker.files.keys()][0]!, first.marker.io)?.rejectedVersion).toBeUndefined();
    expect(fourth.stderr.join('')).toContain('has fully started on this machine before');
  });

  test('a build that never fully started here is still rolled back after the same streak', async () => {
    const h = harness({ version: '2.0.0', current: '2.0.0', previous: '1.0.0' });
    for (let boot = 0; boot < 3; boot++) expect(h.runtime.onStarting()).toBe(false);
    expect(h.runtime.onStarting()).toBe(true);
    await h.runtime.drainHandovers();
    expect(h.files.get(EXEC_PATH)?.toString()).toBe('daemon-1.0.0');
  });

  test('every marker writer keeps the proven version', () => {
    const { io, files } = memoryMarkerIo();
    const path = '/state/daemon-lifecycle.json';
    recordDaemonStart(path, { io, pid: 1, version: '1.0.0' });
    recordDaemonStartAttempt(path, { io, version: '2.0.0' });
    expect(readLifecycleMarker(path, io)?.lastStartedVersion).toBe('1.0.0');
    recordDaemonAutoRollback(path, { io, rejectedVersion: '2.0.0' });
    expect(readLifecycleMarker(path, io)?.lastStartedVersion).toBe('1.0.0');
    recordDaemonCleanShutdown(path, { io, version: '1.0.0' });
    expect(readLifecycleMarker(path, io)?.lastStartedVersion).toBe('1.0.0');
    expect(files.size).toBe(1);
  });
});

describe('a crash-loop rollback only moves to an older, unrejected build', () => {
  test('a kept copy that is newer than the running build is refused with a receipt', async () => {
    const h = harness({ version: '1.0.0', current: '1.0.0', previous: '2.0.0' });
    for (let boot = 0; boot < 4; boot++) expect(h.runtime.onStarting()).toBe(false);
    await h.runtime.drainHandovers();
    expect(h.files.get(EXEC_PATH)?.toString()).toBe('daemon-1.0.0');
    expect(h.stops).toEqual([]);
    expect(h.receipts().join('\n')).toContain('the kept previous copy is v2.0.0, which is not older than the running v1.0.0');
  });

  test('a kept copy that is the rejected release is refused with a receipt', async () => {
    const h = harness({ version: '1.0.0', current: '1.0.0', previous: '0.9.0' });
    const markerPath = join(h.scratch, 'control-plane', 'daemon-lifecycle.json');
    h.marker.files.set(markerPath, JSON.stringify({ state: 'clean-shutdown', at: 1, failedStarts: 0, rejectedVersion: '0.9.0' }));
    for (let boot = 0; boot < 4; boot++) expect(h.runtime.onStarting()).toBe(false);
    await h.runtime.drainHandovers();
    expect(h.files.get(EXEC_PATH)?.toString()).toBe('daemon-1.0.0');
    expect(h.receipts().join('\n')).toContain('the release an earlier automatic rollback rejected');
    expect(readLifecycleMarker(markerPath, h.marker.io)?.rejectedVersion).toBe('0.9.0');
  });
});

describe('a handover that cannot finish after the runtime stopped asks the process owner to end the process', () => {
  test('rollback: a failed service restart ends the process with status 1 and says why on stderr', async () => {
    const h = harness({ version: '2.0.0', current: '2.0.0', previous: '1.0.0', endOnIncomplete: true,
      runner: async () => ({ status: 'failed', detail: 'restart rejected' }) });
    for (let boot = 0; boot < 3; boot++) h.runtime.onStarting();
    expect(h.runtime.onStarting()).toBe(true);
    await h.runtime.drainHandovers();
    expect(h.stops).toHaveLength(1);
    expect(h.exits).toEqual([1]);
    expect(h.stderr.join('')).toContain('ending this process with status 1');
    expect(h.files.get(EXEC_PATH)?.toString()).toBe('daemon-1.0.0');
  });

  test('rollback: an external close during the handover never ends the process', async () => {
    let release!: (outcome: { status: 'failed' }) => void;
    const h = harness({ version: '2.0.0', current: '2.0.0', previous: '1.0.0', endOnIncomplete: true,
      runner: () => new Promise((resolve) => { release = resolve; }) });
    for (let boot = 0; boot < 4; boot++) h.runtime.onStarting();
    await Bun.sleep(1);
    const closing = h.runtime.onStopping(false);
    release({ status: 'failed' });
    await closing;
    expect(h.exits).toEqual([]);
  });

  test('boot promotion: a refused service enable after the orderly stop ends the process with status 1', async () => {
    const commands: string[][] = [];
    const h = harness({ version: '3.0.0', current: '3.0.0', supervised: false, endOnIncomplete: true,
      configOverrides: { 'service.enabled': true },
      runner: async (argv) => { commands.push([...argv]); return argv.includes('enable') ? { status: 'failed', detail: 'no user bus' } : { status: 'accepted' }; } });
    h.runtime.onStarted(true);
    const handover = h.runtime.activateNativeLifecycle();
    if (!handover) throw new Error('Expected a promotion handover');
    await handover.drain;
    expect(h.stops).toHaveLength(1);
    expect(commands.at(-1)).toContain('enable');
    expect(h.exits).toEqual([1]);
    await h.runtime.onStopping(false);
  });

  test('an embedder that did not opt in keeps its process', async () => {
    const h = harness({ version: '2.0.0', current: '2.0.0', previous: '1.0.0',
      runner: async () => ({ status: 'failed', detail: 'restart rejected' }) });
    for (let boot = 0; boot < 4; boot++) h.runtime.onStarting();
    await h.runtime.drainHandovers();
    expect(h.exits).toEqual([]);
  });
});

const LATEST_URL = 'https://example.test/releases/latest';
function releaseFetch(): UpdateFetchLike {
  const base = defaultDownloadBaseUrl(LATEST_URL, 'v2.0.0');
  const release = nativeCohortReleaseFixture({ version: '2.0.0', daemonBytes: 'daemon-v2' });
  const reply = (url: string, status: number, body: Buffer | null, location: string | null = null) => ({
    ok: status === 200, status, url, headers: { get: (name: string) => (name.toLowerCase() === 'location' ? location : null) },
    text: async () => body?.toString('utf-8') ?? '', arrayBuffer: async () => (body ? Uint8Array.from(body).buffer : new ArrayBuffer(0)),
  });
  return async (url) => {
    if (url === LATEST_URL) return reply(url, 302, null, 'https://example.test/releases/tag/v2.0.0');
    if (url === `${base}/SHA256SUMS.txt`) return reply(url, 200, Buffer.from(release.checksumManifest));
    const asset = url.startsWith(`${base}/`) ? release.assets[url.slice(base.length + 1)] : undefined;
    return asset ? reply(url, 200, asset) : reply(url, 404, null);
  };
}

function updater(options: { readonly files?: Record<string, Buffer>; readonly restart?: () => { status: 'accepted' | 'failed'; detail?: string } }) {
  const scratch = mkdtempSync(join(tmpdir(), 'lifecycle-recovery-updater-'));
  scratchDirs.push(scratch);
  const { io, files } = nativeMemoryIo({ ...nativeCohortFixture({ version: '1.0.0', daemonBytes: 'daemon-v1' }).installation(EXEC_PATH), ...options.files });
  const exits: number[] = [], stderr: string[] = [], alerts: string[] = [];
  const timers: number[] = [];
  const instance = new DaemonAutoUpdater({
    currentVersion: '1.0.0', execPath: EXEC_PATH, platform: 'linux', arch: 'x64', releasesLatestUrl: LATEST_URL,
    isIdle: () => true, io, fetchImpl: releaseFetch(),
    receipts: new DaemonReceiptStore(join(scratch, 'receipts.json')),
    serviceActions: { isSupervised: () => true, adoptIntoService: () => ({ status: 'accepted' }), restartService: options.restart ?? (() => ({ status: 'accepted' })) },
    stopGracefully: () => {}, exitProcess: (code) => { exits.push(code); }, onIncompleteHandover: () => { exits.push(1); },
    stderr: { write: (chunk: string) => void stderr.push(chunk) }, alertOwner: (text) => void alerts.push(text),
    setTimer: (_fn, ms) => { timers.push(ms); return 0 as unknown as ReturnType<typeof setTimeout>; }, clearTimer: () => {},
  });
  return { instance, files, exits, stderr, alerts, timers };
}

describe('the update loop after its own orderly stop', () => {
  test('a refused service restart ends the process with status 1 once the update is on disk', async () => {
    const h = updater({ restart: () => ({ status: 'failed', detail: 'restart rejected' }) });
    await h.instance.tick();
    expect(h.files.get(EXEC_PATH)?.toString()).toBe('daemon-v2');
    expect(h.instance.snapshot().handover?.status).toBe('failed');
    expect(h.exits).toEqual([1]);
    expect(h.stderr.join('')).toContain('service handover is incomplete');
  });

  test('an accepted supervised restart neither exits nor reports', async () => {
    const h = updater({});
    await h.instance.tick();
    expect(h.exits).toEqual([]);
    expect(h.stderr).toEqual([]);
  });
});

describe('a transaction claim held by another live updater', () => {
  const claimFrom = (pid: number, startedAt = Date.now()) => Buffer.from(JSON.stringify({ operation: 'update', pid, startedAt }));

  test('is contention: nothing changes, no fence is left, and the attempt can be retried', () => {
    const { io, files } = nativeMemoryIo({ '/fixture/daemon': Buffer.from('old'), '/fixture/daemon.update-transaction': claimFrom(process.ppid) });
    let failure: unknown;
    try { swapFileAtomically('/fixture/daemon', Buffer.from('new'), { executable: true, io }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(UpdateTransactionError);
    const receipt = (failure as UpdateTransactionError).receipt;
    expect(receipt.recoveryRequired).toBe(false);
    expect((failure as UpdateTransactionError).cause).toBeInstanceOf(UpdateTransactionContendedError);
    expect(files.get('/fixture/daemon')?.toString()).toBe('old');
    expect(files.get('/fixture/daemon.update-transaction')?.toString()).toContain(`"pid":${process.ppid}`);
  });

  test('from a process that is gone is recovery, with the retained paths and the safe action named', () => {
    const { io } = nativeMemoryIo({ '/fixture/daemon': Buffer.from('old'), '/fixture/daemon.update-transaction': claimFrom(2 ** 22 + 12_345) });
    let failure: unknown;
    try { swapFileAtomically('/fixture/daemon', Buffer.from('new'), { executable: true, io }); } catch (error) { failure = error; }
    const receipt = (failure as UpdateTransactionError).receipt;
    expect(receipt.recoveryRequired).toBe(true);
    expect(receipt.recoveryPaths).toContain('/fixture/daemon.update-transaction');
    const text = describeTransactionRecovery(receipt);
    expect(text).toContain('/fixture/daemon.update-transaction');
    expect(text).toContain('remove /fixture/daemon.update-transaction');
  });

  test('older than the contention window is recovery even when its pid is alive, and its own pid is never contention', () => {
    for (const claim of [claimFrom(process.ppid, Date.now() - 11 * 60 * 1000), claimFrom(process.pid)]) {
      const { io, files } = nativeMemoryIo({ '/fixture/daemon': Buffer.from('old'), '/fixture/daemon.update-transaction': claim });
      let failure: unknown;
      try { swapFileAtomically('/fixture/daemon', Buffer.from('new'), { executable: true, io }); } catch (error) { failure = error; }
      expect((failure as UpdateTransactionError).receipt.recoveryRequired).toBe(true);
      // The fence is never removed automatically.
      expect(files.has('/fixture/daemon.update-transaction')).toBe(true);
    }
  });

  test('defers the update loop instead of pausing it for recovery', async () => {
    const h = updater({ files: { [`${EXEC_PATH}.update-transaction`]: claimFrom(process.ppid) } });
    await h.instance.tick();
    expect(h.files.get(EXEC_PATH)?.toString()).toBe('daemon-v1');
    expect(h.instance.snapshot().recoveryRequired).toBe(false);
    expect(h.instance.snapshot().pendingVersion).toBe('2.0.0');
    expect(h.alerts).toEqual([]);
  });
});

describe('the systemd user manager that cannot be reached', () => {
  test('is reported as an action error instead of as a stopped service', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lifecycle-recovery-manager-'));
    scratchDirs.push(dir);
    const configManager = new ConfigManager({ configDir: join(dir, 'config') });
    configManager.set('service.platform', 'systemd');
    configManager.set('service.serviceName', 'goodvibes-unreachable');
    const manager = new PlatformServiceManager(configManager, {
      workingDirectory: dir, homeDirectory: dir,
      definitionOverride: { name: 'goodvibes-unreachable', description: 'fixture', workingDirectory: dir, command: '/bin/true', args: [], env: {}, restartOnFailure: true },
      actionRunner: () => ({ status: 1, stdout: '', stderr: 'Failed to connect to bus: No medium found' }),
      featureFlags: { isEnabled: () => true } as never,
    });
    const status = manager.status();
    expect(status.running).toBe(false);
    expect(status.actionError).toContain('could not be reached');
  });
});


const MARKER_PATH = '/state/daemon-lifecycle.json';
/** One live process per entry: pid -> start time. A pid that is not listed is not running. */
function processTable(live: Record<number, string | null>): ProcessIdentityProbe {
  return { isAlive: (pid) => pid in live, startTime: (pid) => live[pid] ?? null };
}

describe('a marker owned by another live daemon is not this process\'s record', () => {
  const owner = { pid: 111, startTime: 'T1' };

  function ownedMarker(live: Record<number, string | null>) {
    const { io, files } = memoryMarkerIo();
    const probe = processTable(live);
    recordDaemonStart(MARKER_PATH, { io, now: () => 1_000, pid: owner.pid, version: '2.0.0', processIdentity: processTable({ [owner.pid]: owner.startTime }) });
    return { io, files, probe, before: () => files.get(MARKER_PATH) };
  }

  test('its boots are not counted, its start is not a crash, its stop does not clear the owner', () => {
    const { io, probe, before } = ownedMarker({ 111: 'T1', 222: 'T9' });
    const snapshot = before();
    for (let boot = 0; boot < 5; boot++) {
      const attempt = recordDaemonStartAttempt(MARKER_PATH, { io, now: () => 2_000 + boot, pid: 222, version: '2.0.0', processIdentity: probe });
      expect(attempt.failedStarts).toBe(0);
      expect(attempt.foreignOwner).toEqual({ pid: 111 });
    }
    const started = recordDaemonStart(MARKER_PATH, { io, now: () => 3_000, pid: 222, version: '2.0.0', processIdentity: probe });
    expect(started.crashed).toBe(false);
    expect(started.foreignOwner).toEqual({ pid: 111 });
    recordDaemonCleanShutdown(MARKER_PATH, { io, now: () => 4_000, pid: 222, version: '2.0.0', processIdentity: probe });
    expect(before()).toBe(snapshot);
    expect(readLifecycleMarker(MARKER_PATH, io)).toMatchObject({ state: 'running', pid: 111, startTime: 'T1' });
  });

  test('a pid that now belongs to a different process owns nothing: the boots count and the dead run is a crash', () => {
    const { io, probe } = ownedMarker({ 111: 'REUSED', 222: 'T9' });
    const attempt = recordDaemonStartAttempt(MARKER_PATH, { io, now: () => 2_000, pid: 222, version: '2.0.0', processIdentity: probe });
    expect(attempt.foreignOwner).toBeNull();
    expect(attempt.crashed).toBe(true);
    expect(readLifecycleMarker(MARKER_PATH, io)?.failedStarts).toBe(1);
  });

  test('an owner that is gone owns nothing', () => {
    const { io, probe } = ownedMarker({ 222: 'T9' });
    const started = recordDaemonStart(MARKER_PATH, { io, now: () => 2_000, pid: 222, version: '2.0.0', processIdentity: probe });
    expect(started.crashed).toBe(true);
    expect(readLifecycleMarker(MARKER_PATH, io)).toMatchObject({ state: 'running', pid: 222, startTime: 'T9' });
  });

  test('a marker with no recorded start time proves no owner, so the safety net stays armed', () => {
    const { io, files } = memoryMarkerIo();
    files.set(MARKER_PATH, JSON.stringify({ state: 'running', at: 1, pid: 111, failedStarts: 0, version: '2.0.0' }));
    const attempt = recordDaemonStartAttempt(MARKER_PATH, { io, now: () => 2_000, pid: 222, version: '2.0.0', processIdentity: processTable({ 111: 'T1', 222: 'T9' }) });
    expect(attempt.foreignOwner).toBeNull();
    expect(readLifecycleMarker(MARKER_PATH, io)?.failedStarts).toBe(1);
  });

  test('a second daemon that keeps failing to bind never rolls the healthy one back', async () => {
    const live = { 111: 'T1', 222: 'T9' };
    const first = harness({ version: '2.0.0', current: '2.0.0', previous: '1.0.0', markerProcessIdentity: processTable(live) });
    // The healthy daemon recorded itself with its real pid; model it as another process.
    const markerPath = join(first.scratch, 'control-plane', 'daemon-lifecycle.json');
    first.marker.files.set(markerPath, JSON.stringify({ state: 'running', at: 1, pid: 111, startTime: 'T1', failedStarts: 0, version: '2.0.0', lastStartedVersion: '2.0.0' }));
    for (let boot = 0; boot < 6; boot++) {
      const second = harness({ version: '2.0.0', current: '2.0.0', previous: '1.0.0', marker: first.marker, scratch: first.scratch, markerProcessIdentity: processTable(live) });
      expect(second.runtime.onStarting()).toBe(false);
      await second.runtime.drainHandovers();
      expect(second.files.get(EXEC_PATH)?.toString()).toBe('daemon-2.0.0');
      expect(second.stops).toEqual([]);
    }
    expect(readLifecycleMarker(markerPath, first.marker.io)).toMatchObject({ state: 'running', pid: 111, failedStarts: 0 });
  });
});

describe('an orderly stop whose cleanup reported errors', () => {
  test('is neither reported as a crash nor lost: the next boot says what it was', async () => {
    const first = harness({ version: '2.0.0', current: '2.0.0' });
    expect(first.runtime.onStarting()).toBe(false);
    first.runtime.onStarted();
    await first.runtime.onStopping(false, false, false);
    const second = harness({ version: '2.0.0', current: '2.0.0', marker: first.marker, scratch: first.scratch });
    expect(second.runtime.onStarting()).toBe(false);
    second.runtime.onStarted();
    const receipts = second.receipts().join('\n');
    expect(receipts).toContain('stopped with cleanup errors');
    expect(receipts).not.toContain('after a crash');
    await second.runtime.onStopping(false);
  });
});

describe('the rejection of a failing build is on disk before its files are exchanged', () => {
  /** A marker filesystem that starts refusing writes once armed, optionally only for writes that match. */
  function failingMarker(refuse: (contents: string) => boolean) {
    const base = memoryMarkerIo();
    let armed = false;
    return {
      files: base.files,
      arm: () => { armed = true; },
      io: { read: base.io.read, write: (path: string, contents: string) => { if (armed && refuse(contents)) throw new Error('marker is read-only'); base.io.write(path, contents); } } satisfies LifecycleMarkerIo,
    };
  }

  test('a marker that cannot record it refuses the rollback while nothing has changed', async () => {
    const marker = failingMarker((contents) => contents.includes('rejectedVersion'));
    const h = harness({ version: '2.0.0', current: '2.0.0', previous: '1.0.0', marker });
    for (let boot = 0; boot < 3; boot++) expect(h.runtime.onStarting()).toBe(false);
    marker.arm();
    expect(h.runtime.onStarting()).toBe(false);
    await h.runtime.drainHandovers();
    expect(h.files.get(EXEC_PATH)?.toString()).toBe('daemon-2.0.0');
    expect(h.stops).toEqual([]);
    expect(h.receipts().join('\n')).toContain('could not record that v2.0.0 failed to start');
  });

  test('a failed stamp after the exchange still leaves the build rejected, so the restored one cannot reinstall it', async () => {
    const marker = failingMarker((contents) => contents.includes('autoRollbackAt'));
    const h = harness({ version: '2.0.0', current: '2.0.0', previous: '1.0.0', marker });
    for (let boot = 0; boot < 3; boot++) expect(h.runtime.onStarting()).toBe(false);
    marker.arm();
    expect(h.runtime.onStarting()).toBe(true);
    await h.runtime.drainHandovers();
    expect(h.files.get(EXEC_PATH)?.toString()).toBe('daemon-1.0.0');
    expect(readLifecycleMarker(join(h.scratch, 'control-plane', 'daemon-lifecycle.json'), marker.io)?.rejectedVersion).toBe('2.0.0');
  });

  test('an exchange that does not happen withdraws the rejection it announced', async () => {
    const h = harness({ version: '1.0.0', current: '1.0.0', previous: '2.0.0' });
    const markerPath = join(h.scratch, 'control-plane', 'daemon-lifecycle.json');
    for (let boot = 0; boot < 4; boot++) expect(h.runtime.onStarting()).toBe(false);
    await h.runtime.drainHandovers();
    expect(readLifecycleMarker(markerPath, h.marker.io)?.rejectedVersion).toBeUndefined();
  });
});

describe('checkForUpdatesNow says what it did', () => {
  test('a daemon whose update loop is off reports loop-off', async () => {
    const h = harness({ version: '2.0.0', current: '2.0.0' });
    expect((await h.runtime.checkForUpdatesNow()).check).toBe('loop-off');
  });

  test('a check that is already running is reported, not started again', async () => {
    const h = harness({ version: '2.0.0', current: '2.0.0' });
    (h.runtime as unknown as { autoUpdater: unknown }).autoUpdater = {
      tick: async () => 'already-in-flight', snapshot: () => ({ appliedVersion: null, recoveryRequired: false }), stop: () => {}, drainHandover: async () => {},
    };
    expect((await h.runtime.checkForUpdatesNow()).check).toBe('already-in-flight');
  });
});

describe('an owner that answers a liveness signal but is no longer running', () => {
  test.each([['Z', false], ['X', false], ['S', true], ['R', true], [null, true]] as const)('state %s is alive: %s', (state, alive) => {
    // Our own pid always answers the signal, so only the reported state decides.
    expect(createProcessIdentityProbe(() => state).isAlive(process.pid)).toBe(alive);
  });

  test('a crashed, unreaped daemon does not shield the next boot from the crash streak', () => {
    const { io } = memoryMarkerIo();
    recordDaemonStart(MARKER_PATH, { io, now: () => 1_000, pid: process.pid, version: '2.0.0', processIdentity: processTable({ [process.pid]: 'T1' }) });
    const zombie: ProcessIdentityProbe = { ...createProcessIdentityProbe(() => 'Z'), startTime: () => 'T1' };
    const attempt = recordDaemonStartAttempt(MARKER_PATH, { io, now: () => 2_000, pid: process.pid + 1, version: '2.0.0', processIdentity: zombie });
    expect(attempt.foreignOwner).toBeNull();
    expect(attempt.crashed).toBe(true);
    expect(readLifecycleMarker(MARKER_PATH, io)?.failedStarts).toBe(1);
  });
});
