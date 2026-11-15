import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAndValidatePath } from '@goodvibes-jev/engine/platform/platform/utils';

describe('resolveAndValidatePath links and dotted names', () => {
  let base = '';
  let root = '';
  let outside = '';

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'gv-path-links-'));
    root = join(base, 'root');
    outside = join(base, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test('refuses a dangling link whose target would be created outside the root', () => {
    symlinkSync(join(outside, 'newfile'), join(root, 'link'));
    expect(() => resolveAndValidatePath('link', root)).toThrow(/outside the project root/);
  });

  test('refuses a path below a dangling directory link that points outside', () => {
    symlinkSync(join(outside, 'missing-dir'), join(root, 'dirlink'));
    expect(() => resolveAndValidatePath('dirlink/sub/file.txt', root)).toThrow(/outside the project root/);
  });

  test('accepts a dangling link whose target stays inside the root', () => {
    symlinkSync(join(root, 'later.txt'), join(root, 'inner'));
    expect(resolveAndValidatePath('inner', root)).toBe(join(root, 'inner'));
  });

  test('accepts an entry whose name starts with two dots', () => {
    mkdirSync(join(root, '..data'));
    expect(resolveAndValidatePath('..data/file.txt', root)).toBe(join(root, '..data', 'file.txt'));
  });
});
