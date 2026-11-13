import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { sweepStaleTmpDirs, testTempRoot } from '@goodvibes-jev/engine/toolchain/test-runner';

/**
 * These directories live inside the checkout (`<product>/.test-tmp/run-…`), not
 * in the system temp dir: project-scoped tools under test only accept paths
 * inside the working directory. One directory per run, named after the run's
 * temp root; older runs' directories are removed when a new run starts.
 */
let projectRunRoot: string | undefined;
function projectRoot(): string {
  if (!projectRunRoot) {
    const parent = join(process.cwd(), '.test-tmp');
    mkdirSync(parent, { recursive: true });
    sweepStaleTmpDirs(parent, 'run-');
    projectRunRoot = join(parent, `run-${basename(testTempRoot())}`);
    mkdirSync(projectRunRoot, { recursive: true });
    // A scratch git repository made in here must not discover the real one.
    const ceilings = new Set((process.env.GIT_CEILING_DIRECTORIES ?? '').split(delimiter).filter(Boolean));
    ceilings.add(parent);
    process.env.GIT_CEILING_DIRECTORIES = [...ceilings].join(delimiter);
  }
  return projectRunRoot;
}
const makeInCheckoutTempDir = (prefix: string): string => mkdtempSync(join(projectRoot(), `${prefix}-`));

export const projectTestTmpRoot = projectRoot;

interface CreatedProjectDir {
  readonly path: string;
  drain?: () => void | Promise<void>;
  closing?: Promise<void>;
}
const created: CreatedProjectDir[] = [];

/**
 * A temp directory removed after the CURRENTLY RUNNING test by the global
 * `afterEach` in preload.ts (sweepCreatedProjectTempDirs). Do not use it for a
 * directory reused across tests or files; use makeLongLivedProjectTempDir.
 */
export function makeProjectTempDir(prefix: string): string {
  const path = makeInCheckoutTempDir(prefix);
  created.push({ path });
  return path;
}

/** A directory meant to outlive any single test; it is removed when a later run starts. */
export function makeLongLivedProjectTempDir(prefix: string): string {
  return makeInCheckoutTempDir(prefix);
}

function close(entry: CreatedProjectDir): Promise<void> {
  entry.closing ??= (async () => {
    // A failed drain keeps the directory: whatever still uses it is not done.
    await entry.drain?.();
    rmSync(entry.path, { recursive: true, force: true });
    const index = created.indexOf(entry);
    if (index !== -1) created.splice(index, 1);
  })();
  return entry.closing;
}

/**
 * Run `drain` (stop whatever still uses the directory) before the directory is
 * removed. Returns an explicit cleanup that the global sweep also joins.
 */
export function registerProjectTempDrain(path: string, drain: () => void | Promise<void>): () => Promise<void> {
  const entry = created.find(candidate => candidate.path === path);
  if (!entry || entry.drain || entry.closing) throw new Error('Agent fixture root is not available for drain registration');
  entry.drain = drain;
  return () => close(entry);
}

/** Remove every directory made by makeProjectTempDir since the last sweep. */
export async function sweepCreatedProjectTempDirs(): Promise<void> {
  const results = await Promise.allSettled([...created].map(close));
  const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, 'Agent fixture cleanup did not complete; the failed roots were preserved');
}
