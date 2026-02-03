// ============================================================================
// RECOMMENDATION ENGINE SERVICE - Agent recommendations based on prompts
// ============================================================================
//
// This service analyzes user prompts via the UserPromptSubmit hook and
// recommends relevant agents and skills from the indexed agency library.
//
// Features:
// - Keyword extraction from user prompts
// - Intent detection (build, fix, test, deploy, etc.)
// - Project context analysis (package.json, file patterns)
// - Historical success rate boosting
// - Per-session recommendation caching
//
// ============================================================================

import { EventEmitter } from 'events';
import { Logger } from '../logger.js';
import { getMainWindow } from '../../window.js';
import {
  createRecommendationsTables,
  recordRecommendation,
  recordRecommendationAction,
  getRecommendationStats,
  getTopPerformingItems,
  wasRecentlyRecommended,
  type RecommendationAction,
  type RecommendationStats,
} from '../../database/recommendations.js';

// Import types
import type {
  Recommendation,
  PromptAnalysis,
  ProjectContext,
  RecommendationEngineConfig,
} from './types.js';

// Import generators
import {
  analyzePrompt as analyzePromptFn,
  analyzeProjectContext as analyzeProjectContextFn,
  getRecommendationsForProject as getRecommendationsForProjectFn,
} from './generators.js';

// Import scorers
import {
  searchAgentsForPrompt,
  searchSkillsForPrompt,
} from './scorers.js';

// Re-export types for external consumers
export type {
  Recommendation,
  PromptAnalysis,
  ProjectContext,
  RecommendationEngineConfig,
} from './types.js';

const logger = new Logger('RecommendationEngine');

// ============================================================================
// RECOMMENDATION ENGINE CLASS
// ============================================================================

class RecommendationEngineClass extends EventEmitter {
  private initialized: boolean = false;
  private config: RecommendationEngineConfig;
  private sessionCache: Map<string, {
    recommendations: Recommendation[];
    timestamp: number;
    promptHash: string;
  }> = new Map();
  private projectContextCache: Map<string, {
    context: ProjectContext;
    timestamp: number;
  }> = new Map();

  constructor() {
    super();
    this.setMaxListeners(50);
    this.config = {
      maxRecommendations: 5,
      minConfidenceScore: 0.3,
      historicalBoostWeight: 0.2,
      projectContextWeight: 0.3,
      cacheTimeoutMs: 5 * 60 * 1000, // 5 minutes
    };
  }

  /**
   * Initialize the recommendation engine
   */
  initialize(): void {
    if (this.initialized) return;

    createRecommendationsTables();
    this.initialized = true;

    logger.info('Recommendation engine initialized');
  }

