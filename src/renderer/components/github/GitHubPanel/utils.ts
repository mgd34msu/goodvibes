// ============================================================================
// GITHUB PANEL - UTILITY FUNCTIONS
// ============================================================================

import type { GitHubCheckRun } from '../../../../shared/types/github';
import type { CombinedCIState } from './types';

export function getCombinedState(checks: GitHubCheckRun[]): CombinedCIState {
  const hasInProgress = checks.some((c) => c.status === 'in_progress' || c.status === 'queued');
  const hasFailed = checks.some((c) => c.conclusion === 'failure');
  const allSuccess = checks.every(
    (c) => c.status === 'completed' && (c.conclusion === 'success' || c.conclusion === 'skipped' || c.conclusion === 'neutral')
  );

  if (hasFailed) return 'failure';
  if (hasInProgress) return 'pending';
  if (allSuccess) return 'success';
  return 'pending';
}
