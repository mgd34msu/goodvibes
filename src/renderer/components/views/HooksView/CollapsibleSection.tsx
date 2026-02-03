// ============================================================================
// COLLAPSIBLE SECTION COMPONENT
// Reusable expandable/collapsible section with smooth animations
// ============================================================================

import { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronDown } from 'lucide-react';
import { clsx } from 'clsx';

// ============================================================================
// TYPES
// ============================================================================

interface CollapsibleSectionProps {
  /** Section title displayed in the header */
  title: string;
  /** Optional icon displayed before the title */
  icon?: React.ReactNode;
  /** Content to display when expanded */
  children: React.ReactNode;
  /** Initial expanded state (default: false) */
  defaultExpanded?: boolean;
  /** Additional CSS classes for the container */
  className?: string;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function CollapsibleSection({
  title,
  icon,
  children,
  defaultExpanded = false,
  className,
}: CollapsibleSectionProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [contentHeight, setContentHeight] = useState<number | undefined>(
    defaultExpanded ? undefined : 0
  );
  const contentRef = useRef<HTMLDivElement>(null);

  // Measure and update content height for smooth animation
  const updateHeight = useCallback(() => {
    if (contentRef.current) {
      const scrollHeight = contentRef.current.scrollHeight;
      setContentHeight(isExpanded ? scrollHeight : 0);
    }
  }, [isExpanded]);

  // Update height when expanded state changes
  useEffect(() => {
    updateHeight();
  }, [updateHeight]);

  // Handle window resize to recalculate height
  useEffect(() => {
    if (!isExpanded) return;

    const handleResize = () => updateHeight();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isExpanded, updateHeight]);

  // After transition completes, set height to auto for dynamic content
  const handleTransitionEnd = () => {
    if (isExpanded && contentRef.current) {
      setContentHeight(undefined);
    }
  };

  const toggleExpanded = () => {
    if (isExpanded) {
      // When collapsing, first set explicit height, then collapse
      if (contentRef.current) {
        setContentHeight(contentRef.current.scrollHeight);
        // Force reflow before setting to 0
        requestAnimationFrame(() => {
          setContentHeight(0);
        });
      }
    }
    setIsExpanded(!isExpanded);
  };

  return (
    <div
      className={clsx(
        'rounded-lg border border-surface-700 overflow-hidden',
        className
      )}
    >
      {/* Header */}
      <button
        type="button"
        onClick={toggleExpanded}
        className={clsx(
          'w-full flex items-center gap-3 px-4 py-3',
          'bg-surface-800 hover:bg-surface-750',
          'transition-colors duration-150',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-inset'
        )}
        aria-expanded={isExpanded}
      >
        {/* Icon */}
        {icon && (
          <span className="text-surface-400 flex-shrink-0">{icon}</span>
        )}

        {/* Title */}
        <span className="text-sm font-medium text-surface-300 flex-1 text-left">
          {title}
        </span>

        {/* Chevron */}
        <ChevronDown
          className={clsx(
            'w-4 h-4 text-surface-400 transition-transform duration-200',
            isExpanded && 'rotate-180'
          )}
        />
      </button>

      {/* Content */}
      <div
        ref={contentRef}
        style={{
          height: contentHeight !== undefined ? `${contentHeight}px` : 'auto',
        }}
        onTransitionEnd={handleTransitionEnd}
        className={clsx(
          'overflow-hidden transition-[height] duration-200 ease-in-out',
          !isExpanded && 'invisible'
        )}
        aria-hidden={!isExpanded}
      >
        <div className="px-4 py-3 bg-surface-850 border-t border-surface-700">
          {children}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// EXPORTS
// ============================================================================

export default CollapsibleSection;
