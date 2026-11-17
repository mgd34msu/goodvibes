/**
 * Crash-loop rollback: a verified update that cannot start is replaced by the
 * kept previous installation after three failed boots, never twice in a row,
 * never onto a build that cannot read the saved data, never over an
 * installation it does not own, and never by half.
 *
 * The lifecycle runtime, marker logic and native installation checks are the
 * product's own; the filesystem is an in-memory one, the clock and process exit
 * are injected, and there is no service manager (a handover is refused).
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  readLifecycleMarker,
  recordDaemonAutoRollback,
  recordDaemonCleanShutdown,
  recordDaemonStart,
  recordDaemonStartAttempt,
  type LifecycleMarkerIo,
} from '../platform/src/platform/daemon/lifecycle-marker.ts';
import { DaemonLifecycleRuntime, type DaemonLifecycleRuntimeOptions } from '../platform/src/platform/daemon/facade-lifecycle.ts';
import { PREVIOUS_FILE_SUFFIX, NATIVE_READER_REQUIREMENT_FILE, nativeReaderCapabilities, realUpdateFileIo, type UpdateFileIo } from '../platform/src/platform/runtime/self-update.ts';
import { fixtureStrings, nativeCohortFixture } from './_helpers/daemon-native-cohort.ts';

const MARKER = '/state/daemon-lifecycle.json';
// One real installation directory for the file; each harness lays it out afresh.
const INSTALL_PARENT = mkdtempSync(join(tmpdir(), 'crash-loop-install-'));
const INSTALL_ROOT = join(INSTALL_PARENT, 'gv');
const EXEC_PATH = join(INSTALL_ROOT, 'goodvibes-daemon');
const PREVIOUS_PATH = `${EXEC_PATH}${PREVIOUS_FILE_SUFFIX}`;

const scratchDirs: string[] = [];
afterEach(() => {
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
});
afterAll(() => rmSync(INSTALL_PARENT, { recursive: true, force: true }));

function memoryMarkerIo(): { io: LifecycleMarkerIo; files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    io: {
      read: (path) => files.get(path) ?? null,
      write: (path, contents) => void files.set(path, contents),
    },
  };
}

const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const badCohort = nativeCohortFixture({ version: '2.0.0', daemonBytes: 'bad-build', arch });
const goodCohort = nativeCohortFixture({ version: '1.0.0', daemonBytes: 'good-build', arch });

describe('failed-start streak', () => {
  test('counts consecutive boots that never fully started; a fully started boot or an orderly stop resets it', () => {
    const { io } = memoryMarkerIo();
    let clock = 1_000_000;
    const now = (): number => clock;
    for (const expected of [0, 1, 2, 3]) { expect(recordDaemonStartAttempt(MARKER, { io, now }).failedStarts).toBe(expected); clock += 5_000; }
    recordDaemonStart(MARKER, { io, now, pid: 4242 });
    expect(recordDaemonStartAttempt(MARKER, { io, now }).failedStarts).toBe(0);
    recordDaemonStartAttempt(MARKER, { io, now });
    recordDaemonCleanShutdown(MARKER, { io, now });
    expect(recordDaemonStartAttempt(MARKER, { io, now }).failedStarts).toBe(0);
  });

  test('a streak recorded by one version does not carry over to the version that replaced it', () => {
    const { io } = memoryMarkerIo();
    let clock = 1_000_000;
    const now = (): number => clock;
    recordDaemonStartAttempt(MARKER, { io, now, version: '1.24.1' });
    clock += 2_000;
    expect(recordDaemonStartAttempt(MARKER, { io, now, version: '1.24.1' }).failedStarts).toBe(1);
    clock += 2_000;
    expect(recordDaemonStartAttempt(MARKER, { io, now, version: '1.27.0' }).failedStarts).toBe(0);
  });

  test('a rejected version outlives the restored build starting and stopping, so the update loop does not reinstall it', () => {
    const { io } = memoryMarkerIo();
    const now = (): number => 1_000_000;
    recordDaemonAutoRollback(MARKER, { io, now, rejectedVersion: '2.0.0' });
    recordDaemonStart(MARKER, { io, now, pid: 99, version: '1.9.0' });
    recordDaemonCleanShutdown(MARKER, { io, now, version: '1.9.0' });
    expect(readLifecycleMarker(MARKER, io)?.rejectedVersion).toBe('2.0.0');
  });

  test('the rejection clears when the rejected version itself starts successfully', () => {
    const { io } = memoryMarkerIo();
    const now = (): number => 1_000_000;
    recordDaemonAutoRollback(MARKER, { io, now, rejectedVersion: '2.0.0' });
    recordDaemonStart(MARKER, { io, now, pid: 99, version: '2.0.0' });
    expect(readLifecycleMarker(MARKER, io)?.rejectedVersion).toBeUndefined();
  });
});

interface RollbackHarness {
  readonly runtime: DaemonLifecycleRuntime;
  /** The installation directory as it is on disk now. */
  readonly files: InstalledFiles;
  /** The file operations the rollback uses: the real ones, which a test may replace one at a time. */
  readonly rollbackIo: UpdateFileIo;
  readonly exits: number[];
  readonly stops: number[];
  /** The lifecycle marker as persisted. */
  readonly marker: () => ReturnType<typeof readLifecycleMarker>;
  /** The state directory, so a second harness can model the NEXT process on the same host. */
  readonly scratch: string;
}

