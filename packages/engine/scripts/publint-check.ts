import { cleanupStage, run, sharedPackedReleaseStage, stagePackages } from './release-shared.ts';

// publint judges the package as published, so it runs over the release stage:
// the normalized manifests without the workspace source condition, beside the
// files npm would pack. The stage validate already made is read as is; alone,
// this stages its own (no packing needed).
const shared = sharedPackedReleaseStage();
const { tempRoot, publicStages } = shared ?? await stagePackages();
try {
  for (const stage of publicStages) {
    run('bunx', ['publint', stage.stageDir], process.cwd());
  }
} finally {
  if (!shared) cleanupStage(tempRoot);
}

console.log('publint check passed for all public packages');