  /**
   * Configure the recommendation engine
   */
  configure(config: Partial<RecommendationEngineConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ============================================================================
  // PROMPT ANALYSIS
  // ============================================================================

  /**
   * Analyze a user prompt to extract keywords, intents, and technologies
   */
  analyzePrompt(prompt: string): PromptAnalysis {
    return analyzePromptFn(prompt);
  }

  // ============================================================================
  // PROJECT CONTEXT ANALYSIS
  // ============================================================================

  /**
   * Analyze project directory for context
   */
  async analyzeProjectContext(projectPath: string): Promise<ProjectContext> {
    return analyzeProjectContextFn(
      projectPath,
      this.projectContextCache,
      this.config.cacheTimeoutMs
    );
  }

  // ============================================================================
  // RECOMMENDATION GENERATION
  // ============================================================================

  /**
   * Get recommendations for a prompt
   */
  async getRecommendationsForPrompt(
    prompt: string,
    sessionId: string | null,
    projectPath: string | null
  ): Promise<Recommendation[]> {
    this.initialize();

    // Analyze prompt
    const analysis = this.analyzePrompt(prompt);

    if (analysis.keywords.length === 0) {
      return [];
    }

    // Get project context if available
    let projectContext: ProjectContext | null = null;
    if (projectPath) {
      projectContext = await this.analyzeProjectContext(projectPath);
    }

    // Get historical success data
    const topAgents = getTopPerformingItems('agent', 2, 20);
    const topSkills = getTopPerformingItems('skill', 2, 20);
    const historicalBoosts = new Map<string, number>();
    for (const item of [...topAgents, ...topSkills]) {
      historicalBoosts.set(`${item.type}:${item.itemId}`, item.successRate);
    }

    // Generate recommendations
    const recommendations: Recommendation[] = [];

    // Search agents
    const agentResults = await searchAgentsForPrompt(analysis, projectContext, historicalBoosts, this.config);
    recommendations.push(...agentResults);

    // Search skills
    const skillResults = await searchSkillsForPrompt(analysis, projectContext, historicalBoosts, this.config);
    recommendations.push(...skillResults);

    // Sort by confidence score
    recommendations.sort((a, b) => b.confidenceScore - a.confidenceScore);

    // Filter by minimum score and take top N
    const filtered = recommendations
      .filter(r => r.confidenceScore >= this.config.minConfidenceScore)
      .slice(0, this.config.maxRecommendations);

    // Record recommendations in database
    const recorded: Recommendation[] = [];
    for (const rec of filtered) {
      // Skip if recently recommended
      if (wasRecentlyRecommended(rec.itemId, rec.type, sessionId, 10)) {
        continue;
      }

      const record = recordRecommendation({
        sessionId,
        projectPath,
        recommendationType: rec.type,
        itemId: rec.itemId,
        itemSlug: rec.slug,
        itemName: rec.name,
        confidenceScore: rec.confidenceScore,
        source: rec.source,
        matchedKeywords: JSON.stringify(rec.matchedKeywords),
        promptSnippet: prompt.slice(0, 200),
      });

      recorded.push({
        ...rec,
        id: record.id,
      });
    }

    // Emit event
    this.emit('recommendations:generated', {
      sessionId,
      projectPath,
      count: recorded.length,
      recommendations: recorded,
    });

    // Notify renderer
    this.notifyRenderer('recommendations:new', {
      sessionId,
      recommendations: recorded,
    });

    return recorded;
  }

  /**
   * Get recommendations based on project context only
   */
  async getRecommendationsForProject(
    projectPath: string
  ): Promise<Recommendation[]> {
    this.initialize();

    const projectContext = await this.analyzeProjectContext(projectPath);
    return getRecommendationsForProjectFn(projectContext, this.config);
  }

  // ============================================================================
  // FEEDBACK HANDLING
  // ============================================================================

  /**
   * Record user feedback on a recommendation
   */
  recordFeedback(recommendationId: number, action: RecommendationAction): void {
    this.initialize();
    recordRecommendationAction(recommendationId, action);

    this.emit('recommendations:feedback', { recommendationId, action });
    logger.debug(`Recommendation ${recommendationId} ${action}`);
  }

  /**
   * Get recommendation statistics
   */
  getStats(): RecommendationStats {
    this.initialize();
    return getRecommendationStats();
  }

  // ============================================================================
  // CACHE MANAGEMENT
  // ============================================================================

  /**
   * Clear all caches
   */
  clearCaches(): void {
    this.sessionCache.clear();
    this.projectContextCache.clear();
    logger.debug('Recommendation caches cleared');
  }

  /**
   * Clear cache for a specific session
   */
  clearSessionCache(sessionId: string): void {
    this.sessionCache.delete(sessionId);
  }

  // ============================================================================
  // UTILITIES
  // ============================================================================

  /**
   * Notify the renderer process
   */
  private notifyRenderer(channel: string, data: unknown): void {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
    }
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let recommendationEngine: RecommendationEngineClass | null = null;

export function getRecommendationEngine(): RecommendationEngineClass {
  if (!recommendationEngine) {
    recommendationEngine = new RecommendationEngineClass();
  }
  return recommendationEngine;
}

export function initializeRecommendationEngine(): RecommendationEngineClass {
  recommendationEngine = new RecommendationEngineClass();
  recommendationEngine.initialize();
  return recommendationEngine;
}

export { RecommendationEngineClass };
