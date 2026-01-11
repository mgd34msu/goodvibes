// ============================================================================
// PRELOAD SCRIPT - Bridge between main and renderer
// ============================================================================

import { contextBridge, ipcRenderer } from 'electron';

// Type-safe API for renderer
const api = {
  // ============================================================================
  // TERMINAL
  // ============================================================================
  startClaude: (options: { cwd?: string; name?: string; resumeSessionId?: string; sessionType?: string }) =>
    ipcRenderer.invoke('start-claude', options),
  startPlainTerminal: (options: { cwd?: string; name?: string }) =>
    ipcRenderer.invoke('start-plain-terminal', options),
  terminalInput: (id: number, data: string) =>
    ipcRenderer.invoke('terminal-input', { id, data }),
  terminalResize: (id: number, cols: number, rows: number) =>
    ipcRenderer.invoke('terminal-resize', { id, cols, rows }),
  killTerminal: (id: number) =>
    ipcRenderer.invoke('kill-terminal', id),
  getTerminals: () =>
    ipcRenderer.invoke('get-terminals'),

  // ============================================================================
  // SESSIONS
  // ============================================================================
  getSessions: () =>
    ipcRenderer.invoke('get-sessions'),
  getSession: (id: string) =>
    ipcRenderer.invoke('get-session', id),
  getSessionMessages: (id: string) =>
    ipcRenderer.invoke('get-session-messages', id),
  getActiveSessions: () =>
    ipcRenderer.invoke('get-active-sessions'),
  getFavoriteSessions: () =>
    ipcRenderer.invoke('get-favorite-sessions'),
  getArchivedSessions: () =>
    ipcRenderer.invoke('get-archived-sessions'),
  toggleFavorite: (id: string) =>
    ipcRenderer.invoke('toggle-favorite', id),
  toggleArchive: (id: string) =>
    ipcRenderer.invoke('toggle-archive', id),
  deleteSession: (id: string) =>
    ipcRenderer.invoke('delete-session', id),
  getLiveSessions: () =>
    ipcRenderer.invoke('get-live-sessions'),
  getSessionRawEntries: (id: string) =>
    ipcRenderer.invoke('get-session-raw-entries', id),
  refreshSession: (id: string) =>
    ipcRenderer.invoke('refresh-session', id),
  isSessionLive: (id: string) =>
    ipcRenderer.invoke('is-session-live', id),
  recalculateSessionCosts: () =>
    ipcRenderer.invoke('recalculate-session-costs'),

  // ============================================================================
  // ANALYTICS
  // ============================================================================
  getAnalytics: () =>
    ipcRenderer.invoke('get-analytics'),
  getToolUsage: () =>
    ipcRenderer.invoke('get-tool-usage'),

  // ============================================================================
  // SETTINGS
  // ============================================================================
  getSetting: (key: string) =>
    ipcRenderer.invoke('get-setting', key),
  setSetting: (key: string, value: unknown) =>
    ipcRenderer.invoke('set-setting', { key, value }),
  getAllSettings: () =>
    ipcRenderer.invoke('get-all-settings'),

  // ============================================================================
  // COLLECTIONS
  // ============================================================================
  getCollections: () =>
    ipcRenderer.invoke('get-collections'),
  createCollection: (name: string, color?: string, icon?: string) =>
    ipcRenderer.invoke('create-collection', { name, color, icon }),
  updateCollection: (id: number, name: string, color: string, icon: string) =>
    ipcRenderer.invoke('update-collection', { id, name, color, icon }),
  deleteCollection: (id: number) =>
    ipcRenderer.invoke('delete-collection', id),
  addSessionToCollection: (sessionId: string, collectionId: number) =>
    ipcRenderer.invoke('add-session-to-collection', { sessionId, collectionId }),

  // Smart Collections
  getSmartCollections: () =>
    ipcRenderer.invoke('get-smart-collections'),
  createSmartCollection: (name: string, rules: unknown[], color?: string, icon?: string, matchMode?: string) =>
    ipcRenderer.invoke('create-smart-collection', { name, rules, color, icon, matchMode }),
  getSmartCollectionSessions: (id: number) =>
    ipcRenderer.invoke('get-smart-collection-sessions', id),
  deleteSmartCollection: (id: number) =>
    ipcRenderer.invoke('delete-smart-collection', id),

  // ============================================================================
  // TAGS
  // ============================================================================
  getTags: () =>
    ipcRenderer.invoke('get-tags'),
  createTag: (name: string, color: string) =>
    ipcRenderer.invoke('create-tag', { name, color }),
  deleteTag: (id: number) =>
    ipcRenderer.invoke('delete-tag', id),
  addTagToSession: (sessionId: string, tagId: number) =>
    ipcRenderer.invoke('add-tag-to-session', { sessionId, tagId }),
  removeTagFromSession: (sessionId: string, tagId: number) =>
    ipcRenderer.invoke('remove-tag-from-session', { sessionId, tagId }),
  getSessionTags: (sessionId: string) =>
    ipcRenderer.invoke('get-session-tags', sessionId),

  // ============================================================================
  // PROMPTS
  // ============================================================================
  getPrompts: () =>
    ipcRenderer.invoke('get-prompts'),
  savePrompt: (title: string, content: string, category?: string) =>
    ipcRenderer.invoke('save-prompt', { title, content, category }),
  usePrompt: (id: number) =>
    ipcRenderer.invoke('use-prompt', id),
  deletePrompt: (id: number) =>
    ipcRenderer.invoke('delete-prompt', id),

  // ============================================================================
  // NOTES
  // ============================================================================
  getQuickNotes: (status: string) =>
    ipcRenderer.invoke('get-quick-notes', status),
  createQuickNote: (content: string, sessionId?: string, priority?: string) =>
    ipcRenderer.invoke('create-quick-note', { content, sessionId, priority }),
  updateQuickNote: (id: number, content: string) =>
    ipcRenderer.invoke('update-quick-note', { id, content }),
  setQuickNoteStatus: (id: number, status: string) =>
    ipcRenderer.invoke('set-quick-note-status', { id, status }),
  deleteQuickNote: (id: number) =>
    ipcRenderer.invoke('delete-quick-note', id),

  // ============================================================================
  // NOTIFICATIONS
  // ============================================================================
  getNotifications: (includeRead?: boolean, limit?: number) =>
    ipcRenderer.invoke('get-notifications', { includeRead, limit }),
  getUnreadNotificationCount: () =>
    ipcRenderer.invoke('get-unread-notification-count'),
  markNotificationRead: (id: number) =>
    ipcRenderer.invoke('mark-notification-read', id),
  markAllNotificationsRead: () =>
    ipcRenderer.invoke('mark-all-notifications-read'),
  dismissAllNotifications: () =>
    ipcRenderer.invoke('dismiss-all-notifications'),

  // ============================================================================
  // KNOWLEDGE BASE
  // ============================================================================
  getAllKnowledgeEntries: () =>
    ipcRenderer.invoke('get-all-knowledge-entries'),
  getKnowledgeEntry: (id: number) =>
    ipcRenderer.invoke('get-knowledge-entry', id),
  createKnowledgeEntry: (title: string, content: string, category?: string, tags?: string) =>
    ipcRenderer.invoke('create-knowledge-entry', { title, content, category, tags }),
  updateKnowledgeEntry: (id: number, title: string, content: string, category?: string, tags?: string) =>
    ipcRenderer.invoke('update-knowledge-entry', { id, title, content, category, tags }),
  deleteKnowledgeEntry: (id: number) =>
    ipcRenderer.invoke('delete-knowledge-entry', id),
  searchKnowledge: (term: string) =>
    ipcRenderer.invoke('search-knowledge', term),

  // ============================================================================
  // SEARCH
  // ============================================================================
  searchSessions: (query: string) =>
    ipcRenderer.invoke('search-sessions', query),
  searchSessionsAdvanced: (options: unknown) =>
    ipcRenderer.invoke('search-sessions-advanced', options),
  saveSearch: (name: string, query: string, filters?: unknown) =>
    ipcRenderer.invoke('save-search', { name, query, filters }),
  getSavedSearches: () =>
    ipcRenderer.invoke('get-saved-searches'),
  deleteSavedSearch: (id: number) =>
    ipcRenderer.invoke('delete-saved-search', id),

  // ============================================================================
  // GIT - Basic operations
  // ============================================================================
  gitStatus: (cwd: string) =>
    ipcRenderer.invoke('git-status', cwd),
  gitBranch: (cwd: string) =>
    ipcRenderer.invoke('git-branch', cwd),
  gitLog: (cwd: string) =>
    ipcRenderer.invoke('git-log', cwd),
  gitDiff: (cwd: string, staged?: boolean) =>
    ipcRenderer.invoke('git-diff', { cwd, staged }),
  gitAdd: (cwd: string, files?: string) =>
    ipcRenderer.invoke('git-add', { cwd, files }),
  gitCommit: (cwd: string, message: string) =>
    ipcRenderer.invoke('git-commit', { cwd, message }),
  gitPush: (cwd: string) =>
    ipcRenderer.invoke('git-push', cwd),
  gitPull: (cwd: string) =>
    ipcRenderer.invoke('git-pull', cwd),
  gitIsRepo: (cwd: string) =>
    ipcRenderer.invoke('git-is-repo', cwd),
  gitStash: (cwd: string, action?: string) =>
    ipcRenderer.invoke('git-stash', { cwd, action }),
  gitInit: (cwd: string) =>
    ipcRenderer.invoke('git-init', cwd),
  gitReset: (cwd: string, files?: string[]) =>
    ipcRenderer.invoke('git-reset', { cwd, files }),
  gitFetch: (cwd: string) =>
    ipcRenderer.invoke('git-fetch', cwd),

  // ============================================================================
  // GIT - Enhanced operations for full-featured Git panel
  // ============================================================================
  gitDetailedStatus: (cwd: string) =>
    ipcRenderer.invoke('git-detailed-status', cwd),
  gitBranches: (cwd: string) =>
    ipcRenderer.invoke('git-branches', cwd),
  gitCheckout: (cwd: string, branch: string) =>
    ipcRenderer.invoke('git-checkout', { cwd, branch }),
  gitCreateBranch: (cwd: string, name: string, checkout?: boolean) =>
    ipcRenderer.invoke('git-create-branch', { cwd, name, checkout }),
  gitStage: (cwd: string, files: string[]) =>
    ipcRenderer.invoke('git-stage', { cwd, files }),
  gitUnstage: (cwd: string, files: string[]) =>
    ipcRenderer.invoke('git-unstage', { cwd, files }),
  gitLogDetailed: (cwd: string, limit?: number) =>
    ipcRenderer.invoke('git-log-detailed', { cwd, limit }),
  gitAheadBehind: (cwd: string) =>
    ipcRenderer.invoke('git-ahead-behind', cwd),
  gitDiscardChanges: (cwd: string, files: string[]) =>
    ipcRenderer.invoke('git-discard-changes', { cwd, files }),
  gitCleanFile: (cwd: string, file: string) =>
    ipcRenderer.invoke('git-clean-file', { cwd, file }),
  gitShowCommit: (cwd: string, hash: string) =>
    ipcRenderer.invoke('git-show-commit', { cwd, hash }),
  gitFileDiff: (cwd: string, file?: string, options?: { staged?: boolean; commit?: string }) =>
    ipcRenderer.invoke('git-file-diff', { cwd, file, options }),
  gitDiffRaw: (cwd: string, options?: { staged?: boolean; file?: string; commit?: string }) =>
    ipcRenderer.invoke('git-diff-raw', { cwd, options }),
  gitBranchesWithHierarchy: (cwd: string) =>
    ipcRenderer.invoke('git-branches-with-hierarchy', cwd),

  // Git - Merge operations
  gitMerge: (cwd: string, branch: string, options?: { noFf?: boolean; squash?: boolean }) =>
    ipcRenderer.invoke('git-merge', { cwd, branch, options }),
  gitMergeAbort: (cwd: string) =>
    ipcRenderer.invoke('git-merge-abort', cwd),
  gitMergeInProgress: (cwd: string) =>
    ipcRenderer.invoke('git-merge-in-progress', cwd),

  // Git - Remote operations
  gitRemotes: (cwd: string) =>
    ipcRenderer.invoke('git-remotes', cwd),
  gitRemoteAdd: (cwd: string, name: string, url: string) =>
    ipcRenderer.invoke('git-remote-add', { cwd, name, url }),
  gitRemoteRemove: (cwd: string, name: string) =>
    ipcRenderer.invoke('git-remote-remove', { cwd, name }),

  // Git - Stash operations
  gitStashList: (cwd: string) =>
    ipcRenderer.invoke('git-stash-list', cwd),
  gitStashPush: (cwd: string, message?: string) =>
    ipcRenderer.invoke('git-stash-push', { cwd, message }),
  gitStashPop: (cwd: string, index?: number) =>
    ipcRenderer.invoke('git-stash-pop', { cwd, index }),
  gitStashApply: (cwd: string, index?: number) =>
    ipcRenderer.invoke('git-stash-apply', { cwd, index }),
  gitStashDrop: (cwd: string, index?: number) =>
    ipcRenderer.invoke('git-stash-drop', { cwd, index }),

  // Git - Branch deletion
  gitDeleteBranch: (cwd: string, branch: string, options?: { force?: boolean }) =>
    ipcRenderer.invoke('git-delete-branch', { cwd, branch, options }),
  gitDeleteRemoteBranch: (cwd: string, remote: string, branch: string) =>
    ipcRenderer.invoke('git-delete-remote-branch', { cwd, remote, branch }),

  // Git - Commit amend
  gitCommitAmend: (cwd: string, options?: { message?: string; noEdit?: boolean }) =>
    ipcRenderer.invoke('git-commit-amend', { cwd, options }),

  // Git - Cherry-pick
  gitCherryPick: (cwd: string, commit: string) =>
    ipcRenderer.invoke('git-cherry-pick', { cwd, commit }),
  gitCherryPickAbort: (cwd: string) =>
    ipcRenderer.invoke('git-cherry-pick-abort', cwd),
  gitCherryPickContinue: (cwd: string) =>
    ipcRenderer.invoke('git-cherry-pick-continue', cwd),
  gitCherryPickInProgress: (cwd: string) =>
    ipcRenderer.invoke('git-cherry-pick-in-progress', cwd),

  // Git - Hunk/line staging
  gitApplyPatch: (cwd: string, patch: string, options?: { cached?: boolean; reverse?: boolean }) =>
    ipcRenderer.invoke('git-apply-patch', { cwd, patch, options }),
  gitDiffForStaging: (cwd: string, file: string, staged?: boolean) =>
    ipcRenderer.invoke('git-diff-for-staging', { cwd, file, staged }),

  // Git - Blame
  gitBlame: (cwd: string, file: string, options?: { startLine?: number; endLine?: number }) =>
    ipcRenderer.invoke('git-blame', { cwd, file, options }),

  // Git - Tag management
  gitTags: (cwd: string) =>
    ipcRenderer.invoke('git-tags', cwd),
  gitCreateTag: (cwd: string, name: string, options?: { message?: string; commit?: string }) =>
    ipcRenderer.invoke('git-create-tag', { cwd, name, options }),
  gitDeleteTag: (cwd: string, name: string) =>
    ipcRenderer.invoke('git-delete-tag', { cwd, name }),
  gitPushTag: (cwd: string, name: string, remote?: string) =>
    ipcRenderer.invoke('git-push-tag', { cwd, name, remote }),
  gitPushAllTags: (cwd: string, remote?: string) =>
    ipcRenderer.invoke('git-push-all-tags', { cwd, remote }),
  gitDeleteRemoteTag: (cwd: string, name: string, remote?: string) =>
    ipcRenderer.invoke('git-delete-remote-tag', { cwd, name, remote }),

  // Git - File history
  gitFileHistory: (cwd: string, file: string, limit?: number) =>
    ipcRenderer.invoke('git-file-history', { cwd, file, limit }),
  gitShowFile: (cwd: string, file: string, commit: string) =>
    ipcRenderer.invoke('git-show-file', { cwd, file, commit }),

  // Git - Conflict resolution
  gitConflictFiles: (cwd: string) =>
    ipcRenderer.invoke('git-conflict-files', cwd),
  gitResolveOurs: (cwd: string, file: string) =>
    ipcRenderer.invoke('git-resolve-ours', { cwd, file }),
  gitResolveTheirs: (cwd: string, file: string) =>
    ipcRenderer.invoke('git-resolve-theirs', { cwd, file }),
  gitMarkResolved: (cwd: string, files: string[]) =>
    ipcRenderer.invoke('git-mark-resolved', { cwd, files }),

  // Git - Rebase
  gitRebase: (cwd: string, onto: string) =>
    ipcRenderer.invoke('git-rebase', { cwd, onto }),
  gitRebaseAbort: (cwd: string) =>
    ipcRenderer.invoke('git-rebase-abort', cwd),
  gitRebaseContinue: (cwd: string) =>
    ipcRenderer.invoke('git-rebase-continue', cwd),
  gitRebaseSkip: (cwd: string) =>
    ipcRenderer.invoke('git-rebase-skip', cwd),
  gitRebaseInProgress: (cwd: string) =>
    ipcRenderer.invoke('git-rebase-in-progress', cwd),

  // Git - Reflog
  gitReflog: (cwd: string, limit?: number) =>
    ipcRenderer.invoke('git-reflog', { cwd, limit }),
  gitResetToReflog: (cwd: string, index: number, options?: { hard?: boolean; soft?: boolean }) =>
    ipcRenderer.invoke('git-reset-to-reflog', { cwd, index, options }),

  // Git - Submodules
  gitSubmodules: (cwd: string) =>
    ipcRenderer.invoke('git-submodules', cwd),
  gitSubmoduleInit: (cwd: string, path?: string) =>
    ipcRenderer.invoke('git-submodule-init', { cwd, path }),
  gitSubmoduleUpdate: (cwd: string, options?: { init?: boolean; recursive?: boolean; remote?: boolean; path?: string }) =>
    ipcRenderer.invoke('git-submodule-update', { cwd, options }),

  // Git - Worktrees
  gitWorktrees: (cwd: string) =>
    ipcRenderer.invoke('git-worktrees', cwd),
  gitWorktreeAdd: (cwd: string, path: string, branch?: string, options?: { newBranch?: boolean; detach?: boolean }) =>
    ipcRenderer.invoke('git-worktree-add', { cwd, path, branch, options }),
  gitWorktreeRemove: (cwd: string, path: string, force?: boolean) =>
    ipcRenderer.invoke('git-worktree-remove', { cwd, path, force }),

  // Git - Commit templates
  gitCommitTemplate: (cwd: string) =>
    ipcRenderer.invoke('git-commit-template', cwd),
  gitConventionalPrefixes: (cwd: string) =>
    ipcRenderer.invoke('git-conventional-prefixes', cwd),

  // ============================================================================
  // GITHUB - Authentication
  // OAuth credentials are bundled with the app - end users just click "Connect"
  // ============================================================================
  githubAuth: (options?: { scopes?: string[] }) =>
    ipcRenderer.invoke('github-auth', options),
  githubLogout: () =>
    ipcRenderer.invoke('github-logout'),
  githubIsAuthenticated: () =>
    ipcRenderer.invoke('github-is-authenticated'),
  githubGetUser: () =>
    ipcRenderer.invoke('github-get-user'),
  githubGetAuthState: () =>
    ipcRenderer.invoke('github-get-auth-state'),
  githubGetOAuthConfig: () =>
    ipcRenderer.invoke('github-get-oauth-config'),

  // ============================================================================
  // GITHUB - Repository Operations
  // ============================================================================
  githubListRepos: (options?: { sort?: string; direction?: string; per_page?: number; page?: number }) =>
    ipcRenderer.invoke('github-list-repos', options),
  githubGetRepo: (owner: string, repo: string) =>
    ipcRenderer.invoke('github-get-repo', { owner, repo }),
  githubCreateRepo: (name: string, options?: { description?: string; private?: boolean; auto_init?: boolean }) =>
    ipcRenderer.invoke('github-create-repo', { name, options }),
  githubListOrgRepos: (org: string, options?: { sort?: string; direction?: string; per_page?: number; page?: number }) =>
    ipcRenderer.invoke('github-list-org-repos', { org, options }),

  // ============================================================================
  // GITHUB - Pull Request Operations
  // ============================================================================
  githubListPRs: (owner: string, repo: string, options?: { state?: string; sort?: string; direction?: string; per_page?: number; page?: number }) =>
    ipcRenderer.invoke('github-list-prs', { owner, repo, options }),
  githubGetPR: (owner: string, repo: string, number: number) =>
    ipcRenderer.invoke('github-get-pr', { owner, repo, number }),
  githubCreatePR: (owner: string, repo: string, data: { title: string; body?: string; head: string; base: string; draft?: boolean }) =>
    ipcRenderer.invoke('github-create-pr', { owner, repo, data }),
  githubMergePR: (owner: string, repo: string, number: number, options?: { commit_title?: string; commit_message?: string; merge_method?: string }) =>
    ipcRenderer.invoke('github-merge-pr', { owner, repo, number, options }),
  githubClosePR: (owner: string, repo: string, number: number) =>
    ipcRenderer.invoke('github-close-pr', { owner, repo, number }),

  // ============================================================================
  // GITHUB - CI/CD Status Operations
  // ============================================================================
  githubGetChecks: (owner: string, repo: string, ref: string) =>
    ipcRenderer.invoke('github-get-checks', { owner, repo, ref }),
  githubGetCommitStatus: (owner: string, repo: string, ref: string) =>
    ipcRenderer.invoke('github-get-commit-status', { owner, repo, ref }),
  githubListWorkflowRuns: (owner: string, repo: string, options?: { branch?: string; event?: string; status?: string; per_page?: number; page?: number }) =>
    ipcRenderer.invoke('github-list-workflow-runs', { owner, repo, options }),

  // ============================================================================
  // GITHUB - Issue Operations
  // ============================================================================
  githubListIssues: (owner: string, repo: string, options?: { state?: string; sort?: string; direction?: string; labels?: string; per_page?: number; page?: number }) =>
    ipcRenderer.invoke('github-list-issues', { owner, repo, options }),
  githubGetIssue: (owner: string, repo: string, number: number) =>
    ipcRenderer.invoke('github-get-issue', { owner, repo, number }),
  githubCreateIssue: (owner: string, repo: string, data: { title: string; body?: string; assignees?: string[]; labels?: string[] }) =>
    ipcRenderer.invoke('github-create-issue', { owner, repo, data }),
  githubCloseIssue: (owner: string, repo: string, number: number) =>
    ipcRenderer.invoke('github-close-issue', { owner, repo, number }),

  // ============================================================================
  // GITHUB - Organization Operations
  // ============================================================================
  githubListOrgs: () =>
    ipcRenderer.invoke('github-list-orgs'),

  // ============================================================================
  // GITHUB - Branch Operations
  // ============================================================================
  githubListBranches: (owner: string, repo: string, options?: { protected_only?: boolean; per_page?: number; page?: number }) =>
    ipcRenderer.invoke('github-list-branches', { owner, repo, options }),

  // ============================================================================
  // GITHUB - Utility Operations
  // ============================================================================
  githubParseRemote: (remoteUrl: string) =>
    ipcRenderer.invoke('github-parse-remote', { remoteUrl }),
  githubIsGitHubRemote: (remoteUrl: string) =>
    ipcRenderer.invoke('github-is-github-remote', { remoteUrl }),

  // ============================================================================
  // FILE/FOLDER
  // ============================================================================
  selectFolder: () =>
    ipcRenderer.invoke('select-folder'),
  createFolder: () =>
    ipcRenderer.invoke('create-folder'),
  openInExplorer: (folderPath: string) =>
    ipcRenderer.invoke('open-in-explorer', folderPath),

  // ============================================================================
  // RECENT PROJECTS
  // ============================================================================
  getRecentProjects: () =>
    ipcRenderer.invoke('get-recent-projects'),
  addRecentProject: (projectPath: string, name?: string) =>
    ipcRenderer.invoke('add-recent-project', { path: projectPath, name }),
  removeRecentProject: (projectPath: string) =>
    ipcRenderer.invoke('remove-recent-project', projectPath),
  pinProject: (projectPath: string) =>
    ipcRenderer.invoke('pin-project', projectPath),
  clearRecentProjects: () =>
    ipcRenderer.invoke('clear-recent-projects'),

  // ============================================================================
  // EXPORT
  // ============================================================================
  exportSession: (sessionId: string, format: string) =>
    ipcRenderer.invoke('export-session', { sessionId, format }),
  bulkExport: (sessionIds: string[]) =>
    ipcRenderer.invoke('bulk-export', sessionIds),

  // ============================================================================
  // APP INFO
  // ============================================================================
  getAppVersion: () =>
    ipcRenderer.invoke('get-app-version'),
  getAppPath: (name: string) =>
    ipcRenderer.invoke('get-app-path', name),

  // ============================================================================
  // ACTIVITY LOG
  // ============================================================================
  getRecentActivity: (limit?: number) =>
    ipcRenderer.invoke('get-recent-activity', limit),
  logActivity: (type: string, sessionId: string | null, description: string, metadata?: unknown) =>
    ipcRenderer.invoke('log-activity', { type, sessionId, description, metadata }),
  clearActivityLog: () =>
    ipcRenderer.invoke('clear-activity-log'),

  // ============================================================================
  // HOOKS
  // ============================================================================
  getHooks: () =>
    ipcRenderer.invoke('get-hooks'),
  getHook: (id: number) =>
    ipcRenderer.invoke('get-hook', id),
  createHook: (hook: { name: string; eventType: string; matchPattern?: string; command: string; enabled: boolean; timeout?: number; projectPath?: string }) =>
    ipcRenderer.invoke('create-hook', hook),
  updateHook: (id: number, updates: Record<string, unknown>) =>
    ipcRenderer.invoke('update-hook', { id, updates }),
  deleteHook: (id: number) =>
    ipcRenderer.invoke('delete-hook', id),
  getHooksByEvent: (eventType: string, projectPath?: string) =>
    ipcRenderer.invoke('get-hooks-by-event', { eventType, projectPath }),

  // ============================================================================
  // HOOK EVENTS (Real-time event streaming and budget/approval)
  // ============================================================================
  // Hook server control
  hookServerStatus: () =>
    ipcRenderer.invoke('hook-server-status'),
  hookServerStart: () =>
    ipcRenderer.invoke('hook-server-start'),
  hookServerStop: () =>
    ipcRenderer.invoke('hook-server-stop'),

  // Hook scripts management
  hookScriptsStatus: () =>
    ipcRenderer.invoke('hook-scripts-status'),
  hookScriptsInstall: () =>
    ipcRenderer.invoke('hook-scripts-install'),
  hookScriptsValidate: () =>
    ipcRenderer.invoke('hook-scripts-validate'),
  hookClaudeConfig: () =>
    ipcRenderer.invoke('hook-claude-config'),

  // Hook event queries
  getHookEvents: (limit?: number) =>
    ipcRenderer.invoke('get-hook-events', { limit }),
  getHookEventsBySession: (sessionId: string, limit?: number) =>
    ipcRenderer.invoke('get-hook-events-by-session', { sessionId, limit }),
  getHookEventsByType: (eventType: string, limit?: number) =>
    ipcRenderer.invoke('get-hook-events-by-type', { eventType, limit }),
  getHookEventStats: () =>
    ipcRenderer.invoke('get-hook-event-stats'),
  cleanupHookEvents: (maxAgeHours?: number) =>
    ipcRenderer.invoke('cleanup-hook-events', { maxAgeHours }),

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
  createSkill: (skill: { name: string; description?: string; category?: string; promptTemplate: string; isBuiltIn?: boolean; icon?: string; keywords?: string[]; allowedTools?: string[] }) =>
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
  // AGENCY INDEX (Agent & Skill Browser)
  // ============================================================================

  // Initialization and status
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

  // Categories
  agencyGetCategories: (type?: 'agent' | 'skill') =>
    ipcRenderer.invoke('agency-get-categories', type),
  agencyGetCategoryTree: (type: 'agent' | 'skill') =>
    ipcRenderer.invoke('agency-get-category-tree', type),

  // Indexed agents
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

  // Indexed skills
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

  // Active agents
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

  // Skill queue
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

  // Context injection
  agencyInjectContext: (context: { sessionId: string; projectPath: string; workingDirectory: string }) =>
    ipcRenderer.invoke('agency-inject-context', context),
  agencyReadClaudeMd: (workingDirectory: string) =>
    ipcRenderer.invoke('agency-read-claude-md', workingDirectory),
  agencyClearInjectedSections: (workingDirectory: string) =>
    ipcRenderer.invoke('agency-clear-injected-sections', workingDirectory),
  agencyGetSectionMarkers: () =>
    ipcRenderer.invoke('agency-get-section-markers'),

  // Usage tracking
  agencyRecordAgentUsage: (id: number) =>
    ipcRenderer.invoke('agency-record-agent-usage', id),
  agencyRecordSkillUsage: (id: number) =>
    ipcRenderer.invoke('agency-record-skill-usage', id),

  // ============================================================================
  // EVENT LISTENERS
  // Each listener returns a cleanup function for proper cleanup
  // ============================================================================
  onTerminalData: (callback: (data: { id: number; data: string }) => void): (() => void) => {
    const handler = (_: unknown, data: { id: number; data: string }) => callback(data);
    ipcRenderer.on('terminal-data', handler);
    return () => { ipcRenderer.removeListener('terminal-data', handler); };
  },
  onTerminalExit: (callback: (data: { id: number; exitCode: number }) => void): (() => void) => {
    const handler = (_: unknown, data: { id: number; exitCode: number }) => callback(data);
    ipcRenderer.on('terminal-exit', handler);
    return () => { ipcRenderer.removeListener('terminal-exit', handler); };
  },
  onScanStatus: (callback: (data: { status: string; message?: string; progress?: { current: number; total: number } }) => void): (() => void) => {
    const handler = (_: unknown, data: { status: string; message?: string; progress?: { current: number; total: number } }) => callback(data);
    ipcRenderer.on('scan-status', handler);
    return () => { ipcRenderer.removeListener('scan-status', handler); };
  },
  onSessionDetected: (callback: (data: unknown) => void): (() => void) => {
    const handler = (_: unknown, data: unknown) => callback(data);
    ipcRenderer.on('session-detected', handler);
    return () => { ipcRenderer.removeListener('session-detected', handler); };
  },
  onSubagentSessionUpdate: (callback: (data: unknown) => void): (() => void) => {
    const handler = (_: unknown, data: unknown) => callback(data);
    ipcRenderer.on('subagent-session-update', handler);
    return () => { ipcRenderer.removeListener('subagent-session-update', handler); };
  },
  onNewSession: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('new-session', handler);
    return () => { ipcRenderer.removeListener('new-session', handler); };
  },
  onCloseTab: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('close-tab', handler);
    return () => { ipcRenderer.removeListener('close-tab', handler); };
  },
  onNextTab: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('next-tab', handler);
    return () => { ipcRenderer.removeListener('next-tab', handler); };
  },
  onPrevTab: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('prev-tab', handler);
    return () => { ipcRenderer.removeListener('prev-tab', handler); };
  },
  onSwitchView: (callback: (view: string) => void): (() => void) => {
    const handler = (_: unknown, view: string) => callback(view);
    ipcRenderer.on('switch-view', handler);
    return () => { ipcRenderer.removeListener('switch-view', handler); };
  },
  onOpenSettings: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('open-settings', handler);
    return () => { ipcRenderer.removeListener('open-settings', handler); };
  },
  onShowAbout: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('show-about', handler);
    return () => { ipcRenderer.removeListener('show-about', handler); };
  },

  // Remove all listeners for a channel (use sparingly, prefer individual cleanup)
  removeAllListeners: (channel: string) =>
    ipcRenderer.removeAllListeners(channel),

  // ============================================================================
  // NEW SERVICE EVENT LISTENERS
  // ============================================================================
  onAgentUpdate: (callback: (data: { id: string; status: string; name: string }) => void): (() => void) => {
    const handler = (_: unknown, data: { id: string; status: string; name: string }) => callback(data);
    ipcRenderer.on('agent-update', handler);
    return () => { ipcRenderer.removeListener('agent-update', handler); };
  },
  onAgentDetected: (callback: (data: { id: string; name: string; description?: string; terminalId: number }) => void): (() => void) => {
    const handler = (_: unknown, data: { id: string; name: string; description?: string; terminalId: number }) => callback(data);
    ipcRenderer.on('agent:detected', handler);
    return () => { ipcRenderer.removeListener('agent:detected', handler); };
  },
  onHookExecuted: (callback: (data: { hookId: string; eventType: string; success: boolean; result?: unknown }) => void): (() => void) => {
    const handler = (_: unknown, data: { hookId: string; eventType: string; success: boolean; result?: unknown }) => callback(data);
    ipcRenderer.on('hook-executed', handler);
    return () => { ipcRenderer.removeListener('hook-executed', handler); };
  },
  onMCPServerStatus: (callback: (data: { id: string; status: string; error?: string }) => void): (() => void) => {
    const handler = (_: unknown, data: { id: string; status: string; error?: string }) => callback(data);
    ipcRenderer.on('mcp-server-status', handler);
    return () => { ipcRenderer.removeListener('mcp-server-status', handler); };
  },
  onFileChange: (callback: (data: { type: string; path: string; watchId: string }) => void): (() => void) => {
    const handler = (_: unknown, data: { type: string; path: string; watchId: string }) => callback(data);
    ipcRenderer.on('file-change', handler);
    return () => { ipcRenderer.removeListener('file-change', handler); };
  },
  onStreamEvent: (callback: (data: { type: string; sessionId: string; data?: unknown }) => void): (() => void) => {
    const handler = (_: unknown, data: { type: string; sessionId: string; data?: unknown }) => callback(data);
    ipcRenderer.on('stream-event', handler);
    return () => { ipcRenderer.removeListener('stream-event', handler); };
  },
  onHeadlessTaskUpdate: (callback: (data: { taskId: string; status: string; progress?: number; result?: unknown }) => void): (() => void) => {
    const handler = (_: unknown, data: { taskId: string; status: string; progress?: number; result?: unknown }) => callback(data);
    ipcRenderer.on('headless-task-update', handler);
    return () => { ipcRenderer.removeListener('headless-task-update', handler); };
  },

  // ============================================================================
  // HOOK EVENT LISTENERS (Real-time)
  // ============================================================================
  onHookEvent: (callback: (data: { id: number; eventType: string; sessionId?: string; toolName?: string; blocked: boolean; timestamp: string }) => void): (() => void) => {
    const handler = (_: unknown, data: { id: number; eventType: string; sessionId?: string; toolName?: string; blocked: boolean; timestamp: string }) => callback(data);
    ipcRenderer.on('hook:event', handler);
    return () => { ipcRenderer.removeListener('hook:event', handler); };
  },
  onHookNotification: (callback: (data: { type?: string; message?: string; sessionId?: string }) => void): (() => void) => {
    const handler = (_: unknown, data: { type?: string; message?: string; sessionId?: string }) => callback(data);
    ipcRenderer.on('hook:notification', handler);
    return () => { ipcRenderer.removeListener('hook:notification', handler); };
  },
  onApprovalRequired: (callback: (data: { id: number; sessionId: string; requestType: string; requestDetails: string }) => void): (() => void) => {
    const handler = (_: unknown, data: { id: number; sessionId: string; requestType: string; requestDetails: string }) => callback(data);
    ipcRenderer.on('hook:approval-required', handler);
    return () => { ipcRenderer.removeListener('hook:approval-required', handler); };
  },

  // ============================================================================
  // TEST MONITOR (Phase 9)
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

  // Test Monitor Event Listeners
  onTestResult: (callback: (data: {
    id: string;
    sessionId: string | null;
    projectPath: string | null;
    command: string;
    timestamp: string;
    status: 'passed' | 'failed' | 'error' | 'unknown';
    totalTests: number;
    passedTests: number;
    failedTests: number;
    skippedTests: number;
    framework: string;
  }) => void): (() => void) => {
    const handler = (_: unknown, data: {
      id: string;
      sessionId: string | null;
      projectPath: string | null;
      command: string;
      timestamp: string;
      status: 'passed' | 'failed' | 'error' | 'unknown';
      totalTests: number;
      passedTests: number;
      failedTests: number;
      skippedTests: number;
      framework: string;
    }) => callback(data);
    ipcRenderer.on('test-monitor:result', handler);
    return () => { ipcRenderer.removeListener('test-monitor:result', handler); };
  },

  // ============================================================================
  // PROJECT REGISTRY (Phase 11)
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
  // PROJECT TEMPLATES (Phase 11)
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
  // PROJECT COORDINATOR (Phase 11)
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

  // Project Coordinator Event Listeners
  onProjectEvent: (callback: (data: { event: string; projectId: number; data: unknown }) => void): (() => void) => {
    const handler = (_: unknown, data: { event: string; projectId: number; data: unknown }) => callback(data);
    ipcRenderer.on('project:event', handler);
    return () => { ipcRenderer.removeListener('project:event', handler); };
  },
  onProjectSwitched: (callback: (data: { projectId: number; projectPath: string }) => void): (() => void) => {
    const handler = (_: unknown, data: { projectId: number; projectPath: string }) => callback(data);
    ipcRenderer.on('project:switched', handler);
    return () => { ipcRenderer.removeListener('project:switched', handler); };
  },

  // ============================================================================
  // RECOMMENDATIONS (Phase 10)
  // ============================================================================

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

  // Recommendation Event Listeners
  onRecommendationsNew: (callback: (data: {
    sessionId: string | null;
    recommendations: Array<{
      id: number;
      type: 'agent' | 'skill';
      itemId: number;
      slug: string;
      name: string;
      description: string | null;
      confidenceScore: number;
      source: 'prompt' | 'project' | 'context' | 'historical';
      matchedKeywords: string[];
      reasoning: string;
    }>;
  }) => void): (() => void) => {
    const handler = (_: unknown, data: {
      sessionId: string | null;
      recommendations: Array<{
        id: number;
        type: 'agent' | 'skill';
        itemId: number;
        slug: string;
        name: string;
        description: string | null;
        confidenceScore: number;
        source: 'prompt' | 'project' | 'context' | 'historical';
        matchedKeywords: string[];
        reasoning: string;
      }>;
    }) => callback(data);
    ipcRenderer.on('recommendations:new', handler);
    return () => { ipcRenderer.removeListener('recommendations:new', handler); };
  },
};

// Expose API to renderer
contextBridge.exposeInMainWorld('clausitron', api);

// Type declaration for renderer
export type ClausitronAPI = typeof api;