/** Read-only view of the installation directory on disk. */
interface InstalledFiles {
  get(path: string): Buffer | undefined;
  has(path: string): boolean;
  entries(): [string, Buffer][];
}
const installedFiles: InstalledFiles = {
  get: path => existsSync(path) ? readFileSync(path) : undefined,
  has: path => existsSync(path),
  entries: () => (readdirSync(INSTALL_ROOT, { recursive: true, withFileTypes: true }) as Dirent[])
    // The kernel lock file a reader lease holds is persistent by design and is not installed content.
    .filter(entry => entry.isFile() && !entry.name.endsWith('.lock.held')).map(entry => join(entry.parentPath, entry.name)).sort()
    .map(path => [path, readFileSync(path)] as [string, Buffer]),
};

/** Lay an installation out on disk with the modes the release installs. */
function placeInstallation(files: Record<string, string>): void {
  rmSync(INSTALL_ROOT, { recursive: true, force: true });
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(path), { recursive: true });
    const live = path.endsWith(PREVIOUS_FILE_SUFFIX) ? path.slice(0, -PREVIOUS_FILE_SUFFIX.length) : path;
    const executable = live === EXEC_PATH || live.endsWith('.bun');
    writeFileSync(path, contents, { mode: executable ? 0o755 : 0o644 });
    chmodSync(path, executable ? 0o755 : 0o644);
  }
}

