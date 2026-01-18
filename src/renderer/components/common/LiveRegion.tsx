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
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const announce = useCallback((message: string, priority: 'polite' | 'assertive' = 'polite') => {
    // Clear any pending announcements
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    // Clear current message first (needed for repeated announcements)
    if (priority === 'polite') {
      setPoliteMessage('');
    } else {
      setAssertiveMessage('');
    }

    // Set new message after a brief delay
    timeoutRef.current = setTimeout(() => {
      if (priority === 'polite') {
        setPoliteMessage(message);
      } else {
        setAssertiveMessage(message);
      }

      // Clear after announcement
      timeoutRef.current = setTimeout(() => {
        setPoliteMessage('');
        setAssertiveMessage('');
      }, 1000);
    }, 50);
  }, []);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
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
