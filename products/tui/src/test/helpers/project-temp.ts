import { mkdirSync, mkdtempSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { sweepStaleTmpDirs, TEST_PROJECT_TMP_ENV, testTempRoot } from '@goodvibes-jev/engine/toolchain/test-runner';

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
    projectRunRoot = process.env[TEST_PROJECT_TMP_ENV] || join(parent, `run-${basename(testTempRoot())}`);
    mkdirSync(projectRunRoot, { recursive: true });
    // A scratch git repository made in here must not discover the real one.
    const ceilings = new Set((process.env.GIT_CEILING_DIRECTORIES ?? '').split(delimiter).filter(Boolean));
    ceilings.add(parent);
    process.env.GIT_CEILING_DIRECTORIES = [...ceilings].join(delimiter);
  }
  return projectRunRoot;
}
const makeInCheckoutTempDir = (prefix: string): string => mkdtempSync(join(projectRoot(), `${prefix}-`));

export const PROJECT_TEST_TMP_ROOT = projectRoot();
export const makeProjectTempDir = makeInCheckoutTempDir;
