import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { nativeReaderCapabilities } from '@goodvibes-jev/engine/platform/platform/runtime/self-update';
import { NATIVE_EXECUTION_TARGETS, nativeExecutionMembers, nativeExecutionPayloadMembers, recordNativeExecutionArtifact, verifyNativeExecutionArtifact } from './native-execution-artifact.mjs';

// Inert source admission fixtures. Actual target execution belongs to the
// independent native consumer jobs; these bytes cannot prove native behavior.
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function syntheticReader(input) {
  input.assertCurrent();
  assert(input.files.every(file => Object.keys(file).sort().join(',') === 'mode,path,sha256,size'), 'Reader receives only the actual existing public pins');
  // Inert cross-target unit data. This does not qualify native execution;
  // production's default runs the current binary on its real native host.
  return { schema: 1, packageName: input.packageName, version: input.version, target: input.target,
    sourceCommit: input.sourceCommit, sourceTree: input.sourceTree, headCommit: input.headCommit,
    files: input.files.map(({ path, sha256, mode, size }) => ({ path, sha256, mode, size })), readers: nativeReaderCapabilities(input.version) };
}

function fixture(target, { record = true, inspectReader = syntheticReader } = {}) {
  const product = mkdtempSync(join(realpathSync(tmpdir()), 'daemon-execution-owner-')); roots.push(product);
  copyFileSync(new URL('../toolchain.config.json', import.meta.url), join(product, 'toolchain.config.json'));
  writeFileSync(join(product, 'package.json'), JSON.stringify({ name: '@goodvibes-jev/daemon', version: '2.0.23' }));
  const source = { sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), headCommit: 'c'.repeat(40), runId: '17', runAttempt: '2', target };
  const members = nativeExecutionMembers(product, target), root = join(product, 'native');
  for (const member of nativeExecutionPayloadMembers(product, target)) {
    const file = join(root, member.path); mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `inert ${target} ${member.path}`, { mode: member.mode }); chmodSync(file, member.mode);
  }
  if (target.startsWith('darwin-')) {
    const row = JSON.parse(readFileSync(join(product, 'toolchain.config.json'), 'utf8')).build.targets.find(row => row.key === target);
    const bytes = Buffer.alloc(64); bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(target === 'darwin-x64' ? 0x01000007 : 0x0100000c, 4); bytes.writeUInt32LE(6, 12);
    writeFileSync(join(root, row.sqliteRuntime.libraryPath), bytes);
    writeFileSync(join(root, row.sqliteRuntime.provenancePath), JSON.stringify({ schema: 1, packageName: '@goodvibes-jev/daemon', daemonVersion: '2.0.23', target,
      sqliteVersion: row.sqliteRuntime.sqliteVersion, sourceUrl: row.sqliteRuntime.sourceUrl, sourceSha3: row.sqliteRuntime.sourceSha3,
      sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }));
  }
  const artifact = record ? recordNativeExecutionArtifact(product, source, { inspectReader }) : undefined;
  return { product, root, source, members, artifact };
}

