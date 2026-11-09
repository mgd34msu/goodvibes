import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureExistingDirectory } from '../../packages/engine/platform/dist/platform/utils/index.js';
import { createReleaseStage } from '../../packages/engine/toolchain/dist/lib/release-publication.js';
import { readTarGzEntries } from '../../packages/engine/platform/dist/platform/browser/index.js';
import { assertDaemonNativePayloadPins, nativeReaderCapabilities, parseDaemonCiArtifact, resolveDaemonNativePayloads, resolveSqliteVecAsset } from '../../packages/engine/platform/dist/platform/runtime/self-update.js';
import { retainVerifiedAgentCiArtifact } from '../../products/agent/scripts/ci-artifact.ts';
import { resolveSqliteVecArchive } from '../../products/agent/src/runtime/release-artifacts.ts';
import { retainVerifiedDaemonCiArtifact } from '../../products/daemon/scripts/ci-artifact.ts';
import { nativeExecutionMembers, retainNativeExecutionFiles, verifyNativeExecutionArtifact } from '../../products/daemon/scripts/native-execution-artifact.mjs';
import { runNativeArchive } from '../../products/daemon/scripts/native-execution-process.mjs';
import { retainVerifiedTuiCiArtifact } from '../../products/tui/scripts/ci-artifact.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const stop = new AbortController();
const cancel = () => stop.abort(new Error('Native release staging cancelled'));
let phase = 'argument admission';

/**
 * @param {Uint8Array} bytes
 * @param {readonly { path: string, mode: number }[]} members
 */
export function admitNativeReleaseArchive(bytes, members) {
  assert(bytes.length <= 256 * 1024 * 1024, 'Native archive exceeds the compressed size limit');
  const entries = [...readTarGzEntries(bytes, { strict: true, maxOutputLength: 512 * 1024 * 1024 })];
  assert.equal(entries.length, members.length, 'Native archive must contain exactly its declared cohort');
  assert.equal(new Set(entries.map(entry => entry.path)).size, members.length, 'Native archive has duplicate members');
  for (const entry of entries) {
    const member = members.find(member => member.path === entry.path);
    assert(member && entry.kind === 'file' && entry.mode === member.mode, 'Unexpected native archive path, type or mode');
  }
  return entries;
}

/** Keep the released v1 updater protocol while preserving the original richer
 * CI evidence for new clients. Both descriptors name the exact same cohort. */
export function daemonReleaseArtifactDescriptors(artifact, capabilityBytes) {
  const captured = parseDaemonCiArtifact(JSON.parse(Buffer.from(capabilityBytes).toString('utf8')), artifact.target);
  assert.equal(captured.schema, 2, 'Native release reader evidence is missing');
  assert.deepEqual(captured, artifact, 'Native release reader evidence changed');
  const compatible = { schema: 1, sourceCommit: artifact.sourceCommit, sourceTree: artifact.sourceTree,
    headCommit: artifact.headCommit, target: artifact.target, files: artifact.files };
  return { compatible: Buffer.from(JSON.stringify(compatible, null, 2) + '\n'), capable: Buffer.from(capabilityBytes) };
}

/** The destination is new, but its configured ancestry still belongs to the
 * caller. Keep both that alias and the original physical output for all writes.
 * Final files survive a later failure; cleanup removes only our private stage. */
