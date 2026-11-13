import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { recordTuiCiArtifact, retainVerifiedTuiCiArtifact, verifyTuiCiArtifact, type TuiArtifactSource } from '../../../scripts/ci-artifact.ts';
import { nativeReaderCapabilities } from '@goodvibes-jev/engine/platform/platform/runtime/self-update';

const source: TuiArtifactSource = { sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), headCommit: 'c'.repeat(40) };
async function fixture(run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'tui-ci-artifact-'));
  mkdirSync(join(root, 'dist/lib/sqlite-vec-linux-x64'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@goodvibes-jev/tui', version: '3.1.2', type: 'module' }));
  writeFileSync(join(root, 'dist/goodvibes-linux-x64'), `#!/bin/sh\n[ "$1" = check-install-reader ] && [ "$2" = --describe ] || exit 2\nprintf '%s\\n' '${JSON.stringify(nativeReaderCapabilities('3.1.2'))}'\n`, { mode: 0o755 });
  writeFileSync(join(root, 'dist/goodvibes-linux-x64.bun'), 'synthetic ordinary runtime', { mode: 0o755 });
  writeFileSync(join(root, 'dist/goodvibes-linux-x64.bun.LICENSE.md'), 'synthetic runtime notices', { mode: 0o644 });
  writeFileSync(join(root, 'dist/goodvibes-linux-x64.bun.json'), 'synthetic runtime provenance', { mode: 0o644 });
  writeFileSync(join(root, 'dist/lib/sqlite-vec-linux-x64/vec0.so'), 'synthetic native library\n', { mode: 0o644 });
  try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('a tar round trip preserves the exact source, binary, library and executable modes', () => fixture(async root => {
  await recordTuiCiArtifact(root, source);
  const manifest = JSON.parse(readFileSync(join(root, 'dist/ci-artifact.json'), 'utf8'));
  expect(manifest).toMatchObject({ schema: 1, ...source, target: 'linux-x64' });
  expect(manifest.files.map((file: { path: string; mode: number }) => [file.path, file.mode])).toEqual([
    ['goodvibes-linux-x64', 0o755], ['goodvibes-linux-x64.bun', 0o755], ['goodvibes-linux-x64.bun.LICENSE.md', 0o644], ['goodvibes-linux-x64.bun.json', 0o644], ['lib/sqlite-vec-linux-x64/vec0.so', 0o644],
  ]);
  const archive = join(root, 'output.tgz');
  execFileSync('tar', ['-czf', archive, '-C', root, 'dist', 'package.json']);
  const restored = join(root, 'restored');
  mkdirSync(restored);
  execFileSync('tar', ['-xzf', archive, '-C', restored]);
  const hash = spyOn(crypto, 'createHash');
  try {
    const verified = await retainVerifiedTuiCiArtifact(restored, source);
    expect(hash).toHaveBeenCalledTimes(5);
    verified.retained.assertCurrent(); verified.retained.assertCurrent();
    const binary = verified.retained.files[0]!, original = binary.bytes;
    binary.bytes.fill(0); expect(binary.bytes).toEqual(original);
    expect(hash).toHaveBeenCalledTimes(5);
    expect(Object.hasOwn(verified.retained.files.at(-1)!, 'sha256')).toBe(false);
    await expect(verifyTuiCiArtifact(restored, source)).resolves.toBeUndefined();
    expect(hash).toHaveBeenCalledTimes(10); // independent cold consumer
  } finally { hash.mockRestore(); }
}));

for (const path of ['goodvibes-linux-x64', 'goodvibes-linux-x64.bun', 'goodvibes-linux-x64.bun.LICENSE.md', 'goodvibes-linux-x64.bun.json', 'lib/sqlite-vec-linux-x64/vec0.so']) {
  test(`rejects changed payload bytes: ${path}`, () => fixture(async root => {
    await recordTuiCiArtifact(root, source);
    writeFileSync(join(root, 'dist', path), 'changed');
    await expect(verifyTuiCiArtifact(root, source)).rejects.toThrow('differs');
  }));
  test(`rejects symlink payload: ${path}`, () => fixture(async root => {
    const full = join(root, 'dist', path);
    rmSync(full);
    symlinkSync(join(root, 'elsewhere'), full);
    await expect(recordTuiCiArtifact(root, source)).rejects.toThrow('regular file');
  }));
}

for (const key of ['sourceCommit', 'sourceTree', 'headCommit'] as const) {
  test(`rejects a different ${key}`, () => fixture(async root => {
    await recordTuiCiArtifact(root, source);
    await expect(verifyTuiCiArtifact(root, { ...source, [key]: 'd'.repeat(40) })).rejects.toThrow('differs');
  }));
}

test('rejects lost execute mode, library mode changes, missing payloads and malformed source identity', () => fixture(async root => {
  await recordTuiCiArtifact(root, source);
  chmodSync(join(root, 'dist/goodvibes-linux-x64'), 0o644);
  await expect(verifyTuiCiArtifact(root, source)).rejects.toThrow('executable');
  chmodSync(join(root, 'dist/goodvibes-linux-x64'), 0o755);
  chmodSync(join(root, 'dist/lib/sqlite-vec-linux-x64/vec0.so'), 0o600);
  await expect(verifyTuiCiArtifact(root, source)).rejects.toThrow('differs');
  rmSync(join(root, 'dist/lib/sqlite-vec-linux-x64/vec0.so'));
  await expect(recordTuiCiArtifact(root, source)).rejects.toThrow();
  await expect(recordTuiCiArtifact(root, { ...source, sourceTree: 'HEAD' })).rejects.toThrow('exact Git');
}));

test('the CLI refuses another checkout or modified tracked source before recording provenance', () => fixture(async root => {
  mkdirSync(join(root, 'scripts'));
  const engine = dirname(createRequire(import.meta.url).resolve('@goodvibes-jev/engine/package.json'));
  mkdirSync(join(root, 'node_modules/@goodvibes-jev'), { recursive: true });
  symlinkSync(engine, join(root, 'node_modules/@goodvibes-jev/engine'), 'dir');
  writeFileSync(join(root, 'scripts/ci-artifact.ts'), readFileSync(resolve(import.meta.dir, '../../../scripts/ci-artifact.ts')));
  writeFileSync(join(root, '.gitignore'), 'dist/\nnode_modules/\n');
  writeFileSync(join(root, 'source.txt'), 'committed source\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'synthetic fixture');
  const revision = git('rev-parse', 'HEAD');
  const run = (expected: string) => execFileSync(process.execPath, ['scripts/ci-artifact.ts', 'record', expected, revision], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  expect(() => run('d'.repeat(40))).toThrow();
  expect(() => run(revision)).not.toThrow();
  const recorded = readFileSync(join(root, 'dist/ci-artifact.json'), 'utf8');
  expect(JSON.parse(recorded)).toMatchObject({ sourceCommit: revision, sourceTree: git('rev-parse', 'HEAD^{tree}'), headCommit: revision });
  writeFileSync(join(root, 'source.txt'), 'uncommitted replacement\n');
  expect(() => run(revision)).toThrow();
  expect(readFileSync(join(root, 'dist/ci-artifact.json'), 'utf8')).toBe(recorded);
}));

test('the native build foundation artifacts match their committed source before provenance recording', () => fixture(async root => {
  const { syncFoundationArtifacts } = await import('../../../scripts/project-surfaces.ts');
  syncFoundationArtifacts(root);
  const generated = join(root, 'docs/foundation-artifacts');
  const committed = resolve(import.meta.dir, '../../../docs/foundation-artifacts');
  const files = readdirSync(generated).sort();
  expect(files).toEqual(['knowledge-graphql.graphql', 'knowledge-store.sql', 'operator-contract.json', 'peer-contract.json']);
  for (const file of files) {
    expect({ file, bytes: readFileSync(join(committed, file)) })
      .toEqual({ file, bytes: readFileSync(join(generated, file)) });
  }
}));
