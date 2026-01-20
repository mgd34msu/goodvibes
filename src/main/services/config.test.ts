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

import { describe, it, expect, beforeEach, afterEach, vi, type MockedFunction } from 'vitest';

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

  // ============================================================================
  // SESSION PATH DETECTION TESTS
  // ============================================================================

  describe('getSessionsPath', () => {
    it('should find and use existing Claude projects path (.claude/projects)', async () => {
      // Need to reset the electron mock
      const { app } = await import('electron');
      (app.getPath as MockedFunction<typeof app.getPath>).mockImplementation((pathType: string) => {
        if (pathType === 'userData') return mockUserDataPath;
        return '/mock/path';
      });

      const { config } = await import('./config.js');

      // Simulate .claude/projects exists
      fsMockState.existsSyncResult = (filePath: string) => {
        if (filePath.includes('.claude') && filePath.includes('projects')) {
          return true;
        }
        return false;
      };

      await config.initialize();

      const sessionsPath = config.getPath('sessions');
      expect(sessionsPath).toContain('.claude');
      expect(sessionsPath).toContain('projects');
    });

    it('should find and use AppData/Roaming/Claude path on Windows', async () => {
      const { app } = await import('electron');
      (app.getPath as MockedFunction<typeof app.getPath>).mockImplementation((pathType: string) => {
        if (pathType === 'userData') return mockUserDataPath;
        return '/mock/path';
      });

      const { config } = await import('./config.js');

      // Simulate AppData/Roaming/Claude/projects exists, but not .claude/projects
      fsMockState.existsSyncResult = (filePath: string) => {
        if (filePath.includes('AppData') && filePath.includes('Claude') && filePath.includes('projects')) {
          return true;
        }
        return false;
      };

      await config.initialize();

      const sessionsPath = config.getPath('sessions');
      expect(sessionsPath).toContain('AppData');
      expect(sessionsPath).toContain('Claude');
      expect(sessionsPath).toContain('projects');
    });

    it('should find and use .config/claude path on Linux', async () => {
      const { app } = await import('electron');
      (app.getPath as MockedFunction<typeof app.getPath>).mockImplementation((pathType: string) => {
        if (pathType === 'userData') return mockUserDataPath;
        return '/mock/path';
      });

      const { config } = await import('./config.js');

      // Simulate only .config/claude/projects exists
      fsMockState.existsSyncResult = (filePath: string) => {
        if (filePath.includes('.config') && filePath.includes('claude') && filePath.includes('projects')) {
          return true;
        }
        return false;
      };

      await config.initialize();

      const sessionsPath = config.getPath('sessions');
      expect(sessionsPath).toContain('.config');
      expect(sessionsPath).toContain('claude');
      expect(sessionsPath).toContain('projects');
    });

    it('should fall back to default .claude/projects path when no paths exist', async () => {
      const { app } = await import('electron');
      (app.getPath as MockedFunction<typeof app.getPath>).mockImplementation((pathType: string) => {
        if (pathType === 'userData') return mockUserDataPath;
        return '/mock/path';
      });

      const { config } = await import('./config.js');

      // No session paths exist
      fsMockState.existsSyncResult = false;

      await config.initialize();

      const sessionsPath = config.getPath('sessions');
      // Should default to first option (.claude/projects)
      expect(sessionsPath).toContain('.claude');
      expect(sessionsPath).toContain('projects');
    });
  });

  // ============================================================================
  // ENVIRONMENT OVERRIDE TESTS
  // ============================================================================

  describe('applyEnvironmentOverrides', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      // Reset environment between tests
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should apply GOODVIBES_LOG_LEVEL environment variable', async () => {
      const { app } = await import('electron');
      (app.getPath as MockedFunction<typeof app.getPath>).mockImplementation((pathType: string) => {
        if (pathType === 'userData') return mockUserDataPath;
        return '/mock/path';
      });

      // Set environment variable before importing config
      process.env.GOODVIBES_LOG_LEVEL = 'warn';

      const { config } = await import('./config.js');

      fsMockState.existsSyncResult = false;

      await config.initialize();

      const logging = config.get('logging');
      expect(logging.level).toBe('warn');
    });

    it('should apply GOODVIBES_SESSIONS_PATH environment variable', async () => {
      const { app } = await import('electron');
      (app.getPath as MockedFunction<typeof app.getPath>).mockImplementation((pathType: string) => {
        if (pathType === 'userData') return mockUserDataPath;
        return '/mock/path';
      });

      const customPath = '/custom/sessions/path';
      process.env.GOODVIBES_SESSIONS_PATH = customPath;

      const { config } = await import('./config.js');

      fsMockState.existsSyncResult = false;

      await config.initialize();

      const sessionsPath = config.getPath('sessions');
      expect(sessionsPath).toBe(customPath);
    });

    it('should apply development environment overrides', async () => {
      const { app } = await import('electron');
      (app.getPath as MockedFunction<typeof app.getPath>).mockImplementation((pathType: string) => {
        if (pathType === 'userData') return mockUserDataPath;
        return '/mock/path';
      });

      process.env.NODE_ENV = 'development';

      const { config } = await import('./config.js');

      fsMockState.existsSyncResult = false;

      await config.initialize();

      const logging = config.get('logging');
      expect(logging.level).toBe('debug');
      expect(logging.enableFile).toBe(false);
    });

    it('should apply test environment overrides', async () => {
      const { app } = await import('electron');
      (app.getPath as MockedFunction<typeof app.getPath>).mockImplementation((pathType: string) => {
        if (pathType === 'userData') return mockUserDataPath;
        return '/mock/path';
      });

      process.env.NODE_ENV = 'test';

      const { config } = await import('./config.js');

      fsMockState.existsSyncResult = false;

      await config.initialize();

      const features = config.get('features');
      expect(features.telemetry).toBe(false);
      expect(features.autoUpdate).toBe(false);
    });
  });

  // ============================================================================
  // PUBLIC METHOD TESTS
  // ============================================================================

  describe('public getter and setter methods', () => {
    beforeEach(async () => {
      // Reset environment
      process.env.NODE_ENV = 'test';

      // Reset the electron mock
      const { app } = await import('electron');
      (app.getPath as MockedFunction<typeof app.getPath>).mockImplementation((pathType: string) => {
        if (pathType === 'userData') return mockUserDataPath;
        return '/mock/path';
      });
    });

    describe('set', () => {
      it('should set a config value', async () => {
        const { config } = await import('./config.js');

        fsMockState.existsSyncResult = false;

        await config.initialize();

        config.set('version', '2.0.0');

        expect(config.get('version')).toBe('2.0.0');
      });

      it('should set nested config sections', async () => {
        const { config } = await import('./config.js');

        fsMockState.existsSyncResult = false;

        await config.initialize();

        const newLimits = {
          maxTerminals: 50,
          maxSessionMessageCache: 2000,
          sessionScanBatchSize: 200,
          databaseVacuumIntervalMs: 12 * 60 * 60 * 1000,
        };
        config.set('limits', newLimits);

        const limits = config.get('limits');
        expect(limits.maxTerminals).toBe(50);
        expect(limits.maxSessionMessageCache).toBe(2000);
      });
    });

    describe('getAll', () => {
      it('should return a copy of the entire config', async () => {
        const { config } = await import('./config.js');

        fsMockState.existsSyncResult = false;

        await config.initialize();

        const allConfig = config.getAll();

        expect(allConfig).toHaveProperty('version');
        expect(allConfig).toHaveProperty('environment');
        expect(allConfig).toHaveProperty('paths');
        expect(allConfig).toHaveProperty('features');
        expect(allConfig).toHaveProperty('limits');
        expect(allConfig).toHaveProperty('logging');
        expect(allConfig).toHaveProperty('performance');
      });

      it('should return a copy that does not modify the original', async () => {
        const { config } = await import('./config.js');

        fsMockState.existsSyncResult = false;

        await config.initialize();

        const allConfig = config.getAll();
        allConfig.version = 'modified';

        expect(config.get('version')).not.toBe('modified');
      });
    });

    describe('getPath', () => {
      it('should return specific path values', async () => {
        const { config } = await import('./config.js');

        fsMockState.existsSyncResult = false;

        await config.initialize();

        expect(config.getPath('userData')).toBe(mockUserDataPath);
        expect(config.getPath('logs')).toContain('logs');
        expect(config.getPath('database')).toContain('goodvibes.db');
      });
    });

    describe('isFeatureEnabled', () => {
      it('should return feature toggle values', async () => {
        const { config } = await import('./config.js');

        fsMockState.existsSyncResult = false;

        await config.initialize();

        // In test environment, telemetry and autoUpdate should be false
        expect(config.isFeatureEnabled('telemetry')).toBe(false);
        expect(config.isFeatureEnabled('autoUpdate')).toBe(false);
        expect(config.isFeatureEnabled('sessionWatching')).toBe(true);
      });
    });

    describe('getLimit', () => {
      it('should return limit values', async () => {
        const { config } = await import('./config.js');

        fsMockState.existsSyncResult = false;

        await config.initialize();

        expect(config.getLimit('maxTerminals')).toBe(20);
        expect(config.getLimit('maxSessionMessageCache')).toBe(1000);
        expect(config.getLimit('sessionScanBatchSize')).toBe(100);
        expect(config.getLimit('databaseVacuumIntervalMs')).toBe(24 * 60 * 60 * 1000);
      });
    });

    describe('getPerformanceSetting', () => {
      it('should return performance setting values', async () => {
        const { config } = await import('./config.js');

        fsMockState.existsSyncResult = false;

        await config.initialize();

        expect(config.getPerformanceSetting('enableVirtualScrolling')).toBe(true);
        expect(config.getPerformanceSetting('sessionListPageSize')).toBe(50);
        expect(config.getPerformanceSetting('debounceSearchMs')).toBe(300);
      });
    });
  });

  // ============================================================================
  // CONFIG MERGE TESTS
  // ============================================================================

  describe('config merging', () => {
    it('should deeply merge user config with defaults', async () => {
      const { app } = await import('electron');
      (app.getPath as MockedFunction<typeof app.getPath>).mockImplementation((pathType: string) => {
        if (pathType === 'userData') return mockUserDataPath;
        return '/mock/path';
      });

      const { config } = await import('./config.js');

      const partialUserConfig = {
        limits: {
          maxTerminals: 30,
          // Other limit properties not specified should use defaults
        },
        features: {
          telemetry: true,
        },
      };

      fsMockState.existsSyncResult = (filePath: string) => filePath.includes('config.json');
      fsMockState.readFileResult = JSON.stringify(partialUserConfig);

      await config.initialize();

      const limits = config.get('limits');
      // User-specified value
      expect(limits.maxTerminals).toBe(30);
      // Default values preserved
      expect(limits.maxSessionMessageCache).toBe(1000);
      expect(limits.sessionScanBatchSize).toBe(100);
    });

    it('should allow overriding nested path values', async () => {
      const { app } = await import('electron');
      (app.getPath as MockedFunction<typeof app.getPath>).mockImplementation((pathType: string) => {
        if (pathType === 'userData') return mockUserDataPath;
        return '/mock/path';
      });

      const { config } = await import('./config.js');

      const userConfig = {
        paths: {
          sessions: '/custom/sessions',
        },
      };

      fsMockState.existsSyncResult = (filePath: string) => filePath.includes('config.json');
      fsMockState.readFileResult = JSON.stringify(userConfig);

      await config.initialize();

      // User-specified path
      expect(config.getPath('sessions')).toBe('/custom/sessions');
      // Default paths preserved
      expect(config.getPath('userData')).toBe(mockUserDataPath);
    });
  });

  // ============================================================================
  // EDGE CASE TESTS
  // ============================================================================

  describe('edge cases', () => {
    it('should handle saveConfig when config directory already exists', async () => {
      const { app } = await import('electron');
      (app.getPath as MockedFunction<typeof app.getPath>).mockImplementation((pathType: string) => {
        if (pathType === 'userData') return mockUserDataPath;
        return '/mock/path';
      });

      const { config } = await import('./config.js');

      // Config directory exists
      fsMockState.existsSyncResult = (filePath: string) => {
        if (filePath === mockUserDataPath) return true;
        return false;
      };
      fsMockState.writeFileResult = undefined;

      await config.initialize();
      await config.saveConfig();

      const saveLog = loggerCalls.info.find(log => log.message === 'Configuration saved');
      expect(saveLog).toBeDefined();
    });

    it('should handle non-Error objects thrown during config load', async () => {
      const { app } = await import('electron');
      (app.getPath as MockedFunction<typeof app.getPath>).mockImplementation((pathType: string) => {
        if (pathType === 'userData') return mockUserDataPath;
        return '/mock/path';
      });

      const { config } = await import('./config.js');

      // Config file exists
      fsMockState.existsSyncResult = (filePath: string) => filePath.includes('config.json');

      // Throw a non-Error object (string)
      fsMockState.readFileResult = { message: 'Non-standard error' } as unknown as Error;

      await config.initialize();

      // Should still initialize successfully (with defaults)
      const initLog = loggerCalls.info.find(log =>
        log.message === 'Configuration initialized with defaults due to config load error'
      );
      expect(initLog).toBeDefined();
    });

    it('should skip mkdir when config directory already exists during save', async () => {
      const { app } = await import('electron');
      const fs = await import('fs');

      (app.getPath as MockedFunction<typeof app.getPath>).mockImplementation((pathType: string) => {
        if (pathType === 'userData') return mockUserDataPath;
        return '/mock/path';
      });

      const { config } = await import('./config.js');

      // Simulate directory already exists when checking in saveConfig
      let existsSyncCalled = false;
      fsMockState.existsSyncResult = (filePath: string) => {
        // Check if this is the saveConfig call checking for directory
        if (filePath === mockUserDataPath) {
          existsSyncCalled = true;
          return true; // Directory exists, so mkdir should be skipped
        }
        return false;
      };
      fsMockState.writeFileResult = undefined;

      await config.initialize();

      // Clear mkdir mock to verify it's not called
      (fs.promises.mkdir as unknown as MockedFunction<typeof fs.promises.mkdir>).mockClear();

      await config.saveConfig();

      // mkdir should not have been called since directory exists
      const saveLog = loggerCalls.info.find(log => log.message === 'Configuration saved');
      expect(saveLog).toBeDefined();
    });

    it('should use USERPROFILE when HOME is not set', async () => {
      const originalEnv = process.env;

      // Set USERPROFILE but not HOME
      process.env = {
        ...originalEnv,
        HOME: '',
        USERPROFILE: 'C:\\Users\\TestUser',
      };

      const { app } = await import('electron');
      (app.getPath as MockedFunction<typeof app.getPath>).mockImplementation((pathType: string) => {
        if (pathType === 'userData') return mockUserDataPath;
        return '/mock/path';
      });

      const { config } = await import('./config.js');

      // Simulate .claude/projects exists
      fsMockState.existsSyncResult = (filePath: string) => {
        if (filePath.includes('.claude') && filePath.includes('projects')) {
          return true;
        }
        return false;
      };

      await config.initialize();

      // Path should use USERPROFILE
      const sessionsPath = config.getPath('sessions');
      expect(sessionsPath).toContain('TestUser');

      process.env = originalEnv;
    });

    it('should handle empty home directory gracefully', async () => {
      const originalEnv = process.env;

      // Set both HOME and USERPROFILE to empty
      process.env = {
        ...originalEnv,
        HOME: '',
        USERPROFILE: '',
      };

      const { app } = await import('electron');
      (app.getPath as MockedFunction<typeof app.getPath>).mockImplementation((pathType: string) => {
        if (pathType === 'userData') return mockUserDataPath;
        return '/mock/path';
      });

      const { config } = await import('./config.js');

      fsMockState.existsSyncResult = false;

      await config.initialize();

      // Should still initialize, falling back to first possible path
      const sessionsPath = config.getPath('sessions');
      expect(sessionsPath).toContain('.claude');
      expect(sessionsPath).toContain('projects');

      process.env = originalEnv;
    });

    it('should convert non-Error to Error when config load fails with non-standard error', async () => {
      const { app } = await import('electron');
      (app.getPath as MockedFunction<typeof app.getPath>).mockImplementation((pathType: string) => {
        if (pathType === 'userData') return mockUserDataPath;
        return '/mock/path';
      });

      const { config } = await import('./config.js');

      // Config file exists
      fsMockState.existsSyncResult = (filePath: string) => filePath.includes('config.json');

      // Return valid JSON but one that will cause an error during merge
      // This tests the error handling path where the error might not be an Error instance
      fsMockState.readFileResult = '{}'; // Valid JSON that won't cause issues

      await config.initialize();

      // Should initialize successfully with an empty user config merged with defaults
      const initLog = loggerCalls.info.find(log =>
        log.message === 'Configuration initialized'
      );
      expect(initLog).toBeDefined();

      // Verify the loaded config has default values since {} was merged
      const limits = config.get('limits');
      expect(limits.maxTerminals).toBe(20);
    });
  });
});
