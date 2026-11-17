// Proves: A checkpoint restore loses the work since, cannot be undone, or removes files that were never in a checkpoint.
// Red when: The restore stops taking its safety checkpoint before it rewrites the tree, or removes a file no checkpoint held (an ignored .env).
// Proves: A checkpoint stages or commits in the owner's own repository.
// Red when: The side repository's git calls lose their GIT_DIR and land in the owner's index, refs or HEAD.
// Proves: A client's hunk revert names a path outside the project and the daemon writes there.
// Red when: The hunk revert's path check stops refusing a path that, as written or through a link inside the project, leads out of the workspace root.

import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { WorkspaceCheckpointManager } from '../platform/src/platform/workspace/checkpoint/manager.ts';
import { applyHunkRevert, HunkRevertConflictError } from '../platform/src/platform/workspace/hunk-revert.ts';

const roots: string[] = [];
const managers: WorkspaceCheckpointManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) { await manager.drain(); manager.dispose(); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** The owner's repository, with `.env` ignored, and a checkpoint manager over it. */
function ownerRepository(): { repo: string; manager: WorkspaceCheckpointManager } {
  const repo = mkdtempSync(join(tmpdir(), 'gv-checkpoint-'));
  roots.push(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 'owner@example.invalid');
  git(repo, 'config', 'user.name', 'Owner');
  writeFileSync(join(repo, '.gitignore'), '.env\n');
  writeFileSync(join(repo, 'README.md'), 'project\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'start');
  const manager = new WorkspaceCheckpointManager({ workspaceRoot: repo, autoRetention: false });
  managers.push(manager);
  return { repo, manager };
}

test('a restore puts the checkpoint back exactly, leaves an ignored file, and can itself be undone', async () => {
  const { repo, manager } = ownerRepository();
  writeFileSync(join(repo, 'a.txt'), 'v1\n');
  const checkpoint = await manager.create({ kind: 'manual', label: 'A' });
  expect(checkpoint).not.toBeNull();

  writeFileSync(join(repo, 'a.txt'), 'v2\n');
  writeFileSync(join(repo, 'b.txt'), 'added after A\n');
  writeFileSync(join(repo, '.env'), 'API_TOKEN=never-checkpointed\n');

  const restored = await manager.restore(checkpoint!.id);
  expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('v1\n');
  expect(existsSync(join(repo, 'b.txt'))).toBe(false);
  expect(readFileSync(join(repo, '.env'), 'utf8')).toBe('API_TOKEN=never-checkpointed\n');
  expect(restored.safetyCheckpointId).not.toBeNull();

  await manager.restore(restored.safetyCheckpointId!);
  expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('v2\n');
  expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('added after A\n');
});

test('a checkpoint leaves the owner\'s index, refs and HEAD as they were', async () => {
  const { repo, manager } = ownerRepository();
  writeFileSync(join(repo, 'staged.txt'), 'staged by the owner\n');
  git(repo, 'add', 'staged.txt');
  writeFileSync(join(repo, 'README.md'), 'project, edited and not staged\n');
  const owner = () => ({
    status: git(repo, 'status', '--porcelain'),
    refs: git(repo, 'for-each-ref'),
    head: git(repo, 'rev-parse', 'HEAD'),
    staged: git(repo, 'diff', '--cached', '--name-only'),
  });
  const before = owner();
  // The side repository as every start after the first finds it: already initialised.
  const sideRepository = join(repo, '.goodvibes', 'checkpoints', 'git');
  mkdirSync(sideRepository, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo, env: { ...process.env, GIT_DIR: sideRepository } });

  const checkpoint = await manager.create({ kind: 'manual', label: 'turn' });
  expect(checkpoint).not.toBeNull();
  expect((await manager.list()).map((entry) => entry.id)).toContain(checkpoint!.id);
  expect(owner()).toEqual(before);
});

test('a hunk revert writes nothing outside the project, by .. or through a link; the same hunk inside is reverted', async () => {
  const { repo, manager } = ownerRepository();
  const elsewhere = mkdtempSync(join(tmpdir(), 'gv-hunk-outside-'));
  roots.push(elsewhere);
  const outside = join(elsewhere, 'outside.txt');
  writeFileSync(outside, 'keep\nadded\n');
  symlinkSync(outside, join(repo, 'link.txt'));
  writeFileSync(join(repo, 'inside.txt'), 'keep\nadded\n');
  const hunk = '@@ -1,1 +1,2 @@\n keep\n+added\n';
  for (const path of [relative(repo, outside), 'link.txt']) {
    const refused = await applyHunkRevert(manager, path, hunk).then(() => 'written', (error: unknown) => error instanceof HunkRevertConflictError ? 'refused' : String(error));
    expect(`${path}: ${refused}`).toBe(`${path}: refused`);
  }
  expect(readFileSync(outside, 'utf8')).toBe('keep\nadded\n');
  await applyHunkRevert(manager, 'inside.txt', hunk);
  expect(readFileSync(join(repo, 'inside.txt'), 'utf8')).toBe('keep\n');
});
