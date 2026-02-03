// ============================================================================
// RECOMMENDATION FEEDBACK - Accept/Reject UI for recommendations
// ============================================================================

import { memo, useCallback, useState } from 'react';
import clsx from 'clsx';

// ============================================================================
// TYPES
// ============================================================================

export interface RecommendationFeedbackProps {
  /** The recommendation ID (for tracking) */
  recommendationId: number;
  /** Callback when accepted */
  onAccept?: () => void;
  /** Callback when rejected */
  onReject?: () => void;
  /** Callback when ignored (optional) */
  onIgnore?: () => void;
  /** Current feedback state (if already given) */
  feedbackGiven?: 'accepted' | 'rejected' | 'ignored' | null;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Whether to show the ignore button */
  showIgnore?: boolean;
  /** Whether to show labels */
  showLabels?: boolean;
  /** Orientation of the buttons */
  orientation?: 'horizontal' | 'vertical';
}

// ============================================================================
// COMPONENT
// ============================================================================

export const RecommendationFeedback = memo(function RecommendationFeedback({
  recommendationId: _recommendationId,
  onAccept,
  onReject,
  onIgnore,
  feedbackGiven = null,
  size = 'md',
  showIgnore = false,
  showLabels = false,
  orientation = 'horizontal',
}: RecommendationFeedbackProps) {
  // Recommendation ID available for future tracking implementation
  void _recommendationId;
  const [isHovered, setIsHovered] = useState<'accept' | 'reject' | 'ignore' | null>(null);

  const handleAccept = useCallback(() => {
    if (!feedbackGiven) {
      onAccept?.();
    }
  }, [feedbackGiven, onAccept]);

  const handleReject = useCallback(() => {
    if (!feedbackGiven) {
      onReject?.();
    }
  }, [feedbackGiven, onReject]);

  const handleIgnore = useCallback(() => {
    if (!feedbackGiven) {
      onIgnore?.();
    }
  }, [feedbackGiven, onIgnore]);

  const sizeClasses = {
    sm: 'p-1',
    md: 'p-1.5',
    lg: 'p-2',
  };

  const iconSizes = {
    sm: 'w-3.5 h-3.5',
    md: 'w-4 h-4',
    lg: 'w-5 h-5',
  };

  const labelSizes = {
    sm: 'text-xs',
    md: 'text-sm',
    lg: 'text-base',
  };

  // Already gave feedback
  if (feedbackGiven) {
    return (
      <div className="flex items-center gap-1 text-xs text-gray-500">
        {feedbackGiven === 'accepted' && (
          <>
            <svg
              className="w-4 h-4 text-green-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
            <span className="text-green-400">Accepted</span>
          </>
        )}
        {feedbackGiven === 'rejected' && (
          <>
            <svg
              className="w-4 h-4 text-red-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
            <span className="text-red-400">Rejected</span>
          </>
        )}
        {feedbackGiven === 'ignored' && (
          <>
            <svg
              className="w-4 h-4 text-gray-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
              <path d="m2 2 20 20" />
            </svg>
            <span>Ignored</span>
          </>
        )}
      </div>
    );
  }

  return (
    <div
      className={clsx(
        'flex gap-1',
        orientation === 'vertical' && 'flex-col'
      )}
    >
      {/* Accept Button */}
      <button
        type="button"
        onClick={handleAccept}
        onMouseEnter={() => setIsHovered('accept')}
        onMouseLeave={() => setIsHovered(null)}
        className={clsx(
          'flex items-center gap-1 rounded transition-all duration-150',
          'focus:outline-none focus:ring-2 focus:ring-green-500/50',
          sizeClasses[size],
          isHovered === 'accept'
            ? 'bg-green-500/30 text-green-300'
            : 'bg-surface-700 text-gray-400 hover:bg-green-500/20 hover:text-green-400'
        )}
        title="Accept recommendation"
      >
        <svg
          className={iconSizes[size]}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
        {showLabels && (
          <span className={labelSizes[size]}>Accept</span>
        )}
      </button>

      {/* Reject Button */}
      <button
        type="button"
        onClick={handleReject}
        onMouseEnter={() => setIsHovered('reject')}
        onMouseLeave={() => setIsHovered(null)}
        className={clsx(
          'flex items-center gap-1 rounded transition-all duration-150',
          'focus:outline-none focus:ring-2 focus:ring-red-500/50',
          sizeClasses[size],
          isHovered === 'reject'
            ? 'bg-red-500/30 text-red-300'
            : 'bg-surface-700 text-gray-400 hover:bg-red-500/20 hover:text-red-400'
        )}
        title="Reject recommendation"
      >
        <svg
          className={iconSizes[size]}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
        {showLabels && (
          <span className={labelSizes[size]}>Reject</span>
        )}
      </button>

      {/* Ignore Button (optional) */}
      {showIgnore && (
        <button
          type="button"
          onClick={handleIgnore}
          onMouseEnter={() => setIsHovered('ignore')}
          onMouseLeave={() => setIsHovered(null)}
          className={clsx(
            'flex items-center gap-1 rounded transition-all duration-150',
            'focus:outline-none focus:ring-2 focus:ring-gray-500/50',
            sizeClasses[size],
            isHovered === 'ignore'
              ? 'bg-gray-500/30 text-gray-300'
              : 'bg-surface-700 text-gray-500 hover:bg-gray-500/20 hover:text-gray-400'
          )}
          title="Ignore recommendation"
        >
          <svg
            className={iconSizes[size]}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
            <circle cx="12" cy="12" r="3" />
            <path d="m2 2 20 20" />
          </svg>
          {showLabels && (
            <span className={labelSizes[size]}>Ignore</span>
          )}
        </button>
      )}
    </div>
  );
});

export default RecommendationFeedback;
