// ============================================================================
// PRELOAD API BRIDGE TESTS
// ============================================================================
//
// Tests the preload API bridge that exposes IPC methods to the renderer.
// Covers terminal, sessions, git, and settings APIs.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcRenderer, contextBridge } from 'electron';

// Mock electron modules
vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: vi.fn(),
  },
  contextBridge: {
    exposeInMainWorld: vi.fn(),
  },
}));

// Import API modules
import { terminalApi } from '../api/terminal.js';
import { sessionsApi } from '../api/sessions.js';
import { gitApi } from '../api/git.js';
import { settingsApi } from '../api/settings.js';

describe('Preload API Bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ============================================================================
  // TERMINAL API TESTS
  // ============================================================================

  describe('Terminal API', () => {
    it('exposes startClaude method', () => {
      expect(terminalApi.startClaude).toBeDefined();
      expect(typeof terminalApi.startClaude).toBe('function');
    });

    it('calls ipcRenderer.invoke with correct channel for startClaude', async () => {
      const options = { cwd: '/test/path', name: 'Test Terminal' };
      vi.mocked(ipcRenderer.invoke).mockResolvedValue({ id: 1 });

      await terminalApi.startClaude(options);

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('start-claude', options);
      expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1);
    });

    it('exposes startPlainTerminal method', () => {
      expect(terminalApi.startPlainTerminal).toBeDefined();
      expect(typeof terminalApi.startPlainTerminal).toBe('function');
    });

    it('calls ipcRenderer.invoke with correct channel for startPlainTerminal', async () => {
      const options = { cwd: '/test/path', name: 'Plain Terminal' };
      vi.mocked(ipcRenderer.invoke).mockResolvedValue({ id: 2 });

      await terminalApi.startPlainTerminal(options);

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('start-plain-terminal', options);
    });

    it('exposes terminalInput method', () => {
      expect(terminalApi.terminalInput).toBeDefined();
      expect(typeof terminalApi.terminalInput).toBe('function');
    });

    it('calls ipcRenderer.invoke with correct arguments for terminalInput', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(true);

      await terminalApi.terminalInput(1, 'echo hello');

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('terminal-input', {
        id: 1,
        data: 'echo hello',
      });
    });

    it('exposes terminalResize method', () => {
      expect(terminalApi.terminalResize).toBeDefined();
      expect(typeof terminalApi.terminalResize).toBe('function');
    });

    it('calls ipcRenderer.invoke with correct arguments for terminalResize', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(true);

      await terminalApi.terminalResize(1, 80, 24);

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('terminal-resize', {
        id: 1,
        cols: 80,
        rows: 24,
      });
    });

    it('exposes killTerminal method', () => {
      expect(terminalApi.killTerminal).toBeDefined();
      expect(typeof terminalApi.killTerminal).toBe('function');
    });

    it('calls ipcRenderer.invoke with correct channel for killTerminal', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(true);

      await terminalApi.killTerminal(1);

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('kill-terminal', 1);
    });

    it('exposes getTerminals method', () => {
      expect(terminalApi.getTerminals).toBeDefined();
      expect(typeof terminalApi.getTerminals).toBe('function');
    });

    it('calls ipcRenderer.invoke with correct channel for getTerminals', async () => {
      const mockTerminals = [{ id: 1, name: 'Terminal 1' }];
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(mockTerminals);

      const result = await terminalApi.getTerminals();

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('get-terminals');
      expect(result).toEqual(mockTerminals);
    });

    it('exposes getAvailableEditors method', () => {
      expect(terminalApi.getAvailableEditors).toBeDefined();
      expect(typeof terminalApi.getAvailableEditors).toBe('function');
    });

    it('calls ipcRenderer.invoke for getAvailableEditors', async () => {
      const mockEditors = [
        { name: 'VSCode', command: 'code', available: true },
        { name: 'Vim', command: 'vim', available: true },
      ];
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(mockEditors);

      const result = await terminalApi.getAvailableEditors();

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('get-available-editors');
      expect(result).toEqual(mockEditors);
    });

    it('exposes getDefaultEditor method', () => {
      expect(terminalApi.getDefaultEditor).toBeDefined();
      expect(typeof terminalApi.getDefaultEditor).toBe('function');
    });

    it('calls ipcRenderer.invoke for getDefaultEditor', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue('code');

      const result = await terminalApi.getDefaultEditor();

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('get-default-editor');
      expect(result).toBe('code');
    });
  });

  // ============================================================================
  // SESSIONS API TESTS
  // ============================================================================

  describe('Sessions API', () => {
    it('exposes getSessions method', () => {
      expect(sessionsApi.getSessions).toBeDefined();
      expect(typeof sessionsApi.getSessions).toBe('function');
    });

    it('calls ipcRenderer.invoke for getSessions', async () => {
      const mockSessions = [{ id: '1', name: 'Session 1' }];
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(mockSessions);

      const result = await sessionsApi.getSessions();

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('get-sessions');
      expect(result).toEqual(mockSessions);
    });

    it('exposes getSession method', () => {
      expect(sessionsApi.getSession).toBeDefined();
      expect(typeof sessionsApi.getSession).toBe('function');
    });

    it('calls ipcRenderer.invoke with session id for getSession', async () => {
      const mockSession = { id: 'session-123', name: 'Test Session' };
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(mockSession);

      const result = await sessionsApi.getSession('session-123');

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('get-session', 'session-123');
      expect(result).toEqual(mockSession);
    });

    it('exposes getSessionMessages method', () => {
      expect(sessionsApi.getSessionMessages).toBeDefined();
      expect(typeof sessionsApi.getSessionMessages).toBe('function');
    });

    it('calls ipcRenderer.invoke for getSessionMessages', async () => {
      const mockMessages = [{ id: 1, content: 'Hello' }];
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(mockMessages);

      const result = await sessionsApi.getSessionMessages('session-123');

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('get-session-messages', 'session-123');
      expect(result).toEqual(mockMessages);
    });

    it('exposes getActiveSessions method', () => {
      expect(sessionsApi.getActiveSessions).toBeDefined();
      expect(typeof sessionsApi.getActiveSessions).toBe('function');
    });

    it('calls ipcRenderer.invoke for getActiveSessions', async () => {
      const mockSessions = [{ id: '1', active: true }];
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(mockSessions);

      const result = await sessionsApi.getActiveSessions();

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('get-active-sessions');
      expect(result).toEqual(mockSessions);
    });

    it('exposes getFavoriteSessions method', () => {
      expect(sessionsApi.getFavoriteSessions).toBeDefined();
      expect(typeof sessionsApi.getFavoriteSessions).toBe('function');
    });

    it('calls ipcRenderer.invoke for getFavoriteSessions', async () => {
      const mockSessions = [{ id: '1', favorite: true }];
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(mockSessions);

      const result = await sessionsApi.getFavoriteSessions();

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('get-favorite-sessions');
      expect(result).toEqual(mockSessions);
    });

    it('exposes getArchivedSessions method', () => {
      expect(sessionsApi.getArchivedSessions).toBeDefined();
      expect(typeof sessionsApi.getArchivedSessions).toBe('function');
    });

    it('calls ipcRenderer.invoke for getArchivedSessions', async () => {
      const mockSessions = [{ id: '1', archived: true }];
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(mockSessions);

      const result = await sessionsApi.getArchivedSessions();

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('get-archived-sessions');
      expect(result).toEqual(mockSessions);
    });

    it('exposes toggleFavorite method', () => {
      expect(sessionsApi.toggleFavorite).toBeDefined();
      expect(typeof sessionsApi.toggleFavorite).toBe('function');
    });

    it('calls ipcRenderer.invoke for toggleFavorite', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(true);

      await sessionsApi.toggleFavorite('session-123');

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('toggle-favorite', 'session-123');
    });

    it('exposes toggleArchive method', () => {
      expect(sessionsApi.toggleArchive).toBeDefined();
      expect(typeof sessionsApi.toggleArchive).toBe('function');
    });

    it('calls ipcRenderer.invoke for toggleArchive', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(true);

      await sessionsApi.toggleArchive('session-123');

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('toggle-archive', 'session-123');
    });

    it('exposes deleteSession method', () => {
      expect(sessionsApi.deleteSession).toBeDefined();
      expect(typeof sessionsApi.deleteSession).toBe('function');
    });

    it('calls ipcRenderer.invoke for deleteSession', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(true);

      await sessionsApi.deleteSession('session-123');

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('delete-session', 'session-123');
    });

    it('exposes getLiveSessions method', () => {
      expect(sessionsApi.getLiveSessions).toBeDefined();
      expect(typeof sessionsApi.getLiveSessions).toBe('function');
    });

    it('calls ipcRenderer.invoke for getLiveSessions', async () => {
      const mockSessions = [{ id: '1', live: true }];
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(mockSessions);

      const result = await sessionsApi.getLiveSessions();

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('get-live-sessions');
      expect(result).toEqual(mockSessions);
    });

    it('exposes getSessionRawEntries method', () => {
      expect(sessionsApi.getSessionRawEntries).toBeDefined();
      expect(typeof sessionsApi.getSessionRawEntries).toBe('function');
    });

    it('calls ipcRenderer.invoke for getSessionRawEntries without afterIndex', async () => {
      const mockEntries = [{ index: 0, data: 'entry1' }];
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(mockEntries);

      const result = await sessionsApi.getSessionRawEntries('session-123');

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('get-session-raw-entries', 'session-123', undefined);
      expect(result).toEqual(mockEntries);
    });

    it('calls ipcRenderer.invoke for getSessionRawEntries with afterIndex', async () => {
      const mockEntries = [{ index: 5, data: 'entry6' }];
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(mockEntries);

      const result = await sessionsApi.getSessionRawEntries('session-123', 5);

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('get-session-raw-entries', 'session-123', 5);
      expect(result).toEqual(mockEntries);
    });

    it('exposes refreshSession method', () => {
      expect(sessionsApi.refreshSession).toBeDefined();
      expect(typeof sessionsApi.refreshSession).toBe('function');
    });

    it('calls ipcRenderer.invoke for refreshSession', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(true);

      await sessionsApi.refreshSession('session-123');

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('refresh-session', 'session-123');
    });

    it('exposes isSessionLive method', () => {
      expect(sessionsApi.isSessionLive).toBeDefined();
      expect(typeof sessionsApi.isSessionLive).toBe('function');
    });

    it('calls ipcRenderer.invoke for isSessionLive', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(true);

      const result = await sessionsApi.isSessionLive('session-123');

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('is-session-live', 'session-123');
      expect(result).toBe(true);
    });

    it('exposes watchSession method', () => {
      expect(sessionsApi.watchSession).toBeDefined();
      expect(typeof sessionsApi.watchSession).toBe('function');
    });

    it('calls ipcRenderer.invoke for watchSession', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue('watcher-id');

      const result = await sessionsApi.watchSession('session-123');

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('watch-session', 'session-123');
      expect(result).toBe('watcher-id');
    });

    it('exposes recalculateSessionCosts method', () => {
      expect(sessionsApi.recalculateSessionCosts).toBeDefined();
      expect(typeof sessionsApi.recalculateSessionCosts).toBe('function');
    });

    it('calls ipcRenderer.invoke for recalculateSessionCosts', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue({ updated: 5 });

      await sessionsApi.recalculateSessionCosts();

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('recalculate-session-costs');
    });

    it('exposes rescanSessions method', () => {
      expect(sessionsApi.rescanSessions).toBeDefined();
      expect(typeof sessionsApi.rescanSessions).toBe('function');
    });

    it('calls ipcRenderer.invoke for rescanSessions', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(true);

      await sessionsApi.rescanSessions();

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('rescan-sessions');
    });

    it('exposes scanNewSessions method', () => {
      expect(sessionsApi.scanNewSessions).toBeDefined();
      expect(typeof sessionsApi.scanNewSessions).toBe('function');
    });

    it('calls ipcRenderer.invoke for scanNewSessions', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(3);

      const result = await sessionsApi.scanNewSessions();

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('scan-new-sessions');
      expect(result).toBe(3);
    });

    it('exposes getProjectSessions method', () => {
      expect(sessionsApi.getProjectSessions).toBeDefined();
      expect(typeof sessionsApi.getProjectSessions).toBe('function');
    });

    it('calls ipcRenderer.invoke for getProjectSessions with default limit', async () => {
      const mockSessions = [{ id: '1' }];
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(mockSessions);

      const result = await sessionsApi.getProjectSessions('/test/project');

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('session:getForProject', '/test/project', 5);
      expect(result).toEqual(mockSessions);
    });

    it('calls ipcRenderer.invoke for getProjectSessions with custom limit', async () => {
      const mockSessions = [{ id: '1' }];
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(mockSessions);

      const result = await sessionsApi.getProjectSessions('/test/project', 10);

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('session:getForProject', '/test/project', 10);
      expect(result).toEqual(mockSessions);
    });

    it('exposes getMostRecentSession method', () => {
      expect(sessionsApi.getMostRecentSession).toBeDefined();
      expect(typeof sessionsApi.getMostRecentSession).toBe('function');
    });

    it('calls ipcRenderer.invoke for getMostRecentSession', async () => {
      const mockSession = {
        sessionId: 'session-123',
        cwd: '/test/path',
        messageCount: 10,
        costUsd: 0.05,
        startedAt: '2025-01-01T00:00:00Z',
        lastActive: '2025-01-01T01:00:00Z',
        firstPrompt: 'Hello',
      };
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(mockSession);

      const result = await sessionsApi.getMostRecentSession();

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('session:getMostRecent');
      expect(result).toEqual(mockSession);
    });
  });

  // ============================================================================
  // GIT API TESTS
  // ============================================================================

  describe('Git API', () => {
    it('exposes gitStatus method', () => {
      expect(gitApi.gitStatus).toBeDefined();
      expect(typeof gitApi.gitStatus).toBe('function');
    });

    it('calls ipcRenderer.invoke for gitStatus', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue('On branch main');

      const result = await gitApi.gitStatus('/test/repo');

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('git-status', '/test/repo');
      expect(result).toBe('On branch main');
    });

    it('exposes gitBranch method', () => {
      expect(gitApi.gitBranch).toBeDefined();
      expect(typeof gitApi.gitBranch).toBe('function');
    });

    it('calls ipcRenderer.invoke for gitBranch', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue('main');

      const result = await gitApi.gitBranch('/test/repo');

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('git-branch', '/test/repo');
      expect(result).toBe('main');
    });

    it('exposes gitLog method', () => {
      expect(gitApi.gitLog).toBeDefined();
      expect(typeof gitApi.gitLog).toBe('function');
    });

    it('calls ipcRenderer.invoke for gitLog', async () => {
      const mockLog = [{ hash: 'abc123', message: 'Initial commit' }];
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(mockLog);

      const result = await gitApi.gitLog('/test/repo');

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('git-log', '/test/repo');
      expect(result).toEqual(mockLog);
    });

    it('exposes gitDiff method', () => {
      expect(gitApi.gitDiff).toBeDefined();
      expect(typeof gitApi.gitDiff).toBe('function');
    });

    it('calls ipcRenderer.invoke for gitDiff without staged flag', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue('diff content');

      const result = await gitApi.gitDiff('/test/repo');

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('git-diff', { cwd: '/test/repo', staged: undefined });
      expect(result).toBe('diff content');
    });

    it('calls ipcRenderer.invoke for gitDiff with staged flag', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue('staged diff');

      const result = await gitApi.gitDiff('/test/repo', true);

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('git-diff', { cwd: '/test/repo', staged: true });
      expect(result).toBe('staged diff');
    });

    it('exposes gitAdd method', () => {
      expect(gitApi.gitAdd).toBeDefined();
      expect(typeof gitApi.gitAdd).toBe('function');
    });

    it('calls ipcRenderer.invoke for gitAdd', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(true);

      await gitApi.gitAdd('/test/repo', 'file.txt');

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('git-add', { cwd: '/test/repo', files: 'file.txt' });
    });

    it('exposes gitCommit method', () => {
      expect(gitApi.gitCommit).toBeDefined();
      expect(typeof gitApi.gitCommit).toBe('function');
    });

    it('calls ipcRenderer.invoke for gitCommit', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(true);

      await gitApi.gitCommit('/test/repo', 'Test commit');

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('git-commit', { cwd: '/test/repo', message: 'Test commit' });
    });

    it('exposes gitPush method', () => {
      expect(gitApi.gitPush).toBeDefined();
      expect(typeof gitApi.gitPush).toBe('function');
    });

    it('calls ipcRenderer.invoke for gitPush', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(true);

      await gitApi.gitPush('/test/repo');

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('git-push', '/test/repo');
    });

    it('exposes gitPull method', () => {
      expect(gitApi.gitPull).toBeDefined();
      expect(typeof gitApi.gitPull).toBe('function');
    });

    it('calls ipcRenderer.invoke for gitPull', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(true);

      await gitApi.gitPull('/test/repo');

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('git-pull', '/test/repo');
    });

    it('exposes gitIsRepo method', () => {
      expect(gitApi.gitIsRepo).toBeDefined();
      expect(typeof gitApi.gitIsRepo).toBe('function');
    });

    it('calls ipcRenderer.invoke for gitIsRepo', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(true);

      const result = await gitApi.gitIsRepo('/test/repo');

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('git-is-repo', '/test/repo');
      expect(result).toBe(true);
    });

    it('exposes gitStash method', () => {
      expect(gitApi.gitStash).toBeDefined();
      expect(typeof gitApi.gitStash).toBe('function');
    });

    it('calls ipcRenderer.invoke for gitStash', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(true);

      await gitApi.gitStash('/test/repo', 'push');

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('git-stash', { cwd: '/test/repo', action: 'push' });
    });

    it('exposes gitInit method', () => {
      expect(gitApi.gitInit).toBeDefined();
      expect(typeof gitApi.gitInit).toBe('function');
    });

    it('calls ipcRenderer.invoke for gitInit', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(true);

      await gitApi.gitInit('/test/repo');

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('git-init', '/test/repo');
    });

    it('exposes gitReset method', () => {
      expect(gitApi.gitReset).toBeDefined();
      expect(typeof gitApi.gitReset).toBe('function');
    });

    it('calls ipcRenderer.invoke for gitReset', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(true);

      await gitApi.gitReset('/test/repo', ['file.txt']);

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('git-reset', { cwd: '/test/repo', files: ['file.txt'] });
    });

    it('exposes gitFetch method', () => {
      expect(gitApi.gitFetch).toBeDefined();
      expect(typeof gitApi.gitFetch).toBe('function');
    });

    it('calls ipcRenderer.invoke for gitFetch', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(true);

      await gitApi.gitFetch('/test/repo');

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('git-fetch', '/test/repo');
    });

    // Test enhanced git operations
    it('exposes gitDetailedStatus method', () => {
      expect(gitApi.gitDetailedStatus).toBeDefined();
      expect(typeof gitApi.gitDetailedStatus).toBe('function');
    });

    it('calls ipcRenderer.invoke for gitDetailedStatus', async () => {
      const mockStatus = { modified: ['file.txt'], staged: [] };
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(mockStatus);

      const result = await gitApi.gitDetailedStatus('/test/repo');

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('git-detailed-status', '/test/repo');
      expect(result).toEqual(mockStatus);
    });

    it('exposes gitBranches method', () => {
      expect(gitApi.gitBranches).toBeDefined();
      expect(typeof gitApi.gitBranches).toBe('function');
    });

    it('calls ipcRenderer.invoke for gitBranches', async () => {
      const mockBranches = ['main', 'develop'];
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(mockBranches);

      const result = await gitApi.gitBranches('/test/repo');

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('git-branches', '/test/repo');
      expect(result).toEqual(mockBranches);
    });

    it('exposes gitCheckout method', () => {
      expect(gitApi.gitCheckout).toBeDefined();
      expect(typeof gitApi.gitCheckout).toBe('function');
    });

    it('calls ipcRenderer.invoke for gitCheckout', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(true);

      await gitApi.gitCheckout('/test/repo', 'develop');

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('git-checkout', { cwd: '/test/repo', branch: 'develop' });
    });

    it('exposes gitCreateBranch method', () => {
      expect(gitApi.gitCreateBranch).toBeDefined();
      expect(typeof gitApi.gitCreateBranch).toBe('function');
    });

    it('calls ipcRenderer.invoke for gitCreateBranch', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(true);

      await gitApi.gitCreateBranch('/test/repo', 'feature-branch', true);

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('git-create-branch', {
        cwd: '/test/repo',
        name: 'feature-branch',
        checkout: true,
      });
    });
  });

  // ============================================================================
  // SETTINGS API TESTS
  // ============================================================================

  describe('Settings API', () => {
    it('exposes getSetting method', () => {
      expect(settingsApi.getSetting).toBeDefined();
      expect(typeof settingsApi.getSetting).toBe('function');
    });

    it('calls ipcRenderer.invoke for getSetting', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue('value');

      const result = await settingsApi.getSetting('theme');

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('get-setting', 'theme');
      expect(result).toBe('value');
    });

    it('exposes setSetting method', () => {
      expect(settingsApi.setSetting).toBeDefined();
      expect(typeof settingsApi.setSetting).toBe('function');
    });

    it('calls ipcRenderer.invoke for setSetting', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(true);

      await settingsApi.setSetting('theme', 'dark');

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('set-setting', { key: 'theme', value: 'dark' });
    });

    it('exposes getAllSettings method', () => {
      expect(settingsApi.getAllSettings).toBeDefined();
      expect(typeof settingsApi.getAllSettings).toBe('function');
    });

    it('calls ipcRenderer.invoke for getAllSettings', async () => {
      const mockSettings = { theme: 'dark', language: 'en' };
      vi.mocked(ipcRenderer.invoke).mockResolvedValue(mockSettings);

      const result = await settingsApi.getAllSettings();

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('get-all-settings');
      expect(result).toEqual(mockSettings);
    });

    it('exposes getAppVersion method', () => {
      expect(settingsApi.getAppVersion).toBeDefined();
      expect(typeof settingsApi.getAppVersion).toBe('function');
    });

    it('calls ipcRenderer.invoke for getAppVersion', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue('1.0.0');

      const result = await settingsApi.getAppVersion();

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('get-app-version');
      expect(result).toBe('1.0.0');
    });

    it('exposes getAppPath method', () => {
      expect(settingsApi.getAppPath).toBeDefined();
      expect(typeof settingsApi.getAppPath).toBe('function');
    });

    it('calls ipcRenderer.invoke for getAppPath', async () => {
      vi.mocked(ipcRenderer.invoke).mockResolvedValue('/app/path');

      const result = await settingsApi.getAppPath('userData');

      expect(ipcRenderer.invoke).toHaveBeenCalledWith('get-app-path', 'userData');
      expect(result).toBe('/app/path');
    });

    it('exposes getPlatform method', () => {
      expect(settingsApi.getPlatform).toBeDefined();
      expect(typeof settingsApi.getPlatform).toBe('function');
    });

    it('returns process.platform for getPlatform', () => {
      const result = settingsApi.getPlatform();

      expect(result).toBe(process.platform);
      // Verify ipcRenderer.invoke was NOT called for getPlatform
      expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // ERROR HANDLING TESTS
  // ============================================================================

  describe('Error Handling', () => {
    it('propagates errors from ipcRenderer.invoke in terminal API', async () => {
      const error = new Error('IPC Error');
      vi.mocked(ipcRenderer.invoke).mockRejectedValue(error);

      await expect(terminalApi.startClaude({ cwd: '/test' })).rejects.toThrow('IPC Error');
    });

    it('propagates errors from ipcRenderer.invoke in sessions API', async () => {
      const error = new Error('Session not found');
      vi.mocked(ipcRenderer.invoke).mockRejectedValue(error);

      await expect(sessionsApi.getSession('invalid-id')).rejects.toThrow('Session not found');
    });

    it('propagates errors from ipcRenderer.invoke in git API', async () => {
      const error = new Error('Not a git repository');
      vi.mocked(ipcRenderer.invoke).mockRejectedValue(error);

      await expect(gitApi.gitStatus('/not/a/repo')).rejects.toThrow('Not a git repository');
    });

    it('propagates errors from ipcRenderer.invoke in settings API', async () => {
      const error = new Error('Setting not found');
      vi.mocked(ipcRenderer.invoke).mockRejectedValue(error);

      await expect(settingsApi.getSetting('invalid-key')).rejects.toThrow('Setting not found');
    });
  });

  // ============================================================================
  // PRELOAD INDEX TESTS
  // ============================================================================

  describe('Preload Index (contextBridge)', () => {
    // We need to re-import the index after mocking
    beforeEach(async () => {
      vi.resetModules();
      await import('../index.js');
    });

    it('calls contextBridge.exposeInMainWorld', () => {
      expect(contextBridge.exposeInMainWorld).toHaveBeenCalled();
    });

    it('exposes API with correct namespace', () => {
      expect(contextBridge.exposeInMainWorld).toHaveBeenCalledWith(
        'goodvibes',
        expect.any(Object)
      );
    });

    it('exposes API object containing terminal methods', () => {
      const calls = vi.mocked(contextBridge.exposeInMainWorld).mock.calls;
      const apiObject = calls[calls.length - 1][1] as Record<string, unknown>;

      expect(apiObject).toHaveProperty('startClaude');
      expect(apiObject).toHaveProperty('startPlainTerminal');
      expect(apiObject).toHaveProperty('terminalInput');
      expect(apiObject).toHaveProperty('terminalResize');
      expect(apiObject).toHaveProperty('killTerminal');
      expect(apiObject).toHaveProperty('getTerminals');
      expect(apiObject).toHaveProperty('getAvailableEditors');
      expect(apiObject).toHaveProperty('getDefaultEditor');
    });

    it('exposes API object containing sessions methods', () => {
      const calls = vi.mocked(contextBridge.exposeInMainWorld).mock.calls;
      const apiObject = calls[calls.length - 1][1] as Record<string, unknown>;

      expect(apiObject).toHaveProperty('getSessions');
      expect(apiObject).toHaveProperty('getSession');
      expect(apiObject).toHaveProperty('getSessionMessages');
      expect(apiObject).toHaveProperty('getActiveSessions');
      expect(apiObject).toHaveProperty('getFavoriteSessions');
      expect(apiObject).toHaveProperty('getArchivedSessions');
      expect(apiObject).toHaveProperty('toggleFavorite');
      expect(apiObject).toHaveProperty('toggleArchive');
      expect(apiObject).toHaveProperty('deleteSession');
    });

    it('exposes API object containing git methods', () => {
      const calls = vi.mocked(contextBridge.exposeInMainWorld).mock.calls;
      const apiObject = calls[calls.length - 1][1] as Record<string, unknown>;

      expect(apiObject).toHaveProperty('gitStatus');
      expect(apiObject).toHaveProperty('gitBranch');
      expect(apiObject).toHaveProperty('gitLog');
      expect(apiObject).toHaveProperty('gitDiff');
      expect(apiObject).toHaveProperty('gitAdd');
      expect(apiObject).toHaveProperty('gitCommit');
      expect(apiObject).toHaveProperty('gitPush');
      expect(apiObject).toHaveProperty('gitPull');
      expect(apiObject).toHaveProperty('gitIsRepo');
    });

    it('exposes API object containing settings methods', () => {
      const calls = vi.mocked(contextBridge.exposeInMainWorld).mock.calls;
      const apiObject = calls[calls.length - 1][1] as Record<string, unknown>;

      expect(apiObject).toHaveProperty('getSetting');
      expect(apiObject).toHaveProperty('setSetting');
      expect(apiObject).toHaveProperty('getAllSettings');
      expect(apiObject).toHaveProperty('getAppVersion');
      expect(apiObject).toHaveProperty('getAppPath');
      expect(apiObject).toHaveProperty('getPlatform');
    });
  });
});
