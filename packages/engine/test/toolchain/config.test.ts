import { describe, expect, test } from 'bun:test';
import { parseToolchainConfig, resolveEnginePinConfig, DEFAULT_ENGINE_PACKAGE } from '@goodvibes-jev/engine/toolchain';

describe('toolchain config', () => {
  test('accepts an optional compile driver and rejects an empty path', () => {
    const build = { appEntrypoint: 'src/main.ts', outDir: 'dist', addonOutDir: 'dist/lib', prebuild: [], targets: [] };
    expect(parseToolchainConfig(JSON.stringify({ packageName: 'fixture', build })).build?.compileDriver).toBeUndefined();
    expect(parseToolchainConfig(JSON.stringify({ packageName: 'fixture', build: { ...build, compileDriver: 'scripts/compile.ts' } })).build?.compileDriver).toBe('scripts/compile.ts');
    expect(() => parseToolchainConfig(JSON.stringify({ packageName: 'fixture', build: { ...build, compileDriver: '' } }))).toThrow(/compileDriver/);
  });
  test('parses a minimal config', () => {
    const config = parseToolchainConfig('{"packageName":"@goodvibes-jev/tui"}');
    expect(config.packageName).toBe('@goodvibes-jev/tui');
  });
  test('rejects a config without packageName', () => {
    expect(() => parseToolchainConfig('{}')).toThrow(/packageName/);
  });
  test('rejects a non-object config', () => {
    expect(() => parseToolchainConfig('[]')).toThrow();
  });
  test('resolveEnginePinConfig fills conventional defaults', () => {
    const resolved = resolveEnginePinConfig(undefined);
    expect(resolved.enginePackage).toBe(DEFAULT_ENGINE_PACKAGE);
    expect(resolved.pinSource).toBe('dependencies');
    expect(resolved.lockfile).toBe('bun.lock');
    expect(resolved.overlayMarker).toContain('.local-engine-overlay.json');
  });
  test('a one-field enginePin section parses: requiredness lives in resolveEnginePinConfig, not the schema', () => {
    const raw = JSON.stringify({
      packageName: '@goodvibes-jev/tui',
      enginePin: { pinSource: 'devDependencies' },
    });
    const config = parseToolchainConfig(raw);
    expect(Object.keys(config.enginePin ?? {})).toEqual(['pinSource']);
    expect(config.enginePin?.pinSource).toBe('devDependencies');
    const resolved = resolveEnginePinConfig(config.enginePin);
    expect(resolved.pinSource).toBe('devDependencies');
    expect(resolved.enginePackage).toBe(DEFAULT_ENGINE_PACKAGE);
  });
  test('rejects a present-but-wrongly-typed optional enginePin field, naming it', () => {
    const raw = JSON.stringify({
      packageName: '@goodvibes-jev/tui',
      enginePin: { sourceRoots: 'src' },
    });
    expect(() => parseToolchainConfig(raw)).toThrow(/enginePin\.sourceRoots/);
  });
  test('rejects a malformed nested section with a clear message naming the bad field', () => {
    const raw = JSON.stringify({
      packageName: '@goodvibes-jev/tui',
      coverage: { funcsFloor: 80, linesFloor: '90', command: ['bun', 'test', '--coverage', 'src'] },
    });
    expect(() => parseToolchainConfig(raw)).toThrow(/coverage\.linesFloor/);
  });
  test('rejects a malformed enum field with a clear message naming the bad field', () => {
    const raw = JSON.stringify({
      packageName: '@goodvibes-jev/tui',
      releaseCut: {
        branch: 'main',
        versionFiles: [],
        syncCommands: [],
        commitPaths: [],
        changelogHeading: 'invalid',
        changelogInsertMarker: 'top',
      },
    });
    expect(() => parseToolchainConfig(raw)).toThrow(/releaseCut\.changelogHeading/);
  });
  test('valid config parses to a deep-equal object, matching the old cast-through parser', () => {
    const full = {
      packageName: '@goodvibes-jev/tui',
      enginePin: {
        enginePackage: '@goodvibes-jev/engine',
        pinSource: 'dependencies',
        lockfile: 'bun.lock',
        overlayMarker: 'node_modules/@goodvibes-jev/engine/.local-engine-overlay.json',
        sourceRoots: ['src'],
        enforceExportsMap: false,
      },
      coverage: {
        funcsFloor: 80,
        linesFloor: 90,
        command: ['bun', 'test', '--coverage', 'src'],
      },
      // Unknown extra key: the old cast-through parser preserved whatever the
      // raw JSON contained, so a valid config must still round-trip it. This
      // is checked with `toEqual` (deep equality of values), not identity;
      // `.catchall(z.unknown())` does not guarantee the parsed object's key
      // order matches the input's, and nothing here re-serializes the config,
      // so that reordering has no observable effect.
      extra: { nested: true },
    };
    const raw = JSON.stringify(full);
    const config = parseToolchainConfig(raw);
    expect(config).toEqual(JSON.parse(raw));
  });
});
