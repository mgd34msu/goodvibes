// ============================================================================
// PROJECT REGISTRY PRELOAD API
// ============================================================================

import { ipcRenderer } from 'electron';

export const projectRegistryApi = {
  // ============================================================================
  // TEST MONITOR
  // ============================================================================
  testMonitorStart: () =>
    ipcRenderer.invoke('test-monitor:start'),
  testMonitorStop: () =>
    ipcRenderer.invoke('test-monitor:stop'),
  testMonitorStatus: () =>
    ipcRenderer.invoke('test-monitor:status'),
  testMonitorGetRecentResults: (options?: { limit?: number; sessionId?: string }) =>
    ipcRenderer.invoke('test-monitor:getRecentResults', options),
  testMonitorGetResult: (id: string) =>
    ipcRenderer.invoke('test-monitor:getResult', id),
  testMonitorGetStats: (sessionId?: string) =>
    ipcRenderer.invoke('test-monitor:getStats', sessionId),
  testMonitorClear: () =>
    ipcRenderer.invoke('test-monitor:clear'),
  testMonitorSubscribe: () =>
    ipcRenderer.invoke('test-monitor:subscribe'),
  testMonitorUnsubscribe: () =>
    ipcRenderer.invoke('test-monitor:unsubscribe'),

  // ============================================================================
  // PROJECT REGISTRY
  // ============================================================================
  projectRegister: (options: { path: string; name?: string; description?: string; settings?: Record<string, unknown> }) =>
    ipcRenderer.invoke('project:register', options),
  projectUpdate: (projectId: number, updates: { name?: string; description?: string | null; settings?: Record<string, unknown> }) =>
    ipcRenderer.invoke('project:update', projectId, updates),
  projectRemove: (projectId: number) =>
    ipcRenderer.invoke('project:remove', projectId),
  projectGetAll: () =>
    ipcRenderer.invoke('project:getAll'),
  projectGet: (projectId: number) =>
    ipcRenderer.invoke('project:get', projectId),
  projectGetByPath: (path: string) =>
    ipcRenderer.invoke('project:getByPath', path),
  projectSearch: (query: string) =>
    ipcRenderer.invoke('project:search', query),
  projectGetSettings: (projectId: number) =>
    ipcRenderer.invoke('project:getSettings', projectId),
  projectUpdateSettings: (projectId: number, settings: Record<string, unknown>) =>
    ipcRenderer.invoke('project:updateSettings', projectId, settings),
  projectSwitch: (projectId: number) =>
    ipcRenderer.invoke('project:switch', projectId),
  projectGetCurrent: () =>
    ipcRenderer.invoke('project:getCurrent'),
  projectGetContext: (projectId: number) =>
    ipcRenderer.invoke('project:getContext', projectId),
  projectAssignAgent: (options: { projectId: number; agentId: number; priority?: number; settings?: Record<string, unknown> }) =>
    ipcRenderer.invoke('project:assignAgent', options),
  projectGetAgents: (projectId: number) =>
    ipcRenderer.invoke('project:getAgents', projectId),
  projectUpdateAgent: (agentAssignmentId: number, updates: { priority?: number; settings?: Record<string, unknown> }) =>
    ipcRenderer.invoke('project:updateAgent', agentAssignmentId, updates),
  projectRemoveAgent: (projectId: number, agentId: number) =>
    ipcRenderer.invoke('project:removeAgent', projectId, agentId),
  projectGetAutoActivateAgents: (projectId: number) =>
    ipcRenderer.invoke('project:getAutoActivateAgents', projectId),
  projectGetAnalytics: (projectId: number) =>
    ipcRenderer.invoke('project:getAnalytics', projectId),
  projectGetGlobalAnalytics: () =>
    ipcRenderer.invoke('project:getGlobalAnalytics'),
  projectGetAgentUsageStats: () =>
    ipcRenderer.invoke('project:getAgentUsageStats'),
  projectGetSessionDistribution: () =>
    ipcRenderer.invoke('project:getSessionDistribution'),
  projectCompareAnalytics: (projectIds: number[]) =>
    ipcRenderer.invoke('project:compareAnalytics', projectIds),
  projectGetTotalCost: () =>
    ipcRenderer.invoke('project:getTotalCost'),
  projectGetSessions: (projectId: number, limit?: number) =>
    ipcRenderer.invoke('project:getSessions', projectId, limit),
  projectGetActiveSessions: () =>
    ipcRenderer.invoke('project:getActiveSessions'),
  projectStartSession: (options: { sessionId: string; projectId: number; agentSessionId?: string; metadata?: Record<string, unknown> }) =>
    ipcRenderer.invoke('project:startSession', options),
  projectCompleteSession: (sessionId: string, success?: boolean) =>
    ipcRenderer.invoke('project:completeSession', sessionId, success),
  projectUpdateSessionUsage: (sessionId: string, tokens: number, cost: number) =>
    ipcRenderer.invoke('project:updateSessionUsage', sessionId, tokens, cost),
  projectGetStatus: () =>
    ipcRenderer.invoke('project:getStatus'),
  projectCleanup: (maxAgeDays?: number) =>
    ipcRenderer.invoke('project:cleanup', maxAgeDays),

  // ============================================================================
  // PROJECT TEMPLATES
  // ============================================================================
  templateCreate: (options: { name: string; description?: string; settings?: Record<string, unknown>; agents?: Array<{ agentId: number; priority: number; settings: Record<string, unknown> }> }) =>
    ipcRenderer.invoke('template:create', options),
  templateGet: (templateId: number) =>
    ipcRenderer.invoke('template:get', templateId),
  templateGetByName: (name: string) =>
    ipcRenderer.invoke('template:getByName', name),
  templateGetAll: () =>
    ipcRenderer.invoke('template:getAll'),
  templateUpdate: (templateId: number, updates: { name?: string; description?: string | null; settings?: Record<string, unknown>; agents?: Array<{ agentId: number; priority: number; settings: Record<string, unknown> }> }) =>
    ipcRenderer.invoke('template:update', templateId, updates),
  templateDelete: (templateId: number) =>
    ipcRenderer.invoke('template:delete', templateId),
  templateApply: (projectId: number, templateId: number) =>
    ipcRenderer.invoke('template:apply', projectId, templateId),
  templateCreateFromProject: (options: { projectId: number; templateName: string; description?: string }) =>
    ipcRenderer.invoke('template:createFromProject', options),

  // ============================================================================
  // PROJECT COORDINATOR
  // ============================================================================
  coordinatorRegisterAgent: (options: { agentId: number; agentName: string; projectIds: number[] }) =>
    ipcRenderer.invoke('coordinator:registerAgent', options),
  coordinatorUnregisterAgent: (agentId: number) =>
    ipcRenderer.invoke('coordinator:unregisterAgent', agentId),
  coordinatorGetAgent: (agentId: number) =>
    ipcRenderer.invoke('coordinator:getAgent', agentId),
  coordinatorGetAllAgents: () =>
    ipcRenderer.invoke('coordinator:getAllAgents'),
  coordinatorGetAgentsForProject: (projectId: number) =>
    ipcRenderer.invoke('coordinator:getAgentsForProject', projectId),
  coordinatorTransitionAgent: (agentId: number, targetProjectId: number) =>
    ipcRenderer.invoke('coordinator:transitionAgent', agentId, targetProjectId),
  coordinatorUpdateAgentStatus: (agentId: number, status: 'idle' | 'active' | 'transitioning') =>
    ipcRenderer.invoke('coordinator:updateAgentStatus', agentId, status),
  coordinatorShareSkill: (options: { skillId: number; skillName: string; projectIds: number[]; settings?: Record<string, unknown> }) =>
    ipcRenderer.invoke('coordinator:shareSkill', options),
  coordinatorUnshareSkill: (skillId: number, projectIds: number[]) =>
    ipcRenderer.invoke('coordinator:unshareSkill', skillId, projectIds),
  coordinatorGetSharedSkill: (skillId: number) =>
    ipcRenderer.invoke('coordinator:getSharedSkill', skillId),
  coordinatorGetAllSharedSkills: () =>
    ipcRenderer.invoke('coordinator:getAllSharedSkills'),
  coordinatorGetSharedSkillsForProject: (projectId: number) =>
    ipcRenderer.invoke('coordinator:getSharedSkillsForProject', projectId),
  coordinatorUpdateSharedSkillSettings: (skillId: number, settings: Record<string, unknown>) =>
    ipcRenderer.invoke('coordinator:updateSharedSkillSettings', skillId, settings),
  coordinatorToggleSharedSkill: (skillId: number, enabled: boolean) =>
    ipcRenderer.invoke('coordinator:toggleSharedSkill', skillId, enabled),
  coordinatorGetProjectState: (projectId: number) =>
    ipcRenderer.invoke('coordinator:getProjectState', projectId),
  coordinatorUpdateProjectState: (projectId: number, updates: { activeAgents?: number[]; pendingSkills?: number[]; sessionId?: string | null }) =>
    ipcRenderer.invoke('coordinator:updateProjectState', projectId, updates),
  coordinatorSyncStates: (sourceProjectId: number, targetProjectIds: number[]) =>
    ipcRenderer.invoke('coordinator:syncStates', sourceProjectId, targetProjectIds),
  coordinatorGetAllStates: () =>
    ipcRenderer.invoke('coordinator:getAllStates'),
  coordinatorBroadcast: (options: { type: string; data: Record<string, unknown>; targetProjectIds: number[]; sourceProjectId?: number }) =>
    ipcRenderer.invoke('coordinator:broadcast', options),
  coordinatorBroadcastAll: (options: { type: string; data: Record<string, unknown>; sourceProjectId?: number }) =>
    ipcRenderer.invoke('coordinator:broadcastAll', options),
  coordinatorGetPendingEvents: (projectId: number) =>
    ipcRenderer.invoke('coordinator:getPendingEvents', projectId),
  coordinatorMarkEventHandled: (eventId: string) =>
    ipcRenderer.invoke('coordinator:markEventHandled', eventId),
  coordinatorGetStatus: () =>
    ipcRenderer.invoke('coordinator:getStatus'),
};
