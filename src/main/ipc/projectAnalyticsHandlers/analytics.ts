// ============================================================================
// ANALYTICS IPC HANDLERS
// ============================================================================

import { ipcMain } from 'electron';
import { getProjectRegistry } from '../../services/projectRegistry/index.js';
import {
  getTestMonitor,
  startTestMonitor,
  stopTestMonitor,
  type TestResult,
  type TestStats,
} from '../../services/testMonitor.js';

// ============================================================================
// ANALYTICS HANDLERS
// ============================================================================

export function registerAnalyticsHandlers(): void {
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

export function registerTestMonitorHandlers(): void {
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
