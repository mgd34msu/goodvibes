/** A home directory reached through a symlinked ancestor still contributes its global skills to a captured registry. */
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureContractInput, contractInputPath, materializeContractInput } from '../platform/src/platform/contract/input-snapshot.js';
import { createContractInputAuthority, revokeContractInputAuthority } from '../platform/src/platform/contract/input-authority.js';
import type { Contract } from '../platform/src/platform/contract/types.js';
import { admitCapturedRegistryContext } from '../platform/src/platform/tools/registry-tool/captured-source.js';
import { createRegistryTool } from '../platform/src/platform/tools/registry-tool/index.js';
import { ToolRegistry } from '../platform/src/platform/tools/registry.js';
import { makeRepo } from './contract/runner-support.js';

const cleanup: string[] = [];
const authorities: Array<Parameters<typeof revokeContractInputAuthority>[0]> = [];
afterEach(() => {
  for (const authority of authorities.splice(0)) revokeContractInputAuthority(authority);
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

test('global skills under a home reached through a symlink are listed, not silently withheld', async () => {
  const root = makeRepo(); cleanup.push(root);
  const base = mkdtempSync(join(tmpdir(), 'registry-symlinked-')); cleanup.push(base);
  const realHome = join(base, 'real-home');
  mkdirSync(join(realHome, '.goodvibes', 'skills'), { recursive: true });
  writeFileSync(join(realHome, '.goodvibes', 'skills', 'global.md'), '---\nname: global-skill\n---\nGLOBAL_SKILL_BODY');
  const linkedHome = join(base, 'linked-home');
  symlinkSync(realHome, linkedHome);
  expect(realpathSync(linkedHome)).not.toBe(linkedHome);

  const snapshot = await captureContractInput(root);
  const view = contractInputPath(snapshot);
  expect(spawnSync('git', ['-C', root, 'worktree', 'add', '--no-checkout', '--detach', view, snapshot.inputCommit]).status).toBe(0);
  await materializeContractInput(snapshot, view);
  const stop = new AbortController();
  const authority = await createContractInputAuthority({ inputSnapshot: snapshot, projectRoot: root } as Contract, view, { signal: stop.signal });
  authorities.push(authority);
  const context = await admitCapturedRegistryContext({ authority, root: view, signal: stop.signal, readAccessFilter: async () => true }, { homeDirectory: linkedHome });
  const tool = createRegistryTool(new ToolRegistry(), { workingDirectory: root, capturedInput: context });
  const result = await tool.execute({ mode: 'search', type: 'skills' });
  expect(result.success).toBe(true);
  expect(result.output).toContain('global-skill');
});
