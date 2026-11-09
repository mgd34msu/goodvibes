import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { nativeReaderCapabilities } from '@goodvibes-jev/engine/platform/platform/runtime/self-update';
import { recordDaemonCiArtifact, retainVerifiedDaemonCiArtifact, readVerifiedDaemonCiArtifact, verifyDaemonCiArtifact, type DaemonArtifactSource } from '../../../scripts/ci-artifact.ts';
import { nativeReaderProbeScript, nativeRuntimeProvenance, writeV1NativeArtifactFixture } from '../helpers/native-runtime-provenance.ts';

const source: DaemonArtifactSource = { sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), headCommit: 'c'.repeat(40) };
async function fixture(run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'daemon-ci-artifact-'));
  mkdirSync(join(root, 'native/lib/sqlite-vec-linux-x64'), { recursive: true });
  writeFileSync(join(root, 'native/goodvibes-daemon-linux-x64'), nativeReaderProbeScript('3.1.2', 'exit 2'), { mode: 0o755 });
  writeFileSync(join(root, 'native/goodvibes-daemon-linux-x64.bun'), 'synthetic ordinary runtime', { mode: 0o755 });
  writeFileSync(join(root, 'native/goodvibes-daemon-linux-x64.bun.LICENSE.md'), 'synthetic runtime notices', { mode: 0o644 });
  writeFileSync(join(root, 'native/goodvibes-daemon-linux-x64.bun.json'), nativeRuntimeProvenance('synthetic ordinary runtime'), { mode: 0o644 });
  writeFileSync(join(root, 'native/lib/sqlite-vec-linux-x64/vec0.so'), 'synthetic native library\n', { mode: 0o644 });
  try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('a tar round trip preserves the exact source, binary, library and executable modes', () => fixture(async root => {
  await recordDaemonCiArtifact(root, source);
  const manifest = JSON.parse(readFileSync(join(root, 'native/ci-artifact.json'), 'utf8'));
  expect(manifest).toMatchObject({ schema: 2, ...source, target: 'linux-x64', readers: nativeReaderCapabilities('3.1.2') });
  expect(manifest.files.map((file: { path: string; mode: number }) => [file.path, file.mode])).toEqual([
    ['goodvibes-daemon-linux-x64', 0o755], ['goodvibes-daemon-linux-x64.bun', 0o755], ['goodvibes-daemon-linux-x64.bun.LICENSE.md', 0o644], ['goodvibes-daemon-linux-x64.bun.json', 0o644], ['lib/sqlite-vec-linux-x64/vec0.so', 0o644],
  ]);
  const archive = join(root, 'output.tgz');
  execFileSync('tar', ['-czf', archive, '-C', root, 'native']);
  const restored = join(root, 'restored');
  mkdirSync(restored);
  execFileSync('tar', ['-xzf', archive, '-C', restored]);
  const hash = spyOn(crypto, 'createHash');
  try {
    const verified = await retainVerifiedDaemonCiArtifact(restored, source);
    expect(hash).toHaveBeenCalledTimes(5);
    verified.retained.assertCurrent(); verified.retained.assertCurrent();
    const binary = verified.retained.files[0]!, original = binary.bytes;
    binary.bytes.fill(0); expect(binary.bytes).toEqual(original);
    expect(hash).toHaveBeenCalledTimes(5);
    expect(Object.hasOwn(verified.retained.files.at(-1)!, 'sha256')).toBe(false);
    await expect(verifyDaemonCiArtifact(restored, source)).resolves.toBeUndefined();
    expect(hash).toHaveBeenCalledTimes(10); // independent cold consumer
  } finally { hash.mockRestore(); }
}));

for (const path of ['goodvibes-daemon-linux-x64', 'goodvibes-daemon-linux-x64.bun', 'goodvibes-daemon-linux-x64.bun.LICENSE.md', 'goodvibes-daemon-linux-x64.bun.json', 'lib/sqlite-vec-linux-x64/vec0.so']) {
  test(`rejects changed payload bytes: ${path}`, () => fixture(async root => {
    await recordDaemonCiArtifact(root, source);
    writeFileSync(join(root, 'native', path), 'changed');
    await expect(verifyDaemonCiArtifact(root, source)).rejects.toThrow('differs');
  }));
  test(`rejects symlink payload: ${path}`, () => fixture(async root => {
    const full = join(root, 'native', path);
    rmSync(full);
    symlinkSync(join(root, 'elsewhere'), full);
    await expect(recordDaemonCiArtifact(root, source)).rejects.toThrow('regular file');
  }));
}

for (const key of ['sourceCommit', 'sourceTree', 'headCommit'] as const) {
  test(`rejects a different ${key}`, () => fixture(async root => {
    await recordDaemonCiArtifact(root, source);
    await expect(verifyDaemonCiArtifact(root, { ...source, [key]: 'd'.repeat(40) })).rejects.toThrow('differs');
  }));
}

