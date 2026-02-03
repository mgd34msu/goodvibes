// ============================================================================
// CI STATUS BADGE COMPONENT
// ============================================================================

import { clsx } from 'clsx';
import type { GitHubCheckConclusion } from '../../../shared/types/github';

interface CIStatusBadgeProps {
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: GitHubCheckConclusion | null;
  name?: string;
  className?: string;
  showLabel?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

export default function CIStatusBadge({
  status,
  conclusion,
  name,
  className,
  showLabel = true,
  size = 'sm',
}: CIStatusBadgeProps) {
  const getStatusConfig = () => {
    if (status === 'queued') {
      return {
        icon: QueuedIcon,
        color: 'text-surface-400',
        bgColor: 'bg-surface-700',
        label: 'Queued',
      };
    }

    if (status === 'in_progress') {
      return {
        icon: SpinnerIcon,
        color: 'text-warning-400',
        bgColor: 'bg-warning-900/30',
        label: 'Running',
      };
    }

    // Completed - check conclusion
    switch (conclusion) {
      case 'success':
        return {
          icon: CheckIcon,
          color: 'text-success-400',
          bgColor: 'bg-success-900/30',
          label: 'Passed',
        };
      case 'failure':
        return {
          icon: XIcon,
          color: 'text-error-400',
          bgColor: 'bg-error-900/30',
          label: 'Failed',
        };
      case 'neutral':
        return {
          icon: NeutralIcon,
          color: 'text-surface-400',
          bgColor: 'bg-surface-700',
          label: 'Neutral',
        };
      case 'cancelled':
        return {
          icon: CancelledIcon,
          color: 'text-surface-500',
          bgColor: 'bg-surface-700',
          label: 'Cancelled',
        };
      case 'skipped':
        return {
          icon: SkippedIcon,
          color: 'text-surface-500',
          bgColor: 'bg-surface-700',
          label: 'Skipped',
        };
      case 'timed_out':
        return {
          icon: TimeoutIcon,
          color: 'text-warning-400',
          bgColor: 'bg-warning-900/30',
          label: 'Timed Out',
        };
      case 'action_required':
        return {
          icon: ActionRequiredIcon,
          color: 'text-warning-400',
          bgColor: 'bg-warning-900/30',
          label: 'Action Required',
        };
      default:
        return {
          icon: UnknownIcon,
          color: 'text-surface-500',
          bgColor: 'bg-surface-700',
          label: 'Unknown',
        };
    }
  };

  const config = getStatusConfig();
  const IconComponent = config.icon;

  const sizeClasses = {
    sm: 'text-xs px-2 py-0.5',
    md: 'text-sm px-2.5 py-1',
    lg: 'text-base px-3 py-1.5',
  };

  const iconSizes = {
    sm: 'w-3 h-3',
    md: 'w-4 h-4',
    lg: 'w-5 h-5',
  };

  return (
    <div
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full',
        config.bgColor,
        sizeClasses[size],
        className
      )}
      title={name ? `${name}: ${config.label}` : config.label}
    >
      <IconComponent className={clsx(iconSizes[size], config.color)} />
      {showLabel && (
        <span className={config.color}>{name || config.label}</span>
      )}
    </div>
  );
}

// ============================================================================
// Combined Status Badge for overall CI status
// ============================================================================

interface CombinedStatusBadgeProps {
  state: 'failure' | 'pending' | 'success';
  totalCount: number;
  className?: string;
}

export function CombinedStatusBadge({
  state,
  totalCount,
  className,
}: CombinedStatusBadgeProps) {
  const getConfig = () => {
    switch (state) {
      case 'success':
        return {
          icon: CheckIcon,
          color: 'text-success-400',
          bgColor: 'bg-success-900/30',
          label: 'All checks passed',
        };
      case 'failure':
        return {
          icon: XIcon,
          color: 'text-error-400',
          bgColor: 'bg-error-900/30',
          label: 'Some checks failed',
        };
      case 'pending':
        return {
          icon: SpinnerIcon,
          color: 'text-warning-400',
          bgColor: 'bg-warning-900/30',
          label: 'Checks in progress',
        };
      default:
        return {
          icon: UnknownIcon,
          color: 'text-surface-500',
          bgColor: 'bg-surface-700',
          label: 'Unknown status',
        };
    }
  };

  const config = getConfig();
  const IconComponent = config.icon;

  return (
    <div
      className={clsx(
        'inline-flex items-center gap-2 rounded-full px-3 py-1',
        config.bgColor,
        className
      )}
      title={`${config.label} (${totalCount} check${totalCount !== 1 ? 's' : ''})`}
    >
      <IconComponent className={clsx('w-4 h-4', config.color)} />
      <span className={clsx('text-sm', config.color)}>
        {totalCount} check{totalCount !== 1 ? 's' : ''}
      </span>
    </div>
  );
}

// ============================================================================
// ICONS
// ============================================================================

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
    </svg>
  );
}

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg className={clsx(className, 'animate-spin')} viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l1.68 1.68a.75.75 0 11-1.06 1.061l-1.68-1.68A6 6 0 012 8z" opacity="0.3" />
      <path d="M8 2a6 6 0 00-6 6h1.5a4.5 4.5 0 014.5-4.5V2z" />
    </svg>
  );
}

function QueuedIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor">
      <circle cx="8" cy="8" r="4" opacity="0.5" />
    </svg>
  );
}

function NeutralIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8z" opacity="0.5" />
    </svg>
  );
}

function CancelledIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8zm5-.25a.75.75 0 000 1.5h6a.75.75 0 000-1.5H5z" />
    </svg>
  );
}

function SkippedIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor">
      <path d="M6.5 2.75a.75.75 0 00-1.5 0v10.5a.75.75 0 001.5 0V2.75zm4 0a.75.75 0 00-1.5 0v10.5a.75.75 0 001.5 0V2.75z" />
    </svg>
  );
}

function TimeoutIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8zm8.75-3a.75.75 0 00-1.5 0v3.25H5a.75.75 0 000 1.5h3.25a.75.75 0 00.75-.75V5z" />
    </svg>
  );
}

function ActionRequiredIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" d="M8.22 1.754a.25.25 0 00-.44 0L1.698 13.132a.25.25 0 00.22.368h12.164a.25.25 0 00.22-.368L8.22 1.754zm-1.763-.707c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0114.082 15H1.918a1.75 1.75 0 01-1.543-2.575L6.457 1.047zM9 11a1 1 0 11-2 0 1 1 0 012 0zm-.25-5.25a.75.75 0 00-1.5 0v2.5a.75.75 0 001.5 0v-2.5z" />
    </svg>
  );
}

function UnknownIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor">
      <path fillRule="evenodd" d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8zm6.5-.25A.75.75 0 017.25 7h1a.75.75 0 01.75.75v2.75h.25a.75.75 0 010 1.5h-2a.75.75 0 010-1.5h.25v-2h-.25a.75.75 0 01-.75-.75zM8 6a1 1 0 100-2 1 1 0 000 2z" />
    </svg>
  );
}
