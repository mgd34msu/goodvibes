#!/usr/bin/env bun
/** Private offline native cohort gate. Never invokes a registry, release, or build. */
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readVerifiedDaemonCiArtifact } from './ci-artifact.ts';
import { daemonCiPayloads } from '../src/cli/native-artifact.ts';
import { stageDaemonCiArchive } from './acquire-native.ts';
import { installDaemonNative, readDaemonInstallOwner, type DaemonInstallOwner } from './install-native.ts';
import { assertPath, expectedModes, targetPaths, validateOwner } from '../src/cli/native-installation.ts';
import { assertNativeInstallationIdle, verifiedDaemonNativePath } from '../src/cli/native-launch.ts';
import { captureUpdateFileIo, realUpdateFileIo, retainDaemonNativeFiles } from '@goodvibes-jev/engine/platform/platform/runtime/self-update';

/** Pack only admitted captured bytes, then re-admit the actual tarball before returning it. */
export async function packDaemonNative(artifactRoot: string, owner: DaemonInstallOwner): Promise<Buffer> {
  owner = { ...owner }; validateOwner(owner); assertPath(resolve(artifactRoot));
  const manifestPath = resolve(artifactRoot, 'native/ci-artifact.json'); assertPath(manifestPath);
  if (!lstatSync(manifestPath).isFile()) throw new Error('Native package manifest must be a regular file');
  const artifact = await readVerifiedDaemonCiArtifact(artifactRoot, owner); expectedModes(artifact);
  const scratch = mkdtempSync(join(tmpdir(), 'daemon-private-pack-'));
  try {
    const native = join(scratch, 'products/daemon/native'); mkdirSync(native, { recursive: true });
    for (const file of artifact.files) {
      const source = join(artifactRoot, 'native', file.path); assertPath(resolve(source));
      if (!lstatSync(source).isFile()) throw new Error('Native package member must remain a regular file');
      const target = join(native, file.path); mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(source), { flag: 'wx', mode: file.mode }); chmodSync(target, file.mode);
    }
    writeFileSync(join(native, 'ci-artifact.json'), JSON.stringify(artifact, null, 2) + '\n', { mode: 0o644 });
    chmodSync(join(native, 'ci-artifact.json'), 0o644);
    const archive = join(scratch, 'cohort.tgz');
    execFileSync('tar', ['--format=ustar', '-czf', archive, ...[...daemonCiPayloads(owner.target), 'ci-artifact.json'].map(path => `products/daemon/native/${path}`)], { cwd: scratch });
    const bytes = readFileSync(archive);
    // The restored tarball is the one byte check of what was captured: a source
    // change after the first verification shows up here as a digest mismatch.
    // Its readers were confirmed by running the source binary above, and the
    // digests prove these are the same bytes; the consumer stage runs them again.
    const restored = stageDaemonCiArchive(bytes, join(scratch, 'restored'), owner.target);
    const packed = await readVerifiedDaemonCiArtifact(restored, owner, { readerEvidence: 'recorded-ci' });
    if (JSON.stringify(packed) !== JSON.stringify(artifact)) throw new Error('Packed native cohort differs from its verified source');
    return bytes;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** Install the real archive into a fresh owned prefix, then run the production isolated verifier. */
export async function verifyDaemonNativePackage(archive: Uint8Array, owner: DaemonInstallOwner): Promise<void> {
  owner = { ...owner }; validateOwner(owner);
  const scratch = mkdtempSync(join(tmpdir(), 'daemon-private-consumer-'));
  try {
    const artifactRoot = stageDaemonCiArchive(archive, join(scratch, 'restored'), owner.target);
    const prefix = join(scratch, 'installed');
    await installDaemonNative({ artifactRoot, prefix, owner });
    // Hash the installed cohort once, as the launcher does; the identities
    // retained around that pass are what prove the probe left it untouched.
    const retained = retainDaemonNativeFiles(targetPaths(prefix, owner.target), captureUpdateFileIo(realUpdateFileIo));
    const binary = verifiedDaemonNativePath(prefix, owner);
    retained();
    // Remove the unpacked source before executing the installed artifact.
    rmSync(join(scratch, 'restored'), { recursive: true, force: true });
    execFileSync('node', [resolve(import.meta.dir, 'verify-binary.mjs'), '--binary', binary], {
      cwd: scratch, stdio: 'inherit', timeout: 300_000,
    });
    try { retained(); assertNativeInstallationIdle(prefix); }
    catch { throw new Error('Native package installation changed during its behaviour probe'); }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

export function parseNativePackageArgs(args: readonly string[]) {
  const usage = 'Usage: package-native.ts --artifact-root PATH --output ABSOLUTE_PATH --source-commit SHA --head-commit SHA';
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!; const value = args[i + 1];
    if (!['--artifact-root', '--output', '--source-commit', '--head-commit'].includes(key) || !value || value.startsWith('--') || values.has(key)) throw new Error(usage);
    values.set(key, value);
  }
  if (values.size !== 4) throw new Error(usage);
  const output = values.get('--output')!; assertPath(output);
  return { artifactRoot: values.get('--artifact-root')!, output, sourceCommit: values.get('--source-commit')!, headCommit: values.get('--head-commit')! };
}

if (import.meta.main) {
  try {
    const args = parseNativePackageArgs(process.argv.slice(2));
    const owner = readDaemonInstallOwner(resolve(import.meta.dir, '../../..'), args.sourceCommit, args.headCommit);
    const archive = await packDaemonNative(args.artifactRoot, owner);
    await verifyDaemonNativePackage(archive, owner);
    // Never replace an existing artifact; failed verification publishes no output.
    writeFileSync(args.output, archive, { flag: 'wx', mode: 0o600 });
    console.log(`[native:package] Verified private offline cohort: ${args.output}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
  }
}
