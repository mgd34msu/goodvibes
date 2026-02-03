// ============================================================================
// RECOMMENDATION IPC HANDLERS
// ============================================================================

import { ipcMain } from 'electron';
import { Logger } from '../../services/logger.js';
import {
  getRecommendationEngine,
  type Recommendation,
  type PromptAnalysis,
  type ProjectContext,
} from '../../services/recommendationEngine.js';
import {
  getRecommendationsForSession,
  getRecommendationsForProject,
  getPendingRecommendations,
  getTopPerformingItems,
  type RecommendationAction,
  type RecommendationType,
  type RecommendationStats,
  type RecommendationRecord,
  type ItemSuccessRate,
} from '../../database/recommendations.js';
import {
  type IPCResult,
  type IPCBooleanResult,
  ipcOk,
  ipcErr,
  ipcBoolOk,
  ipcBoolErr,
} from '../../../shared/types/ipc-types.js';

const logger = new Logger('RecommendationIPC');

// ============================================================================
// RECOMMENDATION HANDLERS
// ============================================================================

export function registerRecommendationHandlers(): void {
  const engine = getRecommendationEngine();

  // ============================================================================
  // PROMPT ANALYSIS & RECOMMENDATIONS
  // ============================================================================

  /**
   * Get recommendations for a user prompt
   * Analyzes the prompt and returns matching agents/skills
   */
  ipcMain.handle('recommendations:getForPrompt', async (
    _event,
    options: {
      prompt: string;
      sessionId?: string;
      projectPath?: string;
    }
  ): Promise<IPCResult<Recommendation[]>> => {
    try {
      engine.initialize();
      const recommendations = await engine.getRecommendationsForPrompt(
        options.prompt,
        options.sessionId ?? null,
        options.projectPath ?? null
      );
      return ipcOk(recommendations);
    } catch (error) {
      logger.error('Failed to get prompt recommendations:', error);
      return ipcErr(error, []);
    }
  });

  /**
   * Get recommendations based on project context only
   * Analyzes package.json, file patterns, etc.
   */
  ipcMain.handle('recommendations:getForProject', async (
    _event,
    projectPath: string
  ): Promise<IPCResult<Recommendation[]>> => {
    try {
      engine.initialize();
      const recommendations = await engine.getRecommendationsForProject(projectPath);
      return ipcOk(recommendations);
    } catch (error) {
      logger.error('Failed to get project recommendations:', error);
      return ipcErr(error, []);
    }
  });

  /**
   * Analyze a prompt without generating recommendations
   * Returns extracted keywords, intents, and technologies
   */
  ipcMain.handle('recommendations:analyzePrompt', async (
    _event,
    prompt: string
  ): Promise<IPCResult<PromptAnalysis>> => {
    const emptyAnalysis: PromptAnalysis = {
      keywords: [],
      intents: [],
      technologies: [],
      frameworks: [],
      actions: [],
    };
    try {
      engine.initialize();
      const analysis = engine.analyzePrompt(prompt);
      return ipcOk(analysis);
    } catch (error) {
      logger.error('Failed to analyze prompt:', error);
      return ipcErr(error, emptyAnalysis);
    }
  });

  /**
   * Analyze project context
   * Returns detected technologies, frameworks, dependencies
   */
  ipcMain.handle('recommendations:analyzeProject', async (
    _event,
    projectPath: string
  ): Promise<IPCResult<ProjectContext>> => {
    const emptyContext: ProjectContext = {
      name: null,
      technologies: [],
      frameworks: [],
      hasTests: false,
      hasDocker: false,
      hasTypeScript: false,
      packageDependencies: [],
    };
    try {
      engine.initialize();
      const context = await engine.analyzeProjectContext(projectPath);
      return ipcOk(context);
    } catch (error) {
      logger.error('Failed to analyze project context:', error);
      return ipcErr(error, emptyContext);
    }
  });

  // ============================================================================
  // FEEDBACK TRACKING
  // ============================================================================

  /**
   * Record user feedback on a recommendation
   * Tracks accept/reject/ignore actions for learning
   */
  ipcMain.handle('recommendations:recordFeedback', async (
    _event,
    options: {
      recommendationId: number;
      action: RecommendationAction;
    }
  ): Promise<IPCBooleanResult> => {
    try {
      engine.initialize();
      engine.recordFeedback(options.recommendationId, options.action);
      return ipcBoolOk();
    } catch (error) {
      logger.error('Failed to record recommendation feedback:', error);
      return ipcBoolErr(error);
    }
  });

  /**
   * Accept a recommendation
   * Shorthand for recordFeedback with 'accepted' action
   */
  ipcMain.handle('recommendations:accept', async (
    _event,
    recommendationId: number
  ): Promise<IPCBooleanResult> => {
    try {
      engine.initialize();
      engine.recordFeedback(recommendationId, 'accepted');
      return ipcBoolOk();
    } catch (error) {
      logger.error('Failed to accept recommendation:', error);
      return ipcBoolErr(error);
    }
  });

  /**
   * Reject a recommendation
   * Shorthand for recordFeedback with 'rejected' action
   */
  ipcMain.handle('recommendations:reject', async (
    _event,
    recommendationId: number
  ): Promise<IPCBooleanResult> => {
    try {
      engine.initialize();
      engine.recordFeedback(recommendationId, 'rejected');
      return ipcBoolOk();
    } catch (error) {
      logger.error('Failed to reject recommendation:', error);
      return ipcBoolErr(error);
    }
  });

  /**
   * Ignore a recommendation
   * Shorthand for recordFeedback with 'ignored' action
   */
  ipcMain.handle('recommendations:ignore', async (
    _event,
    recommendationId: number
  ): Promise<IPCBooleanResult> => {
    try {
      engine.initialize();
      engine.recordFeedback(recommendationId, 'ignored');
      return ipcBoolOk();
    } catch (error) {
      logger.error('Failed to ignore recommendation:', error);
      return ipcBoolErr(error);
    }
  });

  // ============================================================================
  // STATISTICS & HISTORY
  // ============================================================================

  /**
   * Get overall recommendation statistics
   * Returns acceptance rate, breakdown by type/source, top items
   */
  ipcMain.handle('recommendations:getStats', async (): Promise<IPCResult<RecommendationStats>> => {
    const emptyStats: RecommendationStats = {
      totalRecommendations: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      ignoredCount: 0,
      pendingCount: 0,
      acceptanceRate: 0,
      byType: {
        agent: { total: 0, accepted: 0, rate: 0 },
        skill: { total: 0, accepted: 0, rate: 0 },
      },
      bySource: {
        prompt: { total: 0, accepted: 0, rate: 0 },
        project: { total: 0, accepted: 0, rate: 0 },
        context: { total: 0, accepted: 0, rate: 0 },
        historical: { total: 0, accepted: 0, rate: 0 },
      },
      topAcceptedItems: [],
    };
    try {
      engine.initialize();
      const stats = engine.getStats();
      return ipcOk(stats);
    } catch (error) {
      logger.error('Failed to get recommendation stats:', error);
      return ipcErr(error, emptyStats);
    }
  });

  /**
   * Get recommendations history for a session
   */
  ipcMain.handle('recommendations:getForSession', async (
    _event,
    options: {
      sessionId: string;
      limit?: number;
    }
  ): Promise<IPCResult<RecommendationRecord[]>> => {
    try {
      const recommendations = getRecommendationsForSession(options.sessionId, options.limit ?? 50);
      return ipcOk(recommendations);
    } catch (error) {
      logger.error('Failed to get session recommendations:', error);
      return ipcErr(error, []);
    }
  });

  /**
   * Get recommendations history for a project
   */
  ipcMain.handle('recommendations:getHistoryForProject', async (
    _event,
    options: {
      projectPath: string;
      limit?: number;
    }
  ): Promise<IPCResult<RecommendationRecord[]>> => {
    try {
      const recommendations = getRecommendationsForProject(options.projectPath, options.limit ?? 50);
      return ipcOk(recommendations);
    } catch (error) {
      logger.error('Failed to get project recommendation history:', error);
      return ipcErr(error, []);
    }
  });

  /**
   * Get pending recommendations (not yet acted upon)
   */
  ipcMain.handle('recommendations:getPending', async (
    _event,
    options?: {
      sessionId?: string;
      limit?: number;
    }
  ): Promise<IPCResult<RecommendationRecord[]>> => {
    try {
      const recommendations = getPendingRecommendations(options?.sessionId, options?.limit ?? 20);
      return ipcOk(recommendations);
    } catch (error) {
      logger.error('Failed to get pending recommendations:', error);
      return ipcErr(error, []);
    }
  });

  /**
   * Get top performing items (highest acceptance rate)
   */
  ipcMain.handle('recommendations:getTopPerforming', async (
    _event,
    options?: {
      type?: RecommendationType;
      minRecommendations?: number;
      limit?: number;
    }
  ): Promise<IPCResult<ItemSuccessRate[]>> => {
    try {
      const items = getTopPerformingItems(
        options?.type,
        options?.minRecommendations ?? 3,
        options?.limit ?? 20
      );
      return ipcOk(items);
    } catch (error) {
      logger.error('Failed to get top performing items:', error);
      return ipcErr(error, []);
    }
  });

  // ============================================================================
  // CACHE MANAGEMENT
  // ============================================================================

  /**
   * Clear all recommendation caches
   */
  ipcMain.handle('recommendations:clearCache', async (): Promise<IPCBooleanResult> => {
    try {
      engine.clearCaches();
      return ipcBoolOk();
    } catch (error) {
      logger.error('Failed to clear recommendation caches:', error);
      return ipcBoolErr(error);
    }
  });

  /**
   * Clear cache for a specific session
   */
  ipcMain.handle('recommendations:clearSessionCache', async (
    _event,
    sessionId: string
  ): Promise<IPCBooleanResult> => {
    try {
      engine.clearSessionCache(sessionId);
      return ipcBoolOk();
    } catch (error) {
      logger.error('Failed to clear session cache:', error);
      return ipcBoolErr(error);
    }
  });

  // ============================================================================
  // CONFIGURATION
  // ============================================================================

  /**
   * Configure the recommendation engine
   */
  ipcMain.handle('recommendations:configure', async (
    _event,
    config: {
      maxRecommendations?: number;
      minConfidenceScore?: number;
      historicalBoostWeight?: number;
      projectContextWeight?: number;
      cacheTimeoutMs?: number;
    }
  ): Promise<IPCBooleanResult> => {
    try {
      engine.configure(config);
      return ipcBoolOk();
    } catch (error) {
      logger.error('Failed to configure recommendation engine:', error);
      return ipcBoolErr(error);
    }
  });

  logger.debug('Recommendation IPC handlers registered');
}
