/** Source regressions for package-root overlay/gate agreement, cache-safe
 * file copies, private workspace refusal, and exact saved recovery receipts.
 * Reinstall fixtures are inert; no real build, registry, or user profile runs. */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { packageDirs } from '../scripts/release-shared.ts';
import * as publication from '../toolchain/src/lib/release-publication.ts';
import {
  enumerateWorkspacePackages,
  markerPath,
  overlayPackage,
  overlayStatus,
  readEnginePin,
  restoreVersionIssue,
  restoreEngineOverlay,
  ENGINE_ROOT,
} from '../scripts/engine-dev.ts';

const SCRIPT_PATH = resolve(import.meta.dir, '..', 'scripts/engine-dev.ts');

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) {
    const d = created.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function mkTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function writePkgJson(dir: string, contents: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(contents, null, 2));
}

describe('enumerateWorkspacePackages', () => {
  test('uses the actual public engine and judgment manifests, independently of native release opt-in', () => {
    const packages = enumerateWorkspacePackages(ENGINE_ROOT);
    // Publish order: the engine depends on judgment, so judgment comes first.
    expect(packages).toEqual([{ nm: 'judgment', dir: '../judgment' }, { nm: 'engine', dir: '.' }]);
  });

  test('excludes private packages and packages without publishConfig.access:"public"', () => {
    const root = mkTemp('gv-engine-enum-');
    writePkgJson(join(root, 'engine'), {
      name: '@goodvibes-jev/engine',
      publishConfig: { access: 'public' },
    });
    writePkgJson(join(root, 'judgment'), {
      name: '@goodvibes-jev/judgment',
      private: true,
      publishConfig: { access: 'public' },
    });
    expect(enumerateWorkspacePackages(join(root, 'engine')).map((p) => p.nm)).toEqual(['engine']);

    writePkgJson(join(root, 'judgment'), { name: '@goodvibes-jev/judgment' });
    expect(enumerateWorkspacePackages(join(root, 'engine')).map((p) => p.nm)).toEqual(['engine']);
  });

  test('follows the release package list, so a released package needs no change here (the drift class closed)', () => {
    const root = mkTemp('gv-engine-enum-');
    const engineRoot = join(root, 'engine');
    for (const dir of packageDirs) {
      writePkgJson(join(engineRoot, dir), {
        name: `@goodvibes-jev/fixture-${dir === '.' ? 'engine' : dir.split('/').at(-1)}`,
        publishConfig: { access: 'public' },
      });
    }
    expect(enumerateWorkspacePackages(engineRoot).map((p) => p.dir)).toEqual([...packageDirs]);
  });

  test('returns an empty list when no released package exists at the root', () => {
    const root = mkTemp('gv-engine-enum-empty-');
    expect(enumerateWorkspacePackages(root)).toEqual([]);
  });
});

describe('readEnginePin', () => {
  test('reads the pin from devDependencies first (the agent bundles the engine there)', () => {
    const root = mkTemp('gv-engine-pin-');
    writePkgJson(root, { devDependencies: { '@goodvibes-jev/engine': '1.0.0' }, dependencies: { '@goodvibes-jev/engine': '0.38.0' } });
    expect(readEnginePin(root)).toBe('1.0.0');
  });

  test('falls back to dependencies when absent from devDependencies (TUI/webui)', () => {
    const root = mkTemp('gv-engine-pin-');
    writePkgJson(root, { dependencies: { '@goodvibes-jev/engine': '0.38.0' } });
    expect(readEnginePin(root)).toBe('0.38.0');
  });

  test('is undefined when neither field has the pin', () => {
    const root = mkTemp('gv-engine-pin-');
    writePkgJson(root, {});
    expect(readEnginePin(root)).toBeUndefined();
  });
});

describe('overlayStatus', () => {
  test('reports OVERLAY ACTIVE with exit code 2 when the marker exists', () => {
    const marker = JSON.stringify({ engineGit: 'main@abc1234 (dirty)', overlaidAt: '2026-07-06T00:00:00.000Z', sourcePath: '/x/goodvibes' });
    const s = overlayStatus(marker, '0.38.0');
    expect(s.active).toBe(true);
    expect(s.exitCode).toBe(2);
    expect(s.line).toContain('OVERLAY ACTIVE');
    expect(s.line).toContain('main@abc1234');
  });

  test('reports clean npm state with exit code 0 when no marker exists', () => {
    const s = overlayStatus(null, '0.38.0');
    expect(s.active).toBe(false);
    expect(s.exitCode).toBe(0);
    expect(s.line).toContain('clean');
    expect(s.line).toContain('0.38.0');
  });
});