for (const target of NATIVE_EXECUTION_TARGETS) {
  test(`${target} records/restores only its fixed source-declared companions`, () => {
    const f = fixture(target); const verified = verifyNativeExecutionArtifact(f.product, f.source);
    assert.equal(verified.retained.files.at(-1).path, 'native-execution-artifact.json');
    assert.equal(Object.hasOwn(verified.retained.files.at(-1), 'sha256'), false);
    assert(verified.artifact.files.every(file => /^[0-9a-f]{64}$/.test(file.sha256)));
    assert.equal(verified.artifact.target, target); assert.equal(verified.artifact.runAttempt, '2'); verified.retained.assertCurrent();
    assert.equal(f.members.length, 5);
    assert.deepEqual(verified.artifact.files.map(file => file.path), f.members.map(file => file.path));
    assert.equal(f.artifact.kind, 'daemon-native-execution');
    assert(!verified.artifact.files.some(file => file.path === 'daemon-installation.json'));
  });
  test(`${target} later consumers retain earlier producer provenance without rewriting or accepting future attempts`, () => {
    const f = fixture(target), manifest = join(f.root, 'native-execution-artifact.json');
    const original = readFileSync(manifest);
    const verified = verifyNativeExecutionArtifact(f.product, { ...f.source, runAttempt: '3' }, { allowEarlierAttempt: true });
    assert.deepEqual(verified.artifact, f.artifact); verified.retained.assertCurrent();
    assert.deepEqual(readFileSync(manifest), original);
    assert.throws(() => verifyNativeExecutionArtifact(f.product, { ...f.source, runAttempt: '1' }, { allowEarlierAttempt: true }));
    for (const runAttempt of ['0', '01', '-1', '1.5', 'invalid', null]) {
      writeFileSync(manifest, JSON.stringify({ ...f.artifact, runAttempt }));
      assert.throws(() => verifyNativeExecutionArtifact(f.product, { ...f.source, runAttempt: '3' }, { allowEarlierAttempt: true }));
    }
  });
  for (const field of ['sourceCommit', 'sourceTree', 'headCommit', 'runId', 'runAttempt', 'target']) {
    test(`${target} refuses a different ${field} owner`, () => {
      const f = fixture(target);
      const changed = field === 'target' ? NATIVE_EXECUTION_TARGETS.find(value => value !== target) : field.startsWith('run') ? '3' : 'd'.repeat(40);
      assert.throws(() => verifyNativeExecutionArtifact(f.product, { ...f.source, [field]: changed }));
      assert.throws(() => verifyNativeExecutionArtifact(f.product,
        { ...f.source, runAttempt: '3', [field]: field === 'runAttempt' ? '1' : changed }, { allowEarlierAttempt: true }));
    });
  }
  for (const mutation of ['bytes', 'mode', 'missing', 'manifest-path', 'symlink', 'parent-aba', 'foreign-inode']) {
    test(`${target} refuses retained ${mutation} admission/lifetime`, () => {
      const f = fixture(target); const verified = verifyNativeExecutionArtifact(f.product, f.source);
      const full = join(f.root, f.members.at(-2).path);
      if (mutation === 'bytes') writeFileSync(full, 'foreign bytes');
      if (mutation === 'mode') chmodSync(full, 0o600);
      if (mutation === 'missing') rmSync(full);
      if (mutation === 'manifest-path') {
        const artifact = structuredClone(f.artifact); artifact.files[0].path = '../foreign';
        writeFileSync(join(f.root, 'native-execution-artifact.json'), JSON.stringify(artifact));
      }
      if (mutation === 'symlink') { const foreign = join(f.product, 'foreign'); copyFileSync(full, foreign); rmSync(full); symlinkSync(foreign, full); }
      if (mutation === 'parent-aba') { renameSync(f.root, f.root + '.old'); renameSync(f.root + '.old', f.root); }
      if (mutation === 'foreign-inode') { const bytes = readFileSync(full), mode = f.members.at(-2).mode; writeFileSync(full + '.foreign', bytes, { mode }); renameSync(full + '.foreign', full); }
      assert.throws(() => verified.retained.assertCurrent());
      if (mutation !== 'parent-aba' && mutation !== 'foreign-inode') {
        assert.throws(() => verifyNativeExecutionArtifact(f.product, f.source));
        assert.throws(() => verifyNativeExecutionArtifact(f.product, { ...f.source, runAttempt: '3' }, { allowEarlierAttempt: true }));
      }
    });
  }
}

