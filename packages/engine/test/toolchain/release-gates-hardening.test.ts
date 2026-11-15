import { describe, expect, test } from 'bun:test';
import {
  captureLogger, parseToolchainConfig, runBuildBinaries, runChangelogGate, runEnginePinGate, runPackageInstallCheck, runPublishPackage,
  runPostBuildSmoke, type BuildConfig, type PublishPackageConfig,
} from '@goodvibes-jev/engine/toolchain';
import { flagValue, isBareBasename } from '../../toolchain/src/lib/cli-args.ts';
import { parseLedgerAreas } from '../../toolchain/src/lib/verification-ledger.ts';
import { fakeFs, scriptedExec } from './_helpers.ts';

const engine = '@goodvibes-jev/engine';

describe('engine pin gate', () => {
  test('a lockfile entry for a longer version does not satisfy the pin', () => {
    const files = {
      'package.json': JSON.stringify({ dependencies: { [engine]: '3.3.1' } }),
      'bun.lock': `"${engine}": ["${engine}@3.3.10", ""]`,
      [`node_modules/${engine}/package.json`]: JSON.stringify({ version: '3.3.1' }),
    };
    const lock = runEnginePinGate(fakeFs(files), { pinSource: 'dependencies' }).find((r) => r.id === 'lockfile-resolves-pin');
    expect(lock?.ok).toBe(false);
    const exact = runEnginePinGate(fakeFs({ ...files, 'bun.lock': `"${engine}": ["${engine}@3.3.1", ""]` }), { pinSource: 'dependencies' }).find((r) => r.id === 'lockfile-resolves-pin');
    expect(exact?.ok).toBe(true);
  });

  test('a workspace pin does not claim to have verified the workspace link', () => {
    const files = {
      'package.json': JSON.stringify({ dependencies: { [engine]: 'workspace:*' } }),
      'bun.lock': `"${engine}": ["${engine}@workspace:packages/engine"]`,
      [`node_modules/${engine}/package.json`]: JSON.stringify({ version: '1.0.0' }),
    };
    const installed = runEnginePinGate(fakeFs(files), { pinSource: 'dependencies' }).find((r) => r.id === 'installed-matches-pin');
    expect(installed?.ok).toBe(true);
    expect(installed?.detail).toContain('not verified');
  });
});

describe('changelog gate', () => {
  test('a prerelease heading is not the release heading', () => {
    expect(runChangelogGate('## 1.2.3-rc.1\n', '1.2.3', 'plain').ok).toBe(false);
    expect(runChangelogGate('## 1.2.3-rc.1\n', '1.2.3', 'either').ok).toBe(false);
    expect(runChangelogGate('## 1.2.3 - 2026-01-02\n', '1.2.3', 'plain').ok).toBe(true);
  });
});

describe('package install check', () => {
  const config: PublishPackageConfig = {
    packageName: 'p', defaultRegistry: 'r', requiredTarballPaths: ['package.json'], forbiddenTarballPrefixes: [], maxTarballBytes: 1000,
    bins: [{ name: 'tool', path: 'bin/tool', shebang: '#!/usr/bin/env node' }],
  };
  const packOutput = JSON.stringify([{ files: [{ path: 'package.json' }], unpackedSize: 10 }]);

  test('a configured bin shim that is not executable fails the check', () => {
    const parsed = parseToolchainConfig(JSON.stringify({ packageName: 'p', publish: config }));
    expect(parsed.publish?.bins).toEqual(config.bins!);
    const fs = fakeFs({ 'bin/tool': '#!/usr/bin/env node\n' });
    const result = runPackageInstallCheck({ cwd: '.', config: parsed.publish!, bins: parsed.publish!.bins!, fs, exec: scriptedExec(() => ({ stdout: packOutput })), logger: captureLogger() });
    expect(result.ok).toBe(false);
    expect(result.issues.join('\n')).toContain('bin tool is not executable');
  });

  test('npm pack output that is not JSON is reported as an issue instead of throwing', () => {
    const result = runPackageInstallCheck({ cwd: '.', config, exec: scriptedExec(() => ({ stdout: '> prepack running\n' })), fs: fakeFs({}), logger: captureLogger() });
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toContain('could not read npm pack output');
  });
});