describe('restoreVersionIssue', () => {
  test('returns null when the restored version equals the pin', () => {
    expect(restoreVersionIssue('1.0.0', '1.0.0')).toBeNull();
  });

  test('returns an issue string when the restored version differs from the pin', () => {
    const issue = restoreVersionIssue('0.37.2', '0.38.0');
    expect(issue).not.toBeNull();
    expect(issue).toContain('0.37.2');
    expect(issue).toContain('0.38.0');
  });
});

describe('overlayPackage', () => {
  /** A checkout package with one old package's dist, a contract artifact and a conditional export. */
  function writeCheckoutPackage(packageRoot: string, version: string): void {
    mkdirSync(join(packageRoot, 'platform/dist'), { recursive: true });
    writeFileSync(join(packageRoot, 'platform/dist/index.js'), 'fresh local build');
    mkdirSync(join(packageRoot, 'contracts/artifacts'), { recursive: true });
    writeFileSync(join(packageRoot, 'contracts/artifacts/operator-contract.json'), '{"fresh":true}');
    writePkgJson(packageRoot, {
      name: '@goodvibes-jev/engine',
      version,
      files: ['contracts/artifacts', 'platform/dist'],
      exports: {
        './platform': { bun: './platform/src/index.ts', types: './platform/dist/index.d.ts', import: './platform/dist/index.js' },
        './package.json': './package.json',
      },
    });
  }

  test('replaces every published entry and package.json in the installed package (unlink-before-copy)', () => {
    const consumerRoot = mkTemp('gv-engine-overlay-consumer-');
    const engineCheckoutRoot = mkTemp('gv-engine-overlay-engine-');
    const installed = join(consumerRoot, 'node_modules/@goodvibes-jev/engine');
    mkdirSync(join(installed, 'platform/dist'), { recursive: true });
    // The installed file is a hardlink into a package cache, as bun installs
    // it; writing through it in place would corrupt the cache entry.
    const cacheFile = join(consumerRoot, 'cache-index.js');
    writeFileSync(cacheFile, 'stale published build');
    linkSync(cacheFile, join(installed, 'platform/dist/index.js'));
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: '@goodvibes-jev/engine', version: '2.0.0' }));
    writeCheckoutPackage(engineCheckoutRoot, '2.0.23');

    const ok = overlayPackage(consumerRoot, engineCheckoutRoot, { nm: 'engine', dir: '.' });
    expect(ok).toBe(true);
    expect(readFileSync(join(installed, 'platform/dist/index.js'), 'utf8')).toBe('fresh local build');
    expect(readFileSync(cacheFile, 'utf8')).toBe('stale published build');
    expect(readFileSync(join(installed, 'contracts/artifacts/operator-contract.json'), 'utf8')).toBe('{"fresh":true}');
    const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    expect(manifest.version).toBe('2.0.23');
    // The published form: the source condition names src files the overlay
    // does not copy, so a Bun consumer must never see it.
    expect(manifest.exports['./platform']).toEqual({ types: './platform/dist/index.d.ts', import: './platform/dist/index.js' });
    expect(manifest.exports['./package.json']).toBe('./package.json');
  });

  test('skips (returns false) when the package is not installed in the consumer', () => {
    const consumerRoot = mkTemp('gv-engine-overlay-consumer-');
    const engineCheckoutRoot = mkTemp('gv-engine-overlay-engine-');
    writeCheckoutPackage(engineCheckoutRoot, '2.0.23');
    const ok = overlayPackage(consumerRoot, engineCheckoutRoot, { nm: 'engine', dir: '.' });
    expect(ok).toBe(false);
  });

  test('skips (returns false) when the engine has not built a published dist for that package', () => {
    const consumerRoot = mkTemp('gv-engine-overlay-consumer-');
    const engineCheckoutRoot = mkTemp('gv-engine-overlay-engine-');
    mkdirSync(join(consumerRoot, 'node_modules/@goodvibes-jev/engine'), { recursive: true });
    writePkgJson(engineCheckoutRoot, { name: '@goodvibes-jev/engine', files: ['contracts/artifacts', 'platform/dist'] });
    const ok = overlayPackage(consumerRoot, engineCheckoutRoot, { nm: 'engine', dir: '.' });
    expect(ok).toBe(false);
  });
});

describe('markerPath', () => {
  test('points at node_modules/@goodvibes-jev/engine/.local-engine-overlay.json (the path every release gate reads)', () => {
    expect(markerPath('/repo')).toBe('/repo/node_modules/@goodvibes-jev/engine/.local-engine-overlay.json');
  });
});

