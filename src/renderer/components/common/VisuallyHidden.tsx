// ============================================================================
// VISUALLY HIDDEN COMPONENT (Screen Reader Only)
// ============================================================================

import React from 'react';

interface VisuallyHiddenProps {
  children: React.ReactNode;
  /** ID for ARIA references */
  id?: string;
  /** Render as a different element */
  as?: keyof React.JSX.IntrinsicElements;
}

/**
 * Hides content visually but keeps it accessible to screen readers.
 * Use for:
 * - Icon-only buttons that need labels
 * - Additional context for screen readers
 * - Form labels that are visually represented elsewhere
 */
export function VisuallyHidden({ children, id, as = 'span' }: VisuallyHiddenProps): React.JSX.Element {
  const Component = as;
  return (
    <Component
      id={id}
      className="sr-only"
      style={{
        position: 'absolute',
        width: '1px',
        height: '1px',
        padding: 0,
        margin: '-1px',
        overflow: 'hidden',
        clip: 'rect(0, 0, 0, 0)',
        whiteSpace: 'nowrap',
        border: 0,
      }}
    >
      {children}
    </Component>
  );
}
