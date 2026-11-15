/**
 * checkpoint-cross-process-lock.test.ts, the named-path lock every store shares
 * with other processes.
 *
 * The lock is held by the kernel for the holder's process: a holder killed
 * mid-hold leaves nothing that blocks the next one, whatever pid it had. Two
 * real processes creating checkpoints in one directory lose nothing.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireCrossProcessLock,
  CrossProcessLockBusyError,
  tryAcquireCrossProcessLock,
} from '../platform/src/platform/workspace/checkpoint/cross-process-lock.js';
import { WorkspaceCheckpointManager } from '../platform/src/platform/workspace/checkpoint/manager.js';

const createdDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

/** Wait for a subprocess's marker file; fails only when it never appears. */
async function waitForFile(path: string, what: string, budgetMs = 60_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`waited ${budgetMs}ms for ${what}, marker "${path}" never appeared`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function runGit(cwd: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(['git', ...args], { cwd });
  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString('utf8'),
    stderr: Buffer.from(result.stderr).toString('utf8'),
  };
}

function checkpointRefNames(root: string): string[] {
  const gitDir = join(root, '.goodvibes', 'checkpoints', 'git');
  const result = runGit(root, ['--git-dir', gitDir, 'for-each-ref', '--format=%(refname)', 'refs/goodvibes/checkpoints']);
  return result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

function countCheckpointRefs(root: string): number {
  return checkpointRefNames(root).length;
}

/** Every checkpoint ref in git has a manifest entry and the reverse: nothing is invisible or dangling. */
async function expectManifestMatchesRefs(root: string): Promise<void> {
  const fresh = new WorkspaceCheckpointManager({ workspaceRoot: root, autoRetention: false });
  const ids = (await fresh.list()).map((checkpoint) => checkpoint.id);
  const refs = checkpointRefNames(root);
  expect(ids).toHaveLength(refs.length);
  for (const id of ids) expect(refs.some((ref) => ref.endsWith(`/${id}`))).toBe(true);
}

describe('cross-process lock: a holder that dies releases it', () => {
  test('a SIGKILLed holder leaves its record file but not the lock; the next holder takes it at once', async () => {
    const dir = tempDir('gv-lock-killed-');
    const lockPath = join(dir, 'store.lock');
    const marker = join(dir, 'held');
    const modulePath = join(import.meta.dir, '..', 'platform/src/platform/workspace/checkpoint/cross-process-lock.ts').replace(/\\/g, '/');
    const script = join(dir, 'hold.ts');
    writeFileSync(script, [
      `import { acquireCrossProcessLock } from ${JSON.stringify(modulePath)};`,
      `import { writeFileSync } from 'node:fs';`,
      `await acquireCrossProcessLock(process.argv[2]!);`,
      `writeFileSync(process.argv[3]!, String(process.pid));`,
      `setInterval(() => {}, 1_000);`,
    ].join('\n'));
    const child = Bun.spawn(['bun', script, lockPath, marker], { cwd: join(import.meta.dir, '..'), stdout: 'ignore', stderr: 'ignore' });
    await waitForFile(marker, 'the holder to take the lock');
    expect(tryAcquireCrossProcessLock(lockPath)).toBeNull();
    child.kill('SIGKILL');
    await child.exited;
    // The record names the dead holder; nothing has to remove it.
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(child.pid);
    const release = await acquireCrossProcessLock(lockPath, { totalTimeoutMs: 0 });
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(process.pid);
    release();
    expect(existsSync(lockPath)).toBe(false);
  }, 30_000);

  test('a wait that runs out names the holder', async () => {
    const lockPath = join(tempDir('gv-lock-busy-'), 'store.lock');
    const release = await acquireCrossProcessLock(lockPath);
    try {
      const error = await acquireCrossProcessLock(lockPath, { totalTimeoutMs: 0 }).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(CrossProcessLockBusyError);
      expect((error as CrossProcessLockBusyError).holderPid).toBe(process.pid);
    } finally {
      release();
    }
  });
});

describe('WorkspaceCheckpointManager: real subprocess separation', () => {
  test('two genuinely separate OS processes creating checkpoints in the same directory both succeed cleanly', async () => {
    const root = tempDir('gv-lock-subprocess-');
    mkdirSync(root, { recursive: true });
    const scriptPath = join(root, 'create-checkpoint.ts');
    const managerModulePath = join(
      import.meta.dir,
      '..',
      'platform/src/platform/workspace/checkpoint/manager.ts',
    ).replace(/\\/g, '/');
    // Each subprocess reports how many of ITS OWN create() calls returned a
    // real (non-null) checkpoint, in a per-process count file. Two processes
    // sharing one workspace can legitimately dedupe each other's work: `git
    // add -A` stages the WHOLE tree, so if process A's checkpoint already
    // captured a file process B just wrote (a real cross-process race, not a
    // bug), process B's next create() correctly sees "nothing changed" and
    // returns null, the exact same no-op-tree behavior a single process
    // gets from its own back-to-back creates. The invariant this test proves
    // is not "each process always gets exactly N checkpoints" (timing-
    // dependent) but "every create() that DID report success corresponds to
    // exactly one real, uncorrupted git ref, nothing is silently lost".
    writeFileSync(
      scriptPath,
      [
        `import { WorkspaceCheckpointManager } from ${JSON.stringify(managerModulePath)};`,
        `import { writeFileSync } from 'node:fs';`,
        `import { join } from 'node:path';`,
        `const root = process.argv[2]!;`,
        `const tag = process.argv[3]!;`,
        `const manager = new WorkspaceCheckpointManager({ workspaceRoot: root, autoRetention: false });`,
        `let successCount = 0;`,
        `for (let i = 0; i < 3; i++) {`,
        `  writeFileSync(join(root, \`\${tag}-\${i}.txt\`), \`\${tag} \${i}\\n\`);`,
        `  const cp = await manager.create({ kind: 'manual', label: \`\${tag}-\${i}\` });`,
        `  if (cp) successCount++;`,
        `}`,
        `writeFileSync(join(root, \`\${tag}-count.txt\`), String(successCount));`,
      ].join('\n'),
      'utf-8',
    );

    const spawnOne = (tag: string) =>
      Bun.spawn(['bun', scriptPath, root, tag], {
        cwd: join(import.meta.dir, '..'),
        stdout: 'pipe',
        stderr: 'pipe',
      }).exited;

    const [exitA, exitB] = await Promise.all([spawnOne('proc-a'), spawnOne('proc-b')]);
    expect(exitA).toBe(0);
    expect(exitB).toBe(0);

    const gitDir = join(root, '.goodvibes', 'checkpoints', 'git');
    const fsck = runGit(root, ['--git-dir', gitDir, 'fsck', '--no-dangling']);
    expect(fsck.exitCode).toBe(0);

    const countA = Number(readFileSync(join(root, 'proc-a-count.txt'), 'utf-8'));
    const countB = Number(readFileSync(join(root, 'proc-b-count.txt'), 'utf-8'));
    expect(countA + countB).toBeGreaterThan(0);
    // Ground truth at the git level (see countCheckpointRefs): every
    // reported success from either process corresponds to exactly one real,
    // uncorrupted git ref, nothing silently lost, nothing torn.
    expect(countCheckpointRefs(root)).toBe(countA + countB);
    await expectManifestMatchesRefs(root);
  }, 20_000);
});
