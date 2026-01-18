// ============================================================================
// SKIP LINK COMPONENT
// ============================================================================

import React from 'react';
import { clsx } from 'clsx';

interface SkipLinkProps {
  /** ID of the main content element */
  targetId: string;
  /** Skip link text */
  children?: React.ReactNode;
}

/**
 * Accessibility component that allows keyboard users to skip navigation
 * and jump directly to the main content.
 *
 * Uses sr-only pattern: visually hidden until focused, then visible.
 */
export function SkipLink({ targetId, children = 'Skip to main content' }: SkipLinkProps): React.JSX.Element {
  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    const target = document.getElementById(targetId);
    if (target) {
      target.focus();
      target.scrollIntoView();
    }
  };

  return (
    <a
      href={`#${targetId}`}
      onClick={handleClick}
      className={clsx(
        // Visually hidden by default (sr-only pattern)
        'absolute overflow-hidden',
        'w-px h-px p-0 -m-px',
        'whitespace-nowrap border-0',
        '[clip:rect(0,0,0,0)]',
        // When focused, become visible
        'focus:static focus:w-auto focus:h-auto focus:p-4 focus:m-0',
        'focus:overflow-visible focus:[clip:auto]',
        'focus:z-[9999] focus:bg-primary-600 focus:text-white focus:font-medium',
        'focus:rounded-br-lg focus:shadow-lg',
        'focus:outline-none focus:ring-2 focus:ring-primary-300 focus:ring-offset-2 focus:ring-offset-surface-950'
      )}
    >
      {children}
    </a>
  );
}