test('rejects lost execute mode, library mode changes, missing payloads and malformed source identity', () => fixture(async root => {
  await recordDaemonCiArtifact(root, source);
  chmodSync(join(root, 'native/goodvibes-daemon-linux-x64'), 0o644);
  await expect(verifyDaemonCiArtifact(root, source)).rejects.toThrow('executable');
  chmodSync(join(root, 'native/goodvibes-daemon-linux-x64'), 0o755);
  chmodSync(join(root, 'native/lib/sqlite-vec-linux-x64/vec0.so'), 0o600);
  await expect(verifyDaemonCiArtifact(root, source)).rejects.toThrow('differs');
  rmSync(join(root, 'native/lib/sqlite-vec-linux-x64/vec0.so'));
  await expect(recordDaemonCiArtifact(root, source)).rejects.toThrow();
  await expect(recordDaemonCiArtifact(root, { ...source, sourceTree: 'HEAD' })).rejects.toThrow('exact Git');
}));

test('the CLI refuses another checkout or modified tracked source before recording provenance', () => fixture(async root => {
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'src/cli'), { recursive: true });
  writeFileSync(join(root, 'src/cli/native-artifact.ts'), readFileSync(resolve(import.meta.dir, '../../cli/native-artifact.ts')));
  writeFileSync(join(root, 'scripts/ci-artifact.ts'), readFileSync(resolve(import.meta.dir, '../../../scripts/ci-artifact.ts')));
  writeFileSync(join(root, 'scripts/native-execution-process.mjs'), readFileSync(resolve(import.meta.dir, '../../../scripts/native-execution-process.mjs')));
  writeFileSync(join(root, '.gitignore'), 'native/\nnode_modules/\n');
  const engine = dirname(createRequire(import.meta.url).resolve('@goodvibes-jev/engine/package.json'));
  mkdirSync(join(root, 'node_modules/@goodvibes-jev'), { recursive: true });
  symlinkSync(engine, join(root, 'node_modules/@goodvibes-jev/engine'), 'dir');
  writeFileSync(join(root, 'source.txt'), 'committed source\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'synthetic fixture');
  const revision = git('rev-parse', 'HEAD');
  const run = (expected: string) => execFileSync(process.execPath, ['scripts/ci-artifact.ts', 'record', expected, revision], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  expect(() => run('d'.repeat(40))).toThrow();
  expect(() => run(revision)).not.toThrow();
  const recorded = readFileSync(join(root, 'native/ci-artifact.json'), 'utf8');
  expect(JSON.parse(recorded)).toMatchObject({ sourceCommit: revision, sourceTree: git('rev-parse', 'HEAD^{tree}'), headCommit: revision });
  writeFileSync(join(root, 'source.txt'), 'uncommitted replacement\n');
  expect(() => run(revision)).toThrow();
  expect(readFileSync(join(root, 'native/ci-artifact.json'), 'utf8')).toBe(recorded);
}));


for (const path of ['goodvibes-daemon-linux-x64', 'goodvibes-daemon-linux-x64.bun', 'goodvibes-daemon-linux-x64.bun.LICENSE.md', 'goodvibes-daemon-linux-x64.bun.json', 'lib/sqlite-vec-linux-x64/vec0.so', 'ci-artifact.json']) {
  test(`restoration rejects a missing required file: ${path}`, () => fixture(async root => {
    await recordDaemonCiArtifact(root, source);
    rmSync(join(root, 'native', path));
    await expect(verifyDaemonCiArtifact(root, source)).rejects.toThrow();
  }));
}