describe('CLI dispatch (black-box, subprocess)', () => {
  function run(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): { exitCode: number; output: string } {
    const result = Bun.spawnSync(['bun', SCRIPT_PATH, ...args], {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...opts.env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
  }

  test('link fails fast and names the missing checkout when GOODVIBES_WORKSPACE_PATH does not exist', () => {
    const dir = mkTemp('gv-engine-cli-');
    const missingPath = join(dir, 'does-not-exist');
    const { exitCode, output } = run(['link'], { cwd: dir, env: { GOODVIBES_WORKSPACE_PATH: missingPath } });
    expect(exitCode).toBe(1);
    expect(output).toContain('local engine checkout not found');
    expect(output).toContain(missingPath);
  });

  test('status reports OVERLAY ACTIVE and exits 2 when a marker fixture is present', () => {
    const dir = mkTemp('gv-engine-cli-');
    const pkgDir = join(dir, 'node_modules/@goodvibes-jev/engine');
    mkdirSync(join(pkgDir, 'platform'), { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@goodvibes-jev/engine', version: '9.9.9' }));
    writeFileSync(markerPath(dir), JSON.stringify({
      sourcePath: '/fixture/goodvibes',
      engineGit: 'main@fixture (clean)',
      overlaidAt: new Date().toISOString(),
    }));
    const { exitCode, output } = run(['status'], { cwd: dir });
    expect(exitCode).toBe(2);
    expect(output).toContain('OVERLAY ACTIVE');
  });

  test('status reports clean and exits 0 when no marker is present', () => {
    const dir = mkTemp('gv-engine-cli-');
    const pkgDir = join(dir, 'node_modules/@goodvibes-jev/engine');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@goodvibes-jev/engine', version: '0.38.0' }));
    const { exitCode, output } = run(['status'], { cwd: dir });
    expect(exitCode).toBe(0);
    expect(output).toContain('engine-dev: clean');
    expect(output).toContain('0.38.0');
  });

  test('restore is a no-op and exits 0 when no overlay is active', () => {
    const dir = mkTemp('gv-engine-cli-');
    mkdirSync(join(dir, 'node_modules/@goodvibes-jev/engine'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { '@goodvibes-jev/engine': '0.38.0' } }));
    const { exitCode, output } = run(['restore'], { cwd: dir });
    expect(exitCode).toBe(0);
    expect(output).toContain('no overlay active; nothing to restore');
  });

  test('usage message is printed and exit is non-zero for an unknown command', () => {
    const { exitCode, output } = run(['bogus']);
    expect(exitCode).toBe(1);
    expect(output).toContain('usage: bun scripts/engine-dev.ts');
  });

  test('no command prints usage and exits 0', () => {
    const { exitCode, output } = run([]);
    expect(exitCode).toBe(0);
    expect(output).toContain('usage: bun scripts/engine-dev.ts');
  });
});

describe('owned overlay recovery', () => {
  function consumer(names = ['engine', 'judgment']) {
    const root = mkTemp('gv-engine-restore-');
    writePkgJson(root, { dependencies: { '@goodvibes-jev/engine': '3.1.2' } });
    for (const name of ['engine', 'judgment', 'unrelated']) {
      const path = join(root, 'node_modules/@goodvibes-jev', name);
      writePkgJson(path, { name: `@goodvibes-jev/${name}`, version: '9.9.9' });
      writeFileSync(join(path, 'original.txt'), `original ${name}`);
    }
    const marker = markerPath(root), bytes = JSON.stringify({ schema: 1, sourcePath: '/owned/source', engineGit: 'main@fixture',
      overlaidAt: '2026-11-09T00:00:00Z', overlaidPackages: names });
    writeFileSync(marker, bytes);
    return { root, marker, bytes, recovery: join(root, '.engine-overlay-restore.json') };
  }
  function install(root: string) {
    for (const name of ['engine', 'judgment']) writePkgJson(join(root, 'node_modules/@goodvibes-jev', name), { name: `@goodvibes-jev/${name}`, version: '3.1.2' });
  }

  test('restore resets only the saved package set and clears its exact retained receipt after verification', async () => {
    const f = consumer(); let installs = 0;
    await restoreEngineOverlay(f.root, root => { installs++; install(root); });
    expect(installs).toBe(1); expect(existsSync(f.recovery)).toBe(false); expect(existsSync(f.marker)).toBe(false);
    expect(readFileSync(join(f.root, 'node_modules/@goodvibes-jev/unrelated/original.txt'), 'utf8')).toBe('original unrelated');
    expect(JSON.parse(readFileSync(join(f.root, 'node_modules/@goodvibes-jev/engine/package.json'), 'utf8')).version).toBe('3.1.2');
  });

  test('failed reinstall preserves the exact original receipt and a later explicit retry completes it', async () => {
    const f = consumer();
    await expect(restoreEngineOverlay(f.root, () => { throw new Error('owned fixture reinstall failure'); })).rejects.toThrow('original receipt retained');
    expect(readFileSync(f.recovery, 'utf8')).toBe(f.bytes);
    expect(existsSync(join(f.root, 'node_modules/@goodvibes-jev/engine'))).toBe(false);
    await restoreEngineOverlay(f.root, install);
    expect(existsSync(f.recovery)).toBe(false);
    expect(readFileSync(join(f.root, 'node_modules/@goodvibes-jev/unrelated/original.txt'), 'utf8')).toBe('original unrelated');
  });

  test('a byte-identical receipt replacement cannot inherit original publication custody', async () => {
    const f = consumer(), stage = publication.createReleaseStage;
    const replacing = spyOn(publication, 'createReleaseStage').mockImplementation((directory, prefix) => {
      rmSync(f.marker); writeFileSync(f.marker, f.bytes);
      return stage(directory, prefix);
    });
    try { await expect(restoreEngineOverlay(f.root, install)).rejects.toThrow('original receipt retained'); }
    finally { replacing.mockRestore(); }
    expect(readFileSync(f.recovery, 'utf8')).toBe(f.bytes);
    expect(readFileSync(f.marker, 'utf8')).toBe(f.bytes);
    expect(readFileSync(join(f.root, 'node_modules/@goodvibes-jev/engine/original.txt'), 'utf8')).toBe('original engine');
  });

  test('reinstall cannot change the original consumer pin and still acknowledge restore', async () => {
    const f = consumer();
    await expect(restoreEngineOverlay(f.root, root => {
      install(root); writePkgJson(root, { dependencies: { '@goodvibes-jev/engine': '3.1.3' } });
    })).rejects.toThrow('original receipt retained');
    expect(readFileSync(f.recovery, 'utf8')).toBe(f.bytes);
  });

  test('an accidentally asynchronous reinstall rejection is drained and preserves recovery evidence', async () => {
    const f = consumer();
    await expect(restoreEngineOverlay(f.root, async () => { throw new Error('owned async reinstall failure'); })).rejects.toThrow('original receipt retained');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(readFileSync(f.recovery, 'utf8')).toBe(f.bytes);
  });

  for (const invalid of ['unknown-package', '../escape', 'engine/../../escape']) test(`unknown saved package ${invalid} cannot authorize any removal`, async () => {
    const f = consumer(['engine', invalid]); let called = false;
    await expect(restoreEngineOverlay(f.root, () => { called = true; })).rejects.toThrow('Unrecognized overlay receipt');
    expect(called).toBe(false); expect(readFileSync(f.marker, 'utf8')).toBe(f.bytes);
    expect(readFileSync(join(f.root, 'node_modules/@goodvibes-jev/engine/original.txt'), 'utf8')).toBe('original engine');
  });

  test('multiple old/new receipts and workspace aliases are preserved, never treated as a clean install', async () => {
    const f = consumer();
    const historical = join(f.root, 'node_modules/@goodvibes-jev/engine/.local-sdk-overlay.json');
    writeFileSync(historical, f.bytes);
    await expect(restoreEngineOverlay(f.root, install)).rejects.toThrow('Multiple overlay receipts');
    expect(readFileSync(historical, 'utf8')).toBe(f.bytes); expect(readFileSync(f.marker, 'utf8')).toBe(f.bytes);
    rmSync(historical);
    const original = join(f.root, 'workspace-engine');
    const selected = join(f.root, 'node_modules/@goodvibes-jev/engine');
    // This fixture deliberately simulates a normal workspace symlink. A reset
    // must not follow it into the checkout's actual source.
    const fs = await import('node:fs'); fs.renameSync(selected, original); symlinkSync(original, selected);
    await expect(restoreEngineOverlay(f.root, install)).rejects.toThrow('Aliased/workspace');
    expect(readFileSync(join(original, 'original.txt'), 'utf8')).toBe('original engine');
  });

  test('a private current workspace refuses link before building or changing installed files', () => {
    const source = mkTemp('gv-engine-private-'), f = consumer();
    writePkgJson(join(source, 'packages/engine'), { name: '@goodvibes-jev/engine', private: true, files: ['platform/dist'] });
    const result = Bun.spawnSync(['bun', SCRIPT_PATH, 'link'], { cwd: f.root,
      env: { ...process.env, GOODVIBES_WORKSPACE_PATH: source }, stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(1); expect(result.stderr.toString()).toContain('private workspace');
    expect(result.stdout.toString()).not.toContain('building local');
    expect(readFileSync(f.marker, 'utf8')).toBe(f.bytes);
    expect(readFileSync(join(f.root, 'node_modules/@goodvibes-jev/engine/original.txt'), 'utf8')).toBe('original engine');
  });
});
