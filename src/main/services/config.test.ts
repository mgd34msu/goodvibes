// ============================================================================
// CONFIGURATION SERVICE TESTS
// ============================================================================
//
// Comprehensive tests for the ConfigManager service.
// Tests cover:
// - Initialization flow
// - User config loading with proper error handling
// - Config saving with error propagation
// - Error scenarios (corrupted JSON, file read errors, permission errors)
// - Logging behavior during error conditions
//
// IMPORTANT: These tests mock the file system and Electron app module to test
// error handling paths and verify proper logging occurs.
// ============================================================================

import { describe, it, expect, beforeEach, vi, type MockedFunction } from 'vitest';

// ============================================================================
// MOCKS - Must be defined before imports
// ============================================================================

// Track logger calls for assertions
const loggerCalls = {
  debug: [] as Array<{ message: string; data?: unknown; metadata?: unknown }>,
  info: [] as Array<{ message: string; data?: unknown; metadata?: unknown }>,
  warn: [] as Array<{ message: string; error?: unknown; metadata?: unknown }>,
  error: [] as Array<{ message: string; error?: unknown; metadata?: unknown }>,
};

function clearLoggerCalls() {
  loggerCalls.debug = [];
  loggerCalls.info = [];
  loggerCalls.warn = [];
  loggerCalls.error = [];
}

vi.mock('./logger.js', () => ({
  Logger: class MockLogger {
    debug(message: string, data?: unknown, metadata?: unknown) {
      loggerCalls.debug.push({ message, data, metadata });
    }
    info(message: string, data?: unknown, metadata?: unknown) {
      loggerCalls.info.push({ message, data, metadata });
    }
    warn(message: string, error?: unknown, metadata?: unknown) {
      loggerCalls.warn.push({ message, error, metadata });
    }
    error(message: string, error?: unknown, metadata?: unknown) {
      loggerCalls.error.push({ message, error, metadata });
    }
    time() {
      return () => {};
    }
    child() {
      return this;
    }
  },
}));

// Mock Electron app
const mockUserDataPath = '/mock/user/data';
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((pathType: string) => {
      if (pathType === 'userData') return mockUserDataPath;
      return '/mock/path';
    }),
    getVersion: vi.fn(() => '1.0.0-test'),
  },
}));

// Track fs mock state
const fsMockState = {
  existsSyncResult: false as boolean | ((path: string) => boolean),
  readFileResult: '' as string | Error,
  writeFileResult: undefined as void | Error,
  mkdirResult: undefined as void | Error,
};

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn((filePath: string) => {
      if (typeof fsMockState.existsSyncResult === 'function') {
        return fsMockState.existsSyncResult(filePath);
      }
      return fsMockState.existsSyncResult;
    }),
    promises: {
      readFile: vi.fn(async () => {
        if (fsMockState.readFileResult instanceof Error) {
          throw fsMockState.readFileResult;
        }
        return fsMockState.readFileResult;
      }),
      writeFile: vi.fn(async () => {
        if (fsMockState.writeFileResult instanceof Error) {
          throw fsMockState.writeFileResult;
        }
        return fsMockState.writeFileResult;
      }),
      mkdir: vi.fn(async () => {
        if (fsMockState.mkdirResult instanceof Error) {
          throw fsMockState.mkdirResult;
        }
        return fsMockState.mkdirResult;
      }),
    },
  },
  existsSync: vi.fn((filePath: string) => {
    if (typeof fsMockState.existsSyncResult === 'function') {
      return fsMockState.existsSyncResult(filePath);
    }
    return fsMockState.existsSyncResult;
  }),
  promises: {
    readFile: vi.fn(async () => {
      if (fsMockState.readFileResult instanceof Error) {
        throw fsMockState.readFileResult;
      }
      return fsMockState.readFileResult;
    }),
    writeFile: vi.fn(async () => {
      if (fsMockState.writeFileResult instanceof Error) {
        throw fsMockState.writeFileResult;
      }
      return fsMockState.writeFileResult;
    }),
    mkdir: vi.fn(async () => {
      if (fsMockState.mkdirResult instanceof Error) {
        throw fsMockState.mkdirResult;
      }
      return fsMockState.mkdirResult;
    }),
  },
}));

// ============================================================================
// TEST SUITE
// ============================================================================