test('restoration rejects runtime execute-bit loss and a tampered size manifest', () => fixture(async root => {
  await recordDaemonCiArtifact(root, source);
  chmodSync(join(root, 'native/goodvibes-daemon-linux-x64.bun'), 0o644);
  await expect(verifyDaemonCiArtifact(root, source)).rejects.toThrow('executable');
  chmodSync(join(root, 'native/goodvibes-daemon-linux-x64.bun'), 0o755);
  const path = join(root, 'native/ci-artifact.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.files[0].size += 1;
  writeFileSync(path, JSON.stringify(manifest));
  await expect(verifyDaemonCiArtifact(root, source)).rejects.toThrow('differs');
}));

test.each(['version', 'formats'] as const)('restoration compares recorded reader %s to the actual compiled candidate', field => fixture(async root => {
  await recordDaemonCiArtifact(root, source); const path = join(root, 'native/ci-artifact.json');
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  if (field === 'version') stored.readers.version = '3.1.3'; else stored.readers.formats = [];
  const changed = JSON.stringify(stored); writeFileSync(path, changed);
  await expect(verifyDaemonCiArtifact(root, source)).rejects.toThrow('Compiled native readers differ');
  expect(readFileSync(path, 'utf8')).toBe(changed);
}));

test('older v1 artifacts remain readable without executing an unadvertised inspection command or inventing capabilities', () => fixture(async root => {
  const marker = join(root, 'unexpected-probe');
  writeFileSync(join(root, 'native/goodvibes-daemon-linux-x64'), `#!/bin/sh\nprintf touched > '${marker}'\nexit 12\n`);
  const original = writeV1NativeArtifactFixture(root, source);
  await expect(verifyDaemonCiArtifact(root, source)).resolves.toBeUndefined();
  expect(JSON.parse(readFileSync(join(root, 'native/ci-artifact.json'), 'utf8'))).toEqual(original);
  expect(() => readFileSync(marker)).toThrow();
}));

test('an unsupported compiled inspection refuses new provenance without replacing a prior artifact', () => fixture(async root => {
  await recordDaemonCiArtifact(root, source); const path = join(root, 'native/ci-artifact.json'); const before = readFileSync(path);
  writeFileSync(join(root, 'native/goodvibes-daemon-linux-x64'), '#!/bin/sh\nexit 2\n');
  await expect(recordDaemonCiArtifact(root, source)).rejects.toThrow('reader capabilities could not be confirmed');
  expect(readFileSync(path)).toEqual(before);
}));

for (const kind of ['stderr', 'excess-output'] as const) test(`compiled inspection ${kind} is bounded and private, and a later repaired build can record`, () => fixture(async root => {
  await recordDaemonCiArtifact(root, source); const path = join(root, 'native/ci-artifact.json'); const before = readFileSync(path);
  const binary = join(root, 'native/goodvibes-daemon-linux-x64');
  writeFileSync(binary, kind === 'stderr' ? '#!/bin/sh\nprintf private-probe-body >&2\n' : '#!/bin/sh\nprintf "%20000s" x\n');
  let failure: unknown;
  try { await recordDaemonCiArtifact(root, source); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error('Expected bounded native inspection failure');
  expect(failure.message).toBe('Compiled native reader capabilities could not be confirmed');
  expect(readFileSync(path)).toEqual(before);
  writeFileSync(binary, nativeReaderProbeScript('3.1.2', 'exit 2'));
  await expect(recordDaemonCiArtifact(root, source)).resolves.toBeUndefined();
}));

test('source changes made by a misbehaving inspection cannot be published as the captured payload cohort', () => fixture(async root => {
  await recordDaemonCiArtifact(root, source); const path = join(root, 'native/ci-artifact.json'); const before = readFileSync(path);
  const changed = nativeReaderProbeScript('3.1.2').replace('#!/bin/sh\n', '#!/bin/sh\nprintf changed > goodvibes-daemon-linux-x64.bun.LICENSE.md\n');
  writeFileSync(join(root, 'native/goodvibes-daemon-linux-x64'), changed);
  await expect(recordDaemonCiArtifact(root, source)).rejects.toThrow('owner changed');
  expect(readFileSync(path)).toEqual(before);
}));

test('compiled inspection does not receive parent credentials or runtime configuration', () => fixture(async root => {
  const key = 'GOODVIBES_SYNTHETIC_PROBE_CREDENTIAL'; const previous = process.env[key]; process.env[key] = 'synthetic-only';
  try {
    const command = nativeReaderProbeScript('3.1.2').replace('#!/bin/sh\n', '#!/bin/sh\n[ -z "${GOODVIBES_SYNTHETIC_PROBE_CREDENTIAL-}" ] || exit 19\n[ -z "${BUN_OPTIONS-}" ] || exit 19\n');
    writeFileSync(join(root, 'native/goodvibes-daemon-linux-x64'), command);
    await expect(recordDaemonCiArtifact(root, source)).resolves.toBeUndefined();
  } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
}));

test('a trusted release coordinator can verify recorded evidence without claiming fresh foreign-CPU execution', () => fixture(async root => {
  const marker = join(root, 'coordinator-executed-payload');
  writeFileSync(join(root, 'native/goodvibes-daemon-linux-x64'), `#!/bin/sh\nprintf touched > '${marker}'\nexit 12\n`);
  const base = writeV1NativeArtifactFixture(root, source);
  const artifact = { ...base, schema: 2, readers: { schema: 1, version: '3.1.2', formats: ['payment-retained-holds-v2'] } };
  writeFileSync(join(root, 'native/ci-artifact.json'), JSON.stringify(artifact));
  expect<unknown>(await readVerifiedDaemonCiArtifact(root, source, { readerEvidence: 'recorded-ci' })).toEqual(artifact);
  expect(() => readFileSync(marker)).toThrow();
  // Recorded mode still validates this archive's source and exact payloads.
  await expect(readVerifiedDaemonCiArtifact(root, { ...source, headCommit: 'd'.repeat(40) }, { readerEvidence: 'recorded-ci' })).rejects.toThrow('differs');
  writeFileSync(join(root, 'native/goodvibes-daemon-linux-x64.bun.LICENSE.md'), 'foreign notices');
  await expect(readVerifiedDaemonCiArtifact(root, source, { readerEvidence: 'recorded-ci' })).rejects.toThrow('differs');
}));
