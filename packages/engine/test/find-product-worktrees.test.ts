import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeFilesQuery } from '../platform/src/platform/tools/find/files.ts';
import { isInsideProductWorktrees } from '../platform/src/platform/utils/walk-dir.ts';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(fakePort(() => noulAnswer(0.001)).port); });
afterEach(() => { installJudgmentPort(previous); });

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-find-worktrees-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, '.goodvibes', '.worktrees', 'agent-1', 'src'), { recursive: true });
  mkdirSync(join(root, '.goodvibes', '.worktrees', 'agent-2'), { recursive: true });
  mkdirSync(join(root, 'tools', '.worktrees'), { recursive: true });
  writeFileSync(join(root, 'src', 'live.ts'), 'export const live = 1;');
  writeFileSync(join(root, '.goodvibes', '.worktrees', 'agent-1', 'src', 'copy.ts'), 'export const copy = 1;');
  writeFileSync(join(root, 'tools', '.worktrees', 'unrelated.ts'), 'export const unrelated = 1;');
  return root;
}

describe('find skips the product worktree directory by path', () => {
  test('a hidden-inclusive listing leaves out .goodvibes/.worktrees, says so, and still lists a same-named directory elsewhere', async () => {
    const root = project();
    try {
      const result = await executeFilesQuery({ id: 'f', mode: 'files', patterns: ['**/*.ts'], include_hidden: true }, { format: 'files_only' }, root);
      expect([...(result.files as string[])].sort()).toEqual(['src/live.ts', 'tools/.worktrees/unrelated.ts']);
      expect(result.warnings).toEqual([
        "Skipped .goodvibes/.worktrees (product worktrees, 2 entries not searched); pass path: '.goodvibes/.worktrees' to include it.",
      ]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a walk rooted inside the worktree directory, or one that opts in, searches it', async () => {
    const root = project();
    try {
      const inside = await executeFilesQuery({ id: 'f', mode: 'files', patterns: ['**/*.ts'], path: '.goodvibes/.worktrees' }, { format: 'files_only' }, root);
      expect(inside.files).toEqual(['.goodvibes/.worktrees/agent-1/src/copy.ts']);
      expect(inside.warnings).toBeUndefined();
      const optedIn = await executeFilesQuery({ id: 'f', mode: 'files', patterns: ['**/*.ts'], include_hidden: true }, { format: 'files_only' }, root,
        undefined, undefined, { includeProductWorktrees: true });
      expect(optedIn.files as string[]).toContain('.goodvibes/.worktrees/agent-1/src/copy.ts');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('inside-ness is decided by the two path segments, not by a bare name', () => {
    expect(isInsideProductWorktrees('/p/.goodvibes/.worktrees/agent-1')).toBe(true);
    expect(isInsideProductWorktrees('/p/.goodvibes/.worktrees')).toBe(true);
    expect(isInsideProductWorktrees('/p/tools/.worktrees')).toBe(false);
    expect(isInsideProductWorktrees('/p/.goodvibes')).toBe(false);
  });
});
