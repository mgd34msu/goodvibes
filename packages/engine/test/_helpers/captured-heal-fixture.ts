import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigManager } from '../../platform/src/platform/config/manager.js';
import { createContractInputAuthority } from '../../platform/src/platform/contract/input-authority.js';
import { captureContractInput, contractInputPath, materializeContractInput } from '../../platform/src/platform/contract/input-snapshot.js';
import type { Contract } from '../../platform/src/platform/contract/types.js';
import { FileStateCache } from '../../platform/src/platform/state/file-cache.js';
import type { FileUndoManager } from '../../platform/src/platform/state/file-undo.js';
import { createEditTool } from '../../platform/src/platform/tools/edit/index.js';
import { createCapturedAutoHealBackend, type CapturedAutoHealBackend } from '../../platform/src/platform/tools/shared/captured-auto-heal.js';
import { capturedInputTool } from '../../platform/src/platform/tools/shared/captured-input-tools.js';
import type { ValidatorRunner } from '../../platform/src/platform/tools/shared/validators.js';
import { createWriteTool } from '../../platform/src/platform/tools/write/index.js';

export function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
}

/** A committed repository with a captured, mutable input view and write/edit tools wired to a captured auto-heal backend. */
export async function capturedHealFixture(roots: string[], original: string, onRead?: (path: string, root: string) => void) {
  const owner = mkdtempSync(join(tmpdir(), 'captured-heal-fixture-')); roots.push(owner);
  git(owner, 'init', '-q'); git(owner, 'config', 'user.name', 'Fixture'); git(owner, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(owner, '.gitignore'), '.goodvibes/\n');
  writeFileSync(join(owner, 'repair.ts'), original);
  writeFileSync(join(owner, 'first.txt'), 'first original\n');
  writeFileSync(join(owner, 'second.txt'), 'second original\n');
  git(owner, 'add', '.'); git(owner, 'commit', '-qm', 'fixture');
  const inputSnapshot = await captureContractInput(owner); const root = contractInputPath(inputSnapshot);
  const branch = `input/${inputSnapshot.id}`;
  git(owner, 'worktree', 'add', '--no-checkout', '-b', branch, root, inputSnapshot.inputCommit);
  await materializeContractInput(inputSnapshot, root);
  const authority = await createContractInputAuthority({ projectRoot: owner, inputSnapshot } as Contract, root, { mutable: true, branch });
  const filter = async (path: string) => { onRead?.(path, root); return true; };
  const binding = { authority, root, readAccessFilter: filter };
  const backend = createCapturedAutoHealBackend(binding);
  const config = (enabled = true) => ({ get: (() => enabled) as ConfigManager['get'], getWorkingDirectory: () => root });
  const write = (chat: () => Promise<string>, capturedAutoHeal: CapturedAutoHealBackend = backend, fileUndoManager?: FileUndoManager) =>
    capturedInputTool(createWriteTool({ projectRoot: root, configManager: config(), toolLLM: { chat }, capturedAutoHeal, fileUndoManager }), authority, root, filter, undefined);
  const edit = (chat: () => Promise<string>, enabled = true, capturedAutoHeal: CapturedAutoHealBackend | undefined = backend) => {
    const validatorRunner: ValidatorRunner = async (name) => ({ validator: name, passed: false, exitCode: 1, stdout: '', stderr: 'Synthetic validation failure' });
    return capturedInputTool(createEditTool(new FileStateCache(), { cwd: root, configManager: config(enabled), toolLLM: { chat }, validatorRunner, capturedAutoHeal }), authority, root, filter, undefined);
  };
  return { owner, root, authority, binding, backend, config, write, edit };
}
