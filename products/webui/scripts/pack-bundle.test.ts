/**
 * pack-bundle, the release asset the suite installer downloads.
 *
 * The three properties that matter are the ones the installer depends on and
 * cannot check for itself until it is too late:
 *
 *   1. The archive's single top-level directory is `goodvibes-webui/` and it
 *      holds `index.html`. The installer refuses an archive without that file,
 *      so producing one would ship a release that cannot install.
 *   2. Two runs over the same build produce byte-identical archives. Otherwise
 *      the digest in SHA256SUMS.txt stops meaning "the bytes this release
 *      built".
 *   3. A `dist/` with no index.html is refused here rather than published as a
 *      bundle nobody can serve.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUNDLE_ROOT_DIR, bundleAssetName, packBundle } from './pack-bundle';
import { installTestCleanup, makeProjectTempDir } from './helpers/project-temp';

installTestCleanup(afterAll);

function scratch(prefix: string): string {
  return makeProjectTempDir(`pack-bundle-${prefix}-`);
}

/** A minimal but realistic built bundle. */
function buildDist(root: string, options: { readonly omitIndex?: boolean } = {}): string {
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  if (options.omitIndex !== true) {
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>GoodVibes</title>\n');
  }
  writeFileSync(join(dist, 'assets', 'index-abc123.js'), 'console.log("app");\n');
  writeFileSync(join(dist, 'assets', 'index-abc123.css'), 'body{margin:0}\n');
  return dist;
}

