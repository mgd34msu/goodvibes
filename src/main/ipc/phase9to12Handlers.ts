// ============================================================================
// PHASE 9-12 IPC HANDLERS - Project Registry, Coordination, Templates, Recommendations
// ============================================================================
//
// This module registers IPC handlers for the Phase 9-12 features:
// - Project Registry (registration, settings, analytics)
// - Project Coordination (cross-project agents, shared skills)
// - Project Templates (create, apply, manage)
// - Global Analytics (cross-project metrics)
// - Test Monitor (test result parsing, statistics)
// - Agent Recommendations (Phase 10)
//
// ============================================================================

import { ipcMain } from 'electron';
import { Logger } from '../services/logger.js';
import { getProjectRegistry } from '../services/projectRegistry.js';
import { getProjectCoordinator } from '../services/projectCoordinator.js';
import {
  getTestMonitor,
  startTestMonitor,
  stopTestMonitor,
  type TestResult,
  type TestStats,
} from '../services/testMonitor.js';
import type {
  ProjectSettings,
  ProjectAgentSettings,
  TemplateAgent,
} from '../database/projectRegistry.js';
import {
  getRecommendationEngine,
  type Recommendation,
  type PromptAnalysis,
  type ProjectContext,
} from '../services/recommendationEngine.js';
import {
  getRecommendationsForSession,
  getRecommendationsForProject,
  getPendingRecommendations,
  getTopPerformingItems,
  type RecommendationAction,
  type RecommendationType,
  type RecommendationStats,
} from '../database/recommendations.js';

const logger = new Logger('Phase9to12IPC');

// ============================================================================
// REGISTRATION
// ============================================================================

export function registerPhase9to12Handlers(): void {
  // Project Registry Handlers
  registerProjectHandlers();

  // Template Handlers
  registerTemplateHandlers();

  // Coordination Handlers
  registerCoordinationHandlers();

  // Analytics Handlers
  registerAnalyticsHandlers();

  // Test Monitor Handlers
  registerTestMonitorHandlers();

  // Recommendation Handlers (Phase 10)
  registerRecommendationHandlers();

  logger.info('Phase 9-12 IPC handlers registered');
}

// ============================================================================
// PROJECT HANDLERS
// ============================================================================

function registerProjectHandlers(): void {
  const registry = getProjectRegistry();

  // Register a new project
  ipcMain.handle('project:register', async (_event, options: {
    path: string;
    name?: string;
    description?: string;
    settings?: ProjectSettings;
  }) => {
    return registry.addProject(
      options.path,
      options.name,
      options.description,
      options.settings
    );
  });

  // Update project
  ipcMain.handle('project:update', async (_event, projectId: number, updates: {
    name?: string;
    description?: string | null;
    settings?: ProjectSettings;
  }) => {
    return registry.updateProject(projectId, updates);
  });

  // Remove project
  ipcMain.handle('project:remove', async (_event, projectId: number) => {
    registry.removeProject(projectId);
    return true;
  });

  // Get all projects
  ipcMain.handle('project:getAll', async () => {
    return registry.getAllProjects();
  });

  // Get single project
  ipcMain.handle('project:get', async (_event, projectId: number) => {
    return registry.getProject(projectId);
  });

  // Get project by path
  ipcMain.handle('project:getByPath', async (_event, path: string) => {
    return registry.getProjectByPath(path);
  });

  // Search projects
  ipcMain.handle('project:search', async (_event, query: string) => {
    return registry.findProjects(query);
  });

  // Get project settings
  ipcMain.handle('project:getSettings', async (_event, projectId: number) => {
    return registry.getProjectSettings(projectId);
  });

  // Update project settings
  ipcMain.handle('project:updateSettings', async (_event, projectId: number, settings: ProjectSettings) => {
    return registry.updateProjectSettings(projectId, settings);
  });

  // Switch project context
  ipcMain.handle('project:switch', async (_event, projectId: number) => {
    return registry.switchProject(projectId);
  });

  // Get current project
  ipcMain.handle('project:getCurrent', async () => {
    return registry.getCurrentProject();
  });

  // Get project context
  ipcMain.handle('project:getContext', async (_event, projectId: number) => {
    return registry.getProjectContext(projectId);
  });

  // Assign agent to project
  ipcMain.handle('project:assignAgent', async (_event, options: {
    projectId: number;
    agentId: number;
    priority?: number;
    settings?: ProjectAgentSettings;
  }) => {
    return registry.addAgentToProject(
      options.projectId,
      options.agentId,
      options.priority ?? 0,
      options.settings
    );
  });

  // Get project agents
  ipcMain.handle('project:getAgents', async (_event, projectId: number) => {
    return registry.getAgentsForProject(projectId);
  });

  // Update project agent
  ipcMain.handle('project:updateAgent', async (_event, agentAssignmentId: number, updates: {
    priority?: number;
    settings?: ProjectAgentSettings;
  }) => {
    return registry.updateAgentConfig(agentAssignmentId, updates);
  });

  // Remove agent from project
  ipcMain.handle('project:removeAgent', async (_event, projectId: number, agentId: number) => {
    registry.removeAgentFromProjectConfig(projectId, agentId);
    return true;
  });

  // Get auto-activate agents
  ipcMain.handle('project:getAutoActivateAgents', async (_event, projectId: number) => {
    return registry.getAutoActivateAgents(projectId);
  });
}