function rollbackHarness(overrides: {
  readonly artifact?: DaemonLifecycleRuntimeOptions['updateArtifact'];
  /** The installation to lay out; `null` keeps what is on disk, as the next process on the same host would find it. */
  readonly installed?: Record<string, string> | null;
  /** Share one state directory, so the second harness reads the first's marker. */
  readonly controlPlaneDir?: string;
} = {}): RollbackHarness {
  const scratch = overrides.controlPlaneDir ?? mkdtempSync(join(tmpdir(), 'crash-loop-'));
  if (overrides.controlPlaneDir === undefined) scratchDirs.push(scratch);
  if (overrides.installed !== null) placeInstallation(overrides.installed ?? fixtureStrings({ ...badCohort.installation(EXEC_PATH), ...goodCohort.installation(EXEC_PATH, PREVIOUS_FILE_SUFFIX) }));
  const config = new Map<string, unknown>([
    ['update.auto', false], // the loop is not what these tests exercise
    ['service.enabled', false], // boot promotion is a separate path
    ['service.serviceName', 'goodvibes-crash-loop-test'],
    ['service.restartOnFailure', true],
    ['update.rollbackAfterFailedStarts', 3],
  ]);
  const configManager = {
    get: (key: string) => config.get(key),
    getControlPlaneConfigDir: () => scratch,
  } as unknown as DaemonLifecycleRuntimeOptions['configManager'];
  // A systemd user manager that is not running this daemon: the handover adopts the
  // restored build into it, and this one has no unit to install.
  const platformServiceManager = {
    serviceName: () => 'goodvibes-crash-loop-test',
    status: () => ({ installed: false, running: false, platform: 'systemd', path: join(scratch, 'goodvibes-crash-loop-test.service') }),
    install: () => { throw new Error('no service manager in this test'); },
  } as unknown as DaemonLifecycleRuntimeOptions['platformServiceManager'];
  const rollbackIo: UpdateFileIo = { ...realUpdateFileIo };
  const exits: number[] = [];
  const stops: number[] = [];
  const runtime = new DaemonLifecycleRuntime({
    stderr: { write: () => {} },
    configManager,
    platformServiceManager,
    servicePlatform: 'linux',
    serviceCommandRunner: async () => ({ status: 'accepted' }),
    isIdle: () => true,
    rollbackIo,
    now: () => new Date(2026, 6, 12, 14, 30).getTime(),
    exitProcess: (code: number) => { exits.push(code); },
    stopGracefully: () => { stops.push(stops.length); },
    isCompiledBinary: () => true,
    alertOwner: () => {},
    ...(overrides.artifact !== undefined ? { updateArtifact: overrides.artifact } : {}),
  });
  return {
    runtime,
    files: installedFiles,
    rollbackIo,
    exits,
    stops,
    scratch,
    marker: () => readLifecycleMarker(join(scratch, 'control-plane', 'daemon-lifecycle.json')),
  };
}

const ARTIFACT = { version: '2.0.0', execPath: EXEC_PATH };