test('source target retirement and invalid SQLite supplier refuse instead of reducing coverage', () => {
  for (const change of ['retire', 'supplier']) {
    const f = fixture('darwin-arm64'), path = join(f.product, 'toolchain.config.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    if (change === 'retire') config.build.targets.pop(); else config.build.targets.at(-1).sqliteRuntime.sourceSha3 = '0'.repeat(64);
    writeFileSync(path, JSON.stringify(config)); assert.throws(() => verifyNativeExecutionArtifact(f.product, f.source));
  }
});

test('retained payload bytes cannot change behind an unchanged source manifest', () => {
  const f = fixture('linux-x64'), verified = verifyNativeExecutionArtifact(f.product, f.source);
  const original = verified.retained.files[0];
  const before = readFileSync(join(f.root, original.path));
  verified.retained.assertCurrent(); verified.retained.assertCurrent();
  original.bytes.fill(0);
  assert.deepEqual(readFileSync(join(f.root, original.path)), before);
  // The returned buffer is a detached read, never the private original proof.
  verified.retained.assertCurrent();
  assert.deepEqual(original.bytes, before);
});

for (const target of ['darwin-x64', 'darwin-arm64']) {
  test(`${target} records the reader in its real installed name and retains it across relocation`, () => {
    const f = fixture(target), restored = join(f.product, 'relocated', 'native');
    const readerName = f.members[0].path + '.readers.json';
    assert.equal(f.members.at(-1).path, readerName);
    const reader = JSON.parse(readFileSync(join(f.root, readerName), 'utf8'));
    assert.equal(reader.packageName, '@goodvibes-jev/daemon');
    assert.deepEqual(reader.files, f.artifact.files.filter(file => file.path !== readerName));
    const verified = verifyNativeExecutionArtifact(f.product, f.source);
    for (const file of verified.retained.files) {
      const path = join(restored, file.path); mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.bytes, { flag: 'wx', mode: file.mode }); chmodSync(path, file.mode);
    }
    const relocatedProduct = dirname(restored);
    for (const name of ['package.json', 'toolchain.config.json']) copyFileSync(join(f.product, name), join(relocatedProduct, name));
    assert.deepEqual(verifyNativeExecutionArtifact(relocatedProduct, f.source).artifact, f.artifact);
    rmSync(join(restored, readerName));
    assert.throws(() => verifyNativeExecutionArtifact(relocatedProduct, f.source), /ENOENT/);
    verified.retained.assertCurrent();
  });
  for (const field of ['sourceCommit', 'sourceTree', 'headCommit', 'version', 'packageName', 'target', 'files', 'readers']) {
    test(`${target} refuses an internally mismatched ${field} reader even when its outer manifest pin is updated`, () => {
      const f = fixture(target), readerName = f.members.at(-1).path;
      const path = join(f.root, readerName), reader = JSON.parse(readFileSync(path, 'utf8'));
      if (field === 'files') reader.files.pop();
      else if (field === 'readers') reader.readers.version = '9.9.9';
      else reader[field] = field === 'target' ? 'linux-x64' : field === 'packageName' ? '@goodvibes-jev/agent' : field === 'version' ? '9.9.9' : 'd'.repeat(40);
      const bytes = Buffer.from(JSON.stringify(reader)); writeFileSync(path, bytes);
      const artifact = structuredClone(f.artifact), pin = artifact.files.find(file => file.path === readerName);
      pin.sha256 = createHash('sha256').update(bytes).digest('hex'); pin.size = bytes.length;
      writeFileSync(join(f.root, 'native-execution-artifact.json'), JSON.stringify(artifact));
      assert.throws(() => verifyNativeExecutionArtifact(f.product, f.source));
    });
  }
  test(`${target} a changed native payload during reader inspection publishes neither descriptor nor execution manifest`, () => {
    const f = fixture(target, { record: false });
    assert.throws(() => recordNativeExecutionArtifact(f.product, f.source, { inspectReader(input) {
      const reader = syntheticReader(input); writeFileSync(join(f.root, f.members[0].path), 'Changed while describing readers'); return reader;
    } }), /Retained native artifact/);
    assert.throws(() => readFileSync(join(f.root, f.members.at(-1).path)), /ENOENT/);
    assert.throws(() => readFileSync(join(f.root, 'native-execution-artifact.json')), /ENOENT/);
  });
  test(`${target} pre-existing reader metadata is never overwritten by fresh producer recording`, () => {
    const f = fixture(target, { record: false }), path = join(f.root, f.members.at(-1).path), bytes = Buffer.from('Foreign reader metadata');
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o644 });
    assert.throws(() => recordNativeExecutionArtifact(f.product, f.source, { inspectReader: syntheticReader }), /EEXIST/);
    assert.deepEqual(readFileSync(path), bytes);
    assert.throws(() => readFileSync(join(f.root, 'native-execution-artifact.json')), /ENOENT/);
  });
}

if (process.platform !== 'darwin') test('the actual default inspector refuses a cross-host reader without executing an inert foreign target', () => {
  const f = fixture('darwin-x64', { record: false });
  assert.throws(() => recordNativeExecutionArtifact(f.product, f.source), /requires its native build host/);
  assert.throws(() => readFileSync(join(f.root, f.members.at(-1).path)), /ENOENT/);
  assert.throws(() => readFileSync(join(f.root, 'native-execution-artifact.json')), /ENOENT/);
});
