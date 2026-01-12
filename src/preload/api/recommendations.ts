// ============================================================================
// RECOMMENDATIONS PRELOAD API
// ============================================================================

import { ipcRenderer } from 'electron';

export const recommendationsApi = {
  // Get recommendations for a prompt
  recommendationsGetForPrompt: (options: { prompt: string; sessionId?: string; projectPath?: string }) =>
    ipcRenderer.invoke('recommendations:getForPrompt', options),

  // Get recommendations based on project context
  recommendationsGetForProject: (projectPath: string) =>
    ipcRenderer.invoke('recommendations:getForProject', projectPath),

  // Analyze a prompt (get keywords, intents, technologies)
  recommendationsAnalyzePrompt: (prompt: string) =>
    ipcRenderer.invoke('recommendations:analyzePrompt', prompt),

  // Analyze project context
  recommendationsAnalyzeProject: (projectPath: string) =>
    ipcRenderer.invoke('recommendations:analyzeProject', projectPath),

  // Record feedback on a recommendation
  recommendationsRecordFeedback: (options: { recommendationId: number; action: 'accepted' | 'rejected' | 'ignored' }) =>
    ipcRenderer.invoke('recommendations:recordFeedback', options),

  // Accept a recommendation (shorthand)
  recommendationsAccept: (recommendationId: number) =>
    ipcRenderer.invoke('recommendations:accept', recommendationId),

  // Reject a recommendation (shorthand)
  recommendationsReject: (recommendationId: number) =>
    ipcRenderer.invoke('recommendations:reject', recommendationId),

  // Ignore a recommendation (shorthand)
  recommendationsIgnore: (recommendationId: number) =>
    ipcRenderer.invoke('recommendations:ignore', recommendationId),

  // Get overall statistics
  recommendationsGetStats: () =>
    ipcRenderer.invoke('recommendations:getStats'),

  // Get recommendations for a session
  recommendationsGetForSession: (options: { sessionId: string; limit?: number }) =>
    ipcRenderer.invoke('recommendations:getForSession', options),

  // Get recommendations history for a project
  recommendationsGetHistoryForProject: (options: { projectPath: string; limit?: number }) =>
    ipcRenderer.invoke('recommendations:getHistoryForProject', options),

  // Get pending recommendations
  recommendationsGetPending: (options?: { sessionId?: string; limit?: number }) =>
    ipcRenderer.invoke('recommendations:getPending', options),

  // Get top performing items
  recommendationsGetTopPerforming: (options?: { type?: 'agent' | 'skill'; minRecommendations?: number; limit?: number }) =>
    ipcRenderer.invoke('recommendations:getTopPerforming', options),

  // Clear all caches
  recommendationsClearCache: () =>
    ipcRenderer.invoke('recommendations:clearCache'),

  // Clear session cache
  recommendationsClearSessionCache: (sessionId: string) =>
    ipcRenderer.invoke('recommendations:clearSessionCache', sessionId),

  // Configure the recommendation engine
  recommendationsConfigure: (config: {
    maxRecommendations?: number;
    minConfidenceScore?: number;
    historicalBoostWeight?: number;
    projectContextWeight?: number;
    cacheTimeoutMs?: number;
  }) =>
    ipcRenderer.invoke('recommendations:configure', config),
};