describe('crash-loop rollback at boot', () => {
  test('three failed starts restore the complete previous installation and record the rejected version', async () => {
    const h = rollbackHarness({ artifact: ARTIFACT });
    for (let i = 0; i < 3; i++) expect(h.runtime.onStarting()).toBe(false);
    expect(h.files.get(EXEC_PATH)?.toString()).toBe('bad-build');
    // Boot 4 finds three failures behind it and refuses to repeat them.
    expect(h.runtime.onStarting()).toBe(true);
    // The exchange keeps the failing build, so a hand-run rollback rolls forward again.
    for (const [path, bytes] of Object.entries(goodCohort.installation(EXEC_PATH))) {
      expect(h.files.get(path)).toEqual(bytes);
      expect(h.files.get(path + PREVIOUS_FILE_SUFFIX)).toEqual(badCohort.installation(EXEC_PATH)[path]);
    }
    expect(h.marker()?.rejectedVersion).toBe('2.0.0');
    await h.runtime.drainHandovers();
    expect(h.exits).toEqual([]);
  });

  test('a healthy boot in the middle resets the counter, and an in-process restart cycle is not a boot', async () => {
    const h = rollbackHarness({ artifact: ARTIFACT });
    expect(h.runtime.onStarting()).toBe(false);
    expect(h.runtime.onStarting()).toBe(false);
    h.runtime.onStarted();
    for (let i = 0; i < 6; i++) {
      await h.runtime.onStopping(true);
      expect(h.runtime.onStarting()).toBe(false);
      h.runtime.onStarted();
    }
    expect(h.files.get(EXEC_PATH)?.toString()).toBe('bad-build');
    expect(h.marker()?.rejectedVersion).toBeUndefined();
    await h.runtime.onStopping(false);
  });

  test('never twice in a row: a second crash loop after a rollback is refused, in this process and the next', async () => {
    const h = rollbackHarness({ artifact: ARTIFACT });
    for (let i = 0; i < 4; i++) h.runtime.onStarting();
    await h.runtime.drainHandovers();
    expect(h.files.get(EXEC_PATH)?.toString()).toBe('good-build');
    for (let i = 0; i < 4; i++) expect(h.runtime.onStarting()).toBe(true);
    expect(h.files.get(EXEC_PATH)?.toString()).toBe('good-build');
    // The next process on the same host runs the restored build, finds the persisted guard, and fails to start again.
    const next = rollbackHarness({ artifact: { version: '1.0.0', execPath: EXEC_PATH }, controlPlaneDir: h.scratch, installed: null });
    for (let i = 0; i < 4; i++) expect(next.runtime.onStarting()).toBe(false);
    expect(next.files.get(EXEC_PATH)?.toString()).toBe('good-build');
    await next.runtime.onStopping(false);
  });

  test('failed starts for one version cannot replace a different current installation', async () => {
    const unrelated = nativeCohortFixture({ version: '9.0.0', daemonBytes: 'unrelated-current-daemon', arch });
    const h = rollbackHarness({ artifact: ARTIFACT, installed: fixtureStrings({
      ...unrelated.installation(EXEC_PATH), ...goodCohort.installation(EXEC_PATH, PREVIOUS_FILE_SUFFIX),
    }) });
    const before = h.files.entries();
    for (let i = 0; i < 4; i++) expect(h.runtime.onStarting()).toBe(false);
    await h.runtime.drainHandovers();
    expect(h.files.entries()).toEqual(before);
    expect(h.marker()?.rejectedVersion).toBeUndefined();
    await h.runtime.onStopping(false);
  });

  for (const missing of ['.bun', '.bun.LICENSE.md', '.bun.json', '/lib/sqlite-vec-linux-x64/vec0.so', '/daemon-installation.json']) {
    test(`a missing previous member ${missing} refuses the whole rollback`, async () => {
      const h = rollbackHarness({ artifact: ARTIFACT });
      const path = missing.startsWith('/') ? join(INSTALL_ROOT, missing.slice(1).replace('linux-x64', `linux-${arch}`)) : EXEC_PATH + missing;
      rmSync(path + PREVIOUS_FILE_SUFFIX);
      const before = h.files.entries();
      for (let i = 0; i < 4; i++) expect(h.runtime.onStarting()).toBe(false);
      await h.runtime.drainHandovers();
      expect(h.files.entries()).toEqual(before);
      expect(h.marker()?.rejectedVersion).toBeUndefined();
      await h.runtime.onStopping(false);
    });
  }

  for (const confirmed of [false, true]) test(`a previous build is restored over saved data only when its own readers confirm it can read it (confirmed=${confirmed})`, async () => {
    const current = nativeCohortFixture({ version: '3.1.3', daemonBytes: 'current-reader', arch });
    const previous = nativeCohortFixture({ version: '3.1.2', daemonBytes: 'previous-reader', arch,
      ...(confirmed ? { readers: nativeReaderCapabilities('3.1.2') } : {}) });
    const floor = join(EXEC_PATH, '..', NATIVE_READER_REQUIREMENT_FILE);
    const contents = JSON.stringify({ schema: 1, minimumReader: '3.1.2', formats: ['payment-retained-holds-v2'] });
    const h = rollbackHarness({ artifact: { version: '3.1.3', execPath: EXEC_PATH }, installed: {
      ...fixtureStrings(current.installation(EXEC_PATH)), ...fixtureStrings(previous.installation(EXEC_PATH, PREVIOUS_FILE_SUFFIX)), [floor]: contents,
    } });
    for (let i = 0; i < 3; i++) expect(h.runtime.onStarting()).toBe(false);
    expect(h.runtime.onStarting()).toBe(confirmed);
    await h.runtime.drainHandovers();
    for (const [path, bytes] of Object.entries((confirmed ? previous : current).installation(EXEC_PATH))) expect(h.files.get(path)).toEqual(bytes);
    expect(h.files.get(floor)?.toString()).toBe(contents);
    expect(h.exits).toEqual([]);
    await h.runtime.onStopping(false);
  });

  test('a saved-data reader floor above the previous version refuses the rollback and keeps both installations', async () => {
    const current = nativeCohortFixture({ version: '3.1.2', daemonBytes: 'current-reader', arch });
    const previous = nativeCohortFixture({ version: '3.1.1', daemonBytes: 'older-reader', arch });
    const floor = join(EXEC_PATH, '..', NATIVE_READER_REQUIREMENT_FILE);
    const contents = JSON.stringify({ schema: 1, minimumReader: '3.1.2', formats: ['payment-retained-holds-v2'] });
    const h = rollbackHarness({ artifact: { version: '3.1.2', execPath: EXEC_PATH }, installed: {
      ...fixtureStrings(current.installation(EXEC_PATH)), ...fixtureStrings(previous.installation(EXEC_PATH, PREVIOUS_FILE_SUFFIX)), [floor]: contents,
    } });
    for (let i = 0; i < 4; i++) expect(h.runtime.onStarting()).toBe(false);
    for (const [path, bytes] of Object.entries(current.installation(EXEC_PATH))) expect(h.files.get(path)).toEqual(bytes);
    for (const [path, bytes] of Object.entries(previous.installation(EXEC_PATH, PREVIOUS_FILE_SUFFIX))) expect(h.files.get(path)).toEqual(bytes);
    expect(h.files.get(floor)?.toString()).toBe(contents); expect(h.exits).toEqual([]); expect(h.stops).toEqual([]);
    await h.runtime.onStopping(false);
  });

  test('a rollback that fails and is fully compensated leaves the installation unchanged', async () => {
    const h = rollbackHarness({ artifact: ARTIFACT });
    const before = h.files.entries();
    const rename = h.rollbackIo.rename;
    h.rollbackIo.rename = (from, to) => {
      if (from === PREVIOUS_PATH) throw new Error('synthetic rollback commit failure');
      rename(from, to);
    };
    for (let i = 0; i < 4; i++) expect(h.runtime.onStarting()).toBe(false);
    expect(h.files.entries()).toEqual(before);
    expect(h.marker()?.rejectedVersion).toBeUndefined();
    expect(h.exits).toEqual([]);
    await h.runtime.onStopping(false);
  });

  test('a rollback that cannot be compensated pauses the boot and keeps its recovery evidence across lifecycle calls', async () => {
    const h = rollbackHarness({ artifact: ARTIFACT });
    const rename = h.rollbackIo.rename;
    h.rollbackIo.rename = (from, to) => {
      if (from === PREVIOUS_PATH || from.endsWith('.rollback-exchange')) throw new Error('synthetic rollback and compensation failure');
      rename(from, to);
    };
    for (let i = 0; i < 3; i++) expect(h.runtime.onStarting()).toBe(false);
    expect(h.runtime.onStarting()).toBe(true);
    expect(h.files.has(`${EXEC_PATH}.update-transaction`)).toBe(true);
    const initial = h.runtime.updateStatus().transactionRecovery;
    expect(initial?.recoveryRequired).toBe(true);
    expect(initial?.committed).toBe(false);
    const files = h.files.entries();
    for (let i = 0; i < 2; i++) {
      h.runtime.onStarted();
      await h.runtime.onStopping(i === 0);
      expect(h.runtime.onStarting()).toBe(true);
      expect(h.runtime.updateStatus().transactionRecovery).toEqual(initial);
    }
    expect(h.files.entries()).toEqual(files);
    expect(h.marker()?.rejectedVersion).toBeUndefined();
    expect(h.exits).toEqual([]);
  });
});
