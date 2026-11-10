import { describe, expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import {
  DAEMON_REPO_RELEASES_LATEST_URL,
  DAEMON_SPLIT_FLOOR_VERSION,
  createDaemonHandoverProgress,
  daemonReleaseDownloadBaseUrl,
  decideDaemonHandover,
  isPreSplitDaemonVersion,
  parseDaemonVersionOutput,
  performDaemonHandover,
  readInstalledDaemonVersion,
  resolveHandoverServiceName,
  restartHandedOverDaemon,
  runDaemonHandover,
  type PerformDaemonHandoverOptions,
  type RunCommandLike,
  type RunDaemonHandoverOptions,
} from '../platform/src/platform/runtime/client/daemon-handover.ts';
import {
  resolveDaemonNativeTargets,
  type UpdateFetchLike,
  type UpdateFileIo,
} from '../platform/src/platform/runtime/self-update.ts';
import { nativeCohortFixture, nativeCohortReleaseFixture, nativeMemoryIo } from './_helpers/daemon-native-cohort.ts';

// The legacy banner and filesystem are retained while the complete native
// daemon installation is prepared. Every seam is local: the `--version`
// probe never spawns a binary, fetch never reaches the network, the filesystem
// is a map, and systemctl is a recorded call list. Versions are fixtures
// ('1.27.1' as a legacy build, 'v2.0.23' as the native release), never the live
// build VERSION.

const PRE_SPLIT_VERSION = '1.27.1';
const SPLIT_TAG = 'v2.0.23';
const DAEMON_PATH = '/home/op/.local/bin/goodvibes-daemon';
const DAEMON_ASSET = 'goodvibes-daemon-linux-x64';

/** A run-command stub whose `--version` answer and systemctl answers are scripted. */
function stubRunCommand(script: {
  readonly version?: { status: number | null; stdout: string };
  readonly isActive?: { status: number | null; stdout: string };
  readonly restart?: { status: number | null; stdout: string };
  readonly calls?: string[][];
}): RunCommandLike {
  return (command, args) => {
    script.calls?.push([command, ...args]);
    if (args[0] === '--version') return script.version ?? { status: 0, stdout: `goodvibes-daemon ${PRE_SPLIT_VERSION}\n` };
    if (args.includes('is-active')) return script.isActive ?? { status: 0, stdout: 'active\n' };
    if (args.includes('restart')) return script.restart ?? { status: 0, stdout: '' };
    return { status: 1, stdout: '' };
  };
}

/**
 * A fetch stub serving the daemon repository's release: a HEAD redirect naming
 * `tag`, a SHA256SUMS.txt, and the asset bytes themselves. `assets` decides
 * which bytes are served. unavailableAssets leaves a genuine complete
 * manifest in place while its advertised payload responds404.
 */
function stubDaemonReleaseFetch(options: {
  readonly tag?: string;
  readonly assets?: Record<string, string>;
  readonly checksumManifest?: string;
  readonly unavailableAssets?: readonly string[];
  readonly requested?: string[];
}): UpdateFetchLike {
  const tag = options.tag ?? SPLIT_TAG;
  let release: { readonly assets: Record<string, string>; readonly manifest: string } | undefined;
  const releaseAssets = () => {
    if (release) return release;
    if (options.assets !== undefined) return release = { assets: options.assets,
      manifest: options.checksumManifest ?? '' };
    const cohort = nativeCohortReleaseFixture({ version: tag.replace(/^v/, ''), daemonBytes: 'new-daemon-bytes' });
    return release = { assets: Object.fromEntries(Object.entries(cohort.assets).map(([name, bytes]) => [name, bytes.toString()])), manifest: cohort.checksumManifest };
  };
  return async (url: string) => {
    options.requested?.push(url);
    if (url === DAEMON_REPO_RELEASES_LATEST_URL) {
      return {
        ok: true,
        status: 302,
        url,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'location'
              ? `https://github.com/mgd34msu/goodvibes/releases/tag/${tag}`
              : null,
        },
        text: async () => '',
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    const base = `${daemonReleaseDownloadBaseUrl(tag)}/`;
    const name = url.startsWith(base) ? url.slice(base.length) : null;
    const source = releaseAssets();
    const body = name === 'SHA256SUMS.txt' ? source.manifest : name && !options.unavailableAssets?.includes(name) ? source.assets[name] : undefined;
    if (body === undefined) {
      return {
        ok: false,
        status: 404,
        url,
        headers: { get: () => null },
        text: async () => 'Not Found',
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    return {
      ok: true,
      status: 200,
      url,
      headers: { get: () => null },
      text: async () => body,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
    };
  };
}

/** An in-memory filesystem standing in for the install directory. */
function memoryIo(seed: Record<string, string> = {}): UpdateFileIo & { readonly files: Map<string, Buffer>; readonly mutations: readonly string[] } {
  const memory = nativeMemoryIo(Object.fromEntries(Object.entries(seed).map(([path, bytes]) => [path, Buffer.from(bytes)])));
  return { ...memory.io, files: memory.files, mutations: memory.mutations };
}

describe('parseDaemonVersionOutput', () => {
  test('reads the shipped daemon banner', () => {
    expect(parseDaemonVersionOutput('goodvibes-daemon 1.27.1\n')).toBe('1.27.1');
  });

  test('tolerates a leading v', () => {
    expect(parseDaemonVersionOutput('goodvibes-daemon v1.28.0')).toBe('1.28.0');
  });

  test('refuses output with no dotted version: an unidentifiable binary is never a number', () => {
    expect(parseDaemonVersionOutput('unknown flag: --version')).toBeNull();
    expect(parseDaemonVersionOutput('')).toBeNull();
    expect(parseDaemonVersionOutput('goodvibes-daemon')).toBeNull();
  });
});

describe('readInstalledDaemonVersion', () => {
  test('returns the parsed version for a binary that answers', () => {
    expect(readInstalledDaemonVersion(DAEMON_PATH, stubRunCommand({}))).toBe(PRE_SPLIT_VERSION);
  });

  test('returns null when the probe exits non-zero', () => {
    const run = stubRunCommand({ version: { status: 1, stdout: 'goodvibes-daemon 1.27.1' } });
    expect(readInstalledDaemonVersion(DAEMON_PATH, run)).toBeNull();
  });

  test('returns null when the probe could not run at all', () => {
    const run: RunCommandLike = () => ({ status: null, stdout: '' });
    expect(readInstalledDaemonVersion(DAEMON_PATH, run)).toBeNull();
  });
});

describe('isPreSplitDaemonVersion', () => {
  test('every shipped pre-split build is below the floor', () => {
    for (const version of ['1.24.1', '1.26.0', '1.27.0', '1.27.1']) {
      expect(isPreSplitDaemonVersion(version)).toBe(true);
    }
  });

  test('the floor itself and anything above it is left alone', () => {
    for (const version of [DAEMON_SPLIT_FLOOR_VERSION, '2.0.24', '3.0.0']) {
      expect(isPreSplitDaemonVersion(version)).toBe(false);
    }
  });

  test('a caller that states its own floor is measured against that one', () => {
    expect(isPreSplitDaemonVersion('1.28.0', '1.30.0')).toBe(true);
    expect(isPreSplitDaemonVersion('1.30.0', '1.30.0')).toBe(false);
  });
});

describe('decideDaemonHandover', () => {
  const base = { platform: 'linux' as NodeJS.Platform, arch: 'x64' };

  test('hands over a pre-split binary installed beside this one', () => {
    const decision = decideDaemonHandover({
      ...base,
      binaryPath: DAEMON_PATH,
      installedVersion: PRE_SPLIT_VERSION,
    });
    expect(decision).toEqual({
      action: 'handover',
      binaryPath: DAEMON_PATH,
      fromVersion: PRE_SPLIT_VERSION,
      assetName: DAEMON_ASSET,
    });
  });

  test('skips when no daemon binary was found', () => {
    expect(decideDaemonHandover({ ...base, binaryPath: null, installedVersion: null }))
      .toEqual({ action: 'skip', reason: 'no-daemon-binary' });
  });

  test('never swaps a package-manager-managed daemon in place', () => {
    const decision = decideDaemonHandover({
      ...base,
      binaryPath: '/home/op/.bun/install/global/node_modules/goodvibes-daemon/vendor/goodvibes-daemon-linux-x64',
      installedVersion: PRE_SPLIT_VERSION,
    });
    expect(decision).toEqual({ action: 'skip', reason: 'not-swappable-install' });
  });

  test('never swaps a binary whose version could not be read', () => {
    expect(decideDaemonHandover({ ...base, binaryPath: DAEMON_PATH, installedVersion: null }))
      .toEqual({ action: 'skip', reason: 'version-unreadable' });
  });

  test('leaves a daemon that already comes from its own repository alone', () => {
    expect(decideDaemonHandover({ ...base, binaryPath: DAEMON_PATH, installedVersion: DAEMON_SPLIT_FLOOR_VERSION }))
      .toEqual({ action: 'skip', reason: 'already-split' });
  });

  test('a caller-stated floor decides what counts as already-split', () => {
    expect(
      decideDaemonHandover({
        ...base,
        binaryPath: DAEMON_PATH,
        installedVersion: '1.28.0',
        floorVersion: '1.30.0',
      }),
    ).toEqual({
      action: 'handover',
      binaryPath: DAEMON_PATH,
      fromVersion: '1.28.0',
      assetName: DAEMON_ASSET,
    });
  });

  test('skips a platform the daemon publishes no assets for', () => {
    const decision = decideDaemonHandover({
      binaryPath: 'C:\\goodvibes\\goodvibes-daemon.exe',
      installedVersion: PRE_SPLIT_VERSION,
      platform: 'win32',
      arch: 'x64',
    });
    expect(decision).toEqual({ action: 'skip', reason: 'unsupported-platform' });
  });
});

describe('performDaemonHandover', () => {
  test('installs the complete native daemon cohort and keeps the legacy daemon without changing the terminal app', async () => {
    const io = memoryIo({
      [DAEMON_PATH]: 'old-daemon-bytes',
      '/home/op/.local/bin/goodvibes': 'terminal-bytes',
      '/home/op/.local/bin/lib/sqlite-vec-linux-x64/vec0.so': 'addon-bytes',
    });
    const requested: string[] = [];
    const result = await performDaemonHandover({
      runCommand: stubRunCommand({}),
      fetchImpl: stubDaemonReleaseFetch({ requested }),
      binaryPath: DAEMON_PATH,
      assetName: DAEMON_ASSET,
      io,
    });

    expect(result.tag).toBe(SPLIT_TAG);
    expect(io.files.get(DAEMON_PATH)?.toString()).toBe('new-daemon-bytes');
    expect(io.files.get(`${DAEMON_PATH}.previous`)?.toString()).toBe('old-daemon-bytes');
    expect(io.files.get('/home/op/.local/bin/goodvibes')?.toString()).toBe('terminal-bytes');
    const installed = nativeCohortFixture({ version: '2.0.23', daemonBytes: 'new-daemon-bytes' }).installation(DAEMON_PATH);
    for (const [path, bytes] of Object.entries(installed)) {
      if (path.endsWith('daemon-installation.json')) expect(JSON.parse(io.files.get(path)?.toString() ?? 'null')).toEqual(JSON.parse(bytes.toString()));
      else expect(io.files.get(path)).toEqual(bytes);
    }
    expect(io.files.get('/home/op/.local/bin/lib/sqlite-vec-linux-x64/vec0.so.previous')?.toString()).toBe('addon-bytes');
    expect(requested.some((url) => url.includes('goodvibes-linux-x64'))).toBe(false);
    expect(requested.some((url) => url.endsWith('sqlite-vec-linux-x64.so'))).toBe(true);
    expect(requested.some((url) => url.endsWith(`${DAEMON_ASSET}.bun`))).toBe(true);
    expect(requested.some((url) => url.endsWith(`${DAEMON_ASSET}.ci-artifact.json`))).toBe(true);
  });

  test('late discovery cannot redirect the original target or adapter', async () => {
    const io = memoryIo({ [DAEMON_PATH]: 'old-daemon-bytes', '/fixture/redirected': 'unowned' });
    const original = stubDaemonReleaseFetch({});
    const options = { fetchImpl: original, binaryPath: DAEMON_PATH, assetName: DAEMON_ASSET, io: { ...io }, runCommand: stubRunCommand({}) };
    options.fetchImpl = async (url, init) => {
      options.binaryPath = '/fixture/redirected';
      options.assetName = 'other-asset';
      options.io.rename = () => { throw new Error('late adapter substitution'); };
      return original(url, init);
    };
    await performDaemonHandover(options);
    expect(io.files.get(DAEMON_PATH)?.toString()).toBe('new-daemon-bytes');
    expect(io.files.get('/fixture/redirected')?.toString()).toBe('unowned');
  });

  test('same-byte legacy binary replacement during discovery refuses the stale physical owner', async () => {
    const io = memoryIo({ [DAEMON_PATH]: 'old-daemon-bytes' });
    const honest = stubDaemonReleaseFetch({});
    let begin!: () => void;
    let finish!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    const paused = new Promise<void>(resolve => { finish = resolve; });
    const work = performDaemonHandover({
      runCommand: stubRunCommand({}),
      binaryPath: DAEMON_PATH, assetName: DAEMON_ASSET, io,
      fetchImpl: async (url, init) => {
        if (url === DAEMON_REPO_RELEASES_LATEST_URL) { begin(); await paused; }
        return honest(url, init);
      },
    });
    try {
      await started;
      if (!io.writeExclusive) throw new Error('Native fixture I/O is incomplete');
      io.writeExclusive('/fixture/replacement-daemon', Buffer.from('old-daemon-bytes'));
      io.chmod('/fixture/replacement-daemon', 0o755);
      io.rename('/fixture/replacement-daemon', DAEMON_PATH);
      finish();
      await expect(work).rejects.toThrow(/changed|retained|owner/);
      expect(io.files.get(DAEMON_PATH)?.toString()).toBe('old-daemon-bytes');
      expect(io.files.has(`${DAEMON_PATH}.previous`)).toBe(false);
      expect(io.files.has(`${DAEMON_PATH}.bun`)).toBe(false);
    } finally { finish(); await work.catch(() => {}); }
  });

  test('refuses a release below the split floor rather than installing a downgrade', async () => {
    const io = memoryIo({ [DAEMON_PATH]: 'old-daemon-bytes' });
    await expect(
      performDaemonHandover({
        runCommand: stubRunCommand({}),
        fetchImpl: stubDaemonReleaseFetch({ tag: 'v1.27.2', assets: { [DAEMON_ASSET]: 'wrong-line' } }),
        binaryPath: DAEMON_PATH,
        assetName: DAEMON_ASSET,
        io,
      }),
    ).rejects.toThrow(/below the 2\.0\.23 split floor/);
    expect(io.files.get(DAEMON_PATH)?.toString()).toBe('old-daemon-bytes');
  });

  test('a checksum that does not match leaves the installed daemon untouched', async () => {
    const io = memoryIo({ [DAEMON_PATH]: 'old-daemon-bytes' });
    const fetchImpl: UpdateFetchLike = async (url: string) => {
      const honest = stubDaemonReleaseFetch({});
      const response = await honest(url);
      if (!url.endsWith(DAEMON_ASSET)) return response;
      // Same manifest, different bytes.
      return {
        ...response,
        text: async () => 'tampered',
        arrayBuffer: async () => new TextEncoder().encode('tampered').buffer as ArrayBuffer,
      };
    };
    await expect(
      performDaemonHandover({ fetchImpl, binaryPath: DAEMON_PATH, assetName: DAEMON_ASSET, io, runCommand: stubRunCommand({}) }),
    ).rejects.toThrow(/checksum mismatch/);
    expect(io.files.get(DAEMON_PATH)?.toString()).toBe('old-daemon-bytes');
    expect(io.files.has(`${DAEMON_PATH}.previous`)).toBe(false);
  });

  test('an asset missing from the release is a refusal, not a silent skip', async () => {
    const io = memoryIo({ [DAEMON_PATH]: 'old-daemon-bytes' });
    const requested: string[] = [];
    await expect(
      performDaemonHandover({
        runCommand: stubRunCommand({}),
        fetchImpl: stubDaemonReleaseFetch({ unavailableAssets: [DAEMON_ASSET], requested }),
        binaryPath: DAEMON_PATH,
        assetName: DAEMON_ASSET,
        io,
      }),
    ).rejects.toThrow(/download failed \(404\)/);
    expect(requested).toContain(`${daemonReleaseDownloadBaseUrl(SPLIT_TAG)}/${DAEMON_ASSET}`);
    expect(io.mutations).toEqual([]);
    expect(io.files.get(DAEMON_PATH)?.toString()).toBe('old-daemon-bytes');
  });

  test('checksum-valid runtime metadata for a different target refuses the whole native release', async () => {
    const fixture = nativeCohortReleaseFixture({ version: '2.0.23', daemonBytes: 'new-daemon-bytes', runtimeProvenanceTarget: 'linux-arm64' });
    const assets = Object.fromEntries(Object.entries(fixture.assets).map(([name, bytes]) => [name, bytes.toString()]));
    const io = memoryIo({ [DAEMON_PATH]: 'old-daemon-bytes' });
    await expect(performDaemonHandover({ binaryPath: DAEMON_PATH, assetName: DAEMON_ASSET, io,
      runCommand: stubRunCommand({}), fetchImpl: stubDaemonReleaseFetch({ assets, checksumManifest: fixture.checksumManifest }) })).rejects.toThrow(/provenance/);
    expect(io.files.get(DAEMON_PATH)?.toString()).toBe('old-daemon-bytes');
    expect(io.files.has(`${DAEMON_PATH}.previous`)).toBe(false);
    expect(io.files.has(`${DAEMON_PATH}.bun`)).toBe(false);
  });

  test('checksum-valid artifact provenance without an exact source commit refuses publication', async () => {
    const fixture = nativeCohortReleaseFixture({ version: '2.0.23', daemonBytes: 'new-daemon-bytes', sourceCommit: 'main' });
    const assets = Object.fromEntries(Object.entries(fixture.assets).map(([name, bytes]) => [name, bytes.toString()]));
    const io = memoryIo({ [DAEMON_PATH]: 'old-daemon-bytes' });
    await expect(performDaemonHandover({ binaryPath: DAEMON_PATH, assetName: DAEMON_ASSET, io,
      runCommand: stubRunCommand({}), fetchImpl: stubDaemonReleaseFetch({ assets, checksumManifest: fixture.checksumManifest }) })).rejects.toThrow(/exact source/);
    expect(io.files.get(DAEMON_PATH)?.toString()).toBe('old-daemon-bytes');
    expect(io.files.has(`${DAEMON_PATH}.previous`)).toBe(false);
  });

  for (const missing of [`${DAEMON_ASSET}.bun`, `${DAEMON_ASSET}.bun.LICENSE.md`, `${DAEMON_ASSET}.bun.json`, 'sqlite-vec-linux-x64.so', `${DAEMON_ASSET}.ci-artifact.json`]) {
    test(`a new release missing ${missing} leaves every legacy member in place`, async () => {
      const requested: string[] = [];
      const io = memoryIo({ [DAEMON_PATH]: 'old-daemon-bytes' });
      await expect(performDaemonHandover({ binaryPath: DAEMON_PATH, assetName: DAEMON_ASSET, io,
        runCommand: stubRunCommand({}), fetchImpl: stubDaemonReleaseFetch({ unavailableAssets: [missing], requested }) })).rejects.toThrow(/download failed \(404\)/);
      expect(requested).toContain(`${daemonReleaseDownloadBaseUrl(SPLIT_TAG)}/${missing}`);
      expect(io.mutations).toEqual([]);
      expect(io.files.get(DAEMON_PATH)?.toString()).toBe('old-daemon-bytes');
      expect(io.files.has(`${DAEMON_PATH}.previous`)).toBe(false);
      expect(io.files.has(`${DAEMON_PATH}.bun`)).toBe(false);
    });
  }

  test('a missing native descriptor pin refuses before every payload request, hash and install write', async () => {
    const hash = spyOn(crypto, 'createHash');
    try {
      // Only the declared names and pin shapes are read before this refusal;
      // no payload will be fetched or compared, so no real pin is produced.
      const targets = resolveDaemonNativeTargets(DAEMON_PATH, 'linux', 'x64');
      if (!targets) throw new Error('Expected actual native handover target catalog');
      expect(targets.at(-1)?.assetName).toBe(`${DAEMON_ASSET}.ci-artifact.json`);
      const checksumManifest = targets.slice(0, -1).map(target => `${'a'.repeat(64)}  ${target.assetName}`).join('\n');
      const requested: string[] = [], io = memoryIo({ [DAEMON_PATH]: 'old-daemon-bytes' });
      await expect(performDaemonHandover({ binaryPath: DAEMON_PATH, assetName: DAEMON_ASSET, io,
        runCommand: stubRunCommand({}), fetchImpl: stubDaemonReleaseFetch({ assets: {}, checksumManifest, requested }) }))
        .rejects.toThrow(`no checksum entry for ${DAEMON_ASSET}.ci-artifact.json in SHA256SUMS.txt`);
      expect(requested).toEqual([DAEMON_REPO_RELEASES_LATEST_URL, `${daemonReleaseDownloadBaseUrl(SPLIT_TAG)}/SHA256SUMS.txt`]);
      expect(hash).not.toHaveBeenCalled();
      expect(io.mutations).toEqual([]);
      expect([...io.files.entries()]).toEqual([[DAEMON_PATH, Buffer.from('old-daemon-bytes')]]);
    } finally { hash.mockRestore(); }
  });

  test('a binary whose banner is unreadable cannot enter legacy native adoption', async () => {
    const io = memoryIo({ [DAEMON_PATH]: 'old-daemon-bytes' });
    const requested: string[] = [];
    await expect(performDaemonHandover({ binaryPath: DAEMON_PATH, assetName: DAEMON_ASSET, io,
      runCommand: stubRunCommand({ version: { status: 1, stdout: '' } }), fetchImpl: stubDaemonReleaseFetch({ requested }) })).rejects.toThrow();
    expect(requested).toEqual([]);
    expect(io.files.get(DAEMON_PATH)?.toString()).toBe('old-daemon-bytes');
    expect(io.files.has(`${DAEMON_PATH}.previous`)).toBe(false);
  });

  test('records the resolved tag on the progress record before writing anything', async () => {
    const progress = createDaemonHandoverProgress();
    const io = memoryIo({ [DAEMON_PATH]: 'old-daemon-bytes' });
    expect(progress.begun).toBe(false);
    await performDaemonHandover({
      runCommand: stubRunCommand({}),
      fetchImpl: stubDaemonReleaseFetch({}),
      binaryPath: DAEMON_PATH,
      assetName: DAEMON_ASSET,
      io,
      progress,
    });
    expect(progress.tag).toBe(SPLIT_TAG);
    expect(progress.begun).toBe(true);
  });
});

describe('resolveHandoverServiceName', () => {
  test('uses the configured service name when one is set', () => {
    expect(resolveHandoverServiceName({ get: () => '  my-daemon  ' })).toBe('my-daemon');
  });

  test('falls back to the installer-registered managed name', () => {
    expect(resolveHandoverServiceName({ get: () => undefined })).toBe('goodvibes');
    expect(resolveHandoverServiceName({ get: () => '   ' })).toBe('goodvibes');
  });
});

describe('restartHandedOverDaemon', () => {
  const config = { get: (key: string) => (key === 'service.serviceName' ? 'goodvibes' : undefined) };

  test('restarts an active systemd user unit', () => {
    const calls: string[][] = [];
    const outcome = restartHandedOverDaemon('linux', config, stubRunCommand({ calls }));
    expect(outcome.restarted).toBe(true);
    expect(outcome.unitName).toBe('goodvibes');
    expect(calls).toContainEqual(['systemctl', '--user', 'restart', 'goodvibes.service']);
  });

  test('does not restart a unit that is not active, and says so honestly', () => {
    const calls: string[][] = [];
    const outcome = restartHandedOverDaemon(
      'linux',
      config,
      stubRunCommand({ calls, isActive: { status: 3, stdout: 'inactive\n' } }),
    );
    expect(outcome.restarted).toBe(false);
    expect(outcome.detail).toContain('next time the daemon starts');
    expect(calls.some((call) => call.includes('restart'))).toBe(false);
  });

  test('a failed restart names the command to run rather than claiming success', () => {
    const outcome = restartHandedOverDaemon(
      'linux',
      config,
      stubRunCommand({ restart: { status: 1, stdout: '' } }),
    );
    expect(outcome.restarted).toBe(false);
    expect(outcome.detail).toContain('systemctl --user restart goodvibes.service');
  });

  test('never prints a systemctl command on a platform that does not have one', () => {
    const outcome = restartHandedOverDaemon('darwin', config, stubRunCommand({}));
    expect(outcome.restarted).toBe(false);
    expect(outcome.detail).not.toContain('systemctl');
  });
});

describe('runDaemonHandover', () => {
  function baseOptions(
    overrides: Partial<RunDaemonHandoverOptions> = {},
  ): { options: RunDaemonHandoverOptions; printed: string[] } {
    const printed: string[] = [];
    const options: RunDaemonHandoverOptions = {
      fetchImpl: stubDaemonReleaseFetch({}),
      binaryPath: DAEMON_PATH,
      platform: 'linux',
      arch: 'x64',
      configManager: { get: () => undefined },
      print: (line) => printed.push(line),
      runCommand: stubRunCommand({}),
      io: memoryIo({ [DAEMON_PATH]: 'old-daemon-bytes' }),
      ...overrides,
    };
    return { options, printed };
  }

  test('the whole path: pre-split daemon detected, swapped, restarted, reported', async () => {
    const io = memoryIo({ [DAEMON_PATH]: 'old-daemon-bytes' });
    const calls: string[][] = [];
    const { options, printed } = baseOptions({ io, runCommand: stubRunCommand({ calls }) });
    const outcome = await runDaemonHandover(options);

    expect(outcome).toEqual({
      action: 'handed-over',
      fromVersion: PRE_SPLIT_VERSION,
      toTag: SPLIT_TAG,
      restarted: true,
      unitName: 'goodvibes',
    });
    expect(io.files.get(DAEMON_PATH)?.toString()).toBe('new-daemon-bytes');
    expect(io.files.get(`${DAEMON_PATH}.previous`)?.toString()).toBe('old-daemon-bytes');
    expect(calls).toContainEqual(['systemctl', '--user', 'restart', 'goodvibes.service']);
    // The receipt names both versions and the rollback, so the swap is not silent.
    const receipt = printed.join('\n');
    expect(receipt).toContain('v1.27.1');
    expect(receipt).toContain(SPLIT_TAG);
    expect(receipt).toContain('rollback');
  });

  test('a daemon already on its own release line is left alone and says nothing', async () => {
    const io = memoryIo({ [DAEMON_PATH]: 'new-daemon-bytes' });
    const { options, printed } = baseOptions({
      io,
      runCommand: stubRunCommand({ version: { status: 0, stdout: 'goodvibes-daemon 2.0.23\n' } }),
    });
    const outcome = await runDaemonHandover(options);
    expect(outcome).toEqual({ action: 'skipped', reason: 'already-split' });
    expect(printed).toEqual([]);
    expect(io.files.get(DAEMON_PATH)?.toString()).toBe('new-daemon-bytes');
  });

  test('is idempotent: a second launch after a handover does nothing', async () => {
    const io = memoryIo({ [DAEMON_PATH]: 'old-daemon-bytes' });
    let reported = PRE_SPLIT_VERSION;
    const runCommand: RunCommandLike = (command, args) => {
      if (args[0] === '--version') return { status: 0, stdout: `goodvibes-daemon ${reported}\n` };
      return { status: 0, stdout: 'active\n' };
    };
    const first = await runDaemonHandover(baseOptions({ io, runCommand }).options);
    expect(first.action).toBe('handed-over');
    // The swapped binary now reports the new version, exactly as the real one would.
    reported = DAEMON_SPLIT_FLOOR_VERSION;
    const second = await runDaemonHandover(baseOptions({ io, runCommand }).options);
    expect(second).toEqual({ action: 'skipped', reason: 'already-split' });
  });

  test('a failure leaves the installed daemon in place and reports what happened', async () => {
    const io = memoryIo({ [DAEMON_PATH]: 'old-daemon-bytes' });
    const { options, printed } = baseOptions({
      io,
      fetchImpl: stubDaemonReleaseFetch({ assets: {} }),
    });
    const outcome = await runDaemonHandover(options);
    expect(outcome.action).toBe('failed');
    expect(io.files.get(DAEMON_PATH)?.toString()).toBe('old-daemon-bytes');
    expect(printed.join('\n')).toContain('daemon handover failed');
  });

  test('never throws, whatever the swap does', async () => {
    const { options } = baseOptions({
      performHandover: async () => {
        throw new Error('disk full');
      },
    });
    const outcome = await runDaemonHandover(options);
    expect(outcome).toEqual({ action: 'failed', detail: 'disk full' });
  });

  test('a budget that runs out before any write defers instead of half-swapping', async () => {
    const { options, printed } = baseOptions({
      timeoutMs: 5,
      performHandover: (perform: PerformDaemonHandoverOptions) =>
        new Promise((_resolve, reject) => {
          perform.signal?.addEventListener('abort', () => reject(new Error('cancelled')));
        }),
    });
    const outcome = await runDaemonHandover(options);
    expect(outcome).toEqual({ action: 'deferred' });
    expect(printed.join('\n')).toContain('deferred');
  });

  test('a budget that runs out AFTER the swap began reports the replacement, not a deferral', async () => {
    const { options, printed } = baseOptions({
      timeoutMs: 5,
      performHandover: (perform: PerformDaemonHandoverOptions) =>
        new Promise(() => {
          if (perform.progress) {
            perform.progress.begun = true;
            perform.progress.tag = SPLIT_TAG;
          }
        }),
    });
    const outcome = await runDaemonHandover(options);
    expect(outcome).toEqual({ action: 'swapped-needs-restart', toTag: SPLIT_TAG });
    expect(printed.join('\n')).toContain('restart it');
  });

  for (const fault of ['commit', 'undo', 'cleanup'] as const) {
    test(`transaction ${fault} failure prints its actual disk state without a false restart`, async () => {
      const io = memoryIo({ [DAEMON_PATH]: 'old-daemon-bytes', [`${DAEMON_PATH}.previous`]: 'older-daemon-bytes' });
      const rename = io.rename;
      const remove = io.remove!;
      let failed = false;
      io.rename = (from, to) => {
        if (fault !== 'cleanup' && !failed && from.endsWith('.update-download')) { failed = true; throw new Error('commit fault'); }
        if (fault === 'undo' && failed && from.endsWith('.previous') && to === DAEMON_PATH) throw new Error('undo fault');
        rename(from, to);
      };
      io.remove = (path) => { if (fault === 'cleanup') throw new Error('cleanup fault'); remove(path); };
      let restarts = 0;
      const { options, printed } = baseOptions({ io, restartDaemon: () => { restarts += 1; throw new Error('must not restart'); } });
      const result = await runDaemonHandover(options);
      expect(result.action).toBe('failed');
      expect(restarts).toBe(0);
      const receipt = printed.join('\n');
      if (fault === 'commit') {
        expect(io.files.get(DAEMON_PATH)?.toString()).toBe('old-daemon-bytes');
        expect(receipt).toContain('unchanged');
      } else {
        expect(receipt).toContain('automatic retry is fenced');
        expect(receipt).not.toContain('is unchanged');
        expect(io.files.has(`${DAEMON_PATH}.update-transaction`)).toBe(true);
      }
    });
  }

  test('no daemon beside this install is a silent, reasoned skip', async () => {
    const { options, printed } = baseOptions({ binaryPath: null });
    expect(await runDaemonHandover(options)).toEqual({ action: 'skipped', reason: 'no-daemon-binary' });
    expect(printed).toEqual([]);
  });

  test('the caller-stated floor is what the swap is measured against, end to end', async () => {
    const { options } = baseOptions({
      floorVersion: '2.1.0',
      runCommand: stubRunCommand({ version: { status: 0, stdout: 'goodvibes-daemon 2.0.23\n' } }),
    });
    const outcome = await runDaemonHandover(options);
    // The 2.0.23 release the stub serves is below the stated 2.1.0 floor, so
    // the swap refuses rather than installing a build the caller ruled out.
    expect(outcome.action).toBe('failed');
    expect(outcome).toMatchObject({ detail: expect.stringContaining('below the 2.1.0 split floor') });
  });
});