// ============================================================================
// TEMPLATE HANDLERS
// ============================================================================

function registerTemplateHandlers(): void {
  const registry = getProjectRegistry();

  // Create template
  ipcMain.handle('template:create', async (_event, options: {
    name: string;
    description?: string;
    settings?: ProjectSettings;
    agents?: TemplateAgent[];
  }) => {
    return registry.createTemplate(
      options.name,
      options.description,
      options.settings,
      options.agents
    );
  });

  // Get template by ID
  ipcMain.handle('template:get', async (_event, templateId: number) => {
    return registry.getTemplate(templateId);
  });

  // Get template by name
  ipcMain.handle('template:getByName', async (_event, name: string) => {
    return registry.getTemplateByName(name);
  });

  // Get all templates
  ipcMain.handle('template:getAll', async () => {
    return registry.getAllTemplates();
  });

  // Update template
  ipcMain.handle('template:update', async (_event, templateId: number, updates: {
    name?: string;
    description?: string | null;
    settings?: ProjectSettings;
    agents?: TemplateAgent[];
  }) => {
    return registry.updateTemplate(templateId, updates);
  });

  // Delete template
  ipcMain.handle('template:delete', async (_event, templateId: number) => {
    registry.removeTemplate(templateId);
    return true;
  });

  // Apply template to project
  ipcMain.handle('template:apply', async (_event, projectId: number, templateId: number) => {
    return registry.applyTemplate(projectId, templateId);
  });

  // Create template from project
  ipcMain.handle('template:createFromProject', async (_event, options: {
    projectId: number;
    templateName: string;
    description?: string;
  }) => {
    return registry.createTemplateFromExistingProject(
      options.projectId,
      options.templateName,
      options.description
    );
  });
}

// ============================================================================
// COORDINATION HANDLERS
// ============================================================================

