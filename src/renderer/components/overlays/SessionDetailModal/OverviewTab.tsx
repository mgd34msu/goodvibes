// ============================================================================
// OVERVIEW TAB COMPONENT
// ============================================================================

import type { Session } from '../../../../shared/types';
import { formatCost, formatNumber, formatDateTime, formatDuration } from '../../../../shared/utils';
import { StatCard, DetailRow, OutcomeBadge } from './HelperComponents';

interface OverviewTabProps {
  session: Session;
  duration: number | null;
  displayName: string;
}

export function OverviewTab({ session, duration, displayName }: OverviewTabProps): React.JSX.Element {
  return (
    <div className="space-y-6">
      {/* Summary */}
      {session.summary && (
        <div>
          <h3 className="text-sm font-medium text-surface-300 mb-2">Summary</h3>
          <p className="text-surface-200 bg-surface-800 rounded-lg p-4">
            {session.summary}
          </p>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Messages" value={session.messageCount.toString()} />
        <StatCard label="Total Tokens" value={formatNumber(session.tokenCount)} />
        <StatCard label="Cost" value={formatCost(session.cost)} highlight />
        <StatCard label="Duration" value={formatDuration(duration ?? 0)} />
      </div>

      {/* Details */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <DetailRow label="Project" value={displayName} />
        <DetailRow label="Status" value={session.status} />
        <DetailRow label="Started" value={formatDateTime(session.startTime)} />
        <DetailRow label="Ended" value={formatDateTime(session.endTime)} />
        {session.outcome && (
          <DetailRow label="Outcome" value={<OutcomeBadge outcome={session.outcome} />} />
        )}
        {session.rating && (
          <DetailRow label="Rating" value={'★'.repeat(session.rating)} />
        )}
      </div>

      {/* Notes */}
      {session.notes && (
        <div>
          <h3 className="text-sm font-medium text-surface-300 mb-2">Notes</h3>
          <p className="text-surface-300 bg-surface-800 rounded-lg p-4 whitespace-pre-wrap">
            {session.notes}
          </p>
        </div>
      )}

      {/* File Path */}
      {session.filePath && (
        <div>
          <h3 className="text-sm font-medium text-surface-300 mb-2">File Path</h3>
          <p className="text-surface-400 font-mono text-sm bg-surface-800 rounded-lg p-4 break-all">
            {session.filePath}
          </p>
        </div>
      )}
    </div>
  );
}
