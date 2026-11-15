// The Node/npm runtime admission is shared by every command of one owner, so one
// caller cancelling its own wait must not fail the admission for the next caller.
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureContractInput, materializeContractInput, contractInputPath } from '../platform/src/platform/contract/input-snapshot.ts';
import { createContractInputAuthority, revokeContractInputAuthority } from '../platform/src/platform/contract/input-authority.ts';
import type { Contract } from '../platform/src/platform/contract/types.ts';
import type { CapturedExecAuthority } from '../platform/src/platform/tools/exec/captured-exec.ts';
import { createCapturedExecNodeRuntimeAdmission } from '../platform/src/platform/tools/exec/captured-exec-runtime-input.ts';
import { useToolReadings } from './_helpers/tool-readings.ts';

useToolReadings();

const roots: string[] = [];
const authorities = new Set<Parameters<typeof revokeContractInputAuthority>[0]>();
afterEach(() => {
  try { for (const authority of authorities) revokeContractInputAuthority(authority); }
  finally { authorities.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); }
});

function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
}

async function fixture(): Promise<CapturedExecAuthority & { owner: string }> {
  const owner = mkdtempSync(join(tmpdir(), 'captured-admission-cancel-')); roots.push(owner);
  git(owner, 'init', '-q'); git(owner, 'config', 'user.name', 'Fixture'); git(owner, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(owner, 'input.txt'), 'captured-fixture\n');
  git(owner, 'add', '.'); git(owner, 'commit', '-qm', 'fixture');
  const inputSnapshot = await captureContractInput(owner);
  const root = contractInputPath(inputSnapshot);
  git(owner, 'worktree', 'add', '--no-checkout', '-b', `input/${inputSnapshot.id}`, root, inputSnapshot.inputCommit);
  await materializeContractInput(inputSnapshot, root);
  const contract = { projectRoot: owner, inputSnapshot } as Contract;
  const authority = await createContractInputAuthority(contract, root, { mutable: true, branch: `input/${inputSnapshot.id}` });
  authorities.add(authority);
  return { authority, root, owner, readAccessFilter: async () => true };
}

function syntheticRuntime(owner: string) {
  const runtime = join(owner, 'synthetic-runtime');
  const npm = join(runtime, 'lib/node_modules/npm');
  mkdirSync(join(runtime, 'bin'), { recursive: true });
  for (const part of ['bin', 'lib', 'node_modules']) mkdirSync(join(npm, part), { recursive: true });
  writeFileSync(join(runtime, 'bin/node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(npm, 'package.json'), '{"name":"npm"}');
  for (const part of ['index.js', 'bin/npm-cli.js', 'bin/npx-cli.js']) writeFileSync(join(npm, part), '');
  return { nodeExecutable: join(runtime, 'bin/node'), npmExecutable: join(npm, 'bin/npm-cli.js'), npxExecutable: join(npm, 'bin/npx-cli.js') };
}

test('a caller that cancels its wait does not poison the admission for the next caller', async () => {
  const binding = await fixture();
  const admit = createCapturedExecNodeRuntimeAdmission(binding, syntheticRuntime(binding.owner));
  const cancelled = new AbortController();
  const first = admit(cancelled.signal);
  cancelled.abort();
  await expect(first).rejects.toBeDefined();
  const token = await admit(new AbortController().signal);
  expect(token).toBeDefined();
  expect(await admit()).toBe(token);
});
