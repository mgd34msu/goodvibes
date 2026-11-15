/**
 * A captured command that cannot return its output says why, and says whether
 * its file changes already landed, so a rerun is never a guess.
 */
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useToolReadings } from './_helpers/tool-readings.js';
useToolReadings([['CAPTURE_PROMPT', { awaitingInput: true }]]);
import { captureContractInput, contractInputPath, materializeContractInput } from '../platform/src/platform/contract/input-snapshot.js';
import { createContractInputAuthority, revokeContractInputAuthority } from '../platform/src/platform/contract/input-authority.js';
import type { Contract } from '../platform/src/platform/contract/types.js';
import { probeCapturedExecAvailability, runCapturedCommand, type CapturedExecAuthority } from '../platform/src/platform/tools/exec/captured-exec.js';
import { detectPtyAvailability, probePtyHost } from '../platform/src/platform/tools/exec/interactive.js';
import { requireLiveHost } from './_helpers/exec-containment-proof.ts';

const supported = (await probeCapturedExecAvailability()).available;
const ptySupported = supported && detectPtyAvailability(probePtyHost()).available;
requireLiveHost('captured exec', supported);
requireLiveHost('PTY', ptySupported);
const roots: string[] = [];
const authorities = new Set<Parameters<typeof revokeContractInputAuthority>[0]>();
afterEach(() => {
  for (const authority of authorities) revokeContractInputAuthority(authority);
  authorities.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
}

async function fixture(): Promise<CapturedExecAuthority> {
  const owner = mkdtempSync(join(tmpdir(), 'captured-held-')); roots.push(owner);
  git(owner, 'init', '-q'); git(owner, 'config', 'user.name', 'Fixture'); git(owner, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(owner, 'input.txt'), 'original\n');
  git(owner, 'add', '.'); git(owner, 'commit', '-qm', 'fixture');
  const inputSnapshot = await captureContractInput(owner);
  const root = contractInputPath(inputSnapshot);
  git(owner, 'worktree', 'add', '--no-checkout', '-b', `input/${inputSnapshot.id}`, root, inputSnapshot.inputCommit);
  await materializeContractInput(inputSnapshot, root);
  const authority = await createContractInputAuthority({ projectRoot: owner, inputSnapshot } as Contract, root, { mutable: true, branch: `input/${inputSnapshot.id}` });
  authorities.add(authority);
  return { authority, root, readAccessFilter: async () => true };
}

test.skipIf(!supported)('a cancel after the changes were applied says they landed and still withholds output', async () => {
  const binding = await fixture();
  const controller = new AbortController();
  const result = await runCapturedCommand(binding, 'printf changed > input.txt; echo SECRET_OUTPUT', {}, binding.root, 5000, controller.signal,
    'disabled', {}, { beforePublish: () => queueMicrotask(() => controller.abort()) });
  expect(readFileSync(join(binding.root, 'input.txt'), 'utf8')).toBe('changed');
  expect(result.denied).toBe(true);
  expect(result.captured_changes_published).toBe(true);
  expect(result.stderr).toContain('changes are in the project');
  expect(result.stdout).toBe('');
});

test.skipIf(!supported)('a cancel before any change says cancelled, not an authority problem', async () => {
  const binding = await fixture();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const result = await runCapturedCommand(binding, 'sleep 2; printf late > input.txt', {}, binding.root, 5000, controller.signal);
  expect(result.cancelled).toBe(true);
  expect(result.captured_changes_published).toBeUndefined();
  expect(result.stderr).toContain('cancelled');
  expect(result.stderr).not.toContain('authority');
  expect(readFileSync(join(binding.root, 'input.txt'), 'utf8')).toBe('original\n');
});

test.skipIf(!supported)('a timeout names its limit and that nothing was applied', async () => {
  const binding = await fixture();
  const result = await runCapturedCommand(binding, 'sleep 2; printf late > input.txt', {}, binding.root, 300);
  expect(result.timed_out).toBe(true);
  expect(result.stderr).toContain('timed out after 300ms');
  expect(result.stderr).toContain('no file changes were applied');
});

test.skipIf(!ptySupported)('a timed-out prompt run still reports the prompt it was waiting on', async () => {
  const binding = await fixture();
  const result = await runCapturedCommand(binding, 'printf "CAPTURE_PROMPT: "; read answer', {}, binding.root, 1500, undefined, 'disabled', {}, {
    interaction: { availability: detectPtyAvailability(probePtyHost()), quietWindowMs: 30 },
  });
  expect(result.timed_out, JSON.stringify(result)).toBe(true);
  expect(result.pending_prompt, JSON.stringify(result)).toContain('CAPTURE_PROMPT');
});
