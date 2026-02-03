// ============================================================================
// CI STATUS PANEL COMPONENT
// ============================================================================

import type { GitHubCheckRun, GitHubCombinedStatus } from '../../../../shared/types/github';
import CIStatusBadge from '../CIStatusBadge';
import { SpinnerIcon } from './icons';

interface CIStatusPanelProps {
  checks: GitHubCheckRun[];
  combined: GitHubCombinedStatus | null;
  loading: boolean;
  onRefresh: () => void;
}

export function CIStatusPanel({ checks, loading, onRefresh }: CIStatusPanelProps): React.JSX.Element {
  if (loading) {
    return (
      <div className="p-4">
        <div className="flex items-center gap-2 text-surface-400">
          <SpinnerIcon className="w-4 h-4 animate-spin" />
          <span className="text-sm">Loading CI status...</span>
        </div>
      </div>
    );
  }

  if (checks.length === 0) {
    return (
      <div className="p-4">
        <p className="text-sm text-surface-500">No CI checks found for this branch.</p>
        <button
          onClick={onRefresh}
          className="mt-2 text-xs text-primary-400 hover:text-primary-300"
        >
          Refresh
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2 px-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-surface-300">
          Checks ({checks.length})
        </h3>
        <button
          onClick={onRefresh}
          className="text-xs text-primary-400 hover:text-primary-300"
        >
          Refresh
        </button>
      </div>

      <div className="space-y-1">
        {checks.map((check) => (
          <button
            key={check.id}
            onClick={() => check.html_url && window.open(check.html_url, '_blank', 'noopener,noreferrer')}
            className="w-full p-2 rounded text-left hover:bg-surface-700/50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <CIStatusBadge
                status={check.status}
                conclusion={check.conclusion}
                showLabel={false}
              />
              <span className="text-sm text-surface-200 truncate">{check.name}</span>
              {check.app && (
                <span className="text-xs text-surface-500 ml-auto">{check.app.name}</span>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
