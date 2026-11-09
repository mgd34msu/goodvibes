#!/usr/bin/env bun
/**
 * pack-bundle, turn the built `dist/` into the release asset the suite
 * installer downloads.
 *
 * WHY THIS EXISTS
 *
 * The browser operator surface installs alongside the daemon, the terminal app
 * and the agent from one curl. It is the only one of the four that is not a
 * binary, it is static files the daemon serves on its own listener, so what it
 * publishes is a bundle: one gzipped tar, named for its version, attached to the
 * GitHub release with a SHA256SUMS.txt the installer verifies it against, on
 * exactly the same terms as every binary in the suite. A missing manifest entry
 * is a hard failure there, never a skip.
 *
 * THE LAYOUT IS PART OF THE CONTRACT
 *
 * The archive holds a single top-level directory, `goodvibes-webui/`, containing
 * `index.html` and everything beside it. The installer unpacks to a scratch
 * directory, checks `goodvibes-webui/index.html` exists, and only then moves it
 * into place, so an interrupted download can never leave a half-extracted
 * directory that a daemon then serves as if it were an app. `index.html` is what
 * the daemon serves at `/` and falls back to for app routes; an archive without
 * it is not a bundle, and this script refuses to produce one.
 *
 * IT IS DETERMINISTIC ON PURPOSE
 *
 * Two runs over the same `dist/` produce byte-identical archives: entries are
 * sorted, ownership is zeroed, timestamps are pinned to the epoch, and gzip is
 * told not to record its own. Without that the checksum in SHA256SUMS.txt would
 * differ between a re-run and the run that shipped, and "the bytes are the ones
 * this release built" would stop being checkable.
 *
 * Usage:
 *   bun run scripts/pack-bundle.ts                 # writes release/ from dist/
 *   bun run scripts/pack-bundle.ts --dist <dir> --out <dir> --version <x.y.z>
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReleaseStage, planReleaseDirectory } from '@goodvibes-jev/engine/toolchain/release-publication';
import type { PublishedReleaseFile } from '@goodvibes-jev/engine/toolchain/release-publication';
import { readFileObservation } from '@goodvibes-jev/engine/platform/platform/utils';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The single top-level directory inside the archive. Part of the contract. */
export const BUNDLE_ROOT_DIR = 'goodvibes-webui';

/** The release-asset name for a version. Mirrored by the suite installer. */
export function bundleAssetName(version: string): string {
  if (version.length > 128 || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error('A release version is required.');
  return `goodvibes-webui-bundle-${version}.tar.gz`;
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value !== undefined && !value.startsWith('--') ? value : undefined;
}

function run(command: string[], cwd: string): void {
  const result = Bun.spawnSync(command, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(' ')} failed:\n${result.stderr.toString()}`);
  }
}

export interface PackBundleOptions {
  readonly distDir: string;
  readonly outDir: string;
  readonly version: string;
}

export interface PackedBundle {
  readonly assetName: string;
  readonly archivePath: string;
  readonly checksumPath: string;
  readonly sha256: string;
  readonly size: number;
  /** Original archive custody, allowing the suite to reuse this real pin. */
  assertCurrent(): void;
  /** Remove only this invocation's original temporary standalone checksum. */
  removeOwnedChecksum(): void;
  /** Failure compensation, preserving any later replacement. */
  removeOwnedArchive(): void;
}

export function packBundle(options: PackBundleOptions): PackedBundle {
  const { distDir, outDir, version } = options;
  const assetName = bundleAssetName(version);
  const dist = realpathSync(distDir), planned = planReleaseDirectory(outDir);
  const inside = relative(dist, planned);
  if (inside === '' || (!inside.startsWith('..' + '/') && inside !== '..' && !isAbsolute(inside))) {
    throw new Error('Release output must be outside the built dist directory.');
  }
  if (!existsSync(join(dist, 'index.html'))) {
    throw new Error(`${distDir} holds no index.html; that is the file the daemon serves at / and falls back to for app routes, so this is not a bundle. Run the build first.`);
  }
  const staging = createReleaseStage(outDir, '.pack-staging-');
  let archive: PublishedReleaseFile | undefined, checksum: PublishedReleaseFile | undefined;
  try {
    staging.assertCurrent();
    run(['cp', '-R', dist, join(staging.path, BUNDLE_ROOT_DIR)], ROOT);
    staging.assertCurrent();
    // Sorted entries, zero ownership and epoch times; gzip records no name/time.
    run(['tar', '--sort=name', '--owner=0', '--group=0', '--numeric-owner', '--mtime=@0',
      '--format=gnu', '--use-compress-program=gzip -9 -n', '-cf', join(staging.path, assetName),
      '-C', staging.path, BUNDLE_ROOT_DIR], ROOT);
    archive = staging.publish(assetName, assetName);
    archive.assertCurrent();
    const captured = readFileObservation(archive.path);
    const retainedArchive = archive;
    const assertCurrent = () => {
      try { retainedArchive.assertCurrent(); } catch { throw new Error('Packed WebUI archive changed before publication.'); }
    };
    const digest = createHash('sha256').update(captured.bytes).digest('hex');
    assertCurrent();
    checksum = staging.publishBytes('SHA256SUMS.txt', Buffer.from(`${digest}  ${assetName}\n`));
    const retainedChecksum = checksum;
    staging.cleanup(); assertCurrent(); retainedChecksum.assertCurrent();
    return Object.freeze({ assetName, archivePath: join(outDir, assetName), checksumPath: join(outDir, 'SHA256SUMS.txt'),
      sha256: digest, size: captured.bytes.length, assertCurrent, removeOwnedChecksum: () => retainedChecksum.removeOwned(),
      removeOwnedArchive: () => retainedArchive.removeOwned() });
  } catch (error) {
    for (const original of [checksum, archive]) { try { original?.removeOwned(); } catch { /* preserve later foreign outputs and primary error */ } }
    try { staging.cleanup(); } catch { /* original directory replacement is never adopted */ }
    throw error;
  }
}

if (import.meta.main) {
  const distDir = resolve(ROOT, flag('dist') ?? 'dist');
  const outDir = resolve(ROOT, flag('out') ?? 'release');
  const version = flag('version')
    ?? (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
  const packed = packBundle({ distDir, outDir, version });
  console.log(`packed ${packed.assetName}`);
  console.log(`  ${packed.sha256}`);
  console.log(`  manifest: ${packed.checksumPath}`);
}