describe('build-binaries', () => {
  const build: BuildConfig = {
    appEntrypoint: 'src/main.ts', outDir: 'dist', addonOutDir: 'dist/lib', prebuild: [],
    targets: [{ key: 'linux-x64', bunTarget: 'bun-linux-x64', appArtifact: 'app-linux-x64' }],
  };
  test('a daemon-only selection on a repo with no daemon entrypoint is a failed build, not a built one', () => {
    let compiles = 0;
    const outcomes = runBuildBinaries({
      cwd: '/repo', config: build, selection: { targets: build.targets, daemonOnly: true }, nativeKey: 'linux-x64',
      exec: scriptedExec(() => { compiles++; return {}; }), logger: captureLogger(),
    });
    expect(compiles).toBe(0);
    expect(outcomes[0]?.ok).toBe(false);
    expect(outcomes[0]?.detail).toContain('nothing was built');
  });
});

describe('publish-package', () => {
  const base = { cwd: '.', name: 'p', version: '1.0.0', logger: captureLogger() };
  test('a registry lookup that fails for a reason other than not-found does not report a publish', () => {
    const exec = scriptedExec((_c, args) => (args[0] === 'view' ? { status: 1, stderr: 'npm error code ETIMEDOUT' } : { status: 0 }));
    const result = runPublishPackage({ ...base, exec });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('ETIMEDOUT');
  });
  test('a not-found lookup proceeds to publish', () => {
    const exec = scriptedExec((_c, args) => (args[0] === 'view' ? { status: 1, stderr: 'npm error code E404' } : { status: 0 }));
    expect(runPublishPackage({ ...base, exec }).detail).toBe('published');
  });
});

describe('post-build-smoke', () => {
  test('a failing source release does not replace the failed result', async () => {
    let releases = 0;
    const owner = {
      capture: () => ({}), screen: async () => { throw new Error('screening unavailable'); }, project: () => [],
      release: async () => { releases++; throw new Error('release failed'); },
    };
    const config = { bannerPrefix: 'tool ', binaryDefault: 'tool' };
    const result = await runPostBuildSmoke({
      binary: 'tool', config, logger: captureLogger(), readArtifact: () => 'var x = 1;',
      exec: scriptedExec(() => ({ status: 0, stdout: 'tool 1.0.0\n', stderr: 'extra diagnostic output' })),
      diagnosticSourceOwner: owner as never,
    });
    expect(releases).toBe(1);
    expect(result.ok).toBe(false);
  });
});

describe('bin argument helpers', () => {
  test('a flag with no value is an error, not a fallback', () => {
    expect(() => flagValue(['--binary'], '--binary')).toThrow('--binary needs a value');
    expect(() => flagValue(['--binary', '--other'], '--binary')).toThrow('--binary needs a value');
    expect(flagValue(['--binary', 'dist/x'], '--binary')).toBe('dist/x');
    expect(flagValue([], '--binary')).toBeUndefined();
  });
  test('only a bare file name may be resolved against a manifest directory', () => {
    expect(isBareBasename('asset.tgz')).toBe(true);
    for (const name of ['../x', '/etc/passwd', 'a/b', '..', '']) expect(isBareBasename(name)).toBe(false);
  });
  test('a ledger areas file with a malformed entry is refused naming the entry', () => {
    expect(() => parseLedgerAreas({})).toThrow('JSON array');
    expect(() => parseLedgerAreas([{ area: 'a', total: 1, localSignal: 1, localBehavior: 1 }])).toThrow('areas[0] needs a numeric "externalRequired"');
    expect(parseLedgerAreas([{ area: 'a', total: 1, localSignal: 1, localBehavior: 1, externalRequired: 0 }])).toHaveLength(1);
  });
});
