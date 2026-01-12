// ============================================================================
// RECOMMENDATION PANEL - Full recommendation panel with list and actions
// ============================================================================

import { memo, useState, useCallback, useEffect } from 'react';
import clsx from 'clsx';
import { RecommendationBadge } from './RecommendationBadge';
import { RecommendationFeedback } from './RecommendationFeedback';

// ============================================================================
// TYPES
// ============================================================================

export interface Recommendation {
  id: number;
  type: 'agent' | 'skill';
  itemId: number;
  slug: string;
  name: string;
  description: string | null;
  confidenceScore: number;
  source: 'prompt' | 'project' | 'context' | 'historical';
  matchedKeywords: string[];
  reasoning: string;
}

export interface RecommendationPanelProps {
  /** List of recommendations to display */
  recommendations: Recommendation[];
  /** Title for the panel */
  title?: string;
  /** Whether the panel is loading */
  isLoading?: boolean;
  /** Error message if any */
  error?: string | null;
  /** Callback when a recommendation is accepted */
  onAccept?: (recommendation: Recommendation) => void;
  /** Callback when a recommendation is rejected */
  onReject?: (recommendation: Recommendation) => void;
  /** Callback when a recommendation is clicked */
  onSelect?: (recommendation: Recommendation) => void;
  /** Whether to show in compact mode */
  compact?: boolean;
  /** Maximum number of recommendations to show initially */
  maxInitial?: number;
  /** Whether the panel is collapsible */
  collapsible?: boolean;
  /** Initial collapsed state */
  defaultCollapsed?: boolean;
}

// ============================================================================
// SUB-COMPONENTS
// ============================================================================

/**
 * Empty state component
 */
function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-gray-400">
      <svg
        className="w-12 h-12 mb-2 opacity-50"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
        <path d="M8 11h6" />
      </svg>
      <p className="text-sm">{message}</p>
    </div>
  );
}

/**
 * Loading state component
 */
function LoadingState() {
  return (
    <div className="flex items-center justify-center py-8">
      <div className="animate-spin rounded-full h-8 w-8 border-2 border-gray-600 border-t-primary-500" />
    </div>
  );
}

/**
 * Error state component
 */
function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-red-400">
      <svg
        className="w-12 h-12 mb-2 opacity-75"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="m15 9-6 6" />
        <path d="m9 9 6 6" />
      </svg>
      <p className="text-sm">{message}</p>
    </div>
  );
}

/**
 * Individual recommendation card
 */
