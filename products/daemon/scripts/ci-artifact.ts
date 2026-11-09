#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseDaemonCiArtifact, parseNativeReaderCapabilities, realUpdateFileIo, type NativeReaderCapabilities } from '@goodvibes-jev/engine/platform/platform/runtime/self-update';
import { atomicWriteFileSync } from '@goodvibes-jev/engine/platform/platform/config';
import { drainNativeProcessGroup, signalNativeProcessGroup } from './native-execution-process.mjs';

import { daemonCiPayloads, daemonNativeHost, type DaemonArtifactSource, type DaemonCiArtifact } from '../src/cli/native-artifact.ts';
export { DAEMON_CI_PAYLOADS, type DaemonArtifactSource, type DaemonCiArtifact } from '../src/cli/native-artifact.ts';

function captureSource(source: DaemonArtifactSource): DaemonArtifactSource {
  const captured = { sourceCommit: source.sourceCommit, sourceTree: source.sourceTree, headCommit: source.headCommit, target: source.target ?? 'linux-x64' };
  for (const value of [captured.sourceCommit, captured.sourceTree, captured.headCommit]) {
    if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) throw new Error('Daemon CI artifact requires exact Git commit/tree SHAs');
  }
  return Object.freeze(captured);
}

async function inspect(root: string, source: DaemonArtifactSource): Promise<DaemonCiArtifact> {
  const target = source.target ?? 'linux-x64';
  const payloads = daemonCiPayloads(target);
  const files = [];
  for (const path of payloads) {
    const full = resolve(root, 'native', path);
    const stat = lstatSync(full);
    if (!stat.isFile()) throw new Error(`Daemon CI artifact is not a regular file: ${path}`);
    if ((path === payloads[0] || path.endsWith('.bun')) && (stat.mode & 0o111) === 0) throw new Error('Daemon CI binary is not executable');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(full)) hash.update(chunk);
    files.push({ path, sha256: hash.digest('hex'), mode: stat.mode & 0o777, size: stat.size });
  }
  return { schema: 1, sourceCommit: source.sourceCommit, sourceTree: source.sourceTree, headCommit: source.headCommit, target, files };
}

/** Retain real filesystem revisions around the read-only child. File hashes
 * are computed once by inspect(), then checked against the recorded pins. */
function retainInputs(root: string, source: DaemonArtifactSource, includeManifest: boolean): () => void {
  const observe = realUpdateFileIo.observe;
  if (!observe) throw new Error('Native artifact observation is unavailable');
  const paths = [...daemonCiPayloads(source.target ?? 'linux-x64'), ...(includeManifest ? ['ci-artifact.json'] : [])]
    .map(path => resolve(root, 'native', path));
  const states = paths.map(path => {
    const observed = observe(path); if (observed === null) throw new Error('Native artifact input is missing');
    return { path, observed };
  });
  return () => { for (const state of states) {
    const current = observe(state.path);
    if (current === null || current.identity !== state.observed.identity || current.mode !== state.observed.mode) throw new Error('Native artifact input changed during reader inspection');
  } };
}

/** Ask the verified compiled candidate, not this checkout's newer reader table.
 * The child has no credentials, runtime graph, stdin or configuration overrides.
 * A timeout/output failure kills its owned group and waits for actual close. */
async function readCompiledReaders(command: string): Promise<NativeReaderCapabilities> {
  const detached = process.platform !== 'win32';
  const child = spawn(command, ['check-install-reader', '--describe'], { cwd: dirname(command), detached,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = []; let size = 0, failed = false, stopped = false;
  const stop = () => {
    failed = true;
    if (stopped) return;
    stopped = true;
    try { if (detached) signalNativeProcessGroup(child); else child.kill('SIGKILL'); }
    catch { child.kill('SIGKILL'); }
  };
  const timer = setTimeout(stop, 10_000);
  process.once('exit', stop);
  child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 16_384) stop(); else stdout.push(Buffer.from(chunk)); });
  child.stderr.on('data', () => { stop(); });
  child.once('error', () => { failed = true; });
  const closed = new Promise<number | null>(resolve => { child.once('close', exitCode => { clearTimeout(timer); resolve(exitCode); }); });
  const code = await closed;
  try { if (detached) await drainNativeProcessGroup(child, closed); }
  catch { failed = true; }
  finally { process.off('exit', stop); }
  if (failed || code !== 0) throw new Error('Compiled native reader capabilities could not be confirmed');
  try { return parseNativeReaderCapabilities(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(stdout)))); }
  catch { throw new Error('Compiled native reader capabilities are invalid'); }
}

