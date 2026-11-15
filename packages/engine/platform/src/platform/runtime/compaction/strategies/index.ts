/**
 * strategies/index.ts
 *
 * Barrel re-export for the boundary commit and quality score modules.
 */

export { createBoundaryCommit, validateBoundaryCommit } from './boundary-commit.js';
export type { BoundaryCommitOptions } from './boundary-commit.js';
export {
  computeQualityScore,
  describeScore,
  escalateStrategy,
  LOW_QUALITY_THRESHOLD,
} from '../quality-score.js';
export type {
  CompactionQualityScore,
  CompactionQualityGrade,
  SemanticRetentionSignals,
} from '../quality-score.js';