function registerCoordinationHandlers(): void {
  const coordinator = getProjectCoordinator();

  // Register cross-project agent
  ipcMain.handle('coordinator:registerAgent', async (_event, options: {
    agentId: number;
    agentName: string;
    projectIds: number[];
  }) => {
    return coordinator.registerCrossProjectAgent(
      options.agentId,
      options.agentName,
      options.projectIds
    );
  });

  // Unregister cross-project agent
  ipcMain.handle('coordinator:unregisterAgent', async (_event, agentId: number) => {
    coordinator.unregisterCrossProjectAgent(agentId);
    return true;
  });

  // Get cross-project agent
  ipcMain.handle('coordinator:getAgent', async (_event, agentId: number) => {
    return coordinator.getCrossProjectAgent(agentId);
  });

  // Get all cross-project agents
  ipcMain.handle('coordinator:getAllAgents', async () => {
    return coordinator.getAllCrossProjectAgents();
  });

  // Get agents for project
  ipcMain.handle('coordinator:getAgentsForProject', async (_event, projectId: number) => {
    return coordinator.getAgentsForProject(projectId);
  });

  // Transition agent to project
  ipcMain.handle('coordinator:transitionAgent', async (_event, agentId: number, targetProjectId: number) => {
    return coordinator.transitionAgentToProject(agentId, targetProjectId);
  });

  // Update agent status
  ipcMain.handle('coordinator:updateAgentStatus', async (_event, agentId: number, status: 'idle' | 'active' | 'transitioning') => {
    coordinator.updateAgentStatus(agentId, status);
    return true;
  });

  // Share skill across projects
  ipcMain.handle('coordinator:shareSkill', async (_event, options: {
    skillId: number;
    skillName: string;
    projectIds: number[];
    settings?: Record<string, unknown>;
  }) => {
    return coordinator.shareSkillAcrossProjects(
      options.skillId,
      options.skillName,
      options.projectIds,
      options.settings
    );
  });

  // Unshare skill from projects
  ipcMain.handle('coordinator:unshareSkill', async (_event, skillId: number, projectIds: number[]) => {
    coordinator.unshareSkillFromProjects(skillId, projectIds);
    return true;
  });

  // Get shared skill config
  ipcMain.handle('coordinator:getSharedSkill', async (_event, skillId: number) => {
    return coordinator.getSharedSkillConfig(skillId);
  });

  // Get all shared skills
  ipcMain.handle('coordinator:getAllSharedSkills', async () => {
    return coordinator.getAllSharedSkillConfigs();
  });

  // Get shared skills for project
  ipcMain.handle('coordinator:getSharedSkillsForProject', async (_event, projectId: number) => {
    return coordinator.getSharedSkillsForProject(projectId);
  });

  // Update shared skill settings
  ipcMain.handle('coordinator:updateSharedSkillSettings', async (_event, skillId: number, settings: Record<string, unknown>) => {
    return coordinator.updateSharedSkillSettings(skillId, settings);
  });

  // Toggle shared skill
  ipcMain.handle('coordinator:toggleSharedSkill', async (_event, skillId: number, enabled: boolean) => {
    coordinator.setSharedSkillEnabled(skillId, enabled);
    return true;
  });

  // Get project state
  ipcMain.handle('coordinator:getProjectState', async (_event, projectId: number) => {
    return coordinator.getProjectState(projectId);
  });

  // Update project state
  ipcMain.handle('coordinator:updateProjectState', async (_event, projectId: number, updates: {
    activeAgents?: number[];
    pendingSkills?: number[];
    sessionId?: string | null;
  }) => {
    return coordinator.updateProjectState(projectId, updates);
  });

  // Sync project states
  ipcMain.handle('coordinator:syncStates', async (_event, sourceProjectId: number, targetProjectIds: number[]) => {
    coordinator.syncProjectStates(sourceProjectId, targetProjectIds);
    return true;
  });

  // Get all project states
  ipcMain.handle('coordinator:getAllStates', async () => {
    return coordinator.getAllProjectStates();
  });

  // Broadcast to projects
  ipcMain.handle('coordinator:broadcast', async (_event, options: {
    type: string;
    data: Record<string, unknown>;
    targetProjectIds: number[];
    sourceProjectId?: number;
  }) => {
    return coordinator.broadcastToProjects(
      options.type,
      options.data,
      options.targetProjectIds,
      options.sourceProjectId
    );
  });

  // Broadcast to all projects
  ipcMain.handle('coordinator:broadcastAll', async (_event, options: {
    type: string;
    data: Record<string, unknown>;
    sourceProjectId?: number;
  }) => {
    return coordinator.broadcastToAllProjects(
      options.type,
      options.data,
      options.sourceProjectId
    );
  });

  // Get pending events for project
  ipcMain.handle('coordinator:getPendingEvents', async (_event, projectId: number) => {
    return coordinator.getPendingEventsForProject(projectId);
  });

  // Mark event handled
  ipcMain.handle('coordinator:markEventHandled', async (_event, eventId: string) => {
    coordinator.markEventHandled(eventId);
    return true;
  });

  // Get coordination status
  ipcMain.handle('coordinator:getStatus', async () => {
    return coordinator.getStatus();
  });
}

// ============================================================================
// ANALYTICS HANDLERS
// ============================================================================

function registerAnalyticsHandlers(): void {
  const registry = getProjectRegistry();

  // Get project analytics
  ipcMain.handle('project:getAnalytics', async (_event, projectId: number) => {
    return registry.getAnalyticsForProject(projectId);
  });

  // Get global analytics
  ipcMain.handle('project:getGlobalAnalytics', async () => {
    return registry.getGlobalProjectAnalytics();
  });

  // Get agent usage stats
  ipcMain.handle('project:getAgentUsageStats', async () => {
    return registry.getAgentUsageStats();
  });

  // Get session distribution
  ipcMain.handle('project:getSessionDistribution', async () => {
    return registry.getSessionDistributionStats();
  });

  // Compare project analytics
  ipcMain.handle('project:compareAnalytics', async (_event, projectIds: number[]) => {
    return registry.compareProjectAnalytics(projectIds);
  });

  // Get total cost across projects
  ipcMain.handle('project:getTotalCost', async () => {
    return registry.getTotalCostAcrossProjects();
  });

  // Get project sessions
  ipcMain.handle('project:getSessions', async (_event, projectId: number, limit?: number) => {
    return registry.getSessionsForProject(projectId, limit);
  });

  // Get active sessions across projects
  ipcMain.handle('project:getActiveSessions', async () => {
    return registry.getActiveSessionsAcrossProjects();
  });

  // Start project session
  ipcMain.handle('project:startSession', async (_event, options: {
    sessionId: string;
    projectId: number;
    agentSessionId?: string;
    metadata?: Record<string, unknown>;
  }) => {
    return registry.startProjectSession(
      options.sessionId,
      options.projectId,
      options.agentSessionId,
      options.metadata
    );
  });

  // Complete session
  ipcMain.handle('project:completeSession', async (_event, sessionId: string, success?: boolean) => {
    registry.completeSession(sessionId, success ?? true);
    return true;
  });

  // Update session usage
  ipcMain.handle('project:updateSessionUsage', async (_event, sessionId: string, tokens: number, cost: number) => {
    registry.updateSessionUsage(sessionId, tokens, cost);
    return true;
  });

  // Get registry status
  ipcMain.handle('project:getStatus', async () => {
    return registry.getStatus();
  });

  // Cleanup old data
  ipcMain.handle('project:cleanup', async (_event, maxAgeDays?: number) => {
    return registry.cleanup(maxAgeDays ?? 90);
  });
}

