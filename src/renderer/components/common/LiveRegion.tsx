// ============================================================================
// LIVE REGION COMPONENT (Announcements for Screen Readers)
// ============================================================================

import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';

interface LiveRegionContextValue {
  announce: (message: string, priority?: 'polite' | 'assertive') => void;
}

const LiveRegionContext = createContext<LiveRegionContextValue | null>(null);

/**
 * Hook to announce messages to screen readers
 */
export function useAnnounce(): (message: string, priority?: 'polite' | 'assertive') => void {
  const context = useContext(LiveRegionContext);
  if (!context) {
    throw new Error('useAnnounce must be used within a LiveRegionProvider');
  }
  return context.announce;
}

interface LiveRegionProviderProps {
  children: React.ReactNode;
}

/**
 * Provider that creates live regions for screen reader announcements.
 * Wrap your app with this to enable announcements.
 */
export function LiveRegionProvider({ children }: LiveRegionProviderProps): React.JSX.Element {
  const [politeMessage, setPoliteMessage] = useState('');
  const [assertiveMessage, setAssertiveMessage] = useState('');
  const announceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const announce = useCallback((message: string, priority: 'polite' | 'assertive' = 'polite') => {
    // Clear any pending timeouts
    if (announceTimeoutRef.current) {
      clearTimeout(announceTimeoutRef.current);
      announceTimeoutRef.current = null;
    }
    if (clearTimeoutRef.current) {
      clearTimeout(clearTimeoutRef.current);
      clearTimeoutRef.current = null;
    }

    // Clear current message first (needed for repeated announcements)
    if (priority === 'polite') {
      setPoliteMessage('');
    } else {
      setAssertiveMessage('');
    }

    // Set new message after a brief delay
    announceTimeoutRef.current = setTimeout(() => {
      if (priority === 'polite') {
        setPoliteMessage(message);
      } else {
        setAssertiveMessage(message);
      }
      announceTimeoutRef.current = null;

      // Clear after announcement
      clearTimeoutRef.current = setTimeout(() => {
        setPoliteMessage('');
        setAssertiveMessage('');
        clearTimeoutRef.current = null;
      }, 1000);
    }, 50);
  }, []);

  useEffect(() => {
    return () => {
      if (announceTimeoutRef.current) {
        clearTimeout(announceTimeoutRef.current);
      }
      if (clearTimeoutRef.current) {
        clearTimeout(clearTimeoutRef.current);
      }
    };
  }, []);

  return (
    <LiveRegionContext.Provider value={{ announce }}>
      {children}

      {/* Polite live region - waits for user to finish current task */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
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
        {politeMessage}
      </div>

      {/* Assertive live region - interrupts immediately */}
      <div
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
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
        {assertiveMessage}
      </div>
    </LiveRegionContext.Provider>
  );
}
