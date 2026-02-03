// ============================================================================
// COPY BUTTON COMPONENT
// Reusable copy-to-clipboard button with feedback
// ============================================================================

import React, { useState, useCallback } from 'react';
import { clsx } from 'clsx';
import { Clipboard, Check } from 'lucide-react';
import { createLogger } from '../../../shared/logger';

const logger = createLogger('CopyButton');

// Constants
const TOAST_DURATION_MS = 2000;

export interface CopyButtonProps {
  /** Content to copy to clipboard */
  content: string;
  /** Label to show - "Copy" or "Copy as JSON" etc. If not provided, icon only */
  label?: string;
  /** Additional CSS classes */
  className?: string;
  /** Size variant */
  size?: 'sm' | 'md';
  /** Whether to show as icon-only (tooltip on hover) */
  iconOnly?: boolean;
  /** Position style - for absolute positioning in corner */
  position?: 'inline' | 'top-right';
}

/**
 * CopyButton - A reusable copy-to-clipboard button
 *
 * Features:
 * - Click to copy content to clipboard
 * - Shows "Copied!" feedback briefly
 * - Supports icon-only mode with tooltip
 * - Subtle styling that becomes more visible on hover
 */
export function CopyButton({
  content,
  label,
  className,
  size = 'sm',
  iconOnly = false,
  position = 'inline',
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);

  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent triggering parent click handlers
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), TOAST_DURATION_MS);
    } catch (err) {
      logger.error('Failed to copy:', err);
    }
  }, [content]);

  const sizeClasses = size === 'sm'
    ? 'p-1 text-xs'
    : 'p-1.5 text-sm';

  const iconSize = size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4';

  const positionClasses = position === 'top-right'
    ? 'absolute top-2 right-2'
    : '';

  const displayLabel = copied ? 'Copied!' : (label || 'Copy');

  return (
    <div className={clsx('relative inline-flex', positionClasses, className)}>
      <button
        onClick={handleCopy}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        className={clsx(
          'flex items-center gap-1 rounded transition-all',
          'text-surface-400 hover:text-surface-200',
          'hover:bg-surface-700/50',
          'opacity-60 hover:opacity-100',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
          sizeClasses
        )}
        title={iconOnly ? displayLabel : undefined}
        aria-label={displayLabel}
      >
        {copied ? (
          <Check className={iconSize} />
        ) : (
          <Clipboard className={iconSize} />
        )}
        {!iconOnly && (
          <span className="whitespace-nowrap">{displayLabel}</span>
        )}
      </button>

      {/* Tooltip for icon-only mode */}
      {iconOnly && showTooltip && (
        <div
          className={clsx(
            'absolute z-[9959] px-2 py-1 text-xs rounded shadow-lg',
            'bg-surface-800 text-surface-200 border border-surface-700',
            'whitespace-nowrap pointer-events-none',
            '-top-8 left-1/2 -translate-x-1/2'
          )}
        >
          {displayLabel}
          <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-px">
            <div className="border-4 border-transparent border-t-surface-700" />
          </div>
        </div>
      )}
    </div>
  );
}

// Re-export lucide icons for external use if needed
export { Clipboard as ClipboardIcon, Check as CheckIcon } from 'lucide-react';
