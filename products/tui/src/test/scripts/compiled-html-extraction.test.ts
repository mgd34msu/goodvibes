import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { captureLogger, loadToolchainConfig, runBuildBinaries } from '@goodvibes-jev/engine/toolchain';

const root = resolve(import.meta.dir, '../../..');
const entrypoint = 'src/test/fixtures/compiled-html-extraction.ts';

function extraction(stdout: string) {
  const { result, requests } = JSON.parse(stdout);
  expect(result.extractorId).toBe('html-readability');
  expect(result.metadata.extractionPath).toBe('readability');
  expect(result.metadata.warnings).toBeUndefined();
  expect(result.metadata.byline).toBe('Synthetic Writer');
  expect(result.title).toBe('Compiled DOM proof');
  expect(result.structure.searchText).toContain('Parsed content & 電圧 100 V.');
  expect(result.links).toEqual(['/guide']);
  expect(requests).toEqual(['engine.knowledge.html-main-content', 'engine.knowledge.html-document-title']);
  return { result, requests };
}

test('the TUI configuration delegates every supported target to the shared compile adapter', () => {
  const config = loadToolchainConfig(root).build!;
  expect(config.compileDriver).toBe('scripts/compile.ts');
  expect(config.targets.map(target => target.bunTarget)).toEqual([
    'bun-linux-x64', 'bun-linux-arm64', 'bun-darwin-x64', 'bun-darwin-arm64', 'bun-windows-x64',
  ]);
  const calls: { executable: string; args: readonly string[] }[] = [];
  const runtimes: { key: string; artifacts: readonly string[] }[] = [];
  const outcomes = runBuildBinaries({
    cwd: root, config, selection: { targets: config.targets, daemonOnly: false }, nativeKey: 'linux-x64',
    provideAddon: () => true,
    provideBunRuntime: (target, artifacts) => { runtimes.push({ key: target.key, artifacts }); },
    exec: (executable, args) => { calls.push({ executable, args }); return { status: 0, stdout: '', stderr: '' }; },
    logger: captureLogger(),
  });
  expect(outcomes.every(outcome => outcome.ok)).toBe(true);
  expect(calls.slice(config.prebuild.length)).toEqual(config.targets.map(target => ({
    executable: process.execPath, args: [
      'scripts/compile.ts', config.appEntrypoint, '--compile', `--target=${target.bunTarget}`,
      '--outfile', `${config.outDir}/${target.appArtifact}`, '--external', target.nativeAddonPackage!,
    ],
  })));
  expect(runtimes).toEqual(config.targets.filter(target => target.capturedBunRuntime).map(target => ({ key: target.key, artifacts: [target.appArtifact] })));
});

test('the TUI resolves the lazy HTML extraction dependencies and extracts readable content in a clean process', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-html-extraction-'));
  try {
    // A fresh process with an empty HOME: nothing from the developer's config or secrets can be what makes it work.
    // The run is judged on its output; the timeout only kills a hung child.
    const run = spawnSync(process.execPath, [join(root, entrypoint)], {
      cwd: dir, env: { HOME: dir }, encoding: 'utf8', timeout: 120_000,
    });
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });
    extraction(run.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
