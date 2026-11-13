/**
 * Per-run temp directories for tests.
 *
 * `scripts/test.ts` creates one directory per run under os.tmpdir(), exports it
 * as TMPDIR and as GOODVIBES_TEST_TMP_ROOT, and removes it when the run ends,
 * so a run that fails or is interrupted leaves one directory behind at worst
 * (reclaimed by the one-hour sweep) instead of thousands of loose ones. Plain
 * `bun test` has no runner, so it falls back to its own directory under
 * os.tmpdir(); `bun test` never runs exit hooks, so that one is reclaimed by
 * the same sweep on a later run.
 */
import { existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEST_TMP_ROOT_ENV = 'GOODVIBES_TEST_TMP_ROOT';
/** Set by the runner when a test file has its own in-checkout temp directory. */
export const TEST_PROJECT_TMP_ENV = 'GOODVIBES_TEST_PROJECT_TMP';
export const RUN_TMP_PREFIX = 'goodvibes-testrun-';
export const PLAIN_TMP_PREFIX = 'goodvibes-plaintest-';
export const STALE_RUN_MS = 60 * 60 * 1000;

/**
 * Remove directories under `root` named `prefix*` that were last modified more
 * than `maxAgeMs` ago. Best effort; never touches other names, symlinks, or a
 * directory carrying `preserveMarker` or for which `preserve` returns true.
 */
export function sweepStaleTmpDirs(root: string, prefix: string, maxAgeMs: number = STALE_RUN_MS, options: {
  readonly preserveMarker?: string;
  readonly preserve?: (directory: string) => boolean;
} = {}): void {
  if (!prefix || /[\\/\0]/.test(prefix)) throw new Error('Invalid sweep prefix');
  let names: string[];
  try { names = readdirSync(root); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const path = join(root, name);
    try {
      const entry = lstatSync(path);
      if (!entry.isDirectory() || Date.now() - entry.mtimeMs <= maxAgeMs) continue;
      if (options.preserveMarker !== undefined && existsSync(join(path, options.preserveMarker))) continue;
      if (options.preserve?.(path)) continue;
      rmSync(path, { recursive: true, force: true });
    } catch { /* vanished, or an inspector failed: keep it */ }
  }
}

let fallbackRoot: string | undefined;

/** The directory this process's temp dirs go under: the runner's, else its own. */
export function testTempRoot(): string {
  const supplied = process.env[TEST_TMP_ROOT_ENV];
  if (supplied) return supplied;
  if (!fallbackRoot) {
    sweepStaleTmpDirs(tmpdir(), PLAIN_TMP_PREFIX);
    fallbackRoot = realpathSync(mkdtempSync(join(tmpdir(), PLAIN_TMP_PREFIX)));
  }
  return fallbackRoot;
}

/** A fresh directory `<prefix>-XXXXXX` under the run's temp root. */
export function makeTestTempDir(prefix: string): string {
  if (!prefix || prefix === '.' || prefix === '..' || /[\\/\0]/.test(prefix)) throw new Error('Test temp prefix must be a single nonempty path component');
  return mkdtempSync(join(testTempRoot(), `${prefix}-`));
}