function listArchive(archivePath: string): string[] {
  const result = Bun.spawnSync(['tar', '-tzf', archivePath]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().split('\n').filter(Boolean).map((entry) => entry.replace(/\/$/, ''));
}

describe('pack-bundle', () => {
  test('names the asset the way the installer looks it up', () => {
    expect(bundleAssetName('1.12.1')).toBe('goodvibes-webui-bundle-1.12.1.tar.gz');
  });

  test('packs a single goodvibes-webui/ directory holding index.html and the assets', () => {
    const root = scratch('pack-layout');
    const dist = buildDist(root);
    const out = join(root, 'release');
    const packed = packBundle({ distDir: dist, outDir: out, version: '1.12.1' });

    const entries = listArchive(packed.archivePath);
    expect(entries).toContain(BUNDLE_ROOT_DIR);
    expect(entries).toContain(`${BUNDLE_ROOT_DIR}/index.html`);
    expect(entries).toContain(`${BUNDLE_ROOT_DIR}/assets/index-abc123.js`);
    // Nothing outside the one contract directory.
    expect(entries.every((entry) => entry === BUNDLE_ROOT_DIR || entry.startsWith(`${BUNDLE_ROOT_DIR}/`))).toBe(true);
  });

  test('writes a SHA256SUMS.txt entry the installer can look the asset up by', () => {
    const root = scratch('pack-manifest');
    const dist = buildDist(root);
    const out = join(root, 'release');
    const packed = packBundle({ distDir: dist, outDir: out, version: '2.0.0' });

    const manifest = readFileSync(packed.checksumPath, 'utf8');
    expect(manifest).toBe(`${packed.sha256}  goodvibes-webui-bundle-2.0.0.tar.gz\n`);
    // The name in the manifest is the name of the file that was actually written.
    expect(packed.assetName).toBe('goodvibes-webui-bundle-2.0.0.tar.gz');
  });

  test('two runs over the same build produce byte-identical archives', () => {
    const root = scratch('pack-deterministic');
    const dist = buildDist(root);
    const first = packBundle({ distDir: dist, outDir: join(root, 'a'), version: '1.12.1' });
    const second = packBundle({ distDir: dist, outDir: join(root, 'b'), version: '1.12.1' });
    expect(second.sha256).toBe(first.sha256);
    expect(readFileSync(second.archivePath).equals(readFileSync(first.archivePath))).toBe(true);
  });

  test('a build with no index.html is refused rather than published', () => {
    const root = scratch('pack-no-index');
    const dist = buildDist(root, { omitIndex: true });
    expect(() => packBundle({ distDir: dist, outDir: join(root, 'release'), version: '1.12.1' }))
      .toThrow();
  });

  test('leaves no staging directory behind', () => {
    const root = scratch('pack-staging');
    const dist = buildDist(root);
    const out = join(root, 'release');
    packBundle({ distDir: dist, outDir: out, version: '1.12.1' });
    expect(() => readFileSync(join(out, '.pack-staging', BUNDLE_ROOT_DIR, 'index.html'))).toThrow();
  });
});


test('the suite can reuse the original archive pin while same-inode edits or identical-byte replacement retire it', () => {
  const root = scratch('pack-original-pin'), dist = buildDist(root);
  for (const replacement of ['edit', 'replace'] as const) {
    const packed = packBundle({ distDir: dist, outDir: join(root, replacement), version: '3.1.2' });
    const bytes = readFileSync(packed.archivePath);
    expect(packed.size).toBe(bytes.length);
    // Independent expected release checksum, not a second producer hash.
    expect(packed.sha256).toBe(createHash('sha256').update(bytes).digest('hex')); packed.assertCurrent();
    if (replacement === 'edit') { const changed = Buffer.from(bytes); changed[0] = changed[0]! ^ 1; writeFileSync(packed.archivePath, changed); }
    else { writeFileSync(packed.archivePath + '.foreign', bytes); renameSync(packed.archivePath + '.foreign', packed.archivePath); }
    expect(() => packed.assertCurrent()).toThrow('Packed WebUI archive changed');
  }
});

test('existing private staging and existing archive/checksum outputs are preserved', () => {
  const root = scratch('pack-preserve'), dist = buildDist(root), out = join(root, 'release');
  mkdirSync(join(out, '.pack-staging'), { recursive: true });
  writeFileSync(join(out, '.pack-staging', 'foreign.txt'), 'another build');
  const first = packBundle({ distDir: dist, outDir: out, version: '3.1.2' });
  const archive = readFileSync(first.archivePath), manifest = readFileSync(first.checksumPath);
  expect(() => packBundle({ distDir: dist, outDir: out, version: '3.1.2' })).toThrow();
  expect(readFileSync(first.archivePath).equals(archive)).toBe(true);
  expect(readFileSync(first.checksumPath).equals(manifest)).toBe(true);
  expect(readFileSync(join(out, '.pack-staging', 'foreign.txt'), 'utf8')).toBe('another build');
  first.assertCurrent();
});

test('an existing checksum refuses publication and rolls back only the new archive', () => {
  const root = scratch('pack-existing-sums'), dist = buildDist(root), out = join(root, 'release');
  mkdirSync(out); writeFileSync(join(out, 'SHA256SUMS.txt'), 'foreign manifest');
  expect(() => packBundle({ distDir: dist, outDir: out, version: '3.1.2' })).toThrow();
  expect(readFileSync(join(out, 'SHA256SUMS.txt'), 'utf8')).toBe('foreign manifest');
  expect(existsSync(join(out, bundleAssetName('3.1.2')))).toBe(false);
  expect(readdirSync(out)).toEqual(['SHA256SUMS.txt']);
});

test('suite checksum cleanup preserves replacements and leaves archive custody usable after its own removal', () => {
  const root = scratch('pack-checksum-owner'), dist = buildDist(root);
  const first = packBundle({ distDir: dist, outDir: join(root, 'first'), version: '3.1.2' });
  first.removeOwnedChecksum(); first.removeOwnedChecksum(); first.assertCurrent();
  expect(existsSync(first.checksumPath)).toBe(false);
  const second = packBundle({ distDir: dist, outDir: join(root, 'second'), version: '3.1.2' });
  writeFileSync(second.checksumPath + '.foreign', 'foreign replacement');
  renameSync(second.checksumPath + '.foreign', second.checksumPath);
  expect(() => second.removeOwnedChecksum()).toThrow();
  expect(readFileSync(second.checksumPath, 'utf8')).toBe('foreign replacement'); second.assertCurrent();
  writeFileSync(second.archivePath + '.foreign', 'foreign archive'); renameSync(second.archivePath + '.foreign', second.archivePath);
  expect(() => second.removeOwnedArchive()).toThrow(); expect(readFileSync(second.archivePath, 'utf8')).toBe('foreign archive');
});

test('an output symlink and a recursively nested output are refused before touching build inputs', () => {
  const root = scratch('pack-alias'), dist = buildDist(root), nested = join(dist, 'not-created', 'release');
  expect(() => packBundle({ distDir: dist, outDir: nested, version: '3.1.2' })).toThrow('outside');
  expect(existsSync(join(dist, 'not-created'))).toBe(false);
  const out = join(root, 'release'); mkdirSync(out);
  const foreign = join(root, 'foreign'); writeFileSync(foreign, 'foreign bytes');
  symlinkSync(foreign, join(out, bundleAssetName('3.1.2')));
  expect(() => packBundle({ distDir: dist, outDir: out, version: '3.1.2' })).toThrow();
  expect(readlinkSync(join(out, bundleAssetName('3.1.2')))).toBe(foreign);
  expect(readFileSync(foreign, 'utf8')).toBe('foreign bytes');
  const alias = join(root, 'dist-alias'); symlinkSync(dist, alias, 'dir');
  expect(() => packBundle({ distDir: dist, outDir: join(alias, 'nested'), version: '3.1.2' })).toThrow('outside');
  expect(existsSync(join(dist, 'nested'))).toBe(false);
  const nestedAlias = join(root, 'assets-alias'); symlinkSync(join(dist, 'assets'), nestedAlias, 'dir');
  expect(() => packBundle({ distDir: dist, outDir: `${nestedAlias}/../nested`, version: '3.1.2' })).toThrow();
  expect(existsSync(join(dist, 'nested'))).toBe(false);
});

test('invalid versions cannot create arbitrary archive paths or output directories', () => {
  const root = scratch('pack-invalid-version'), dist = buildDist(root), out = join(root, 'not-created');
  for (const version of ['../../foreign', '3.1.2/../foreign', '3.1.2\nforeign', '3.1.2' + 'x'.repeat(250)]) {
    expect(() => packBundle({ distDir: dist, outDir: out, version })).toThrow('version');
  }
  expect(existsSync(out)).toBe(false);
});

test('concurrent actual CLI publishers select one complete winner without deleting its files', async () => {
  const root = scratch('pack-concurrent'), dist = buildDist(root), out = join(root, 'release');
  const children = [0, 1].map(() => Bun.spawn([process.execPath, import.meta.dir + '/pack-bundle.ts', '--dist', dist, '--out', out, '--version', '3.1.2'], {
    stdout: 'pipe', stderr: 'pipe',
  }));
  const results = await Promise.all(children.map(async child => {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  }));
  expect(results.map(result => result.code).sort()).toEqual([0, 1]);
  const archive = join(out, bundleAssetName('3.1.2'));
  expect(listArchive(archive)).toContain(`${BUNDLE_ROOT_DIR}/index.html`);
  expect(readFileSync(join(out, 'SHA256SUMS.txt'), 'utf8')).toContain(`  ${bundleAssetName('3.1.2')}\n`);
  expect(readdirSync(out).some(name => name.startsWith('.pack-staging-'))).toBe(false);
}, 10_000);

test('actual tar failure cleans only this attempt staging and publishes no partial archive', async () => {
  const root = scratch('pack-failure'), dist = buildDist(root), out = join(root, 'release'), bin = join(root, 'bin');
  mkdirSync(bin); mkdirSync(join(out, '.pack-staging'), { recursive: true });
  writeFileSync(join(out, '.pack-staging', 'foreign'), 'preserved');
  writeFileSync(join(bin, 'tar'), '#!/bin/sh\nexit 17\n', { mode: 0o755 });
  const child = Bun.spawn([process.execPath, import.meta.dir + '/pack-bundle.ts', '--dist', dist, '--out', out, '--version', '3.1.2'], {
    env: { ...process.env, PATH: bin + ':' + process.env.PATH }, stdout: 'pipe', stderr: 'pipe',
  });
  const [code, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(1);
  expect(readdirSync(out)).toEqual(['.pack-staging']);
  expect(readFileSync(join(out, '.pack-staging', 'foreign'), 'utf8')).toBe('preserved');
}, 10_000);
