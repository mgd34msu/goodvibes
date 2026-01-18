// ============================================================================
// SESSIONS VIEW - CUSTOM HOOKS
// ============================================================================

import { useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Session, SessionFilter } from './types';
import { useSettingsStore } from '../../../stores/settingsStore';

export function useSessions(filter: SessionFilter): { sessions: Session[]; isLoading: boolean; error: Error | null } {
  const { data: sessions = [], isLoading, error } = useQuery({
    queryKey: ['sessions', filter],
    queryFn: async () => {
      switch (filter) {
        case 'favorites':
          return await window.goodvibes.getFavoriteSessions();
        case 'archived':
          return await window.goodvibes.getArchivedSessions();
        default:
          return await window.goodvibes.getActiveSessions();
      }
    },
  });

  return { sessions, isLoading, error };
}

export function useLiveSessions(): { liveSessions: Session[]; liveSessionIds: Set<string> } {
  const { data: liveSessions = [] } = useQuery({
    queryKey: ['live-sessions'],
    queryFn: () => window.goodvibes.getLiveSessions(),
    refetchInterval: 5000, // Refresh every 5 seconds
    refetchIntervalInBackground: false, // Stop polling when app is backgrounded to prevent memory leaks
  });

  const liveSessionIds = useMemo(
    () => new Set<string>(liveSessions.map((s: Session) => s.id)),
    [liveSessions]
  );

  return { liveSessions, liveSessionIds };
}

export function useSessionFilters(sessions: Session[], search: string): { filteredSessions: Session[] } {
  const { settings } = useSettingsStore();

  const filteredSessions = useMemo(() => {
    let result = sessions;

    // Filter out agent sessions if hideAgentSessions is enabled
    if (settings.hideAgentSessions) {
      result = result.filter((s: Session) => !s.id.startsWith('agent-'));
    }

    // Filter by search term
    if (search.trim()) {
      const lower = search.toLowerCase();
      result = result.filter(
        (s: Session) =>
          s.projectName?.toLowerCase().includes(lower) ||
          s.customTitle?.toLowerCase().includes(lower) ||
          s.summary?.toLowerCase().includes(lower)
      );
    }

    return result;
  }, [sessions, search, settings.hideAgentSessions]);

  return { filteredSessions };
}

export function useAppUptime(): number {
  const [appUptime, setAppUptime] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setAppUptime((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  return appUptime;
}
