import { afterEach, beforeEach, describe, test, expect } from 'bun:test';
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAndValidatePath } from '@goodvibes-jev/engine/platform/platform/utils';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

// The root is a fresh temp directory, resolved through its real path because
// the code under test resolves against the real path of the root.
let base: string;
let PROJECT_ROOT: string;
let OUTSIDE: string;

beforeEach(() => {
  base = makeProjectTempDir('gv-path-safety');
  PROJECT_ROOT = join(realpathSync(base), 'root');
  OUTSIDE = join(realpathSync(base), 'outside');
  mkdirSync(PROJECT_ROOT);
  mkdirSync(OUTSIDE);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('resolveAndValidatePath', () => {
  test('resolves a relative path within project root', () => {
    const result = resolveAndValidatePath('src/main.ts', PROJECT_ROOT);
    expect(result).toBe(join(PROJECT_ROOT, 'src/main.ts'));
  });

  test('resolves a nested relative path', () => {
    const result = resolveAndValidatePath('src/tools/registry.ts', PROJECT_ROOT);
    expect(result).toBe(join(PROJECT_ROOT, 'src/tools/registry.ts'));
  });

  test('resolves current directory (.)', () => {
    const result = resolveAndValidatePath('.', PROJECT_ROOT);
    expect(result).toBe(PROJECT_ROOT);
  });

  test('resolves an absolute path inside the project root', () => {
    const absPath = join(PROJECT_ROOT, 'src', 'main.ts');
    const result = resolveAndValidatePath(absPath, PROJECT_ROOT);
    expect(result).toBe(absPath);
  });

  test('a first segment that merely starts with two dots stays inside the root', () => {
    expect(resolveAndValidatePath('..cache/x.txt', PROJECT_ROOT)).toBe(join(PROJECT_ROOT, '..cache', 'x.txt'));
    expect(resolveAndValidatePath('.hidden/x.txt', PROJECT_ROOT)).toBe(join(PROJECT_ROOT, '.hidden', 'x.txt'));
  });

  test('throws for path that escapes root via ..', () => {
    expect(() => resolveAndValidatePath('../outside/x', PROJECT_ROOT)).toThrow(
      /outside the project root/
    );
  });

  test('throws for absolute path outside project root', () => {
    expect(() => resolveAndValidatePath(join(OUTSIDE, 'x'), PROJECT_ROOT)).toThrow(
      /outside the project root/
    );
  });

  test('throws for a sibling directory that shares the root name as a prefix', () => {
    const evil = `${PROJECT_ROOT}-evil`;
    mkdirSync(evil);
    expect(() => resolveAndValidatePath(join(evil, 'x.txt'), PROJECT_ROOT)).toThrow(/outside the project root/);
  });

  test('throws for path with embedded ..', () => {
    // Resolved path still escapes, even if starts without ..
    expect(() => resolveAndValidatePath('src/../../outside/x', PROJECT_ROOT)).toThrow(
      /outside the project root/
    );
  });

  test('throws for symlinks that escape the project root', () => {
    const outsideFile = join(OUTSIDE, 'secret.txt');
    const linkPath = join(PROJECT_ROOT, 'link');
    writeFileSync(outsideFile, 'secret');
    symlinkSync(outsideFile, linkPath);

    expect(() => resolveAndValidatePath(linkPath, PROJECT_ROOT)).toThrow(/outside the project root/);
  });

  test('a symlinked parent directory pointing outside refuses a leaf that does not exist yet', () => {
    symlinkSync(OUTSIDE, join(PROJECT_ROOT, 'linked-dir'));
    expect(() => resolveAndValidatePath('linked-dir/new-file.txt', PROJECT_ROOT)).toThrow(/outside the project root/);
  });

  test('allowOutsideProject accepts paths outside the root and through an escaping link', () => {
    symlinkSync(OUTSIDE, join(PROJECT_ROOT, 'linked-dir'));
    expect(resolveAndValidatePath(join(OUTSIDE, 'x.txt'), PROJECT_ROOT, true)).toBe(join(OUTSIDE, 'x.txt'));
    expect(resolveAndValidatePath('../outside/x.txt', PROJECT_ROOT, true)).toBe(join(OUTSIDE, 'x.txt'));
    expect(resolveAndValidatePath('linked-dir/new-file.txt', PROJECT_ROOT, true)).toBe(join(PROJECT_ROOT, 'linked-dir', 'new-file.txt'));
  });

  test('a root given through a symlink resolves against its real path', () => {
    const viaLink = join(realpathSync(base), 'root-link');
    symlinkSync(PROJECT_ROOT, viaLink);
    expect(resolveAndValidatePath('src/main.ts', viaLink)).toBe(join(PROJECT_ROOT, 'src/main.ts'));
  });
});
