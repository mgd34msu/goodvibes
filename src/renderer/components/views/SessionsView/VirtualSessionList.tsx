// ============================================================================
// VIRTUAL SESSION LIST COMPONENT
// ============================================================================

import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { VirtualSessionListProps } from './types';
import { SessionCard } from './SessionCard';

// Fixed card height (card padding 16px*2 + content ~56px + gap 8px = 96px)
const CARD_HEIGHT = 96;
const CARD_GAP = 8;

export function VirtualSessionList({
  sessions,
  projectsRoot,
  liveSessionIds,
  onSessionClick,
}: VirtualSessionListProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: sessions.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => CARD_HEIGHT + CARD_GAP,
    overscan: 5,
    // No measureElement - using fixed heights for uniform spacing
  });

  return (
    <div ref={parentRef} className="flex-1 overflow-auto px-5 py-4">
      <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const session = sessions[virtualItem.index];
          if (!session) return null;
          return (
            <div
              key={session.id}
              className="absolute top-0 left-0 w-full"
              style={{
                height: `${CARD_HEIGHT}px`,
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <SessionCard
                session={session}
                projectsRoot={projectsRoot}
                isLive={liveSessionIds.has(session.id)}
                onClick={() => onSessionClick(session)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