// ============================================================================
// TEST MONITOR HANDLERS
// ============================================================================

function registerTestMonitorHandlers(): void {
  const testMonitor = getTestMonitor();

  // Start the test monitor
  ipcMain.handle('test-monitor:start', async () => {
    startTestMonitor();
    return testMonitor.getStatus();
  });

  // Stop the test monitor
  ipcMain.handle('test-monitor:stop', async () => {
    stopTestMonitor();
    return { listening: false, resultCount: 0 };
  });

  // Get monitor status
  ipcMain.handle('test-monitor:status', async () => {
    return testMonitor.getStatus();
  });

  // Get recent test results
  ipcMain.handle('test-monitor:getRecentResults', async (
    _event,
    options?: { limit?: number; sessionId?: string }
  ): Promise<TestResult[]> => {
    return testMonitor.getRecentResults(
      options?.limit ?? 20,
      options?.sessionId
    );
  });

  // Get a specific test result by ID
  ipcMain.handle('test-monitor:getResult', async (
    _event,
    id: string
  ): Promise<TestResult | null> => {
    return testMonitor.getResult(id);
  });

  // Get test statistics
  ipcMain.handle('test-monitor:getStats', async (
    _event,
    sessionId?: string
  ): Promise<TestStats> => {
    return testMonitor.getStats(sessionId);
  });

  // Clear all test results
  ipcMain.handle('test-monitor:clear', async () => {
    testMonitor.clear();
    return true;
  });

  // Subscribe to test result events
  ipcMain.handle('test-monitor:subscribe', async () => {
    if (!testMonitor.getStatus().listening) {
      startTestMonitor();
    }
    return { subscribed: true };
  });

  // Unsubscribe from test result events
  ipcMain.handle('test-monitor:unsubscribe', async () => {
    return { subscribed: false };
  });
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize Phase 9-12 services
 * Call this during app startup after hook server is ready
 */
export function initializePhase9to12Services(): void {
  startTestMonitor();
  logger.info('Phase 9-12 monitoring services initialized');
}

/**
 * Cleanup Phase 9-12 services
 * Call this during app shutdown
 */
export function cleanupPhase9to12Services(): void {
  stopTestMonitor();
  logger.info('Phase 9-12 monitoring services cleaned up');
}

// ============================================================================
// RECOMMENDATION HANDLERS (Phase 10)
// ============================================================================

function registerRecommendationHandlers(): void {
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
  ): Promise<Recommendation[]> => {
    try {
      engine.initialize();
      return await engine.getRecommendationsForPrompt(
        options.prompt,
        options.sessionId ?? null,
        options.projectPath ?? null
      );
    } catch (error) {
      logger.error('Failed to get prompt recommendations:', error);
      return [];
    }
  });

  /**
   * Get recommendations based on project context only
   * Analyzes package.json, file patterns, etc.
   */
  ipcMain.handle('recommendations:getForProject', async (
    _event,
    projectPath: string
  ): Promise<Recommendation[]> => {
    try {
      engine.initialize();
      return await engine.getRecommendationsForProject(projectPath);
    } catch (error) {
      logger.error('Failed to get project recommendations:', error);
      return [];
    }
  });

  /**
   * Analyze a prompt without generating recommendations
   * Returns extracted keywords, intents, and technologies
   */
  ipcMain.handle('recommendations:analyzePrompt', async (
    _event,
    prompt: string
  ): Promise<PromptAnalysis> => {
    try {
      engine.initialize();
      return engine.analyzePrompt(prompt);
    } catch (error) {
      logger.error('Failed to analyze prompt:', error);
      return {
        keywords: [],
        intents: [],
        technologies: [],
        frameworks: [],
        actions: [],
      };
    }
  });

  /**
   * Analyze project context
   * Returns detected technologies, frameworks, dependencies
   */
  ipcMain.handle('recommendations:analyzeProject', async (
    _event,
    projectPath: string
  ): Promise<ProjectContext> => {
    try {
      engine.initialize();
      return await engine.analyzeProjectContext(projectPath);
    } catch (error) {
      logger.error('Failed to analyze project context:', error);
      return {
        name: null,
        technologies: [],
        frameworks: [],
        hasTests: false,
        hasDocker: false,
        hasTypeScript: false,
        packageDependencies: [],
      };
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
  ): Promise<boolean> => {
    try {
      engine.initialize();
      engine.recordFeedback(options.recommendationId, options.action);
      return true;
    } catch (error) {
      logger.error('Failed to record recommendation feedback:', error);
      return false;
    }
  });

  /**
   * Accept a recommendation
   * Shorthand for recordFeedback with 'accepted' action
   */
  ipcMain.handle('recommendations:accept', async (
    _event,
    recommendationId: number
  ): Promise<boolean> => {
    try {
      engine.initialize();
      engine.recordFeedback(recommendationId, 'accepted');
      return true;
    } catch (error) {
      logger.error('Failed to accept recommendation:', error);
      return false;
    }
  });

  /**
   * Reject a recommendation
   * Shorthand for recordFeedback with 'rejected' action
   */
  ipcMain.handle('recommendations:reject', async (
    _event,
    recommendationId: number
  ): Promise<boolean> => {
    try {
      engine.initialize();
      engine.recordFeedback(recommendationId, 'rejected');
      return true;
    } catch (error) {
      logger.error('Failed to reject recommendation:', error);
      return false;
    }
  });

  /**
   * Ignore a recommendation
   * Shorthand for recordFeedback with 'ignored' action
   */
  ipcMain.handle('recommendations:ignore', async (
    _event,
    recommendationId: number
  ): Promise<boolean> => {
    try {
      engine.initialize();
      engine.recordFeedback(recommendationId, 'ignored');
      return true;
    } catch (error) {
      logger.error('Failed to ignore recommendation:', error);
      return false;
    }
  });

  // ============================================================================
  // STATISTICS & HISTORY
  // ============================================================================

  /**
   * Get overall recommendation statistics
   * Returns acceptance rate, breakdown by type/source, top items
   */
  ipcMain.handle('recommendations:getStats', async (): Promise<RecommendationStats> => {
    try {
      engine.initialize();
      return engine.getStats();
    } catch (error) {
      logger.error('Failed to get recommendation stats:', error);
      return {
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
  ) => {
    try {
      return getRecommendationsForSession(options.sessionId, options.limit ?? 50);
    } catch (error) {
      logger.error('Failed to get session recommendations:', error);
      return [];
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
  ) => {
    try {
      return getRecommendationsForProject(options.projectPath, options.limit ?? 50);
    } catch (error) {
      logger.error('Failed to get project recommendation history:', error);
      return [];
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
  ) => {
    try {
      return getPendingRecommendations(options?.sessionId, options?.limit ?? 20);
    } catch (error) {
      logger.error('Failed to get pending recommendations:', error);
      return [];
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
  ) => {
    try {
      return getTopPerformingItems(
        options?.type,
        options?.minRecommendations ?? 3,
        options?.limit ?? 20
      );
    } catch (error) {
      logger.error('Failed to get top performing items:', error);
      return [];
    }
  });

  // ============================================================================
  // CACHE MANAGEMENT
  // ============================================================================

  /**
   * Clear all recommendation caches
   */
  ipcMain.handle('recommendations:clearCache', async (): Promise<boolean> => {
    try {
      engine.clearCaches();
      return true;
    } catch (error) {
      logger.error('Failed to clear recommendation caches:', error);
      return false;
    }
  });

  /**
   * Clear cache for a specific session
   */
  ipcMain.handle('recommendations:clearSessionCache', async (
    _event,
    sessionId: string
  ): Promise<boolean> => {
    try {
      engine.clearSessionCache(sessionId);
      return true;
    } catch (error) {
      logger.error('Failed to clear session cache:', error);
      return false;
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
  ): Promise<boolean> => {
    try {
      engine.configure(config);
      return true;
    } catch (error) {
      logger.error('Failed to configure recommendation engine:', error);
      return false;
    }
  });

  logger.debug('Recommendation IPC handlers registered');
}
