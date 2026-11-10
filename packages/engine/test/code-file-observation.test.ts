/** Actual filesystem code-cache revisions, without a digest or stored file body. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { captureCodeFileObservation } from '../platform/src/platform/state/code-file-observation.js';
import { readFileObservation } from '../platform/src/platform/utils/file-observation.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = makeProjectTempDir('code-file-original-'); roots.push(root);
  const directory = join(root, 'source'); fs.mkdirSync(directory);
  const path = join(directory, 'owned.ts'), content = '\ufeffexport const originalUnicode = "😀 complete original";\n';
  fs.writeFileSync(path, content);
  return { root, directory, path, content };
}

test('the source text, nanosecond revision and timestamp come from the same original descriptor', () => {
  const f = fixture(), first = captureCodeFileObservation(f.root, f.path), native = readFileObservation(f.path);
  expect(first.content).toBe('export const originalUnicode = "😀 complete original";\n');
  expect(first.mtimeMs).toBe(native.mtimeMs);
  expect(JSON.parse(first.revision).at(-1)).toBe(native.physical);
  expect(first.revision).not.toContain('complete original');
  expect(captureCodeFileObservation(f.root, f.path).revision).toBe(first.revision);
  fs.writeFileSync(join(f.directory, 'unrelated.txt'), 'a sibling does not change owned code');
  first.assertCurrent();
  expect(captureCodeFileObservation(f.root, f.path).revision).toBe(first.revision);
});

for (const change of ['same-size', 'restored', 'replacement'] as const) test(`a ${change} file cannot inherit an old native revision`, () => {
  const f = fixture(), before = fs.statSync(f.path), original = captureCodeFileObservation(f.root, f.path);
  if (change === 'replacement') {
    const replacement = join(f.directory, 'replacement'); fs.writeFileSync(replacement, f.content); fs.renameSync(replacement, f.path);
  } else {
    fs.writeFileSync(f.path, f.content.replace('originalUnicode', 'modifiedUnicode'));
    if (change === 'restored') fs.writeFileSync(f.path, f.content);
    fs.utimesSync(f.path, before.atime, before.mtime);
  }
  expect(() => original.assertCurrent()).toThrow();
  const current = captureCodeFileObservation(f.root, f.path);
  expect(current.revision).not.toBe(original.revision);
  if (change !== 'same-size') expect(current.content).toBe(original.content);
});

test('an original supported root alias has the same physical revision but cannot follow a retargeted parent', () => {
  const f = fixture(), alias = join(f.root, 'alias'); fs.symlinkSync(f.directory, alias);
  const original = captureCodeFileObservation(alias, join(alias, 'owned.ts'));
  expect(original.revision).toBe(captureCodeFileObservation(f.directory, f.path).revision);
  const foreign = join(f.root, 'foreign'); fs.mkdirSync(foreign); fs.writeFileSync(join(foreign, 'owned.ts'), f.content);
  fs.unlinkSync(alias); fs.symlinkSync(foreign, alias);
  expect(() => original.assertCurrent()).toThrow();
});

test('replacement of an actual parent is detected even when the original leaf is moved into it', () => {
  const f = fixture(), original = captureCodeFileObservation(f.root, f.path);
  const retired = join(f.root, 'retired'); fs.renameSync(f.directory, retired); fs.mkdirSync(f.directory);
  fs.renameSync(join(retired, 'owned.ts'), f.path);
  expect(() => original.assertCurrent()).toThrow();
  expect(captureCodeFileObservation(f.root, f.path).revision).not.toBe(original.revision);
});

test('foreign roots, leaf aliases and shared hardlinks cannot supply an original code source', () => {
  const f = fixture(), outside = makeProjectTempDir('code-file-foreign-'); roots.push(outside);
  expect(() => captureCodeFileObservation(outside, f.path)).toThrow('outside its original root');
  const alias = join(f.directory, 'alias.ts'); fs.symlinkSync(f.path, alias);
  expect(() => captureCodeFileObservation(f.root, alias)).toThrow();
  fs.linkSync(f.path, join(f.directory, 'linked.ts'));
  expect(() => captureCodeFileObservation(f.root, f.path)).toThrow();
});

test('the real bounded reader refuses oversize before descriptor reads and still admits the exact boundary', () => {
  const f = fixture(), size = Buffer.byteLength(f.content), read = spyOn(fs, 'readSync');
  try {
    expect(() => captureCodeFileObservation(f.root, f.path, size - 1)).toThrow('read budget');
    expect(read).not.toHaveBeenCalled();
    expect(captureCodeFileObservation(f.root, f.path, size).content).toContain('😀 complete original');
    expect(read.mock.calls.length).toBeGreaterThan(0);
  } finally { read.mockRestore(); }
});

test('file growth during the original descriptor read is refused within the original size plus sentinel', () => {
  const f = fixture(), size = Buffer.byteLength(f.content), nativeRead = fs.readSync;
  let changed = false, requested = 0;
  const read = spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const count = Reflect.apply(nativeRead, fs, args);
    requested += count;
    if (!changed) { changed = true; fs.appendFileSync(f.path, 'more source than originally admitted'); }
    return count;
  }) as typeof fs.readSync);
  try {
    expect(() => captureCodeFileObservation(f.root, f.path, size)).toThrow('changed');
    expect(changed).toBe(true); expect(requested).toBeLessThanOrEqual(size + 1);
  } finally { read.mockRestore(); }
});
