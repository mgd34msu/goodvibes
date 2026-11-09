#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeFileAtomic } from '@goodvibes-jev/engine/platform/platform/utils';
import { recordTerminalReaderArtifact, retainNativeArtifactFiles, verifyTerminalReaderArtifact } from '@goodvibes-jev/engine/toolchain';

const payloads = ['goodvibes-linux-x64', 'goodvibes-linux-x64.bun', 'goodvibes-linux-x64.bun.LICENSE.md', 'goodvibes-linux-x64.bun.json', 'lib/sqlite-vec-linux-x64/vec0.so'] as const;
export interface TuiArtifactSource {
  sourceCommit: string;
  sourceTree: string;
  headCommit: string;
}

function inspect(root: string, source: TuiArtifactSource, includeMetadata = false) {
  source = Object.freeze({ sourceCommit: source.sourceCommit, sourceTree: source.sourceTree, headCommit: source.headCommit });
  for (const value of [source.sourceCommit, source.sourceTree, source.headCommit]) {
    if (!/^[0-9a-f]{40}$/.test(value)) throw new Error('TUI CI artifact requires exact Git commit/tree SHAs');
  }
  const retained = retainNativeArtifactFiles(resolve(root, 'dist'), [
    ...payloads.map(path => ({ path, executable: path === payloads[0] || path.endsWith('.bun') })),
    ...(includeMetadata ? [{ path: 'ci-artifact.json', mode: 0o644, pin: false }, { path: 'reader-ci-artifact.json', mode: 0o644, pin: false }] : []),
  ], { directoryRevisions: includeMetadata });
  const files = retained.files.slice(0, payloads.length).map(({ path, sha256, mode, size }) => Object.freeze({ path, sha256: sha256!, mode, size }));
  const artifact = Object.freeze({ schema: 1, ...source, target: 'linux-x64', files: Object.freeze(files) });
  return { artifact, retained };
}

/** Preserve the existing build's executable, Bun sidecar with notices, and native library, without rebuilding. */
export async function recordTuiCiArtifact(root: string, source: TuiArtifactSource): Promise<void> {
  const { artifact, retained } = inspect(root, source);
  const current = retained.assertCurrent;
  const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version as string;
  recordTerminalReaderArtifact({ sourceCommit: artifact.sourceCommit, sourceTree: artifact.sourceTree, headCommit: artifact.headCommit, target: 'linux-x64', packageName: '@goodvibes-jev/tui', version,
    directory: resolve(root, 'dist'), files: artifact.files, assertCurrent: current, retained });
  current();
  writeFileAtomic(resolve(root, 'dist/ci-artifact.json'), `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o644, assertCurrent: current });
}

/** Verify restored payload bytes, modes, and exact checkout/PR provenance before execution. */
export async function verifyTuiCiArtifact(root: string, source: TuiArtifactSource): Promise<void> {
  await retainVerifiedTuiCiArtifact(root, source);
}

/** One cold verification, followed only by guards on its actual original files. */
export async function retainVerifiedTuiCiArtifact(root: string, source: TuiArtifactSource) {
  const { artifact, retained } = inspect(root, source, true);
  const stored: unknown = JSON.parse(retained.files[payloads.length]!.bytes.toString('utf8'));
  if (JSON.stringify(stored) !== JSON.stringify(artifact)) {
    throw new Error('Restored TUI CI artifact differs from its source, payload or mode manifest');
  }
  const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version as string;
  verifyTerminalReaderArtifact({ sourceCommit: artifact.sourceCommit, sourceTree: artifact.sourceTree, headCommit: artifact.headCommit,
    target: 'linux-x64', packageName: '@goodvibes-jev/tui', version,
    directory: resolve(root, 'dist'), files: artifact.files, assertCurrent: retained.assertCurrent, retained });
  retained.assertCurrent();
  return Object.freeze({ artifact, retained });
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  const [action, sourceCommit, headCommit] = process.argv.slice(2);
  if (!sourceCommit || !headCommit || (action !== 'record' && action !== 'verify')) {
    throw new Error('Usage: ci-artifact.ts <record|verify> <checkout SHA> <PR head SHA>');
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  if (git('rev-parse', 'HEAD') !== sourceCommit) throw new Error('TUI CI artifact checkout SHA mismatch');
  // Generated source changes must not be mislabeled as the checked-out commit.
  git('diff', '--exit-code', 'HEAD');
  const source = { sourceCommit, sourceTree: git('rev-parse', 'HEAD^{tree}'), headCommit };
  if (action === 'record') await recordTuiCiArtifact(root, source);
  else await verifyTuiCiArtifact(root, source);
}
