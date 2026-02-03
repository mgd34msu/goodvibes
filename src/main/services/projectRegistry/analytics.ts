// ============================================================================
// PROJECT REGISTRY - Analytics Operations
// ============================================================================

import { Logger } from '../logger.js';
import {
  recordCrossProjectSession,
  getCrossProjectSessionBySessionId,
  getProjectSessions,
  getActiveCrossProjectSessions,
  updateCrossProjectSession,
  incrementSessionMetrics,
  getProjectAnalytics,
  getGlobalAnalytics,
  getAgentUsageByProject,
  getSessionDistribution,
  compareProjects,
  cleanupOldSessions,
  type CrossProjectSession,
  type ProjectAnalytics,
  type GlobalAnalytics,
} from '../../database/projectRegistry.js';
import type { ProjectContext } from './types.js';

const _logger = new Logger('ProjectRegistryService:Analytics');

// Reference to project contexts map (injected from main module)
let projectContextsRef: Map<number, ProjectContext> | null = null;
let emitEventFn: ((event: string, data: Record<string, unknown>) => void) | null = null;

export function setAnalyticsContexts(contexts: Map<number, ProjectContext>): void {
  projectContextsRef = contexts;
}

export function setAnalyticsEventEmitter(fn: (event: string, data: Record<string, unknown>) => void): void {
  emitEventFn = fn;
}

function emitEvent(event: string, data: Record<string, unknown>): void {
  if (emitEventFn) {
    emitEventFn(event, data);
  }
}

// ============================================================================
// SESSION TRACKING
// ============================================================================

/**
 * Start tracking a session for a project
 */
export function startProjectSession(
  sessionId: string,
  projectId: number,
  agentSessionId?: string,
  metadata?: Record<string, unknown>,
  updateContextFn?: (projectId: number, updates: { activeSessionId: string | null }) => void
): CrossProjectSession {
  const session = recordCrossProjectSession(sessionId, projectId, agentSessionId, metadata);

  // Update context if function provided
  if (updateContextFn) {
    updateContextFn(projectId, { activeSessionId: sessionId });
  }

  emitEvent('session:started', { sessionId, projectId });
  return session;
}

/**
 * Get session tracking info
 */
export function getSessionTracking(sessionId: string): CrossProjectSession | null {
  return getCrossProjectSessionBySessionId(sessionId);
}

/**
 * Get all sessions for a project
 */
export function getSessionsForProject(projectId: number, limit: number = 50): CrossProjectSession[] {
  return getProjectSessions(projectId, limit);
}

/**
 * Get all active sessions across projects
 */
export function getActiveSessionsAcrossProjects(): CrossProjectSession[] {
  return getActiveCrossProjectSessions();
}

/**
 * Complete a session
 */
export function completeSession(sessionId: string, success: boolean = true): void {
  updateCrossProjectSession(sessionId, {
    status: success ? 'completed' : 'failed',
  });

  // Clear from context
  const session = getCrossProjectSessionBySessionId(sessionId);
  if (session && projectContextsRef) {
    const context = projectContextsRef.get(session.projectId);
    if (context && context.activeSessionId === sessionId) {
      context.activeSessionId = null;
    }
  }

  emitEvent('session:completed', { sessionId, success });
}

/**
 * Update session metrics
 */
export function updateSessionUsage(sessionId: string, tokens: number, cost: number): void {
  incrementSessionMetrics(sessionId, tokens, cost);
}

// ============================================================================
// ANALYTICS
// ============================================================================

/**
 * Get analytics for a specific project
 */
export function getAnalyticsForProject(projectId: number): ProjectAnalytics | null {
  return getProjectAnalytics(projectId);
}

/**
 * Get global analytics across all projects
 */
export function getGlobalProjectAnalytics(): GlobalAnalytics {
  return getGlobalAnalytics();
}

/**
 * Get agent usage statistics by project
 */
export function getAgentUsageStats(): ReturnType<typeof getAgentUsageByProject> {
  return getAgentUsageByProject();
}

/**
 * Get session distribution across projects
 */
export function getSessionDistributionStats(): ReturnType<typeof getSessionDistribution> {
  return getSessionDistribution();
}

/**
 * Compare analytics between multiple projects
 */
export function compareProjectAnalytics(projectIds: number[]): ProjectAnalytics[] {
  return compareProjects(projectIds);
}

/**
 * Get total cost across all projects
 */
export function getTotalCostAcrossProjects(): number {
  const analytics = getGlobalAnalytics();
  return analytics.totalCostUsd;
}

// ============================================================================
// MAINTENANCE
// ============================================================================

/**
 * Clean up old session records
 */
export function cleanup(maxAgeDays: number = 90): number {
  return cleanupOldSessions(maxAgeDays);
}
