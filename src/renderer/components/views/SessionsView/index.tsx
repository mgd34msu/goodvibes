// ============================================================================
// SESSIONS VIEW COMPONENT - Unified Sessions + Monitor View
// ============================================================================

import { useState, useCallback, useEffect } from 'react';
import type { Session, SessionFilter } from './types';
import { createLogger } from '../../../../shared/logger';

const logger = createLogger('SessionsView');
import { useSessions, useLiveSessions, useSessionFilters } from './hooks';
import { useSettingsStore } from '../../../stores/settingsStore';
import { SessionFilters } from './SessionFilters';
import { VirtualSessionList } from './VirtualSessionList';
import { MonitorPanel } from './MonitorPanel';
import { LoadingSkeleton, EmptyState, ErrorState } from './SessionStates';
import { SessionDetailModal } from '../../overlays/SessionDetailModal';
import { toast } from '../../../stores/toastStore';

export default function SessionsView() {
  const { settings } = useSettingsStore();
  const [filter, setFilter] = useState<SessionFilter>('all');
  const [search, setSearch] = useState('');
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);

  const { sessions, isLoading, error } = useSessions(filter);
  const { liveSessionIds } = useLiveSessions();
  const { filteredSessions } = useSessionFilters(sessions, search);

  // Auto-scan for NEW sessions every 10 seconds (incremental, not full rescan)
  useEffect(() => {
    // Note: Full scan happens at app startup, so we don't need one here.
    // Just start the incremental scan interval.
    const interval = setInterval(() => {
      // Only scan for NEW sessions, not re-process all existing ones
      void window.goodvibes.scanNewSessions().catch(() => {
        // API should always exist - log if call fails
        logger.debug('scanNewSessions API call failed');
      });
    }, 10000);
    
    return () => clearInterval(interval);
  }, []);

  // Handle clicking activity items - fetch the session by ID and open modal
  const handleActivityClick = useCallback(async (sessionId: string) => {
    try {
      // First try direct lookup
      let session = await window.goodvibes.getSession(sessionId);

      // If not found, search in currently loaded sessions (includes agents)
      if (!session) {
        session = sessions.find(s => s.id === sessionId || s.id.endsWith(`/${sessionId}`)) || null;
      }

      // If still not found, try fetching all sessions and search
      if (!session) {
        const allSessions = await window.goodvibes.getSessions();
        session = allSessions?.find((s: Session) => s.id === sessionId || s.id.includes(sessionId)) || null;
      }

      if (session) {
        setSelectedSession(session);
      } else {
        // Session was ephemeral (e.g., short-lived subagent) and is no longer available
        toast.info('This session has completed and is no longer accessible.', { title: 'Session unavailable' });
      }
    } catch (err) {
      logger.error('Failed to fetch session for activity item:', err);
      toast.error('Failed to load session');
    }
  }, [sessions]);

  return (
    <div className="flex h-full">
      {/* Left Panel - Sessions List (60%) */}
      <div className="flex flex-col w-[60%] min-w-0 border-r border-surface-700/50">
        {/* Sessions Header with Filters */}
        <SessionFilters
          filter={filter}
          onFilterChange={setFilter}
          search={search}
          onSearchChange={setSearch}
        />

        {/* Sessions Content */}
        {isLoading ? (
          <LoadingSkeleton />
        ) : error ? (
          <ErrorState error={error} />
        ) : filteredSessions.length === 0 ? (
          <EmptyState filter={filter} search={search} />
        ) : (
          <VirtualSessionList
            sessions={filteredSessions}
            projectsRoot={settings.projectsRoot}
            liveSessionIds={liveSessionIds}
            onSessionClick={setSelectedSession}
          />
        )}
      </div>

      {/* Right Panel - Monitor (40%) */}
      <div className="w-[40%] min-w-0 bg-surface-950/50">
        <MonitorPanel
          projectsRoot={settings.projectsRoot}
          onSessionClick={setSelectedSession}
          onActivityClick={handleActivityClick}
        />
      </div>

      {/* Session Detail Modal */}
      {selectedSession && (
        <SessionDetailModal session={selectedSession} onClose={() => setSelectedSession(null)} />
      )}
    </div>
  );
}

// Re-export types for convenience
export type { Session, SessionFilter, ActivityLogEntry } from './types';
