// ============================================================================
// TEST SETUP
// ============================================================================

/// <reference types="@testing-library/jest-dom" />

import '@testing-library/jest-dom/vitest';
import { vi, beforeEach } from 'vitest';

// Mock window.goodvibes API
const mockGoodVibesAPI = {
  // Terminal
  startClaude: vi.fn().mockResolvedValue({ id: 1 }),
  startPlainTerminal: vi.fn().mockResolvedValue({ id: 1, name: 'Terminal', cwd: '/test/path' }),
  terminalInput: vi.fn().mockResolvedValue(true),
  terminalResize: vi.fn().mockResolvedValue(true),
  killTerminal: vi.fn().mockResolvedValue(true),
  getTerminals: vi.fn().mockResolvedValue([]),
  showTerminalContextMenu: vi.fn().mockResolvedValue(null),
  clipboardRead: vi.fn().mockResolvedValue(''),
  clipboardWrite: vi.fn().mockResolvedValue(true),

  // Sessions
  getSessions: vi.fn().mockResolvedValue([]),
  getSession: vi.fn().mockResolvedValue(null),
  getSessionMessages: vi.fn().mockResolvedValue([]),
  getActiveSessions: vi.fn().mockResolvedValue([]),
  getFavoriteSessions: vi.fn().mockResolvedValue([]),
  getArchivedSessions: vi.fn().mockResolvedValue([]),
  toggleFavorite: vi.fn().mockResolvedValue(true),
  toggleArchive: vi.fn().mockResolvedValue(true),
  deleteSession: vi.fn().mockResolvedValue(true),
  getLiveSessions: vi.fn().mockResolvedValue([]),
  getMostRecentSession: vi.fn().mockResolvedValue(null),

  // Analytics
  getAnalytics: vi.fn().mockResolvedValue({
    totalSessions: 0,
    totalTokens: 0,
    totalCost: 0,
    avgTokensPerSession: 0,
    sessionsOverTime: [],
    costByProject: {},
  }),
  getToolUsage: vi.fn().mockResolvedValue([]),

  // Settings
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(true),
  getAllSettings: vi.fn().mockResolvedValue({}),

  // Collections
  getCollections: vi.fn().mockResolvedValue([]),
  createCollection: vi.fn().mockResolvedValue({ id: 1 }),
  updateCollection: vi.fn().mockResolvedValue(true),
  deleteCollection: vi.fn().mockResolvedValue(true),
  addSessionToCollection: vi.fn().mockResolvedValue(true),
  getSmartCollections: vi.fn().mockResolvedValue([]),
  createSmartCollection: vi.fn().mockResolvedValue({ id: 1 }),
  getSmartCollectionSessions: vi.fn().mockResolvedValue([]),
  deleteSmartCollection: vi.fn().mockResolvedValue(true),

  // Tags
  getTags: vi.fn().mockResolvedValue([]),
  createTag: vi.fn().mockResolvedValue(true),
  deleteTag: vi.fn().mockResolvedValue(true),
  addTagToSession: vi.fn().mockResolvedValue(true),
  removeTagFromSession: vi.fn().mockResolvedValue(true),
  getSessionTags: vi.fn().mockResolvedValue([]),

  // Prompts
  getPrompts: vi.fn().mockResolvedValue([]),
  savePrompt: vi.fn().mockResolvedValue({ id: 1 }),
  usePrompt: vi.fn().mockResolvedValue(true),
  deletePrompt: vi.fn().mockResolvedValue(true),

  // Notes
  getQuickNotes: vi.fn().mockResolvedValue([]),
  createQuickNote: vi.fn().mockResolvedValue({ id: 1 }),
  updateQuickNote: vi.fn().mockResolvedValue(true),
  setQuickNoteStatus: vi.fn().mockResolvedValue(true),
  deleteQuickNote: vi.fn().mockResolvedValue(true),

  // Notifications
  getNotifications: vi.fn().mockResolvedValue([]),
  getUnreadNotificationCount: vi.fn().mockResolvedValue(0),
  markNotificationRead: vi.fn().mockResolvedValue(true),
  markAllNotificationsRead: vi.fn().mockResolvedValue(true),
  dismissAllNotifications: vi.fn().mockResolvedValue(true),

  // Knowledge
  getAllKnowledgeEntries: vi.fn().mockResolvedValue([]),
  getKnowledgeEntry: vi.fn().mockResolvedValue(null),
  createKnowledgeEntry: vi.fn().mockResolvedValue({ id: 1 }),
  updateKnowledgeEntry: vi.fn().mockResolvedValue(true),
  deleteKnowledgeEntry: vi.fn().mockResolvedValue(true),
  searchKnowledge: vi.fn().mockResolvedValue([]),

  // Search
  searchSessions: vi.fn().mockResolvedValue([]),
  searchSessionsAdvanced: vi.fn().mockResolvedValue([]),
  saveSearch: vi.fn().mockResolvedValue({ id: 1 }),
  getSavedSearches: vi.fn().mockResolvedValue([]),
  deleteSavedSearch: vi.fn().mockResolvedValue(true),

  // Git
  gitStatus: vi.fn().mockResolvedValue(''),
  gitBranch: vi.fn().mockResolvedValue(''),
  gitLog: vi.fn().mockResolvedValue([]),
  gitDiff: vi.fn().mockResolvedValue(''),
  gitAdd: vi.fn().mockResolvedValue(true),
  gitCommit: vi.fn().mockResolvedValue(true),
  gitPush: vi.fn().mockResolvedValue(true),
  gitPull: vi.fn().mockResolvedValue(true),
  gitIsRepo: vi.fn().mockResolvedValue(true),
  gitStash: vi.fn().mockResolvedValue(true),
  gitInit: vi.fn().mockResolvedValue(true),
  gitReset: vi.fn().mockResolvedValue(true),
  gitWatch: vi.fn().mockResolvedValue(true),
  gitUnwatch: vi.fn().mockResolvedValue(true),
  onGitChanged: vi.fn().mockReturnValue(() => {}),
  // Additional Git functions used by useGitState
  gitDetailedStatus: vi.fn().mockResolvedValue({
    branch: 'main',
    staged: [],
    unstaged: [],
    untracked: [],
  }),
  gitBranches: vi.fn().mockResolvedValue({ branches: [] }),
  gitLogDetailed: vi.fn().mockResolvedValue({ commits: [] }),
  gitStashList: vi.fn().mockResolvedValue({ stashes: [] }),
  gitMergeInProgress: vi.fn().mockResolvedValue(false),
  gitCherryPickInProgress: vi.fn().mockResolvedValue(false),
  gitRebaseInProgress: vi.fn().mockResolvedValue(false),
  gitTags: vi.fn().mockResolvedValue({ tags: [] }),
  gitConflictFiles: vi.fn().mockResolvedValue({ files: [] }),
  gitConventionalPrefixes: vi.fn().mockResolvedValue({ prefixes: [] }),
  gitCherryPick: vi.fn().mockResolvedValue({ success: true }),
  gitCherryPickContinue: vi.fn().mockResolvedValue({ success: true }),
  gitCherryPickAbort: vi.fn().mockResolvedValue({ success: true }),
  gitMerge: vi.fn().mockResolvedValue({ success: true }),
  gitMergeAbort: vi.fn().mockResolvedValue({ success: true }),

  // File/Folder
  selectFolder: vi.fn().mockResolvedValue(null),
  selectFile: vi.fn().mockResolvedValue(null),
  createFolder: vi.fn().mockResolvedValue(null),
  openInExplorer: vi.fn().mockResolvedValue(true),
  getDefaultEditor: vi.fn().mockResolvedValue('nvim'),

  // Recent Projects
  getRecentProjects: vi.fn().mockResolvedValue([]),
  addRecentProject: vi.fn().mockResolvedValue(true),
  removeRecentProject: vi.fn().mockResolvedValue(true),
  pinProject: vi.fn().mockResolvedValue(true),
  clearRecentProjects: vi.fn().mockResolvedValue(true),

  // Export
  exportSession: vi.fn().mockResolvedValue({ success: true }),
  bulkExport: vi.fn().mockResolvedValue({ success: true }),

  // App Info
  getAppVersion: vi.fn().mockResolvedValue('1.0.0'),
  getAppPath: vi.fn().mockResolvedValue('/tmp'),
  getPlatform: vi.fn().mockReturnValue('win32'),
  getAvailableEditors: vi.fn().mockResolvedValue([]),

  // Maintenance
  recalculateSessionCosts: vi.fn().mockResolvedValue({ updated: 0 }),

  // Activity
  getRecentActivity: vi.fn().mockResolvedValue([]),
  logActivity: vi.fn().mockResolvedValue(true),
  clearActivityLog: vi.fn().mockResolvedValue(true),

  // GitHub
  githubAuth: vi.fn().mockResolvedValue({ success: false, error: 'Not configured' }),
  githubLogout: vi.fn().mockResolvedValue({ success: true }),
  githubIsAuthenticated: vi.fn().mockResolvedValue(false),
  githubGetUser: vi.fn().mockResolvedValue(null),
  githubGetAuthState: vi.fn().mockResolvedValue({
    isAuthenticated: false,
    user: null,
    accessToken: null,
    tokenExpiresAt: null,
  }),
  githubGetOAuthConfig: vi.fn().mockResolvedValue({
    isConfigured: false,
    source: 'none',
    clientId: null,
  }),
  githubGetCustomOAuthStatus: vi.fn().mockResolvedValue({
    isConfigured: true,
    source: 'default',
    clientId: null,
    useDeviceFlow: true,
    hasClientSecret: false,
  }),
  // GitHub Device Flow
  githubDeviceFlowStart: vi.fn().mockResolvedValue({
    success: true,
    userCode: 'ABCD-1234',
    verificationUri: 'https://github.com/login/device',
    expiresIn: 900,
  }),
  githubDeviceFlowWait: vi.fn().mockResolvedValue({
    success: false,
    completed: false,
    error: 'Test mode - not polling',
  }),
  githubDeviceFlowCancel: vi.fn().mockResolvedValue({ success: true }),
  githubDeviceFlowState: vi.fn().mockResolvedValue({
    status: 'idle',
    userCode: null,
    verificationUri: null,
    expiresAt: null,
    error: null,
  }),
  githubDeviceFlowAvailable: vi.fn().mockResolvedValue(true),
  githubDeviceFlowClientId: vi.fn().mockResolvedValue('test-client-id'),
  onDeviceFlowStateChange: vi.fn().mockReturnValue(() => {}),
  githubListRepos: vi.fn().mockResolvedValue([]),
  githubGetRepo: vi.fn().mockResolvedValue(null),
  githubCreateRepo: vi.fn().mockResolvedValue(null),
  githubListOrgRepos: vi.fn().mockResolvedValue([]),
  githubListPRs: vi.fn().mockResolvedValue([]),
  githubGetPR: vi.fn().mockResolvedValue(null),
  githubCreatePR: vi.fn().mockResolvedValue(null),
  githubMergePR: vi.fn().mockResolvedValue({ success: false }),
  githubClosePR: vi.fn().mockResolvedValue({ success: false }),
  githubGetChecks: vi.fn().mockResolvedValue({ check_runs: [] }),
  githubGetCommitStatus: vi.fn().mockResolvedValue({ state: 'pending', statuses: [] }),
  githubListWorkflowRuns: vi.fn().mockResolvedValue({ workflow_runs: [] }),
  githubListIssues: vi.fn().mockResolvedValue([]),
  githubGetIssue: vi.fn().mockResolvedValue(null),
  githubCreateIssue: vi.fn().mockResolvedValue(null),
  githubCloseIssue: vi.fn().mockResolvedValue({ success: false }),
  githubListOrgs: vi.fn().mockResolvedValue([]),
  githubListBranches: vi.fn().mockResolvedValue([]),
  githubParseRemote: vi.fn().mockResolvedValue(null),
  githubIsGitHubRemote: vi.fn().mockResolvedValue(false),

  // MCP Servers
  getMCPServers: vi.fn().mockResolvedValue([]),
  getMCPServer: vi.fn().mockResolvedValue(null),
  createMCPServer: vi.fn().mockResolvedValue({ id: 1, name: 'Test Server' }),
  updateMCPServer: vi.fn().mockResolvedValue(true),
  deleteMCPServer: vi.fn().mockResolvedValue(true),
  setMCPServerStatus: vi.fn().mockResolvedValue(true),
  onMCPServerStatus: vi.fn().mockReturnValue(() => {}),

  // Agent Templates
  getAgentTemplates: vi.fn().mockResolvedValue([]),
  createAgentTemplate: vi.fn().mockResolvedValue({ id: '1', name: 'Test Agent' }),
  updateAgentTemplate: vi.fn().mockResolvedValue(true),
  deleteAgentTemplate: vi.fn().mockResolvedValue(true),

  // Feature Installation/Uninstallation
  installAgent: vi.fn().mockResolvedValue({ success: true }),
  installSkill: vi.fn().mockResolvedValue({ success: true }),
  installCommand: vi.fn().mockResolvedValue({ success: true }),
  installHook: vi.fn().mockResolvedValue({ success: true }),
  uninstallAgent: vi.fn().mockResolvedValue({ success: true }),
  uninstallSkill: vi.fn().mockResolvedValue({ success: true }),
  uninstallCommand: vi.fn().mockResolvedValue({ success: true }),
  uninstallHook: vi.fn().mockResolvedValue({ success: true }),

  // Projects (for ProjectSelector)
  getProjects: vi.fn().mockResolvedValue([]),
  getProject: vi.fn().mockResolvedValue(null),
  projectGetAll: vi.fn().mockResolvedValue([]),
  projectRegister: vi.fn().mockResolvedValue({ id: 1, name: 'Test Project', path: '/test/path' }),

  // Event Listeners
  onTerminalData: vi.fn(),
  onTerminalExit: vi.fn(),
  onScanStatus: vi.fn(),
  onSessionDetected: vi.fn(),
  onSubagentSessionUpdate: vi.fn(),
  onNewSession: vi.fn(),
  onCloseTab: vi.fn(),
  onNextTab: vi.fn(),
  onPrevTab: vi.fn(),
  onSwitchView: vi.fn(),
  onOpenSettings: vi.fn(),
  onShowAbout: vi.fn(),
  removeAllListeners: vi.fn(),
};

Object.defineProperty(window, 'goodvibes', {
  value: mockGoodVibesAPI,
  writable: true,
});

// Mock ResizeObserver
global.ResizeObserver = class ResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
};

// Mock IntersectionObserver
global.IntersectionObserver = class IntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  root = null;
  rootMargin = '';
  thresholds = [];
  takeRecords = vi.fn().mockReturnValue([]);
};

// Mock matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Reset mocks between tests
beforeEach(() => {
  vi.clearAllMocks();
});
