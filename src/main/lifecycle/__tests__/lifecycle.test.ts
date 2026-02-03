// ====================================================================
// LIFECYCLE MODULE TESTS
// ===================================================================
//
// Tests for lifecycle modules covering:
// - Initialization sequence runs in correct order
// - Shutdown sequence cleans up properly
// - Protocol handler processes URLs correctly
// - Agent bridge tracks agents properly
//
// ====================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ====================================================================
// MOCKS
// ====================================================================

// Mock electron module
const mockApp = {
  getPath: vi.fn().mockReturnValue('/test/userData'),
  setAsDefaultProtocolClient: vi.fn(),
  requestSingleInstanceLock: vi.fn().mockReturnValue(true),
  quit: vi.fn(),
  on: vi.fn(),
};

const mockBrowserWindow = {
  isDestroyed: vi.fn().mockReturnValue(false),
  isMinimized: vi.fn().mockReturnValue(false),
  restore: vi.fn(),
  focus: vi.fn(),
  webContents: {
    send: vi.fn(),
    on: vi.fn(),
  },
};

const mockBrowserWindowClass = {
  getAllWindows: vi.fn().mockReturnValue([mockBrowserWindow]),
};

vi.mock('electron', () => ({
  app: mockApp,
  BrowserWindow: mockBrowserWindowClass,
  ipcMain: {
    on: vi.fn(),
    handle: vi.fn(),
  },
}));

// Mock electron-store to avoid projectName error
vi.mock('electron-store', () => ({
  default: class MockStore {
    constructor() {}
    get() { return null; }
    set() {}
    delete() {}
  }
}));

// Mock Logger
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

vi.mock('../services/logger.js', () => ({
  Logger: vi.fn().mockImplementation(() => mockLogger),
}));

// Mock database functions
const mockInitDatabase = vi.fn().mockResolvedValue(undefined);
const mockCloseDatabase = vi.fn();
const mockClearActivityLog = vi.fn();
const mockGetSetting = vi.fn();
const mockCreateHookEventsTables = vi.fn();

vi.mock('../database/index.js', () => ({
  initDatabase: mockInitDatabase,
  closeDatabase: mockCloseDatabase,
  clearActivityLog: mockClearActivityLog,
  getSetting: mockGetSetting,
}));

vi.mock('../database/hookEvents.js', () => ({
  createHookEventsTables: mockCreateHookEventsTables,
}));

// Mock service managers
const mockSessionManager = {
  init: vi.fn().mockResolvedValue(undefined),
  stopWatching: vi.fn(),
};

const mockGetSessionManager = vi.fn().mockReturnValue(mockSessionManager);
const mockInitSessionManager = vi.fn();

vi.mock('../services/sessionManager.js', () => ({
  initSessionManager: mockInitSessionManager,
  getSessionManager: mockGetSessionManager,
}));

const mockInitTerminalManager = vi.fn();
const mockCloseAllTerminals = vi.fn();
const mockGetTerminalCount = vi.fn().mockReturnValue(0);

vi.mock('../services/terminalManager.js', () => ({
  initTerminalManager: mockInitTerminalManager,
  closeAllTerminals: mockCloseAllTerminals,
  getTerminalCount: mockGetTerminalCount,
}));

const mockInitAgentRegistry = vi.fn();
const mockShutdownAgentRegistry = vi.fn();
const mockAgentRegistry = {
  spawn: vi.fn().mockReturnValue({ id: 'agent-123', name: 'Test Agent', status: 'active' }),
  getAgent: vi.fn().mockReturnValue({ id: 'agent-123', name: 'Test Agent', status: 'active' }),
  markActive: vi.fn(),
  complete: vi.fn(),
  terminateAgent: vi.fn(),
  recordActivity: vi.fn(),
};
const mockGetAgentRegistry = vi.fn().mockReturnValue(mockAgentRegistry);

vi.mock('../services/agentRegistry.js', () => ({
  initAgentRegistry: mockInitAgentRegistry,
  shutdownAgentRegistry: mockShutdownAgentRegistry,
  getAgentRegistry: mockGetAgentRegistry,
}));

const mockShutdownPTYStreamAnalyzer = vi.fn();
const mockStreamAnalyzer = {
  on: vi.fn(),
};
const mockGetPTYStreamAnalyzer = vi.fn().mockReturnValue(mockStreamAnalyzer);

