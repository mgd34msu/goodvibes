// ============================================================================
// USE RECOMMENDATIONS HOOK - React hook for recommendation functionality
// ============================================================================

import { useState, useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Recommendation } from '../components/recommendations';
import { createLogger } from '../../shared/logger';

const logger = createLogger('Recommendations');

// ============================================================================
// TYPES
// ============================================================================

export interface RecommendationStats {
  totalRecommendations: number;
  acceptedCount: number;
  rejectedCount: number;
  ignoredCount: number;
  pendingCount: number;
  acceptanceRate: number;
  byType: {
    agent: { total: number; accepted: number; rate: number };
    skill: { total: number; accepted: number; rate: number };
  };
  bySource: {
    prompt: { total: number; accepted: number; rate: number };
    project: { total: number; accepted: number; rate: number };
    context: { total: number; accepted: number; rate: number };
    historical: { total: number; accepted: number; rate: number };
  };
  topAcceptedItems: Array<{
    itemId: number;
    itemSlug: string;
    itemName: string;
    type: 'agent' | 'skill';
    acceptedCount: number;
  }>;
}

export interface PromptAnalysis {
  keywords: string[];
  intents: string[];
  technologies: string[];
  frameworks: string[];
  actions: string[];
}

export interface ProjectContext {
  name: string | null;
  technologies: string[];
  frameworks: string[];
  hasTests: boolean;
  hasDocker: boolean;
  hasTypeScript: boolean;
  packageDependencies: string[];
}

export interface UseRecommendationsOptions {
  /** Automatically fetch recommendations on mount */
  autoFetch?: boolean;
  /** Project path for project-based recommendations */
  projectPath?: string | null;
  /** Session ID for session-scoped recommendations */
  sessionId?: string | null;
}

export interface UseRecommendationsReturn {
  /** Current recommendations */
  recommendations: Recommendation[];
  /** Whether recommendations are loading */
  isLoading: boolean;
  /** Error if any */
  error: string | null;
  /** Fetch recommendations for a prompt */
  getForPrompt: (prompt: string) => Promise<Recommendation[]>;
  /** Fetch recommendations for project context */
  getForProject: () => Promise<Recommendation[]>;
  /** Accept a recommendation */
  accept: (recommendationId: number) => Promise<boolean>;
  /** Reject a recommendation */
  reject: (recommendationId: number) => Promise<boolean>;
  /** Ignore a recommendation */
  ignore: (recommendationId: number) => Promise<boolean>;
  /** Clear current recommendations */
  clear: () => void;
  /** Refresh recommendations */
  refresh: () => void;
  /** Analyzed prompt data */
  analysis: PromptAnalysis | null;
  /** Project context */
  projectContext: ProjectContext | null;
  /** Recommendation statistics */
  stats: RecommendationStats | null;
  /** Fetch stats */
  fetchStats: () => Promise<RecommendationStats>;
}

// ============================================================================
// QUERY KEYS
// ============================================================================

const QUERY_KEYS = {
  recommendations: ['recommendations'] as const,
  forPrompt: (prompt: string) => ['recommendations', 'prompt', prompt] as const,
  forProject: (path: string) => ['recommendations', 'project', path] as const,
  stats: ['recommendations', 'stats'] as const,
  pending: (sessionId?: string) => ['recommendations', 'pending', sessionId] as const,
  topPerforming: ['recommendations', 'top-performing'] as const,
};

// ============================================================================
// HOOK
// ============================================================================

