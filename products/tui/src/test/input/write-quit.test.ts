import { afterEach, describe, expect, test } from 'bun:test';
import { execSync } from 'child_process';
import { rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { CommandContext } from '../../input/command-registry.ts';
import { buildWriteQuitCommitMessage, collectGitChanges, executeCommitAll } from '../../input/commands/quit-shared.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeCommandContext(overrides: Partial<CommandContext> = {}): Pick<CommandContext, 'print'> {
  return {
    print: () => {},
    ...overrides,
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('commit-all', () => {
  test('builds a readable commit subject from collected changes', () => {
    const changes = collectGitChanges({
      staged: ['src/main.ts', 'src/ui.ts'],
      modified: [],
      not_added: [],
      deleted: [],
      created: [],
      renamed: [],
    });

    expect(changes).toHaveLength(2);
    expect(buildWriteQuitCommitMessage(changes)).toBe('Update src files');
  });

  function repoWithThreeKinds(): string {
    const repoDir = makeProjectTempDir('goodvibes-commit-all');
    tempDirs.push(repoDir);
    const git = (command: string) => execSync(command, { cwd: repoDir, stdio: 'ignore' });
    git('git init');
    git('git config user.email "test@example.com"');
    git('git config user.name "Test User"');
    writeFileSync(join(repoDir, 'a.txt'), 'one\n', 'utf-8');
    writeFileSync(join(repoDir, 'b.txt'), 'one\n', 'utf-8');
    git('git add a.txt b.txt');
    git('git commit -m base');
    writeFileSync(join(repoDir, 'a.txt'), 'staged\n', 'utf-8');
    git('git add a.txt');
    writeFileSync(join(repoDir, 'b.txt'), 'unstaged\n', 'utf-8');
    writeFileSync(join(repoDir, 'new.txt'), 'untracked\n', 'utf-8');
    return repoDir;
  }

  test('bare /commit-all changes nothing', async () => {
    const repoDir = repoWithThreeKinds();
    const before = execSync('git status --porcelain', { cwd: repoDir }).toString('utf-8');
    await executeCommitAll(makeCommandContext(), [], { cwd: repoDir });
    expect(execSync('git status --porcelain', { cwd: repoDir }).toString('utf-8')).toBe(before);
    expect(execSync('git log -1 --pretty=%s', { cwd: repoDir }).toString('utf-8').trim()).toBe('base');
  });

  test('--yes commits a hand-staged set alone and leaves the rest as it was', async () => {
    const repoDir = repoWithThreeKinds();
    await executeCommitAll(makeCommandContext(), ['--yes'], { cwd: repoDir });
    expect(execSync('git show --name-only --pretty=format: HEAD', { cwd: repoDir }).toString('utf-8').trim()).toBe('a.txt');
    expect(execSync('git status --porcelain', { cwd: repoDir }).toString('utf-8').trim().split('\n').sort()).toEqual([' M b.txt', '?? new.txt']);
  });

  test('--yes from a model commits nothing', async () => {
    const repoDir = repoWithThreeKinds();
    await expect(executeCommitAll({ ...makeCommandContext(), invokedByModel: true }, ['--yes'], { cwd: repoDir })).rejects.toThrow();
    expect(execSync('git log -1 --pretty=%s', { cwd: repoDir }).toString('utf-8').trim()).toBe('base');
  });
});
