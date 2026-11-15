/**
 * Coverage-gap smoke test, platform/git
 * Verifies that GitService executes observable behavior when called.
 * Closes coverage gap: platform/git
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitService, conflictPathsFromMergeOutput } from '../platform/src/platform/git/service.js';

// The repo is built here rather than read from the checkout the tests happen to run in,
// so the result does not depend on how the source was obtained.
let scratch = '';
let repo = '';
let plain = '';
let previousCeiling: string | undefined;

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'gv-git-smoke-')));
  repo = join(scratch, 'repo');
  plain = join(scratch, 'plain');
  mkdirSync(repo);
  mkdirSync(plain);
  const init = Bun.spawnSync(['git', '-C', repo, 'init', '-q']);
  if (init.exitCode !== 0) throw new Error('git init failed for the fixture repository');
  // Stops discovery at the scratch directory, so the plain directory is never
  // inside whatever repository holds the temp directory.
  previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = scratch;
});

afterAll(() => {
  if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
  rmSync(scratch, { recursive: true, force: true });
});

describe('platform/git: behavior smoke', () => {
  test('GitService.isGitRepo is true inside a repository and false outside one', () => {
    expect(GitService.isGitRepo(repo)).toBe(true);
    expect(GitService.isGitRepo(plain)).toBe(false);
  });

  test('new GitService(cwd).getCwd() returns the working directory', () => {
    const svc = new GitService(repo);
    expect(svc.getCwd()).toBe(repo);
  });

  test('GitService.getRepoRoot returns the repository top, and null outside one', () => {
    expect(GitService.getRepoRoot(repo)).toBe(repo);
    expect(GitService.getRepoRoot(plain)).toBeNull();
  });
});

// The conflicted-file list is structured data a resolution session seeds from,
// so every entry must be a BARE repo-relative path on every git version. The
// raw merge-failure message has two real shapes depending on the
// git/simple-git output pairing; both are pinned here as recorded fixtures so
// the parse never depends on the host's git version.
describe('platform/git: merge-conflict path extraction (both raw output shapes)', () => {
  test("git's own informational lines: `CONFLICT (content): Merge conflict in <path>`", () => {
    const raw = [
      'Auto-merging shared.txt',
      'CONFLICT (content): Merge conflict in shared.txt',
      'Automatic merge failed; fix conflicts and then commit the result.',
    ].join('\n');
    expect(conflictPathsFromMergeOutput(raw)).toEqual(['shared.txt']);
  });

  test("git library merge-summary rendering: `CONFLICTS: <path>:<reason>` loses the reason suffix", () => {
    // Recorded from a CI runner where the merge rejection stringifies the
    // parsed summary: each entry is the conflict's `file:reason` pair. The
    // reason suffix must never leak into the path list.
    expect(conflictPathsFromMergeOutput('CONFLICTS: shared.txt:content')).toEqual(['shared.txt']);
  });

  test('merge-summary rendering with several conflicts and compound reasons', () => {
    expect(conflictPathsFromMergeOutput('CONFLICTS: src/a.ts:content, docs/b.md:add/add, c.txt:modify/delete'))
      .toEqual(['src/a.ts', 'docs/b.md', 'c.txt']);
  });

  test('multiple informational CONFLICT lines each yield their bare path', () => {
    const raw = [
      'Auto-merging src/a.ts',
      'CONFLICT (content): Merge conflict in src/a.ts',
      'Auto-merging docs/b.md',
      'CONFLICT (content): Merge conflict in docs/b.md',
      'Automatic merge failed; fix conflicts and then commit the result.',
    ].join('\n');
    expect(conflictPathsFromMergeOutput(raw)).toEqual(['src/a.ts', 'docs/b.md']);
  });

  test('a message with no conflict lines yields an empty list', () => {
    expect(conflictPathsFromMergeOutput('fatal: not something we handle')).toEqual([]);
  });
});
