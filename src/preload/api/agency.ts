// ============================================================================
// AGENCY INDEX PRELOAD API
// ============================================================================

import { ipcRenderer } from 'electron';

export const agencyApi = {
  // ============================================================================
  // INITIALIZATION AND STATUS
  // ============================================================================
  agencyIndexStatus: () =>
    ipcRenderer.invoke('agency-index-status'),
  agencyIndexInit: (config: { agencyPath: string }) =>
    ipcRenderer.invoke('agency-index-init', config),

  // Agent indexer
  agencyIndexAgents: () =>
    ipcRenderer.invoke('agency-index-agents'),
  agencyAgentIndexerStatus: () =>
    ipcRenderer.invoke('agency-agent-indexer-status'),

  // Skill indexer
  agencyIndexSkills: () =>
    ipcRenderer.invoke('agency-index-skills'),
  agencySkillIndexerStatus: () =>
    ipcRenderer.invoke('agency-skill-indexer-status'),

  // ============================================================================
  // CATEGORIES
  // ============================================================================
  agencyGetCategories: (type?: 'agent' | 'skill') =>
    ipcRenderer.invoke('agency-get-categories', type),
  agencyGetCategoryTree: (type: 'agent' | 'skill') =>
    ipcRenderer.invoke('agency-get-category-tree', type),

  // ============================================================================
  // INDEXED AGENTS
  // ============================================================================
  agencyGetIndexedAgents: () =>
    ipcRenderer.invoke('agency-get-indexed-agents'),
  agencyGetIndexedAgent: (id: number) =>
    ipcRenderer.invoke('agency-get-indexed-agent', id),
  agencyGetIndexedAgentBySlug: (slug: string) =>
    ipcRenderer.invoke('agency-get-indexed-agent-by-slug', slug),
  agencyGetAgentsByCategory: (categoryPath: string) =>
    ipcRenderer.invoke('agency-get-agents-by-category', categoryPath),
  agencyGetPopularAgents: (limit?: number) =>
    ipcRenderer.invoke('agency-get-popular-agents', limit),
  agencyGetRecentAgents: (limit?: number) =>
    ipcRenderer.invoke('agency-get-recent-agents', limit),
  agencySearchAgents: (query: string, limit?: number) =>
    ipcRenderer.invoke('agency-search-agents', { query, limit }),

  // ============================================================================
  // INDEXED SKILLS
  // ============================================================================
  agencyGetIndexedSkills: () =>
    ipcRenderer.invoke('agency-get-indexed-skills'),
  agencyGetIndexedSkill: (id: number) =>
    ipcRenderer.invoke('agency-get-indexed-skill', id),
  agencyGetIndexedSkillBySlug: (slug: string) =>
    ipcRenderer.invoke('agency-get-indexed-skill-by-slug', slug),
  agencyGetSkillsByCategory: (categoryPath: string) =>
    ipcRenderer.invoke('agency-get-skills-by-category', categoryPath),
  agencyGetSkillsByAgent: (agentSlug: string) =>
    ipcRenderer.invoke('agency-get-skills-by-agent', agentSlug),
  agencyGetPopularSkills: (limit?: number) =>
    ipcRenderer.invoke('agency-get-popular-skills', limit),
  agencyGetRecentSkills: (limit?: number) =>
    ipcRenderer.invoke('agency-get-recent-skills', limit),
  agencySearchSkills: (query: string, limit?: number) =>
    ipcRenderer.invoke('agency-search-skills', { query, limit }),

  // ============================================================================
  // ACTIVE AGENTS
  // ============================================================================
  agencyActivateAgent: (agentId: number, sessionId?: string, projectPath?: string, priority?: number) =>
    ipcRenderer.invoke('agency-activate-agent', { agentId, sessionId, projectPath, priority }),
  agencyDeactivateAgent: (agentId: number, sessionId?: string, projectPath?: string) =>
    ipcRenderer.invoke('agency-deactivate-agent', { agentId, sessionId, projectPath }),
  agencyGetActiveAgentsForSession: (sessionId: string) =>
    ipcRenderer.invoke('agency-get-active-agents-for-session', sessionId),
  agencyGetActiveAgentsForProject: (projectPath: string) =>
    ipcRenderer.invoke('agency-get-active-agents-for-project', projectPath),
  agencyGetAllActiveAgents: () =>
    ipcRenderer.invoke('agency-get-all-active-agents'),

  // ============================================================================
  // SKILL QUEUE
  // ============================================================================
  agencyQueueSkill: (skillId: number, sessionId?: string, projectPath?: string, priority?: number) =>
    ipcRenderer.invoke('agency-queue-skill', { skillId, sessionId, projectPath, priority }),
  agencyRemoveQueuedSkill: (id: number) =>
    ipcRenderer.invoke('agency-remove-queued-skill', id),
  agencyGetPendingSkills: () =>
    ipcRenderer.invoke('agency-get-pending-skills'),
  agencyGetPendingSkillsForSession: (sessionId: string) =>
    ipcRenderer.invoke('agency-get-pending-skills-for-session', sessionId),
  agencyClearSkillQueue: (sessionId?: string, projectPath?: string) =>
    ipcRenderer.invoke('agency-clear-skill-queue', { sessionId, projectPath }),

  // ============================================================================
  // CONTEXT INJECTION
  // ============================================================================
  agencyInjectContext: (context: { sessionId: string; projectPath: string; workingDirectory: string }) =>
    ipcRenderer.invoke('agency-inject-context', context),
  agencyReadClaudeMd: (workingDirectory: string) =>
    ipcRenderer.invoke('agency-read-claude-md', workingDirectory),
  agencyClearInjectedSections: (workingDirectory: string) =>
    ipcRenderer.invoke('agency-clear-injected-sections', workingDirectory),
  agencyGetSectionMarkers: () =>
    ipcRenderer.invoke('agency-get-section-markers'),

  // ============================================================================
  // USAGE TRACKING
  // ============================================================================
  agencyRecordAgentUsage: (id: number) =>
    ipcRenderer.invoke('agency-record-agent-usage', id),
  agencyRecordSkillUsage: (id: number) =>
    ipcRenderer.invoke('agency-record-skill-usage', id),
};
