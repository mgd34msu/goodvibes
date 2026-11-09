import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { DurableContractExecution } from './durable-admission.js';

const OUTPUT_LIMIT = 64 * 1024;

/** Read metadata without blocking the host. Abort stops the child, but the
 * returned promise settles only after its stdio and process have closed. */
async function git(root: string, args: readonly string[], signal: AbortSignal): Promise<{ status: number | null; text: string }> {
  signal.throwIfAborted();
  const child = spawn('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let failed = false;
  const stop = (): void => { child.kill('SIGKILL'); };
  const status = await new Promise<number | null>((resolve) => {
    child.once('error', () => { failed = true; });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) { failed = true; stop(); return; }
      chunks.push(Buffer.from(chunk));
    });
    // Git errors can contain private paths and config. Retain no diagnostic body.
    child.stderr.resume();
    child.once('close', (code) => { signal.removeEventListener('abort', stop); resolve(code); });
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  });
  signal.throwIfAborted();
  if (failed || status === null) throw new Error('Contract repository metadata could not be read.');
  return { status, text: Buffer.concat(chunks).toString('utf8').trim() };
}

/** Resolve placement before the durable receipt/owner is published. This is a
 * metadata read, not captured-input admission: the normal source snapshot and
 * live launch boundary still run before any planner or executor. */
export async function resolveContractGitPlacement(
  setting: 'auto' | 'worktree' | 'shared',
  projectRoot: string,
  contractId: string,
  signal: AbortSignal,
): Promise<DurableContractExecution> {
  const isolation = await resolveContractIsolation(setting, projectRoot, signal);
  if (isolation === 'shared') return { isolation };
  const baseBranch = await resolveContractBase(projectRoot, signal);
  const short = contractId.slice('ctr-'.length);
  return { isolation: 'worktree', branch: `contract/${short}`,
    worktreePath: join(projectRoot, '.goodvibes', '.worktrees', 'contract', short), baseBranch };
}

export async function resolveContractIsolation(setting: 'auto' | 'worktree' | 'shared', projectRoot: string,
  signal: AbortSignal): Promise<'worktree' | 'shared'> {
  signal.throwIfAborted();
  if (setting !== 'auto' && setting !== 'worktree' && setting !== 'shared') throw new Error('Invalid contract isolation');
  if (setting !== 'auto') return setting;
  const verified = await git(projectRoot, ['rev-parse', '--verify', '--quiet', 'HEAD'], signal);
  if (verified.status !== 0) return 'shared';
  if (verified.text.length === 0) throw new Error('Contract repository HEAD is unavailable.');
  return 'worktree';
}

export async function resolveContractBase(projectRoot: string, signal: AbortSignal): Promise<string> {
  const branch = await git(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], signal);
  let baseBranch = branch.status === 0 && branch.text !== 'HEAD' ? branch.text : '';
  if (baseBranch.length === 0) {
    // Re-read detached HEAD here: the earlier auto probe only decided whether
    // a repository existed; it cannot pin a later checkout's base commit.
    const commit = await git(projectRoot, ['rev-parse', '--verify', '--quiet', 'HEAD'], signal);
    if (commit.status !== 0 || commit.text.length === 0) throw new Error('Contract repository HEAD is unavailable.');
    baseBranch = commit.text;
  }
  return baseBranch;
}
