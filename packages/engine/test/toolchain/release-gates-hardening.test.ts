import { describe, expect, test } from 'bun:test';
import {
  captureLogger, parseToolchainConfig, runBuildBinaries, runEnginePinGate, runPackageInstallCheck,
  type BuildConfig, type PublishPackageConfig,
} from '@goodvibes-jev/engine/toolchain';
import { flagValue } from '../../toolchain/src/lib/cli-args.ts';
import { fakeFs, scriptedExec } from './_helpers.ts';

const engine = '@goodvibes-jev/engine';

describe('engine pin gate', () => {
  test('a workspace pin does not claim to have verified the workspace link', () => {
    const files = {
      'package.json': JSON.stringify({ dependencies: { [engine]: 'workspace:*' } }),
      'bun.lock': `"${engine}": ["${engine}@workspace:packages/engine"]`,
      [`node_modules/${engine}/package.json`]: JSON.stringify({ version: '1.0.0' }),
    };
    const installed = runEnginePinGate(fakeFs(files), { pinSource: 'dependencies' }).find((r) => r.id === 'engine-installed');
    expect(installed?.ok).toBe(true);
    expect(installed?.detail).toContain('not verified');
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

describe('bin argument helpers', () => {
  test('a flag with no value is an error, not a fallback', () => {
    expect(() => flagValue(['--binary'], '--binary')).toThrow('--binary needs a value');
    expect(() => flagValue(['--binary', '--other'], '--binary')).toThrow('--binary needs a value');
    expect(flagValue(['--binary', 'dist/x'], '--binary')).toBe('dist/x');
    expect(flagValue([], '--binary')).toBeUndefined();
  });
});
