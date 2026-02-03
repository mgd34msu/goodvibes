// ============================================================================
// PRIMITIVES PRELOAD API
// ============================================================================
//
// MCP servers, agent templates, project configs, agent registry, skills,
// task definitions, session analytics, tool usage
// ============================================================================

import { ipcRenderer } from 'electron';

export const primitivesApi = {
  // ============================================================================
  // MCP SERVERS
  // ============================================================================
  getMCPServers: () =>
    ipcRenderer.invoke('get-mcp-servers'),
  getMCPServer: (id: number) =>
    ipcRenderer.invoke('get-mcp-server', id),
  createMCPServer: (server: { name: string; transport: string; command?: string; args?: string[]; url?: string; env?: Record<string, string>; enabled: boolean; description?: string }) =>
    ipcRenderer.invoke('create-mcp-server', server),
  updateMCPServer: (id: number, updates: Record<string, unknown>) =>
    ipcRenderer.invoke('update-mcp-server', { id, updates }),
  deleteMCPServer: (id: number) =>
    ipcRenderer.invoke('delete-mcp-server', id),
  setMCPServerStatus: (id: number, status: string, errorMessage?: string) =>
    ipcRenderer.invoke('set-mcp-server-status', { id, status, errorMessage }),

  // ============================================================================
  // AGENT TEMPLATES
  // ============================================================================
  getAgentTemplates: () =>
    ipcRenderer.invoke('get-agent-templates'),
  getAgentTemplate: (id: string) =>
    ipcRenderer.invoke('get-agent-template', id),
  createAgentTemplate: (template: { name: string; description?: string; cwd?: string; initialPrompt?: string; claudeMdContent?: string; flags?: string[]; model?: string; permissionMode?: string }) =>
    ipcRenderer.invoke('create-agent-template', template),
  updateAgentTemplate: (id: string, updates: Record<string, unknown>) =>
    ipcRenderer.invoke('update-agent-template', { id, updates }),
  deleteAgentTemplate: (id: string) =>
    ipcRenderer.invoke('delete-agent-template', id),

  // ============================================================================
  // PROJECT CONFIGS
  // ============================================================================
  getProjectConfigs: () =>
    ipcRenderer.invoke('get-project-configs'),
  getProjectConfig: (id: string) =>
    ipcRenderer.invoke('get-project-config', id),
  getProjectConfigByPath: (projectPath: string) =>
    ipcRenderer.invoke('get-project-config-by-path', projectPath),
  createProjectConfig: (config: { projectPath: string; name?: string; defaultModel?: string; permissionMode?: string; autoInjectClaudeMd?: boolean; claudeMdTemplate?: string; enabledHooks?: string[]; enabledMCPServers?: string[] }) =>
    ipcRenderer.invoke('create-project-config', config),
  updateProjectConfig: (id: string, updates: Record<string, unknown>) =>
    ipcRenderer.invoke('update-project-config', { id, updates }),
  deleteProjectConfig: (id: string) =>
    ipcRenderer.invoke('delete-project-config', id),

  // ============================================================================
  // AGENT REGISTRY
  // ============================================================================
  getAgentRegistryEntries: () =>
    ipcRenderer.invoke('get-agent-registry-entries'),
  getAgentRegistryEntry: (id: string) =>
    ipcRenderer.invoke('get-agent-registry-entry', id),
  getActiveAgents: () =>
    ipcRenderer.invoke('get-active-agents'),
  getAgentChildren: (parentId: string) =>
    ipcRenderer.invoke('get-agent-children', parentId),
  createAgentRegistryEntry: (entry: { name: string; cwd: string; status: string; templateId?: string; sessionPath?: string; parentId?: string }) =>
    ipcRenderer.invoke('create-agent-registry-entry', entry),
  updateAgentRegistryEntry: (id: string, updates: Record<string, unknown>) =>
    ipcRenderer.invoke('update-agent-registry-entry', { id, updates }),
  deleteAgentRegistryEntry: (id: string) =>
    ipcRenderer.invoke('delete-agent-registry-entry', id),

  // ============================================================================
  // SKILLS
  // ============================================================================
  getSkills: () =>
    ipcRenderer.invoke('get-skills'),
  getSkill: (id: number) =>
    ipcRenderer.invoke('get-skill', id),
  createSkill: (skill: { name: string; description?: string; content: string; allowedTools?: string[]; scope?: 'user' | 'project'; projectPath?: string }) =>
    ipcRenderer.invoke('create-skill', skill),
  updateSkill: (id: number, updates: Record<string, unknown>) =>
    ipcRenderer.invoke('update-skill', { id, updates }),
  deleteSkill: (id: number) =>
    ipcRenderer.invoke('delete-skill', id),
  incrementSkillUsage: (id: number) =>
    ipcRenderer.invoke('increment-skill-usage', id),

  // ============================================================================
  // TASK DEFINITIONS
  // ============================================================================
  getTaskDefinitions: () =>
    ipcRenderer.invoke('get-task-definitions'),
  getTaskDefinition: (id: number) =>
    ipcRenderer.invoke('get-task-definition', id),
  createTaskDefinition: (task: { name: string; description?: string; prompt: string; cwd?: string; model?: string; permissionMode?: string; timeout?: number; retryCount?: number; tags?: string[] }) =>
    ipcRenderer.invoke('create-task-definition', task),
  updateTaskDefinition: (id: number, updates: Record<string, unknown>) =>
    ipcRenderer.invoke('update-task-definition', { id, updates }),
  deleteTaskDefinition: (id: number) =>
    ipcRenderer.invoke('delete-task-definition', id),

  // ============================================================================
  // SESSION ANALYTICS (EXTENDED)
  // ============================================================================
  getSessionAnalytics: (sessionId: string) =>
    ipcRenderer.invoke('get-session-analytics', sessionId),
  createSessionAnalytics: (analytics: { sessionId: string; thinkingTime?: number; codingTime?: number; toolCalls?: number; filesModified?: number; linesAdded?: number; linesRemoved?: number; errorCount?: number; retryCount?: number }) =>
    ipcRenderer.invoke('create-session-analytics', analytics),
  updateSessionAnalytics: (sessionId: string, updates: Record<string, unknown>) =>
    ipcRenderer.invoke('update-session-analytics', { sessionId, updates }),

  // ============================================================================
  // TOOL USAGE (DETAILED)
  // ============================================================================
  getToolUsageDetailed: (sessionId: string) =>
    ipcRenderer.invoke('get-tool-usage-detailed', sessionId),
  recordToolUsage: (usage: { sessionId: string; toolName: string; input?: string; output?: string; duration?: number; success: boolean; timestamp: number }) =>
    ipcRenderer.invoke('record-tool-usage', usage),
  getToolUsageSummary: () =>
    ipcRenderer.invoke('get-tool-usage-summary'),

  // ============================================================================
  // CLIPBOARD
  // ============================================================================
  clipboardRead: () =>
    ipcRenderer.invoke('clipboard-read'),
  clipboardWrite: (text: string) =>
    ipcRenderer.invoke('clipboard-write', text),

  // ============================================================================
  // CONTEXT MENU
  // ============================================================================
  showContextMenu: (options: { hasSelection: boolean; isEditable: boolean; isTerminal?: boolean }) =>
    ipcRenderer.invoke('show-context-menu', options),
  showTerminalContextMenu: (options: { hasSelection: boolean; selectedText?: string }) =>
    ipcRenderer.invoke('show-terminal-context-menu', options),

  // ============================================================================
  // FILE OPERATIONS
  // ============================================================================
  getHomeDirectory: () => ipcRenderer.invoke('get-home-directory'),
  readDirectory: (dirPath: string) =>
    ipcRenderer.invoke('read-directory', dirPath),
  openFileExternal: (filePath: string) =>
    ipcRenderer.invoke('open-file-external', filePath),
  renameFile: (oldPath: string, newPath: string) =>
    ipcRenderer.invoke('rename-file', oldPath, newPath),
  deleteFile: (filePath: string) =>
    ipcRenderer.invoke('delete-file', filePath),
  deleteDirectory: (dirPath: string) =>
    ipcRenderer.invoke('delete-directory', dirPath),
  createFile: (filePath: string) =>
    ipcRenderer.invoke('create-file', filePath),
  createDirectory: (dirPath: string) =>
    ipcRenderer.invoke('create-directory', dirPath),
  readFileContent: (filePath: string) =>
    ipcRenderer.invoke('read-file-content', filePath),
  writeFileContent: (filePath: string, content: string) =>
    ipcRenderer.invoke('write-file-content', filePath, content),
};
