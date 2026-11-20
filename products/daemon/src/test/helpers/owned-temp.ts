import { makeTestTempDir } from '@goodvibes/engine/toolchain/test-runner';

/** Test fixtures live under the run's temp directory, removed when the run ends. */
export const makeOwnedTempDir = makeTestTempDir;