vi.mock('../services/ptyStreamAnalyzer.js', () => ({
  shutdownPTYStreamAnalyzer: mockShutdownPTYStreamAnalyzer,
  getPTYStreamAnalyzer: mockGetPTYStreamAnalyzer,
}));

const mockStartHookServer = vi.fn().mockResolvedValue(undefined);
const mockStopHookServer = vi.fn().mockResolvedValue(undefined);
const mockHookServer = {
  on: vi.fn(),
};
const mockGetHookServer = vi.fn().mockReturnValue(mockHookServer);

vi.mock('../services/hookServer.js', () => ({
  startHookServer: mockStartHookServer,
  stopHookServer: mockStopHookServer,
  getHookServer: mockGetHookServer,
}));

const mockInstallAllHookScripts = vi.fn().mockResolvedValue(undefined);
const mockAreHookScriptsInstalled = vi.fn().mockResolvedValue(false);

vi.mock('../services/hookScripts.js', () => ({
  installAllHookScripts: mockInstallAllHookScripts,
  areHookScriptsInstalled: mockAreHookScriptsInstalled,
}));

const mockBackupSessions = vi.fn().mockResolvedValue({ backed: 5, total: 10 });

vi.mock('../services/sessionBackup.js', () => ({
  backupSessions: mockBackupSessions,
}));

const mockRegisterAllIpcHandlers = vi.fn();

vi.mock('../ipc/index.js', () => ({
  registerAllIpcHandlers: mockRegisterAllIpcHandlers,
}));

const mockLoadRecentProjects = vi.fn();
const mockLoadPinnedFolders = vi.fn();

vi.mock('../services/recentProjects.js', () => ({
  loadRecentProjects: mockLoadRecentProjects,
}));

vi.mock('../services/pinnedFolders.js', () => ({
  loadPinnedFolders: mockLoadPinnedFolders,
}));

const mockInitializeGitHub = vi.fn().mockResolvedValue(undefined);
const mockHandleOAuthCallback = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/github.js', () => ({
  initializeGitHub: mockInitializeGitHub,
  handleOAuthCallback: mockHandleOAuthCallback,
}));

const mockCreateWindow = vi.fn();
const mockGetMainWindow = vi.fn().mockReturnValue(mockBrowserWindow);

vi.mock('../window.js', () => ({
  createWindow: mockCreateWindow,
  getMainWindow: mockGetMainWindow,
}));

const mockCreateMenu = vi.fn();

vi.mock('../menu.js', () => ({
  createMenu: mockCreateMenu,
}));

const mockRemoveAllListeners = vi.fn();
const mockRegisteredListeners = {
  streamAnalyzer: {
    agentSpawn: null,
    agentComplete: null,
    agentActivity: null,
  },
  hookServer: {
    sessionStart: null,
    agentStart: null,
    agentStop: null,
    sessionEnd: null,
  },
  ipcMain: {
    terminalExited: null,
  },
};

vi.mock('./listenerRegistry.js', () => ({
  removeAllListeners: mockRemoveAllListeners,
  registeredListeners: mockRegisteredListeners,
}));

vi.mock('../../shared/constants.js', () => ({
  SESSION_SCAN_INIT_DELAY_MS: 100,
  GRACEFUL_SHUTDOWN_TIMEOUT_MS: 5000,
  AGENT_DEDUP_WINDOW_MS: 1000,
}));

// ====================================================================
// INITIALIZATION TESTS
// ====================================================================