export function createNativeReleaseOutput(destination, assertSource) {
  const parent = captureExistingDirectory(dirname(destination));
  parent.assertCurrent();
  const directory = join(parent.canonical, basename(destination));
  const mask = process.umask(), adjustMask = (mask & 0o700) !== 0;
  if (adjustMask) process.umask(mask & ~0o700);
  try { mkdirSync(directory, { mode: 0o700 }); }
  finally { if (adjustMask) process.umask(mask); }
  const created = lstatSync(directory, { bigint: true });
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true });
    assert(opened.isDirectory() && created.dev === opened.dev && created.ino === opened.ino && created.birthtimeNs === opened.birthtimeNs,
      'Native release output changed during creation');
    parent.assertCurrent(); fchmodSync(fd, 0o755);
    const ready = lstatSync(directory, { bigint: true });
    assert(ready.isDirectory() && !ready.isSymbolicLink() && created.dev === ready.dev && created.ino === ready.ino && created.birthtimeNs === ready.birthtimeNs,
      'Native release output changed during creation');
    parent.assertCurrent();
  } finally { closeSync(fd); }
  const stage = createReleaseStage(directory, '.native-release-output-'), published = new Map();
  const assertCurrent = () => { parent.assertCurrent(); stage.assertCurrent(); };
  const put = (name, bytes, mode) => {
    assert.equal(basename(name), name, 'A release asset must have one filename');
    assertCurrent();
    const original = published.get(name);
    if (original) {
      original.assertCurrent();
      const stat = lstatSync(original.path), selected = readFileSync(original.path);
      original.assertCurrent(); assertCurrent();
      assert.equal(stat.mode & 0o777, mode, 'Shared native asset modes differ');
      assert(selected.equals(bytes), 'Shared native asset bytes differ');
      return original;
    }
    const file = stage.publishBytes(name, bytes, mode);
    published.set(name, file); assertCurrent(); return file;
  };
  const archive = async (name, members, cwd, signal) => {
    signal?.throwIfAborted();
    assertCurrent();
    const file = await stage.publishFile(name, name, async fd => {
      assertCurrent(); await runNativeArchive(members, cwd, fd, signal); assertCurrent();
    }, 0o644, () => {
      signal?.throwIfAborted();
      // Preserve a nonvoid result for the publisher's strict restriction
      // admission; do not erase a rejected promise behind a void callback.
      const restricted = assertSource?.();
      if (restricted !== undefined) return restricted;
      signal?.throwIfAborted();
    });
    published.set(name, file); assertCurrent(); return file;
  };
  return Object.freeze({ directory, put, archive, assertCurrent, cleanup: stage.cleanup });
}

export function createNativeReleaseInput() { return createReleaseStage(tmpdir(), 'goodvibes-native-release-'); }

/** Preserve the primary failure and report incomplete original cleanup. Never
 * retry cleanup through a replaced pathname or recursively remove final output. */
export function cleanupNativeReleaseStages(stages, failure, failed = failure !== undefined) {
  const cleanupFailures = [];
  for (const stage of stages) {
    try { stage?.cleanup(); } catch (error) { cleanupFailures.push(error); }
  }
  return cleanupFailures.length ? failed
    ? new AggregateError([failure, ...cleanupFailures], 'Native release staging and original cleanup failed')
    : new AggregateError(cleanupFailures, 'Native release original cleanup failed') : failure;
}