const RecommendationCard = memo(function RecommendationCard({
  recommendation,
  onAccept,
  onReject,
  onSelect,
  compact = false,
}: {
  recommendation: Recommendation;
  onAccept?: (r: Recommendation) => void;
  onReject?: (r: Recommendation) => void;
  onSelect?: (r: Recommendation) => void;
  compact?: boolean;
}) {
  const [feedbackGiven, setFeedbackGiven] = useState<'accepted' | 'rejected' | null>(null);

  const handleAccept = useCallback(() => {
    setFeedbackGiven('accepted');
    onAccept?.(recommendation);
  }, [recommendation, onAccept]);

  const handleReject = useCallback(() => {
    setFeedbackGiven('rejected');
    onReject?.(recommendation);
  }, [recommendation, onReject]);

  const handleClick = useCallback(() => {
    onSelect?.(recommendation);
  }, [recommendation, onSelect]);

  if (compact) {
    return (
      <div
        className={clsx(
          'flex items-center gap-2 p-2 rounded-lg bg-surface-800/50 border border-surface-700',
          'hover:bg-surface-700/50 transition-colors',
          feedbackGiven === 'accepted' && 'border-green-500/30 bg-green-500/5',
          feedbackGiven === 'rejected' && 'opacity-50'
        )}
      >
        <RecommendationBadge
          type={recommendation.type}
          name={recommendation.name}
          confidenceScore={recommendation.confidenceScore}
          source={recommendation.source}
          size="sm"
          onClick={handleClick}
        />
        <div className="flex-1 min-w-0">
          <p className="text-xs text-gray-400 truncate">
            {recommendation.reasoning}
          </p>
        </div>
        <RecommendationFeedback
          recommendationId={recommendation.id}
          size="sm"
          onAccept={handleAccept}
          onReject={handleReject}
          feedbackGiven={feedbackGiven}
        />
      </div>
    );
  }

  return (
    <div
      className={clsx(
        'p-4 rounded-lg bg-surface-800/50 border border-surface-700',
        'hover:bg-surface-700/50 transition-colors',
        feedbackGiven === 'accepted' && 'border-green-500/30 bg-green-500/5',
        feedbackGiven === 'rejected' && 'opacity-50'
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-2">
        <RecommendationBadge
          type={recommendation.type}
          name={recommendation.name}
          confidenceScore={recommendation.confidenceScore}
          source={recommendation.source}
          size="md"
          onClick={handleClick}
        />
        <RecommendationFeedback
          recommendationId={recommendation.id}
          size="md"
          onAccept={handleAccept}
          onReject={handleReject}
          feedbackGiven={feedbackGiven}
        />
      </div>

      {/* Description */}
      {recommendation.description && (
        <p className="text-sm text-gray-300 mb-2 line-clamp-2">
          {recommendation.description}
        </p>
      )}

      {/* Reasoning */}
      <p className="text-xs text-gray-400 mb-2">
        {recommendation.reasoning}
      </p>

      {/* Keywords */}
      {recommendation.matchedKeywords.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {recommendation.matchedKeywords.slice(0, 5).map((keyword, idx) => (
            <span
              key={`${keyword}-${idx}`}
              className="px-1.5 py-0.5 text-xs bg-surface-700 text-gray-400 rounded"
            >
              {keyword}
            </span>
          ))}
          {recommendation.matchedKeywords.length > 5 && (
            <span className="px-1.5 py-0.5 text-xs text-gray-500">
              +{recommendation.matchedKeywords.length - 5} more
            </span>
          )}
        </div>
      )}
    </div>
  );
});

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export const RecommendationPanel = memo(function RecommendationPanel({
  recommendations,
  title = 'Recommended',
  isLoading = false,
  error = null,
  onAccept,
  onReject,
  onSelect,
  compact = false,
  maxInitial = 5,
  collapsible = false,
  defaultCollapsed = false,
}: RecommendationPanelProps) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
  const [showAll, setShowAll] = useState(false);

  const visibleRecommendations = showAll
    ? recommendations
    : recommendations.slice(0, maxInitial);

  const hasMore = recommendations.length > maxInitial;

  // Auto-expand when new recommendations come in
  useEffect(() => {
    if (recommendations.length > 0 && isCollapsed) {
      setIsCollapsed(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recommendations.length]);

  const toggleCollapse = useCallback(() => {
    setIsCollapsed(prev => !prev);
  }, []);

  const toggleShowAll = useCallback(() => {
    setShowAll(prev => !prev);
  }, []);

  return (
    <div className="rounded-lg border border-surface-700 bg-surface-900/50 overflow-hidden">
      {/* Header */}
      <div
        className={clsx(
          'flex items-center justify-between px-4 py-3',
          'bg-surface-800/50 border-b border-surface-700',
          collapsible && 'cursor-pointer hover:bg-surface-700/50'
        )}
        onClick={collapsible ? toggleCollapse : undefined}
      >
        <div className="flex items-center gap-2">
          <svg
            className="w-5 h-5 text-primary-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
          </svg>
          <h3 className="text-sm font-medium text-gray-200">{title}</h3>
          {recommendations.length > 0 && (
            <span className="px-1.5 py-0.5 text-xs bg-primary-500/20 text-primary-400 rounded">
              {recommendations.length}
            </span>
          )}
        </div>

        {collapsible && (
          <svg
            className={clsx(
              'w-4 h-4 text-gray-400 transition-transform',
              isCollapsed && '-rotate-180'
            )}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m18 15-6-6-6 6" />
          </svg>
        )}
      </div>

      {/* Content */}
      {!isCollapsed && (
        <div className="p-4">
          {isLoading && <LoadingState />}

          {error && <ErrorState message={error} />}

          {!isLoading && !error && recommendations.length === 0 && (
            <EmptyState message="No recommendations available" />
          )}

          {!isLoading && !error && recommendations.length > 0 && (
            <>
              <div className={clsx('space-y-2', compact && 'space-y-1')}>
                {visibleRecommendations.map(rec => (
                  <RecommendationCard
                    key={rec.id}
                    recommendation={rec}
                    onAccept={onAccept}
                    onReject={onReject}
                    onSelect={onSelect}
                    compact={compact}
                  />
                ))}
              </div>

              {hasMore && (
                <button
                  type="button"
                  onClick={toggleShowAll}
                  className={clsx(
                    'w-full mt-3 py-2 text-sm text-gray-400',
                    'hover:text-gray-200 transition-colors',
                    'border border-dashed border-surface-600 rounded-lg',
                    'hover:border-surface-500'
                  )}
                >
                  {showAll
                    ? 'Show less'
                    : `Show ${recommendations.length - maxInitial} more`
                  }
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
});

export default RecommendationPanel;