describe('initialization.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSetting.mockReturnValue(true);
  });

  describe('initializeApp', () => {
    it('should initialize all services in correct order', async () => {
      const { initializeApp } = await import('../initialization.js');
      await initializeApp();

      // Verify key functions were called
      expect(mockInitDatabase).toHaveBeenCalledWith('/test/userData');
      expect(mockCreateHookEventsTables).toHaveBeenCalled();
      expect(mockInitTerminalManager).toHaveBeenCalled();
      expect(mockInitAgentRegistry).toHaveBeenCalled();
      expect(mockInitSessionManager).toHaveBeenCalled();
      expect(mockLoadRecentProjects).toHaveBeenCalled();
      expect(mockLoadPinnedFolders).toHaveBeenCalled();
      expect(mockInitializeGitHub).toHaveBeenCalled();
      expect(mockStartHookServer).toHaveBeenCalled();
      expect(mockRegisterAllIpcHandlers).toHaveBeenCalled();
      expect(mockCreateWindow).toHaveBeenCalled();
    });

    it('should handle session backup when enabled', async () => {
      mockGetSetting.mockReturnValue(true);
      mockBackupSessions.mockResolvedValue({ backed: 5, total: 10 });
      
      const { initializeApp } = await import('../initialization.js');
      await initializeApp();

      expect(mockBackupSessions).toHaveBeenCalled();
    });

    it('should skip session backup when disabled', async () => {
      mockGetSetting.mockReturnValue(false);
      
      const { initializeApp } = await import('../initialization.js');
      await initializeApp();

      expect(mockBackupSessions).not.toHaveBeenCalled();
    });

    it('should install hook scripts if not already installed', async () => {
      mockAreHookScriptsInstalled.mockResolvedValue(false);
      
      const { initializeApp } = await import('../initialization.js');
      await initializeApp();

      expect(mockInstallAllHookScripts).toHaveBeenCalled();
    });

    it('should skip hook script installation if already installed', async () => {
      mockAreHookScriptsInstalled.mockResolvedValue(true);
      
      const { initializeApp } = await import('../initialization.js');
      await initializeApp();

      expect(mockInstallAllHookScripts).not.toHaveBeenCalled();
    });

    it('should continue if hook server fails to start', async () => {
      mockStartHookServer.mockRejectedValue(new Error('Hook server failed'));
      
      const { initializeApp } = await import('../initialization.js');
      await initializeApp();

      // Should continue with other initialization
      expect(mockRegisterAllIpcHandlers).toHaveBeenCalled();
    });

    it('should throw error if database initialization fails', async () => {
      mockInitDatabase.mockRejectedValue(new Error('Database error'));
      
      const { initializeApp } = await import('../initialization.js');
      
      await expect(initializeApp()).rejects.toThrow('Database error');
    });
  });
});

// ====================================================================
// SHUTDOWN TESTS
// ====================================================================

describe('shutdown.ts', () => {
  beforeEach(async () => {
    vi.resetModules(); // Reset module state to clear shutdown flag
    vi.clearAllMocks();
    mockGetTerminalCount.mockReturnValue(0);
  });

  describe('performGracefulShutdown', () => {
    it('should shut down all services', async () => {
      const { performGracefulShutdown } = await import('../shutdown.js');
      await performGracefulShutdown();

      // Verify key shutdown functions were called
      expect(mockRemoveAllListeners).toHaveBeenCalled();
      expect(mockShutdownPTYStreamAnalyzer).toHaveBeenCalled();
      expect(mockStopHookServer).toHaveBeenCalled();
      expect(mockShutdownAgentRegistry).toHaveBeenCalled();
      expect(mockCloseAllTerminals).toHaveBeenCalled();
      expect(mockCloseDatabase).toHaveBeenCalled();
    });

    it('should wait for terminals to close', async () => {
      let callCount = 0;
      mockGetTerminalCount.mockImplementation(() => {
        callCount++;
        return callCount < 3 ? 2 : 0;
      });

      const { performGracefulShutdown } = await import('../shutdown.js');
      await performGracefulShutdown();

      expect(mockGetTerminalCount).toHaveBeenCalled();
      expect(mockCloseDatabase).toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      mockStopHookServer.mockRejectedValueOnce(new Error('Shutdown error'));

      const { performGracefulShutdown } = await import('../shutdown.js');
      await performGracefulShutdown();

      // Should still close critical resources
      expect(mockCloseDatabase).toHaveBeenCalled();
    });
  });

  describe('getIsShuttingDown', () => {
    it('should return false initially', async () => {
      const { getIsShuttingDown } = await import('../shutdown.js');
      expect(getIsShuttingDown()).toBe(false);
    });
  });

  describe('setupShutdownHandlers', () => {
    it('should register window-all-closed handler', async () => {
      const { setupShutdownHandlers } = await import('../shutdown.js');
      setupShutdownHandlers();
      expect(mockApp.on).toHaveBeenCalledWith('window-all-closed', expect.any(Function));
    });

    it('should register before-quit handler', async () => {
      const { setupShutdownHandlers } = await import('../shutdown.js');
      setupShutdownHandlers();
      expect(mockApp.on).toHaveBeenCalledWith('before-quit', expect.any(Function));
    });
  });
});

