/**
 * Run roots for the live smoke scripts (live-daemon-smoke*.ts,
 * connected-router-*.ts), which are not `bun test` runs: each gets
 * `<repo>/.test-tmp/run-<pid>` as TMPDIR, its parent removes it after the child
 * exits, and roots abandoned by a killed run are swept after an hour.
 * `bun test` itself gets its temp directory from packages/engine/scripts/test.ts.
 */
import { mkdirSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sweepStaleTmpDirs } from '@goodvibes-jev/engine/toolchain/test-runner';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function runRootFor(pid: number, repoRoot: string = REPO_ROOT): string {
  return join(repoRoot, '.test-tmp', `run-${String(pid)}`);
}

export function sweepStaleRunRoots(repoRoot: string = REPO_ROOT): void {
  sweepStaleTmpDirs(join(repoRoot, '.test-tmp'), 'run-');
}

/** Create this process's run root and point the temp environment variables at it. */
export function installTestTempRoot(repoRoot: string = REPO_ROOT, pid: number = process.pid): string {
  const root = runRootFor(pid, repoRoot);
  mkdirSync(root, { recursive: true });
  process.env.TMPDIR = root;
  process.env.TMP = root;
  process.env.TEMP = root;
  // Never let Git discovery from a nested non-Git fixture ascend into this checkout.
  process.env.GIT_CEILING_DIRECTORIES = [...new Set([
    realpathSync(root), ...(process.env.GIT_CEILING_DIRECTORIES?.split(delimiter) ?? []),
  ].filter(Boolean))].join(delimiter);
  return root;
}
