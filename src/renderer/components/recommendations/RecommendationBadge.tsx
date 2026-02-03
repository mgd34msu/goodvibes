// ============================================================================
// RECOMMENDATION BADGE - Inline suggestion badge for agents/skills
// ============================================================================

import { memo } from 'react';
import clsx from 'clsx';

// ============================================================================
// TYPES
// ============================================================================

export interface RecommendationBadgeProps {
  /** Type of recommendation */
  type: 'agent' | 'skill';
  /** Name to display */
  name: string;
  /** Confidence score (0.0 - 1.0) */
  confidenceScore: number;
  /** Source of the recommendation */
  source: 'prompt' | 'project' | 'context' | 'historical';
  /** Whether this badge is selected/highlighted */
  isSelected?: boolean;
  /** Callback when badge is clicked */
  onClick?: () => void;
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Whether to show the confidence score */
  showScore?: boolean;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get the color class based on confidence score
 */
function getConfidenceColor(score: number): string {
  if (score >= 0.8) return 'bg-green-500/20 text-green-400 border-green-500/30';
  if (score >= 0.6) return 'bg-blue-500/20 text-blue-400 border-blue-500/30';
  if (score >= 0.4) return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
  return 'bg-gray-500/20 text-gray-400 border-gray-500/30';
}

/**
 * Get source icon
 */
function _getSourceIcon(source: RecommendationBadgeProps['source']): string {
  switch (source) {
    case 'prompt': return ''; // Magnifying glass
    case 'project': return ''; // Folder
    case 'context': return ''; // Lightbulb
    case 'historical': return ''; // Clock
    default: return '';
  }
}

/**
 * Get type icon
 */
function _getTypeIcon(type: 'agent' | 'skill'): string {
  return type === 'agent' ? '' : ''; // Robot or Sparkles
}

// Suppress unused warnings - these will be used when icon support is added
void _getSourceIcon;
void _getTypeIcon;

// ============================================================================
// COMPONENT
// ============================================================================

export const RecommendationBadge = memo(function RecommendationBadge({
  type,
  name,
  confidenceScore,
  source,
  isSelected = false,
  onClick,
  size = 'md',
  showScore = true,
}: RecommendationBadgeProps) {
  const sizeClasses = {
    sm: 'px-2 py-0.5 text-xs gap-1',
    md: 'px-2.5 py-1 text-sm gap-1.5',
    lg: 'px-3 py-1.5 text-base gap-2',
  };

  const iconSizes = {
    sm: 'w-3 h-3',
    md: 'w-4 h-4',
    lg: 'w-5 h-5',
  };

  const scorePercent = Math.round(confidenceScore * 100);

  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'inline-flex items-center rounded-full border transition-all duration-150',
        'focus:outline-none focus:ring-2 focus:ring-primary-500/50',
        sizeClasses[size],
        getConfidenceColor(confidenceScore),
        isSelected && 'ring-2 ring-primary-500 scale-105',
        onClick && 'cursor-pointer hover:scale-105 hover:brightness-110',
        !onClick && 'cursor-default'
      )}
      disabled={!onClick}
    >
      {/* Type Icon */}
      <span className={clsx('shrink-0', iconSizes[size])}>
        {type === 'agent' ? (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 8V4H8" />
            <rect width="16" height="12" x="4" y="8" rx="2" />
            <path d="M2 14h2" />
            <path d="M20 14h2" />
            <path d="M15 13v2" />
            <path d="M9 13v2" />
          </svg>
        ) : (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
            <path d="M5 3v4" />
            <path d="M19 17v4" />
            <path d="M3 5h4" />
            <path d="M17 19h4" />
          </svg>
        )}
      </span>

      {/* Name */}
      <span className="truncate max-w-[120px] font-medium">{name}</span>

      {/* Score */}
      {showScore && (
        <span className="text-xs opacity-75 tabular-nums">
          {scorePercent}%
        </span>
      )}

      {/* Source indicator (small dot) */}
      <span
        className={clsx(
          'w-1.5 h-1.5 rounded-full shrink-0',
          source === 'historical' && 'bg-purple-400',
          source === 'context' && 'bg-blue-400',
          source === 'project' && 'bg-green-400',
          source === 'prompt' && 'bg-yellow-400'
        )}
        title={`Source: ${source}`}
      />
    </button>
  );
});

export default RecommendationBadge;
