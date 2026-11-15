import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContractInputAuthority, revokeContractInputAuthority } from '../platform/src/platform/contract/input-authority.js';
import { captureContractInput, contractInputPath, materializeContractInput } from '../platform/src/platform/contract/input-snapshot.js';
import type { Contract } from '../platform/src/platform/contract/types.js';
import { FileStateCache } from '../platform/src/platform/state/file-cache.js';
import { createEditTool } from '../platform/src/platform/tools/edit/index.js';
import { capturedInputTool } from '../platform/src/platform/tools/shared/captured-input-tools.js';
import type { ValidatorRunner } from '../platform/src/platform/tools/shared/validators.js';

const roots: string[] = [];
const authorities: Parameters<typeof revokeContractInputAuthority>[0][] = [];
afterEach(() => {
  for (const authority of authorities.splice(0)) {
    try { revokeContractInputAuthority(authority); } catch { /* already revoked */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
}

async function fixture(validatorRunner: ValidatorRunner) {
  const owner = mkdtempSync(join(tmpdir(), 'captured-edit-change-record-')); roots.push(owner);
  git(owner, 'init', '-q'); git(owner, 'config', 'user.name', 'Fixture'); git(owner, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(owner, '.gitignore'), '.goodvibes/\n');
  writeFileSync(join(owner, 'a.txt'), 'original a\n');
  git(owner, 'add', '.'); git(owner, 'commit', '-qm', 'fixture');
  const inputSnapshot = await captureContractInput(owner); const root = contractInputPath(inputSnapshot);
  const branch = `input/${inputSnapshot.id}`;
  git(owner, 'worktree', 'add', '--no-checkout', '-b', branch, root, inputSnapshot.inputCommit);
  await materializeContractInput(inputSnapshot, root);
  const controller = new AbortController();
  const authority = await createContractInputAuthority({ projectRoot: owner, inputSnapshot } as Contract, root, { mutable: true, branch, signal: controller.signal });
  authorities.push(authority);
  const recorded: string[] = [];
  const tool = capturedInputTool(
    createEditTool(new FileStateCache(), { cwd: root, validatorRunner, changeTracker: { recordChange: (path: string) => { recorded.push(path); } } }),
    authority, root, async () => true, controller.signal,
  );
  return { root, tool, recorded };
}

const failing: ValidatorRunner = async (validator) => ({ validator, passed: false, exitCode: 1, stdout: '', stderr: 'Synthetic validation failure' });
const passing: ValidatorRunner = async (validator) => ({ validator, passed: true, exitCode: 0, stdout: '', stderr: '' });
const edit = { path: 'a.txt', find: 'original', replace: 'edited' };

test('a captured atomic edit rolled back by a failing validator leaves no change record', async () => {
  const f = await fixture(failing);
  const result = await f.tool.execute({ edits: [edit], validate: { after: ['build'] } });
  expect(result.success).toBe(false);
  expect(result.error).toContain('edits rolled back');
  expect(readFileSync(join(f.root, 'a.txt'), 'utf8')).toBe('original a\n');
  expect(f.recorded).toEqual([]);
});

test('a captured edit that stays applied is recorded once', async () => {
  const f = await fixture(passing);
  const result = await f.tool.execute({ edits: [edit], validate: { after: ['build'] } });
  expect(result.success).toBe(true);
  expect(readFileSync(join(f.root, 'a.txt'), 'utf8')).toBe('edited a\n');
  expect(f.recorded).toEqual([join(f.root, 'a.txt')]);
});

test('a captured non-atomic edit kept after a failing validator is recorded', async () => {
  const f = await fixture(failing);
  const result = await f.tool.execute({ edits: [edit], validate: { after: ['build'] }, transaction: { mode: 'partial' } });
  expect(result.success).toBe(false);
  expect(readFileSync(join(f.root, 'a.txt'), 'utf8')).toBe('edited a\n');
  expect(f.recorded).toEqual([join(f.root, 'a.txt')]);
});