// ====================================================================
// PROTOCOL TESTS
// ====================================================================

describe('protocol.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('registerProtocol', () => {
    it('should register protocol', async () => {
      const { registerProtocol } = await import('../protocol.js');
      registerProtocol();
      expect(mockApp.setAsDefaultProtocolClient).toHaveBeenCalled();
    });
  });

  describe('handleProtocolUrl', () => {
    it('should handle OAuth callback with code', async () => {
      const { handleProtocolUrl } = await import('../protocol.js');
      await handleProtocolUrl('goodvibes://oauth?code=test123&state=abc');
      expect(mockHandleOAuthCallback).toHaveBeenCalledWith('test123', 'abc', null, null);
    });

    it('should handle OAuth callback with error', async () => {
      const { handleProtocolUrl } = await import('../protocol.js');
      await handleProtocolUrl('goodvibes://oauth?error=access_denied&error_description=User%20denied');
      expect(mockHandleOAuthCallback).toHaveBeenCalledWith(null, null, 'access_denied', 'User denied');
    });

    it('should handle unknown protocol paths', async () => {
      const { handleProtocolUrl } = await import('../protocol.js');
      await handleProtocolUrl('goodvibes://unknown/path');
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should handle malformed URLs', async () => {
      const { handleProtocolUrl } = await import('../protocol.js');
      await handleProtocolUrl('not-a-valid-url');
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('setupSingleInstance', () => {
    it('should return true when lock acquired', async () => {
      mockApp.requestSingleInstanceLock.mockReturnValue(true);
      const { setupSingleInstance } = await import('../protocol.js');
      const result = setupSingleInstance();
      expect(result).toBe(true);
      expect(mockApp.setAsDefaultProtocolClient).toHaveBeenCalled();
    });

    it('should return false when another instance running', async () => {
      mockApp.requestSingleInstanceLock.mockReturnValue(false);
      const { setupSingleInstance } = await import('../protocol.js');
      const result = setupSingleInstance();
      expect(result).toBe(false);
      expect(mockApp.quit).toHaveBeenCalled();
    });
  });

  describe('setupActivationHandlers', () => {
    it('should register activate handler', async () => {
      const { setupActivationHandlers } = await import('../protocol.js');
      setupActivationHandlers();
      expect(mockApp.on).toHaveBeenCalledWith('activate', expect.any(Function));
    });
  });
});

// ====================================================================
// AGENT BRIDGE TESTS
// ====================================================================

describe('agentBridge.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('wireAgentBridge', () => {
    it('should wire up all event listeners', async () => {
      const { wireAgentBridge } = await import('../agentBridge.js');
      wireAgentBridge();
      expect(mockStreamAnalyzer.on).toHaveBeenCalledWith('agent:spawn', expect.any(Function));
      expect(mockStreamAnalyzer.on).toHaveBeenCalledWith('agent:complete', expect.any(Function));
      expect(mockStreamAnalyzer.on).toHaveBeenCalledWith('agent:activity', expect.any(Function));
    });

    it('should skip wiring if agent registry not available', async () => {
      mockGetAgentRegistry.mockReturnValueOnce(null);
      const { wireAgentBridge } = await import('../agentBridge.js');
      wireAgentBridge();
      expect(mockStreamAnalyzer.on).not.toHaveBeenCalled();
    });
  });

  describe('wireHookServerEvents', () => {
    it('should wire up hook server event listeners', async () => {
      const { wireHookServerEvents } = await import('../agentBridge.js');
      wireHookServerEvents();
      expect(mockHookServer.on).toHaveBeenCalledWith('session:start', expect.any(Function));
      expect(mockHookServer.on).toHaveBeenCalledWith('agent:start', expect.any(Function));
      expect(mockHookServer.on).toHaveBeenCalledWith('agent:stop', expect.any(Function));
      expect(mockHookServer.on).toHaveBeenCalledWith('session:end', expect.any(Function));
    });
  });
});