describe('ConfigManager', () => {
  beforeEach(async () => {
    // Reset all mocks
    vi.clearAllMocks();
    clearLoggerCalls();

    // Reset fs mock state to defaults
    fsMockState.existsSyncResult = false;
    fsMockState.readFileResult = '';
    fsMockState.writeFileResult = undefined;
    fsMockState.mkdirResult = undefined;

    // Reset module to get fresh instance
    vi.resetModules();
  });

  describe('initialize', () => {
    it('should initialize successfully when no user config exists', async () => {
      // Import fresh module
      const { config } = await import('./config.js');

      // No config file exists
      fsMockState.existsSyncResult = false;

      await config.initialize();

      // Should log successful initialization with defaults
      const initLog = loggerCalls.info.find(log => log.message === 'Configuration initialized');
      expect(initLog).toBeDefined();
      expect(initLog?.data).toEqual(expect.objectContaining({
        usingDefaults: true,
      }));
    });

    it('should load user config successfully when valid JSON exists', async () => {
      const { config } = await import('./config.js');

      const userConfig = {
        logging: { level: 'debug' },
        features: { telemetry: true },
      };

      // Config file exists
      fsMockState.existsSyncResult = (filePath: string) => filePath.includes('config.json');
      fsMockState.readFileResult = JSON.stringify(userConfig);

      await config.initialize();

      // Should log successful config load
      const loadLog = loggerCalls.debug.find(log => log.message === 'Loaded user config successfully');
      expect(loadLog).toBeDefined();
      expect(loadLog?.data).toEqual(expect.objectContaining({
        configPath: expect.stringContaining('config.json'),
      }));

      // Should log initialization without defaults
      const initLog = loggerCalls.info.find(log => log.message === 'Configuration initialized');
      expect(initLog).toBeDefined();
      expect(initLog?.data).toEqual(expect.objectContaining({
        usingDefaults: false,
      }));
    });

    it('should handle corrupted JSON config gracefully and use defaults', async () => {
      const { config } = await import('./config.js');

      // Config file exists but contains invalid JSON
      fsMockState.existsSyncResult = (filePath: string) => filePath.includes('config.json');
      fsMockState.readFileResult = '{ invalid json content }}}';

      await config.initialize();

      // Should log warning with JSON parse error details
      const warnLog = loggerCalls.warn.find(log =>
        log.message === 'Failed to load user config, using defaults'
      );
      expect(warnLog).toBeDefined();
      expect(warnLog?.error).toBeInstanceOf(Error);
      expect(warnLog?.metadata).toEqual(expect.objectContaining({
        errorType: 'JSON_PARSE_ERROR',
        configPath: expect.stringContaining('config.json'),
      }));

      // Should still initialize with defaults
      const initLog = loggerCalls.info.find(log =>
        log.message === 'Configuration initialized with defaults due to config load error'
      );
      expect(initLog).toBeDefined();
      expect(initLog?.data).toEqual(expect.objectContaining({
        configLoadError: expect.any(String),
      }));
    });

    it('should handle file read permission errors gracefully', async () => {
      const { config } = await import('./config.js');

      // Config file exists but cannot be read
      fsMockState.existsSyncResult = (filePath: string) => filePath.includes('config.json');

      const permissionError = new Error('EACCES: permission denied');
      (permissionError as NodeJS.ErrnoException).code = 'EACCES';
      fsMockState.readFileResult = permissionError;

      await config.initialize();

      // Should log warning with file read error details
      const warnLog = loggerCalls.warn.find(log =>
        log.message === 'Failed to load user config, using defaults'
      );
      expect(warnLog).toBeDefined();
      expect(warnLog?.metadata).toEqual(expect.objectContaining({
        errorType: 'FILE_READ_ERROR',
        errorMessage: 'EACCES: permission denied',
      }));

      // Should still initialize with defaults
      const initLog = loggerCalls.info.find(log =>
        log.message === 'Configuration initialized with defaults due to config load error'
      );
      expect(initLog).toBeDefined();
    });

    it('should handle file not found errors after existsSync (race condition)', async () => {
      const { config } = await import('./config.js');

      // File exists when checked but deleted before read (race condition)
      fsMockState.existsSyncResult = (filePath: string) => filePath.includes('config.json');

      const notFoundError = new Error('ENOENT: no such file or directory');
      (notFoundError as NodeJS.ErrnoException).code = 'ENOENT';
      fsMockState.readFileResult = notFoundError;

      await config.initialize();

      // Should handle gracefully
      const warnLog = loggerCalls.warn.find(log =>
        log.message === 'Failed to load user config, using defaults'
      );
      expect(warnLog).toBeDefined();
      expect(warnLog?.metadata).toEqual(expect.objectContaining({
        errorType: 'FILE_READ_ERROR',
      }));
    });

    it('should not re-initialize if already initialized', async () => {
      const { config } = await import('./config.js');

      fsMockState.existsSyncResult = false;

      await config.initialize();
      const firstCallCount = loggerCalls.info.length;

      // Second initialization should be no-op
      await config.initialize();

      expect(loggerCalls.info.length).toBe(firstCallCount);
    });
  });

  describe('saveConfig', () => {
    it('should save config successfully', async () => {
      const { config } = await import('./config.js');

      fsMockState.existsSyncResult = false;
      fsMockState.mkdirResult = undefined;
      fsMockState.writeFileResult = undefined;

      await config.initialize();
      await config.saveConfig();

      const saveLog = loggerCalls.info.find(log => log.message === 'Configuration saved');
      expect(saveLog).toBeDefined();
    });

    it('should throw and log error when save fails', async () => {
      const { config } = await import('./config.js');

      fsMockState.existsSyncResult = false;
      fsMockState.mkdirResult = undefined;

      const writeError = new Error('ENOSPC: no space left on device');
      fsMockState.writeFileResult = writeError;

      await config.initialize();

      // Save should throw error (not swallow it)
      await expect(config.saveConfig()).rejects.toThrow('ENOSPC');

      // Should log error before throwing
      const errorLog = loggerCalls.error.find(log => log.message === 'Failed to save config');
      expect(errorLog).toBeDefined();
      expect(errorLog?.error).toBe(writeError);
    });

    it('should throw and log error when directory creation fails', async () => {
      const { config } = await import('./config.js');

      fsMockState.existsSyncResult = false;

      const mkdirError = new Error('EACCES: permission denied');
      fsMockState.mkdirResult = mkdirError;

      await config.initialize();

      await expect(config.saveConfig()).rejects.toThrow('EACCES');

      const errorLog = loggerCalls.error.find(log => log.message === 'Failed to save config');
      expect(errorLog).toBeDefined();
      expect(errorLog?.error).toBe(mkdirError);
    });
  });

  describe('error propagation verification', () => {
    it('should propagate errors with proper context from loadConfig', async () => {
      const { config } = await import('./config.js');

      fsMockState.existsSyncResult = (filePath: string) => filePath.includes('config.json');

      // Simulate a file read error (not JSON parse error)
      const readError = new Error('EMFILE: too many open files');
      (readError as NodeJS.ErrnoException).code = 'EMFILE';
      fsMockState.readFileResult = readError;

      await config.initialize();

      // Should report FILE_READ_ERROR
      const warnLog = loggerCalls.warn.find(log =>
        log.message === 'Failed to load user config, using defaults'
      );
      expect(warnLog).toBeDefined();
      expect(warnLog?.error).toBeInstanceOf(Error);
      expect(warnLog?.metadata).toEqual(expect.objectContaining({
        errorType: 'FILE_READ_ERROR',
        errorMessage: expect.stringContaining('EMFILE'),
      }));
    });

    it('should not swallow initialization errors', async () => {
      // This test verifies that critical initialization errors are thrown,
      // not silently ignored

      const { config } = await import('./config.js');
      const { app } = await import('electron');

      // Mock getPath to throw - this simulates a critical failure
      (app.getPath as MockedFunction<typeof app.getPath>).mockImplementation(() => {
        throw new Error('Critical Electron error');
      });

      await expect(config.initialize()).rejects.toThrow('Critical Electron error');

      const errorLog = loggerCalls.error.find(log =>
        log.message === 'Failed to initialize config'
      );
      expect(errorLog).toBeDefined();
    });
  });

  describe('config getters after error recovery', () => {
    it('should return default values after config load error', async () => {
      // Need to reset the electron mock before this test since the previous test modified it
      const { app } = await import('electron');
      (app.getPath as MockedFunction<typeof app.getPath>).mockImplementation((pathType: string) => {
        if (pathType === 'userData') return mockUserDataPath;
        return '/mock/path';
      });

      const { config } = await import('./config.js');

      fsMockState.existsSyncResult = (filePath: string) => filePath.includes('config.json');
      fsMockState.readFileResult = new Error('Read error');

      await config.initialize();

      // Should return defaults even after load error
      const limits = config.get('limits');
      expect(limits.maxTerminals).toBe(20);
      expect(limits.maxSessionMessageCache).toBe(1000);
    });
  });
});