async function main() {
  const [sourceCommit, runId, downloads, destination, ...extra] = process.argv.slice(2);
  assert(!extra.length && sourceCommit && runId && downloads && destination, 'Expected verified source, CI run and owned input/output directories');
  assert.match(runId, /^[1-9][0-9]*$/, 'Expected a verified CI run');
  const git = (...args) => execFileSync('git', ['--no-replace-objects', ...args], { cwd: repo, encoding: 'utf8', timeout: 30_000 }).trim();
  assert.equal(git('rev-parse', 'HEAD'), sourceCommit, 'Release checkout must match the admitted producer');
  git('diff', '--exit-code', 'HEAD');
  const sourceTree = git('rev-parse', 'HEAD^{tree}');
  const suiteVersion = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
  assert.equal(typeof suiteVersion, 'string', 'Release suite version is missing');
  const inputStage = createNativeReleaseInput(), inputRoot = inputStage.path;
  let output, failure, failed = false;
  const retained = [];
  const assertCurrent = () => {
    stop.signal.throwIfAborted();
    inputStage.assertCurrent(); output?.assertCurrent();
    assert.equal(git('rev-parse', 'HEAD'), sourceCommit, 'Release checkout changed');
    git('diff', '--exit-code', 'HEAD');
    for (const owner of retained) owner.assertCurrent();
  };
  const put = (name, bytes, mode) => {
    assertCurrent();
    output.put(name, bytes, mode);
    assertCurrent();
  };
  const restore = (name, members) => {
    const directory = join(downloads, name);
    const archiveName = name + '.tgz';
    const archive = retainNativeExecutionFiles(directory, [{ path: archiveName, mode: 0o644, pin: false }]);
    retained.push(archive); assertCurrent();
    const bytes = archive.files[0].bytes;
    const entries = admitNativeReleaseArchive(bytes, members);
    assertCurrent();
    const root = join(inputRoot, name); mkdirSync(root);
    for (const entry of entries) {
      assertCurrent();
      const path = join(root, entry.path); mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, entry.data, { flag: 'wx', mode: entry.mode }); chmodSync(path, entry.mode);
    }
    assertCurrent(); return { root, archive: archive.files[0] };
  };
  try {
    output = createNativeReleaseOutput(destination, assertCurrent);
    phase = 'Agent native admission';
    const agent = join(repo, 'products/agent');
    const { retained: agentOwner } = retainVerifiedAgentCiArtifact(agent, sourceCommit);
    retained.push(agentOwner); assertCurrent();
    for (const file of agentOwner.files) {
      if (file.path.startsWith('lib/')) continue;
      put(file.path === 'ci-artifact.json' ? 'goodvibes-agent-linux-x64.ci-artifact.json'
        : file.path === 'reader-ci-artifact.json' ? 'goodvibes-agent-linux-x64.reader-ci-artifact.json' : file.path, file.bytes, file.mode);
    }
    const addon = resolveSqliteVecArchive('linux', 'x64'); assert(addon, 'Agent native addon is unsupported');
    const agentAddon = agentOwner.files.find(file => file.path === addon.entryPath); assert(agentAddon, 'Agent native addon is absent');
    const addonRoot = join(inputRoot, 'agent-addon'); mkdirSync(join(addonRoot, dirname(addon.entryPath)), { recursive: true });
    writeFileSync(join(addonRoot, addon.entryPath), agentAddon.bytes, { flag: 'wx', mode: agentAddon.mode });
    assertCurrent(); await output.archive(addon.assetName, [addon.entryPath], addonRoot, stop.signal); assertCurrent();

    phase = 'TUI native admission';
    const tuiBinary = 'goodvibes-linux-x64';
    const tuiRestored = restore('tui-native-linux-x64', [
      { path: tuiBinary, mode: 0o755 }, { path: tuiBinary + '.bun', mode: 0o755 },
      { path: tuiBinary + '.bun.LICENSE.md', mode: 0o644 }, { path: tuiBinary + '.bun.json', mode: 0o644 },
      { path: addon.entryPath, mode: 0o644 }, { path: 'ci-artifact.json', mode: 0o644 }, { path: 'reader-ci-artifact.json', mode: 0o644 },
    ].map(member => ({ ...member, path: 'products/tui/dist/' + member.path })));
    const tui = join(tuiRestored.root, 'products/tui');
    writeFileSync(join(tui, 'package.json'), readFileSync(join(repo, 'products/tui/package.json')), { flag: 'wx', mode: 0o644 });
    const tuiSource = { sourceCommit, sourceTree, headCommit: sourceCommit };
    const { retained: tuiOwner } = await retainVerifiedTuiCiArtifact(tui, tuiSource);
    retained.push(tuiOwner); assertCurrent();
    const tuiAddon = resolveSqliteVecAsset('linux', 'x64'); assert(tuiAddon, 'TUI native addon is unsupported');
    for (const file of tuiOwner.files) put(file.path === 'ci-artifact.json' ? 'goodvibes-linux-x64.ci-artifact.json'
      : file.path === 'reader-ci-artifact.json' ? 'goodvibes-linux-x64.reader-ci-artifact.json' : file.path.startsWith('lib/') ? tuiAddon.assetName : file.path, file.bytes, file.mode);
    assert(tuiOwner.files.find(file => file.path === addon.entryPath).bytes.equals(agentAddon.bytes), 'Product native addon suppliers differ');

    for (const target of ['linux-x64', 'linux-arm64']) {
      phase = 'Daemon Linux native admission';
      const payloads = resolveDaemonNativePayloads('linux', target.slice('linux-'.length)); assert(payloads, 'Daemon native target is unsupported');
      const restored = restore('daemon-native-' + target, [
        ...payloads.map(payload => ({ path: payload.relativePath, mode: payload.executable ? 0o755 : 0o644 })),
        { path: 'ci-artifact.json', mode: 0o644 },
      ].map(member => ({ ...member, path: 'products/daemon/native/' + member.path })));
      const daemon = join(restored.root, 'products/daemon');
      const source = { sourceCommit, sourceTree, headCommit: sourceCommit, target };
      // restore() admitted this exact native CI run/source/target archive.
      // The coordinator retains its recorded compiled-reader evidence; it
      // cannot execute an ARM64 daemon on the x64 release host.
      const verified = await retainVerifiedDaemonCiArtifact(daemon, source, { readerEvidence: 'recorded-ci' });
      const artifact = parseDaemonCiArtifact(verified.artifact, target);
      assert.equal(artifact.schema, 2, 'Current native release requires compiled reader capability evidence');
      assert.deepEqual(artifact.readers, nativeReaderCapabilities(suiteVersion), 'Compiled daemon reader profile differs from the admitted release source');
      const owner = verified.retained;
      retained.push(owner);
      assertDaemonNativePayloadPins(artifact, owner.files.slice(0, -1), owner.files[3].bytes); assertCurrent();
      for (const payload of payloads) {
        const file = owner.files.find(file => file.path === payload.relativePath); assert(file, 'Daemon native companion is absent');
        put(payload.assetName, file.bytes, file.mode);
      }
      // Released v3.1.1 updaters accept only the original exact schema. Keep
      // that descriptor for their forward upgrade, and publish the richer
      // candidate evidence separately for readers that understand it.
      const descriptors = daemonReleaseArtifactDescriptors(artifact, owner.files.at(-1).bytes);
      put(payloads[0].assetName + '.ci-artifact.json', descriptors.compatible, 0o644);
      put(payloads[0].assetName + '.reader-ci-artifact.json', descriptors.capable, 0o644);
      put('daemon-native-' + target + '.tgz', restored.archive.bytes, 0o644);
    }
    for (const target of ['darwin-x64', 'darwin-arm64']) {
      phase = 'Daemon Darwin native admission';
      const members = nativeExecutionMembers(join(repo, 'products/daemon'), target);
      const restored = restore('daemon-native-' + target, [...members, { path: 'native-execution-artifact.json', mode: 0o644 }]
        .map(member => ({ ...member, path: 'products/daemon/native/' + member.path })));
      const daemon = join(restored.root, 'products/daemon');
      for (const name of ['package.json', 'toolchain.config.json']) writeFileSync(join(daemon, name), readFileSync(join(repo, 'products/daemon', name)), { flag: 'wx', mode: 0o644 });
      const artifact = JSON.parse(readFileSync(join(daemon, 'native/native-execution-artifact.json'), 'utf8'));
      const verified = verifyNativeExecutionArtifact(daemon, { sourceCommit, sourceTree, headCommit: sourceCommit, target, runId, runAttempt: artifact.runAttempt });
      retained.push(verified.retained); assertCurrent();
      put('daemon-native-' + target + '.tgz', restored.archive.bytes, 0o644);
    }
    assertCurrent(); phase = 'complete';
  } catch (error) {
    failure = error; failed = true;
  } finally {
    const cleaned = cleanupNativeReleaseStages([output, inputStage], failure, failed);
    if (cleaned !== failure) { failure = cleaned; failed = true; }
  }
  if (failed) throw failure;
}

if (import.meta.main) {
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try { await main(); console.log('Native release assets staged.'); }
  catch { console.error('Native release asset staging failed at ' + phase + '.'); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
