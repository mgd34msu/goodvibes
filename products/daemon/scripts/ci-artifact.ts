#!/usr/bin/env bun
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseDaemonCiArtifact, parseNativeReaderCapabilities, realUpdateFileIo, type NativeReaderCapabilities } from '@goodvibes-jev/engine/platform/platform/runtime/self-update';
import { retainNativeArtifactFiles } from '@goodvibes-jev/engine/toolchain';
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

function inspect(root: string, source: DaemonArtifactSource, includeManifest = false) {
  const target = source.target ?? 'linux-x64', payloads = daemonCiPayloads(target);
  const retained = retainNativeArtifactFiles(resolve(root, 'native'), [
    ...payloads.map(path => ({ path, executable: path === payloads[0] || path.endsWith('.bun') })),
    ...(includeManifest ? [{ path: 'ci-artifact.json', mode: 0o644, pin: false }] : []),
  ], { directoryRevisions: includeManifest });
  const files = retained.files.slice(0, payloads.length).map(({ path, sha256, mode, size }) => ({ path, sha256: sha256!, mode, size }));
  const artifact: DaemonCiArtifact = { schema: 1, sourceCommit: source.sourceCommit,
    sourceTree: source.sourceTree, headCommit: source.headCommit, target, files };
  return { artifact, retained };
}
function immutableArtifact(artifact: DaemonCiArtifact): DaemonCiArtifact {
  artifact.files.forEach(file => Object.freeze(file)); Object.freeze(artifact.files);
  return Object.freeze(artifact);
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
  const { artifact: base, retained } = inspect(root, source);
  const current = retained.assertCurrent; current();
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
  return (await retainVerifiedDaemonCiArtifact(root, source, options)).artifact;
}

/** Keep the actual cold-verified files alive through coordinator staging. */
export async function retainVerifiedDaemonCiArtifact(root: string, source: DaemonArtifactSource,
  options: { readonly readerEvidence?: 'compiled' | 'recorded-ci' } = {}) {
  const readerEvidence = options.readerEvidence ?? 'compiled';
  if (readerEvidence !== 'compiled' && readerEvidence !== 'recorded-ci') throw new Error('Invalid native reader evidence mode');
  source = captureSource(source);
  const { artifact: actual, retained } = inspect(root, source, true);
  const current = retained.assertCurrent;
  const stored = parseDaemonCiArtifact(JSON.parse(retained.files.at(-1)!.bytes.toString('utf8')), source.target ?? 'linux-x64');
  current();
  const base = { schema: 1, sourceCommit: stored.sourceCommit, sourceTree: stored.sourceTree,
    headCommit: stored.headCommit, target: stored.target, files: stored.files };
  if (JSON.stringify(base) !== JSON.stringify(actual)) {
    throw new Error('Restored Daemon CI artifact differs from its source, payload or mode manifest');
  }
  // V1 never acquires reader support from the running checkout. Recorded-CI
  // evidence still requires the coordinator's independent archive admission.
  let artifact: DaemonCiArtifact = actual;
  if (stored.schema === 2) {
    const readers = readerEvidence === 'recorded-ci' ? stored.readers : await readCompiledReaders(resolve(root, 'native', daemonCiPayloads(actual.target)[0]!));
    current();
    if (JSON.stringify(readers) !== JSON.stringify(stored.readers)) throw new Error('Compiled native readers differ from the recorded artifact');
    artifact = { ...actual, schema: 2, readers };
  }
  current();
  return Object.freeze({ artifact: immutableArtifact(artifact), retained });
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
