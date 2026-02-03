// ============================================================================
// FOCUS TRAP COMPONENT
// ============================================================================

import React, { useEffect, useRef, useCallback } from 'react';

interface FocusTrapProps {
  children: React.ReactNode;
  /** Whether the trap is active */
  active?: boolean;
  /** Element to return focus to when trap deactivates */
  returnFocusOnDeactivate?: boolean;
  /** Auto-focus first focusable element */
  autoFocus?: boolean;
}

const FOCUSABLE_SELECTORS = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function FocusTrap({
  children,
  active = true,
  returnFocusOnDeactivate = true,
  autoFocus = true,
}: FocusTrapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<Element | null>(null);

  const getFocusableElements = useCallback(() => {
    if (!containerRef.current) return [];
    return Array.from(
      containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS)
    );
  }, []);

  // Store previously focused element
  useEffect(() => {
    if (active) {
      previousActiveElement.current = document.activeElement;

      if (autoFocus) {
        const focusable = getFocusableElements();
        if (focusable.length > 0) {
          focusable[0]?.focus();
        }
      }
    }

    return () => {
      if (returnFocusOnDeactivate && previousActiveElement.current instanceof HTMLElement) {
        previousActiveElement.current.focus();
      }
    };
  }, [active, autoFocus, getFocusableElements, returnFocusOnDeactivate]);

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!active || e.key !== 'Tab') return;

      const focusable = getFocusableElements();
      if (focusable.length === 0) return;

      const firstElement = focusable[0];
      const lastElement = focusable[focusable.length - 1];

      if (e.shiftKey) {
        // Shift+Tab: go backwards
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement?.focus();
        }
      } else {
        // Tab: go forwards
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement?.focus();
        }
      }
    },
    [active, getFocusableElements]
  );

  return (
    <div ref={containerRef} onKeyDown={handleKeyDown}>
      {children}
    </div>
  );
}
