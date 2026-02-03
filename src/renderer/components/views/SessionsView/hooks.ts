// ============================================================================
// SESSIONS VIEW - CUSTOM HOOKS
// ============================================================================

import { useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Session, SessionFilter } from './types';
import type { TagFilterExpression } from '../../../../shared/types/tag-types';
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
    refetchInterval: 5000, // Poll for new sessions every 5 seconds to match Live Monitor
    refetchIntervalInBackground: false, // Stop polling when app is backgrounded
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
      setAppUptime((prev) => prev + 10);
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  return appUptime;
}

// ============================================================================
// TAG FILTERING
// ============================================================================

export interface UseTagFilterResult {
  // Filter state
  tagFilterExpression: TagFilterExpression | null;
  activeFilterCount: number;
  
  // Modal state
  isFilterModalOpen: boolean;
  openFilterModal: () => void;
  closeFilterModal: () => void;
  
  // Filter actions
  applyFilter: (expression: TagFilterExpression | null) => void;
  clearFilter: () => void;
  
  // Filtered session IDs (for use in session queries)
  filteredSessionIds: string[] | null; // null means no filter active
  isFiltering: boolean; // loading state
}

/**
 * Helper function to count total number of tags in a filter expression
 */
function countTagsInExpression(expr: TagFilterExpression | null): number {
  if (!expr) return 0;
  if (expr.type === 'tag') return 1;
  if (!expr.children) return 0;
  return expr.children.reduce((sum, child) => sum + countTagsInExpression(child), 0);
}

/**
 * Hook for managing tag filter state in SessionsView
 * Handles filter expression, modal state, and filtered session IDs
 */
export function useTagFilter(): UseTagFilterResult {
  const [tagFilterExpression, setTagFilterExpression] = useState<TagFilterExpression | null>(null);
  const [isFilterModalOpen, setIsFilterModalOpen] = useState(false);
  const [filteredSessionIds, setFilteredSessionIds] = useState<string[] | null>(null);
  const [isFiltering, setIsFiltering] = useState(false);

  // Calculate active filter count from expression
  const activeFilterCount = useMemo(
    () => countTagsInExpression(tagFilterExpression),
    [tagFilterExpression]
  );

  // Fetch filtered session IDs when expression changes
  useEffect(() => {
    if (!tagFilterExpression) {
      setFilteredSessionIds(null);
      setIsFiltering(false);
      return;
    }

    // Start filtering
    setIsFiltering(true);

    // TODO: This needs an IPC handler to be added to src/preload/api/tags.ts
    // For now, we'll set empty array to indicate "no sessions match"
    // Once the IPC handler is added, replace with:
    // window.goodvibes.getFilteredSessionIds(tagFilterExpression)
    //   .then(result => {
    //     if (result.success) {
    //       setFilteredSessionIds(result.data);
    //     } else {
    //       console.error('Failed to get filtered session IDs:', result.error);
    //       setFilteredSessionIds([]);
    //     }
    //   })
    //   .finally(() => setIsFiltering(false));
    
    // Temporary placeholder until IPC handler is implemented
    console.warn('Tag filtering not yet implemented - needs IPC handler for getFilteredSessionIds');
    setFilteredSessionIds([]);
    setIsFiltering(false);
  }, [tagFilterExpression]);

  // Modal controls
  const openFilterModal = () => setIsFilterModalOpen(true);
  const closeFilterModal = () => setIsFilterModalOpen(false);

  // Filter actions
  const applyFilter = (expression: TagFilterExpression | null) => {
    setTagFilterExpression(expression);
    closeFilterModal();
  };

  const clearFilter = () => {
    setTagFilterExpression(null);
    setFilteredSessionIds(null);
  };

  return {
    tagFilterExpression,
    activeFilterCount,
    isFilterModalOpen,
    openFilterModal,
    closeFilterModal,
    applyFilter,
    clearFilter,
    filteredSessionIds,
    isFiltering,
  };
}
