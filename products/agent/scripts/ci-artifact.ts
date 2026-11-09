#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { writeFileAtomic } from '@goodvibes-jev/engine/platform/platform/utils';
import { recordTerminalReaderArtifact, retainNativeArtifactFiles, verifyTerminalReaderArtifact, type RetainedNativeArtifactFiles } from '@goodvibes-jev/engine/toolchain';

const payloads = ['goodvibes-agent-linux-x64', 'goodvibes-agent-linux-x64.bun', 'goodvibes-agent-linux-x64.bun.LICENSE.md', 'goodvibes-agent-linux-x64.bun.json', 'lib/sqlite-vec-linux-x64/vec0.so'] as const;
interface ArtifactManifest {
  schema: 1;
  revision: string;
  target: 'linux-x64';
  files: readonly { readonly path: string; readonly sha256: string; readonly mode: number; readonly size: number }[];
}
export interface AgentReaderSource { readonly sourceTree: string; readonly headCommit: string }

function inspect(root: string, revision: string, includeMetadata = false) {
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('Agent CI artifact requires an exact Git commit SHA');
  const retained = retainNativeArtifactFiles(resolve(root, 'dist'), [
    ...payloads.map(path => ({ path, executable: path === payloads[0] || path.endsWith('.bun') })),
    ...(includeMetadata ? [{ path: 'ci-artifact.json', mode: 0o644, pin: false }, { path: 'reader-ci-artifact.json', mode: 0o644, pin: false }] : []),
  ], { directoryRevisions: includeMetadata });
  const artifact: ArtifactManifest = { schema: 1, revision, target: 'linux-x64',
    files: retained.files.slice(0, payloads.length).map(({ path, sha256, mode, size }) => ({ path, sha256: sha256!, mode, size })) };
  return { artifact, retained };
}

/** Record only the exact host binary, ordinary Bun sidecar with notices, and native library produced by this build. */
export function recordAgentCiArtifact(root: string, revision: string, source?: AgentReaderSource): void {
  source = source === undefined ? undefined : Object.freeze({ sourceTree: source.sourceTree, headCommit: source.headCommit });
  const { artifact, retained } = inspect(root, revision);
  const current = retained.assertCurrent;
  recordTerminalReaderArtifact({ ...readerInput(root, revision, artifact, source), assertCurrent: current, retained });
  current();
  writeFileAtomic(resolve(root, 'dist/ci-artifact.json'), `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o644, assertCurrent: current });
}

/** Restoring tar must preserve source provenance, payload bytes and executable permissions. */
export function verifyAgentCiArtifact(root: string, revision: string, source?: AgentReaderSource): void {
  retainVerifiedAgentCiArtifact(root, revision, source);
}

/** Retain this exact independently verified input through one staging operation;
 * no caller-provided manifest or copied proof can skip cold verification. */
export function retainVerifiedAgentCiArtifact(root: string, revision: string, source?: AgentReaderSource):
  { readonly artifact: ArtifactManifest; readonly retained: RetainedNativeArtifactFiles } {
  source = source === undefined ? undefined : Object.freeze({ sourceTree: source.sourceTree, headCommit: source.headCommit });
  const { artifact, retained } = inspect(root, revision, true);
  const stored: unknown = JSON.parse(retained.files[payloads.length]!.bytes.toString('utf8'));
  if (JSON.stringify(stored) !== JSON.stringify(artifact)) {
    throw new Error('Restored Agent CI artifact differs from its commit, payload or mode manifest');
  }
  verifyTerminalReaderArtifact({ ...readerInput(root, revision, artifact, source), assertCurrent: retained.assertCurrent, retained });
  retained.assertCurrent();
  return Object.freeze({ artifact: Object.freeze({ ...artifact, files: Object.freeze(artifact.files.map(file => Object.freeze(file))) }), retained });
}

function readerInput(root: string, revision: string, artifact: ArtifactManifest, source?: AgentReaderSource) {
  const git = (...args: string[]) => execFileSync('git', ['--no-replace-objects', ...args], { cwd: root, encoding: 'utf8', timeout: 30_000 }).trim();
  if (!source) {
    if (git('rev-parse', 'HEAD') !== revision) throw new Error('Agent reader artifact checkout changed');
    git('diff', '--exit-code', 'HEAD');
  }
  const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version as string;
  return { sourceCommit: revision, sourceTree: source?.sourceTree ?? git('rev-parse', 'HEAD^{tree}'), headCommit: source?.headCommit ?? revision,
    target: 'linux-x64' as const, packageName: '@goodvibes-jev/agent' as const, version,
    directory: resolve(root, 'dist'), files: artifact.files };
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  const [action, revision] = process.argv.slice(2);
  if (!revision || (action !== 'record' && action !== 'verify')) throw new Error('Usage: ci-artifact.ts <record|verify> <commit SHA>');
  if (action === 'record') recordAgentCiArtifact(root, revision);
  else verifyAgentCiArtifact(root, revision);
}