/** Preserve existing payloads without rebuilding; record only the readers
 * reported by this compiled candidate's bounded read-only inspection. */
export async function recordDaemonCiArtifact(root: string, source: DaemonArtifactSource): Promise<void> {
  source = captureSource(source);
  const current = retainInputs(root, source, false);
  const base = await inspect(root, source); current();
  const binary = daemonCiPayloads(base.target)[0]; if (!binary) throw new Error('Native artifact has no executable');
  const readers = await readCompiledReaders(resolve(root, 'native', binary)); current();
  const artifact: DaemonCiArtifact = { ...base, schema: 2, readers };
  const manifest = resolve(root, 'native/ci-artifact.json');
  const observe = realUpdateFileIo.observe; if (!observe) throw new Error('Native artifact observation is unavailable');
  const original = observe(manifest);
  atomicWriteFileSync(manifest, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o644, assertCurrent: () => {
    current(); const selected = observe(manifest);
    if (original?.identity !== selected?.identity || original?.mode !== selected?.mode) throw new Error('Native artifact manifest changed before publication');
  } });
}

/** Verify restored bytes/modes/source before execution. A matching-host consumer
 * rechecks the compiled reader protocol. A release coordinator may retain the
 * original trusted CI archive's recorded profile without executing foreign CPU
 * code; it must independently admit that archive's run/source/target owner. */
export async function readVerifiedDaemonCiArtifact(root: string, source: DaemonArtifactSource,
  options: { readonly readerEvidence?: 'compiled' | 'recorded-ci' } = {}): Promise<DaemonCiArtifact> {
  const readerEvidence = options.readerEvidence ?? 'compiled';
  source = captureSource(source);
  const current = retainInputs(root, source, true);
  const stored = parseDaemonCiArtifact(JSON.parse(readFileSync(resolve(root, 'native/ci-artifact.json'), 'utf8')), source.target ?? 'linux-x64');
  const actual = await inspect(root, source);
  current();
  const base = { schema: 1, sourceCommit: stored.sourceCommit, sourceTree: stored.sourceTree,
    headCommit: stored.headCommit, target: stored.target, files: stored.files };
  if (JSON.stringify(base) !== JSON.stringify(actual)) {
    throw new Error('Restored Daemon CI artifact differs from its source, payload or mode manifest');
  }
  // V1 has no capability evidence. Preserve that fact rather than borrowing
  // support from the running checkout or executing an older inspection path.
  if (stored.schema === 1) return actual;
  if (readerEvidence === 'recorded-ci') return { ...actual, schema: 2, readers: stored.readers };
  const binary = daemonCiPayloads(actual.target)[0]; if (!binary) throw new Error('Native artifact has no executable');
  const readers = await readCompiledReaders(resolve(root, 'native', binary)); current();
  if (JSON.stringify(readers) !== JSON.stringify(stored.readers)) throw new Error('Compiled native readers differ from the recorded artifact');
  return { ...actual, schema: 2, readers };
}

export async function verifyDaemonCiArtifact(root: string, source: DaemonArtifactSource): Promise<void> {
  await readVerifiedDaemonCiArtifact(root, source);
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  const [action, sourceCommit, headCommit] = process.argv.slice(2);
  if (!sourceCommit || !headCommit || (action !== 'record' && action !== 'verify')) {
    throw new Error('Usage: ci-artifact.ts <record|verify> <checkout SHA> <PR head SHA>');
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  if (git('rev-parse', 'HEAD') !== sourceCommit) throw new Error('Daemon CI artifact checkout SHA mismatch');
  // Generated source changes must not be mislabeled as the checked-out commit.
  git('diff', '--exit-code', 'HEAD');
  const source = { sourceCommit, sourceTree: git('rev-parse', 'HEAD^{tree}'), headCommit, target: daemonNativeHost() };
  if (action === 'record') await recordDaemonCiArtifact(root, source);
  else await verifyDaemonCiArtifact(root, source);
}