export function useRecommendations(options: UseRecommendationsOptions = {}): UseRecommendationsReturn {
  const { autoFetch = false, projectPath = null, sessionId = null } = options;

  const queryClient = useQueryClient();
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [analysis, setAnalysis] = useState<PromptAnalysis | null>(null);
  const [projectContext, setProjectContext] = useState<ProjectContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Subscribe to new recommendations from the main process
  useEffect(() => {
    const unsubscribe = window.goodvibes.onRecommendationsNew((data) => {
      if (!sessionId || data.sessionId === sessionId) {
        setRecommendations(data.recommendations);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [sessionId]);

  // Auto-fetch project recommendations if configured
  useEffect(() => {
    if (autoFetch && projectPath) {
      getForProject();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFetch, projectPath]);

  /**
   * Get recommendations for a prompt
   */
  const getForPrompt = useCallback(async (prompt: string): Promise<Recommendation[]> => {
    setIsLoading(true);
    setError(null);

    try {
      // Get analysis
      const analysisResult = await window.goodvibes.recommendationsAnalyzePrompt(prompt);
      setAnalysis(analysisResult);

      // Get recommendations
      const recs = await window.goodvibes.recommendationsGetForPrompt({
        prompt,
        sessionId: sessionId ?? undefined,
        projectPath: projectPath ?? undefined,
      });

      setRecommendations(recs);
      return recs;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to get recommendations';
      setError(message);
      return [];
    } finally {
      setIsLoading(false);
    }
  }, [sessionId, projectPath]);

  /**
   * Get recommendations for project context
   */
  const getForProject = useCallback(async (): Promise<Recommendation[]> => {
    if (!projectPath) {
      return [];
    }

    setIsLoading(true);
    setError(null);

    try {
      // Get project context
      const context = await window.goodvibes.recommendationsAnalyzeProject(projectPath);
      setProjectContext(context);

      // Get recommendations
      const recs = await window.goodvibes.recommendationsGetForProject(projectPath);
      setRecommendations(recs);
      return recs;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to get project recommendations';
      setError(message);
      return [];
    } finally {
      setIsLoading(false);
    }
  }, [projectPath]);

  /**
   * Accept a recommendation
   */
  const accept = useCallback(async (recommendationId: number): Promise<boolean> => {
    try {
      const success = await window.goodvibes.recommendationsAccept(recommendationId);
      if (success) {
        // Update local state to reflect accepted status
        setRecommendations(prev =>
          prev.filter(r => r.id !== recommendationId)
        );
        // Invalidate stats
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.stats });
      }
      return success;
    } catch (err) {
      logger.error('Failed to accept recommendation:', err);
      return false;
    }
  }, [queryClient]);

  /**
   * Reject a recommendation
   */
  const reject = useCallback(async (recommendationId: number): Promise<boolean> => {
    try {
      const success = await window.goodvibes.recommendationsReject(recommendationId);
      if (success) {
        setRecommendations(prev =>
          prev.filter(r => r.id !== recommendationId)
        );
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.stats });
      }
      return success;
    } catch (err) {
      logger.error('Failed to reject recommendation:', err);
      return false;
    }
  }, [queryClient]);

  /**
   * Ignore a recommendation
   */
  const ignore = useCallback(async (recommendationId: number): Promise<boolean> => {
    try {
      const success = await window.goodvibes.recommendationsIgnore(recommendationId);
      if (success) {
        setRecommendations(prev =>
          prev.filter(r => r.id !== recommendationId)
        );
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.stats });
      }
      return success;
    } catch (err) {
      logger.error('Failed to ignore recommendation:', err);
      return false;
    }
  }, [queryClient]);

  /**
   * Clear current recommendations
   */
  const clear = useCallback(() => {
    setRecommendations([]);
    setAnalysis(null);
    setError(null);
  }, []);

  /**
   * Refresh recommendations
   */
  const refresh = useCallback(() => {
    if (projectPath) {
      getForProject();
    }
  }, [projectPath, getForProject]);

  /**
   * Fetch recommendation statistics
   */
  const fetchStats = useCallback(async (): Promise<RecommendationStats> => {
    return window.goodvibes.recommendationsGetStats();
  }, []);

  // Query for stats
  const { data: stats = null } = useQuery({
    queryKey: QUERY_KEYS.stats,
    queryFn: fetchStats,
    staleTime: 30000, // 30 seconds
    refetchOnWindowFocus: false,
  });

  return {
    recommendations,
    isLoading,
    error,
    getForPrompt,
    getForProject,
    accept,
    reject,
    ignore,
    clear,
    refresh,
    analysis,
    projectContext,
    stats,
    fetchStats,
  };
}

// ============================================================================
// ADDITIONAL HOOKS
// ============================================================================

/**
 * Hook to get pending recommendations
 */
export function usePendingRecommendations(sessionId?: string) {
  return useQuery({
    queryKey: QUERY_KEYS.pending(sessionId),
    queryFn: () => window.goodvibes.recommendationsGetPending({
      sessionId,
      limit: 20,
    }),
    staleTime: 10000,
    refetchOnWindowFocus: true,
  });
}

/**
 * Hook to get top performing items
 */
export function useTopPerformingItems(type?: 'agent' | 'skill') {
  return useQuery({
    queryKey: [...QUERY_KEYS.topPerforming, type],
    queryFn: () => window.goodvibes.recommendationsGetTopPerforming({
      type,
      minRecommendations: 3,
      limit: 10,
    }),
    staleTime: 60000, // 1 minute
    refetchOnWindowFocus: false,
  });
}

/**
 * Hook to get recommendation statistics
 */
export function useRecommendationStats() {
  return useQuery({
    queryKey: QUERY_KEYS.stats,
    queryFn: () => window.goodvibes.recommendationsGetStats(),
    staleTime: 30000,
    refetchOnWindowFocus: false,
  });
}

export default useRecommendations;
