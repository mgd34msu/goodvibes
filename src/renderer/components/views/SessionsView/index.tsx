// ============================================================================
// SESSIONS VIEW COMPONENT - Unified Sessions + Monitor View
// ============================================================================

import { useState, useCallback, useEffect } from 'react';
import type { Session, SessionFilter } from './types';
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

  // Auto-rescan for new sessions every 10 seconds
  useEffect(() => {
    // Initial rescan when view opens
    window.goodvibes.rescanSessions?.();
    
    const interval = setInterval(() => {
      window.goodvibes.rescanSessions?.();
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
      console.error('Failed to fetch session for activity item:', err);
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
