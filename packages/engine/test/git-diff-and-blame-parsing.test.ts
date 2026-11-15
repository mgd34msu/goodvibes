/**
 * Real `git` output for the shapes a hand-rolled parser gets wrong: commits that
 * interleave in blame, and file headers that carry no ---/+++ lines.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitService } from '../platform/src/platform/git/service.ts';
import { parseUnifiedDiff } from '../platform/src/platform/git/structured-diff.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-git-parse-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  return dir;
}

function commitAs(dir: string, author: string, message: string): void {
  git(dir, '-c', `user.name=${author}`, 'commit', '-qam', message);
}

describe('GitService.blame', () => {
  test('a commit that reappears after another one keeps its own author', async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'f.txt'), 'one\ntwo\nthree\n');
    git(dir, 'add', '.');
    commitAs(dir, 'Alice', 'first');
    writeFileSync(join(dir, 'f.txt'), 'one\nTWO\nthree\n');
    commitAs(dir, 'Bob', 'second');

    const blame = await new GitService(dir).blame('f.txt');
    expect(blame.map((entry) => [entry.content, entry.author])).toEqual([['one', 'Alice'], ['TWO', 'Bob'], ['three', 'Alice']]);
  });
});

describe('parseUnifiedDiff headers without ---/+++ lines', () => {
  test('an empty added file is added, and an empty deleted file is deleted', async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'gone.txt'), '');
    git(dir, 'add', '.');
    commitAs(dir, 'Test', 'seed');
    unlinkSync(join(dir, 'gone.txt'));
    writeFileSync(join(dir, 'empty.txt'), '');
    git(dir, 'add', '-A');

    const files = parseUnifiedDiff(git(dir, 'diff', '--cached', '--no-renames')).files;
    const byPath = new Map(files.map((file) => [file.newPath ?? file.oldPath, file]));
    expect(byPath.get('empty.txt')).toMatchObject({ status: 'added', oldPath: null, newPath: 'empty.txt' });
    expect(byPath.get('gone.txt')).toMatchObject({ status: 'deleted', oldPath: 'gone.txt', newPath: null });
  });

  test('a rename of a path with spaces and a non-ASCII path report their real paths', async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, 'a b.txt'), 'some content that stays the same\n');
    writeFileSync(join(dir, 'é.txt'), 'other content that stays the same\n');
    git(dir, 'add', '.');
    commitAs(dir, 'Test', 'seed');
    renameSync(join(dir, 'a b.txt'), join(dir, 'c d.txt'));
    writeFileSync(join(dir, 'é.txt'), 'other content that stays the same\nplus one\n');
    git(dir, 'add', '-A');

    const files = parseUnifiedDiff(git(dir, 'diff', '--cached', '-M')).files;
    const renamed = files.find((file) => file.status === 'renamed');
    expect(renamed).toMatchObject({ oldPath: 'a b.txt', newPath: 'c d.txt' });
    const accented = files.find((file) => file.newPath === 'é.txt');
    expect(accented).toMatchObject({ status: 'modified', oldPath: 'é.txt' });
  });
});
