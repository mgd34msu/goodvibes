#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { writeFileAtomic } from '@goodvibes-jev/engine/sdk/platform/utils';
import { recordTerminalReaderArtifact, retainTerminalReaderCohort, verifyTerminalReaderArtifact } from '@goodvibes-jev/engine/toolchain';

const payloads = ['goodvibes-agent-linux-x64', 'goodvibes-agent-linux-x64.bun', 'goodvibes-agent-linux-x64.bun.LICENSE.md', 'goodvibes-agent-linux-x64.bun.json', 'lib/sqlite-vec-linux-x64/vec0.so'] as const;
interface ArtifactManifest {
  schema: 1;
  revision: string;
  target: 'linux-x64';
  files: { path: string; sha256: string; mode: number; size: number }[];
}
export interface AgentReaderSource { readonly sourceTree: string; readonly headCommit: string }

function inspect(root: string, revision: string): ArtifactManifest {
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('Agent CI artifact requires an exact Git commit SHA');
  return {
    schema: 1, revision, target: 'linux-x64',
    files: payloads.map((path) => {
      const full = resolve(root, 'dist', path);
      const stat = lstatSync(full);
      if (!stat.isFile()) throw new Error(`Agent CI artifact is not a regular file: ${path}`);
      if ((path === payloads[0] || path.endsWith('.bun')) && (stat.mode & 0o111) === 0) throw new Error('Agent CI binary is not executable');
      return { path, sha256: createHash('sha256').update(readFileSync(full)).digest('hex'), mode: stat.mode & 0o777, size: stat.size };
    }),
  };
}

/** Record only the exact host binary, ordinary Bun sidecar with notices, and native library produced by this build. */
export function recordAgentCiArtifact(root: string, revision: string, source?: AgentReaderSource): void {
  const current = retainTerminalReaderCohort(resolve(root, 'dist'), '@goodvibes-jev/agent', 'linux-x64');
  const artifact = inspect(root, revision);
  recordTerminalReaderArtifact({ ...readerInput(root, revision, artifact, source), assertCurrent: current });
  current();
  writeFileAtomic(resolve(root, 'dist/ci-artifact.json'), `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o644, assertCurrent: current });
}

/** Restoring tar must preserve source provenance, payload bytes and executable permissions. */
export function verifyAgentCiArtifact(root: string, revision: string, source?: AgentReaderSource): void {
  const current = retainTerminalReaderCohort(resolve(root, 'dist'), '@goodvibes-jev/agent', 'linux-x64');
  const actual = inspect(root, revision);
  const stored: unknown = JSON.parse(readFileSync(resolve(root, 'dist/ci-artifact.json'), 'utf8'));
  if (JSON.stringify(stored) !== JSON.stringify(actual)) {
    throw new Error('Restored Agent CI artifact differs from its commit, payload or mode manifest');
  }
  verifyTerminalReaderArtifact({ ...readerInput(root, revision, actual, source), assertCurrent: current });
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
