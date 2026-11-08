import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { observeProjectSource, sameProjectSource } from '../scripts/project-source-observation.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = makeProjectTempDir('calibration-source-observation'); roots.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Synthetic source fixture');
  git('config', 'user.email', 'source-fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', join(root, 'no-hooks'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, '.gitignore'), 'src/ignored/\n');
  writeFileSync(join(root, 'src', 'source.ts'), 'export const answer = 1;\n');
  git('add', '.'); git('commit', '-qm', 'Synthetic initial source');
  return { root, git, file: join(root, 'src', 'source.ts'), observe: () => observeProjectSource(root, ['src']) };
}

test('retains Git attribution and local file versions without source bytes or content digests', () => {
  const f = fixture(), before = f.observe(), after = f.observe();
  expect(sameProjectSource(before, after)).toBe(true);
  expect(before).toMatchObject({ version: 2, sha: f.git('rev-parse', 'HEAD'), trackedChanges: '' });
  expect(before.files).toHaveLength(1); expect(before.files[0]?.path).toBe('src/source.ts');
  expect(before.files[0]?.entry).toBeTypeOf('string');
  const serialized = JSON.stringify(before);
  expect(serialized).not.toContain(readFileSync(f.file, 'utf8'));
  expect(serialized).not.toContain('sha256'); expect(serialized).not.toContain('digest');
  expect(Object.isFrozen(before.files)).toBe(true); expect(Object.isFrozen(before.files[0])).toBe(true);
});

test('same-size edits and byte restoration with restored mtime still change the observed local version', () => {
  const f = fixture(), before = f.observe(), original = readFileSync(f.file), stat = statSync(f.file);
  writeFileSync(f.file, 'export const answer = 2;\n'); utimesSync(f.file, stat.atime, stat.mtime);
  const changed = f.observe(); expect(sameProjectSource(before, changed)).toBe(false);
  writeFileSync(f.file, original); utimesSync(f.file, stat.atime, stat.mtime);
  const restored = f.observe();
  expect(restored.trackedChanges).toBe('');
  expect(sameProjectSource(before, restored)).toBe(false);
});

test('replacing a source with identical bytes and permissions does not retain its incarnation', () => {
  const f = fixture(), before = f.observe(), next = join(f.root, 'replacement');
  writeFileSync(next, readFileSync(f.file)); renameSync(next, f.file);
  const after = f.observe(); expect(after.trackedChanges).toBe('');
  expect(sameProjectSource(before, after)).toBe(false);
});

test('tracks added, deleted and ignored source files without discarding absent tracked entries', () => {
  const f = fixture(), before = f.observe();
  mkdirSync(join(f.root, 'src', 'ignored'));
  writeFileSync(join(f.root, 'src', 'ignored', 'secret.ts'), 'synthetic-private-not-source');
  expect(sameProjectSource(before, f.observe())).toBe(true);
  writeFileSync(join(f.root, 'src', 'new.ts'), 'export {};\n');
  expect(sameProjectSource(before, f.observe())).toBe(false);
  unlinkSync(f.file);
  expect(f.observe().files.find(file => file.path === 'src/source.ts')?.entry).toBeNull();
});

test('follows an imported source symlink without serializing its target or contents', () => {
  const f = fixture(), target = join(f.root, 'private-target.ts');
  writeFileSync(target, 'synthetic-private-source-one');
  symlinkSync('../private-target.ts', join(f.root, 'src', 'link.ts'));
  const before = f.observe();
  expect(before.files.find(file => file.path === 'src/link.ts')?.target).toBeTypeOf('string');
  expect(JSON.stringify(before)).not.toContain('private-target');
  expect(JSON.stringify(before)).not.toContain('synthetic-private-source');
  writeFileSync(target, 'synthetic-private-source-two');
  expect(sameProjectSource(before, f.observe())).toBe(false);
  unlinkSync(target);
  expect(f.observe().files.find(file => file.path === 'src/link.ts')?.target).toBeNull();
});

test('refuses source directory symlinks instead of treating directory metadata as complete source evidence', () => {
  const f = fixture(); symlinkSync('../src', join(f.root, 'src', 'directory'));
  expect(() => f.observe()).toThrow('not a file');
});

test('mode changes and different commits are different source observations', () => {
  const f = fixture(), before = f.observe();
  chmodSync(f.file, 0o755); expect(sameProjectSource(before, f.observe())).toBe(false);
  f.git('add', 'src/source.ts'); f.git('commit', '-qm', 'Synthetic mode change');
  expect(sameProjectSource(before, f.observe())).toBe(false);
});

test('extra source paths cannot read outside the selected repository', () => {
  const f = fixture(); expect(() => observeProjectSource(f.root, ['src'], ['../outside.ts'])).toThrow('outside the repository');
});
