// ============================================================================
// SETTINGS IPC HANDLERS UNIT TESTS
// ============================================================================
//
// Comprehensive tests for settings IPC handlers covering:
// - get-setting handler validation and behavior
// - set-setting handler with Zod validation
// - get-all-settings handler
// - get-app-path handler with enum validation
// - Theme setting validation (colorTheme, theme)
// - Error handling via IPCValidationError
// - Security edge cases
//
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain, app, IpcMainInvokeEvent } from 'electron';

// Mock electron before importing the module under test
vi.mock('electron', () => {
  return {
    ipcMain: {
      handle: vi.fn(),
    },
    app: {
      getVersion: vi.fn().mockReturnValue('1.0.0'),
      getPath: vi.fn().mockImplementation((name: string) => `/mock/path/${name}`),
    },
  };
});

// Mock the database module
vi.mock('../../database/index.js', () => {
  return {
    getSetting: vi.fn(),
    setSetting: vi.fn(),
    getAllSettings: vi.fn(),
  };
});

// Mock the logger with a proper class
vi.mock('../../services/logger.js', () => {
  return {
    Logger: class MockLogger {
      info = vi.fn();
      warn = vi.fn();
      error = vi.fn();
      debug = vi.fn();
    },
  };
});

// Mock withContext to pass through the handler directly
vi.mock('../utils.js', () => {
  return {
    withContext: vi.fn().mockImplementation(
      (_operation: string, handler: (...args: unknown[]) => Promise<unknown>) => handler
    ),
  };
});

// Import after mocks
import { registerSettingsHandlers } from './settings.js';
import * as db from '../../database/index.js';
import {
  getSettingInputSchema,
  setSettingInputSchema,
  getAppPathInputSchema,
  validateInput,
  isThemeSettingKey,
  validateThemeSettingValue,
} from '../schemas/index.js';

// ============================================================================
// TEST UTILITIES
// ============================================================================

/**
 * Creates a mock IPC event for testing handlers
 */
function createMockEvent(): IpcMainInvokeEvent {
  return {
    sender: {
      id: 1,
      getURL: () => 'http://localhost',
      send: vi.fn(),
    },
    frameId: 1,
    processId: 1,
    senderFrame: null,
  } as unknown as IpcMainInvokeEvent;
}

/**
 * Captures registered IPC handlers for testing
 */
interface RegisteredHandlers {
  'get-setting'?: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;
  'set-setting'?: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;
  'get-all-settings'?: (event: IpcMainInvokeEvent) => Promise<unknown>;
  'get-app-version'?: (event: IpcMainInvokeEvent) => Promise<unknown>;
  'get-app-path'?: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;
}

// Capture handlers once at module level since registerSettingsHandlers modifies global ipcMain
const capturedHandlers: RegisteredHandlers = {};
let handlersInitialized = false;

function initializeHandlers(): void {
  if (handlersInitialized) return;

  const mockHandle = ipcMain.handle as ReturnType<typeof vi.fn>;
  mockHandle.mockImplementation((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
    capturedHandlers[channel as keyof RegisteredHandlers] = handler as RegisteredHandlers[keyof RegisteredHandlers];
  });

  registerSettingsHandlers();
  handlersInitialized = true;
}

function getHandlers(): RegisteredHandlers {
  initializeHandlers();
  return capturedHandlers;
}

// ============================================================================
// SCHEMA VALIDATION TESTS
// ============================================================================

describe('Settings Schema Validation', () => {
  describe('getSettingInputSchema', () => {
    describe('valid keys', () => {
      const validKeys = [
        'theme',
        'colorTheme',
        'userSettings',
        'appConfig',
        'setting123',
        'my.nested.setting',
        'config_v2',
      ];

      validKeys.forEach((key) => {
        it(`accepts valid key "${key}"`, () => {
          const result = validateInput(getSettingInputSchema, key);
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.data).toBe(key);
          }
        });
      });
    });

    describe('invalid keys', () => {
      const invalidKeys = [
        { value: '', reason: 'empty string' },
        { value: '123start', reason: 'starts with number' },
        { value: '_private', reason: 'starts with underscore' },
        { value: 'has space', reason: 'contains space' },
        { value: 'has-dash', reason: 'contains dash' },
        { value: 'special@char', reason: 'contains special character' },
        { value: 'a'.repeat(101), reason: 'exceeds max length' },
        { value: null, reason: 'null' },
        { value: undefined, reason: 'undefined' },
        { value: 123, reason: 'number' },
        { value: {}, reason: 'object' },
        { value: [], reason: 'array' },
      ];

      invalidKeys.forEach(({ value, reason }) => {
        it(`rejects ${reason}`, () => {
          const result = validateInput(getSettingInputSchema, value);
          expect(result.success).toBe(false);
          if (!result.success) {
            expect(result.error).toBeTruthy();
          }
        });
      });
    });
  });

  describe('setSettingInputSchema', () => {
    describe('valid updates', () => {
      const validUpdates = [
        { key: 'theme', value: 'dark' },
        { key: 'fontSize', value: 14 },
        { key: 'autoSave', value: true },
        { key: 'config', value: { nested: { data: 123 } } },
        { key: 'list', value: [1, 2, 3] },
        { key: 'nullable', value: null },
      ];

      validUpdates.forEach(({ key, value }) => {
        it(`accepts valid update with key="${key}"`, () => {
          const result = validateInput(setSettingInputSchema, { key, value });
          expect(result.success).toBe(true);
        });
      });
    });

    describe('invalid updates', () => {
      const invalidUpdates = [
        { data: { key: '', value: 'test' }, reason: 'empty key' },
        { data: { key: '123', value: 'test' }, reason: 'key starting with number' },
        { data: { value: 'test' }, reason: 'missing key' },
        { data: {}, reason: 'empty object' },
        { data: null, reason: 'null' },
        { data: 'string', reason: 'string instead of object' },
      ];

      invalidUpdates.forEach(({ data, reason }) => {
        it(`rejects ${reason}`, () => {
          const result = validateInput(setSettingInputSchema, data);
          expect(result.success).toBe(false);
        });
      });
    });
  });

  describe('getAppPathInputSchema', () => {
    describe('valid path names', () => {
      const validNames = [
        'home', 'appData', 'userData', 'sessionData', 'temp', 'exe',
        'module', 'desktop', 'documents', 'downloads', 'music',
        'pictures', 'videos', 'recent', 'logs', 'crashDumps',
      ];

      validNames.forEach((name) => {
        it(`accepts "${name}"`, () => {
          const result = validateInput(getAppPathInputSchema, name);
          expect(result.success).toBe(true);
        });
      });
    });

    describe('invalid path names', () => {
      const invalidNames = [
        { value: 'invalid', reason: 'not in enum' },
        { value: 'HOME', reason: 'wrong case' },
        { value: 'app-data', reason: 'dash instead of camelCase' },
        { value: '', reason: 'empty string' },
        { value: null, reason: 'null' },
        { value: undefined, reason: 'undefined' },
        { value: 123, reason: 'number' },
        { value: 'root', reason: 'root path not allowed' },
        { value: '../etc', reason: 'path traversal attempt' },
        { value: '/etc/passwd', reason: 'absolute path' },
      ];

      invalidNames.forEach(({ value, reason }) => {
        it(`rejects ${reason}`, () => {
          const result = validateInput(getAppPathInputSchema, value);
          expect(result.success).toBe(false);
        });
      });
    });
  });
});

// ============================================================================
// THEME VALIDATION TESTS
// ============================================================================

describe('Theme Validation', () => {
  describe('isThemeSettingKey', () => {
    it('returns true for colorTheme', () => {
      expect(isThemeSettingKey('colorTheme')).toBe(true);
    });

    it('returns true for theme', () => {
      expect(isThemeSettingKey('theme')).toBe(true);
    });

    it('returns false for other keys', () => {
      expect(isThemeSettingKey('fontSize')).toBe(false);
      expect(isThemeSettingKey('userSettings')).toBe(false);
      expect(isThemeSettingKey('colorThemes')).toBe(false);
    });
  });

  describe('validateThemeSettingValue', () => {
    describe('colorTheme validation', () => {
      const validThemeIds = [
        'goodvibes-classic',
        'catppuccin-latte',
        'catppuccin-frappe',
        'catppuccin-macchiato',
        'catppuccin-mocha',
        'dracula',
        'one-dark',
        'nord',
        'solarized-dark',
        'solarized-light',
        'tokyo-night',
        'gruvbox-dark',
      ];

      validThemeIds.forEach((themeId) => {
        it(`accepts valid theme ID "${themeId}"`, () => {
          const result = validateThemeSettingValue('colorTheme', themeId);
          expect(result.success).toBe(true);
        });
      });

      it('rejects invalid theme ID', () => {
        const result = validateThemeSettingValue('colorTheme', 'invalid-theme');
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('Invalid theme ID');
        }
      });

      it('rejects empty string for theme ID', () => {
        const result = validateThemeSettingValue('colorTheme', '');
        expect(result.success).toBe(false);
      });

      it('rejects number for theme ID', () => {
        const result = validateThemeSettingValue('colorTheme', 123);
        expect(result.success).toBe(false);
      });

      it('rejects null for theme ID', () => {
        const result = validateThemeSettingValue('colorTheme', null);
        expect(result.success).toBe(false);
      });
    });

    describe('theme variant validation', () => {
      it('accepts dark variant', () => {
        const result = validateThemeSettingValue('theme', 'dark');
        expect(result.success).toBe(true);
      });

      it('accepts light variant', () => {
        const result = validateThemeSettingValue('theme', 'light');
        expect(result.success).toBe(true);
      });

      it('rejects invalid variant', () => {
        const result = validateThemeSettingValue('theme', 'auto');
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain('must be "dark" or "light"');
        }
      });

      it('rejects empty string for variant', () => {
        const result = validateThemeSettingValue('theme', '');
        expect(result.success).toBe(false);
      });
    });

    describe('non-theme keys', () => {
      it('passes through for non-theme settings', () => {
        const result = validateThemeSettingValue('fontSize', 'anything');
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBe('anything');
        }
      });
    });
  });
});

// ============================================================================
// IPC HANDLER TESTS
// ============================================================================

describe('Settings IPC Handlers', () => {
  let handlers: RegisteredHandlers;
  let mockEvent: IpcMainInvokeEvent;

  beforeEach(() => {
    // Only clear database mocks, not the ipcMain.handle mock
    vi.mocked(db.getSetting).mockReset();
    vi.mocked(db.setSetting).mockReset();
    vi.mocked(db.getAllSettings).mockReset();
    vi.mocked(app.getVersion).mockReturnValue('1.0.0');
    vi.mocked(app.getPath).mockImplementation((name: string) => `/mock/path/${name}`);
    handlers = getHandlers();
    mockEvent = createMockEvent();
  });

  describe('Handler Registration', () => {
    it('registers all expected handlers', () => {
      expect(handlers['get-setting']).toBeDefined();
      expect(handlers['set-setting']).toBeDefined();
      expect(handlers['get-all-settings']).toBeDefined();
      expect(handlers['get-app-version']).toBeDefined();
      expect(handlers['get-app-path']).toBeDefined();
    });

    it('registers handlers as callable functions', () => {
      // Verify that all handlers are actually functions (proving ipcMain.handle was called)
      expect(typeof handlers['get-setting']).toBe('function');
      expect(typeof handlers['set-setting']).toBe('function');
      expect(typeof handlers['get-all-settings']).toBe('function');
      expect(typeof handlers['get-app-version']).toBe('function');
      expect(typeof handlers['get-app-path']).toBe('function');
    });
  });

  describe('get-setting handler', () => {
    it('returns setting value for valid key', async () => {
      const mockValue = { darkMode: true };
      (db.getSetting as ReturnType<typeof vi.fn>).mockReturnValue(mockValue);

      const handler = handlers['get-setting'];
      expect(handler).toBeDefined();

      const result = await handler!(mockEvent, 'userSettings');

      expect(db.getSetting).toHaveBeenCalledWith('userSettings');
      expect(result).toEqual(mockValue);
    });

    it('returns null for non-existent setting', async () => {
      (db.getSetting as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const handler = handlers['get-setting'];
      const result = await handler!(mockEvent, 'nonexistent');

      expect(result).toBeNull();
    });

    it('throws IPCValidationError for invalid key format', async () => {
      const handler = handlers['get-setting'];

      await expect(handler!(mockEvent, '')).rejects.toThrow('Invalid setting key');
      await expect(handler!(mockEvent, '123invalid')).rejects.toThrow('Invalid setting key');
      await expect(handler!(mockEvent, '_private')).rejects.toThrow('Invalid setting key');
    });

    it('throws IPCValidationError for non-string key', async () => {
      const handler = handlers['get-setting'];

      await expect(handler!(mockEvent, 123)).rejects.toThrow('Invalid setting key');
      await expect(handler!(mockEvent, null)).rejects.toThrow('Invalid setting key');
      await expect(handler!(mockEvent, undefined)).rejects.toThrow('Invalid setting key');
      await expect(handler!(mockEvent, {})).rejects.toThrow('Invalid setting key');
    });

    it('throws error with validation details', async () => {
      const handler = handlers['get-setting'];

      try {
        await handler!(mockEvent, '');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('Invalid setting key');
      }
    });
  });

  describe('set-setting handler', () => {
    it('sets setting value for valid input', async () => {
      const handler = handlers['set-setting'];

      const result = await handler!(mockEvent, { key: 'fontSize', value: 14 });

      expect(db.setSetting).toHaveBeenCalledWith('fontSize', 14);
      expect(result).toBe(true);
    });

    it('sets complex object values', async () => {
      const handler = handlers['set-setting'];
      const complexValue = { nested: { data: [1, 2, 3] } };

      await handler!(mockEvent, { key: 'config', value: complexValue });

      expect(db.setSetting).toHaveBeenCalledWith('config', complexValue);
    });

    it('sets null values', async () => {
      const handler = handlers['set-setting'];

      await handler!(mockEvent, { key: 'clearMe', value: null });

      expect(db.setSetting).toHaveBeenCalledWith('clearMe', null);
    });

    it('throws IPCValidationError for invalid key', async () => {
      const handler = handlers['set-setting'];

      await expect(handler!(mockEvent, { key: '', value: 'test' })).rejects.toThrow('Invalid setting data');
      await expect(handler!(mockEvent, { key: '123', value: 'test' })).rejects.toThrow('Invalid setting data');
    });

    it('throws IPCValidationError for missing key', async () => {
      const handler = handlers['set-setting'];

      await expect(handler!(mockEvent, { value: 'test' })).rejects.toThrow('Invalid setting data');
      await expect(handler!(mockEvent, {})).rejects.toThrow('Invalid setting data');
    });

    it('throws IPCValidationError for non-object input', async () => {
      const handler = handlers['set-setting'];

      await expect(handler!(mockEvent, 'string')).rejects.toThrow('Invalid setting data');
      await expect(handler!(mockEvent, null)).rejects.toThrow('Invalid setting data');
      await expect(handler!(mockEvent, 123)).rejects.toThrow('Invalid setting data');
    });

    describe('theme setting validation', () => {
      it('accepts valid colorTheme setting', async () => {
        const handler = handlers['set-setting'];

        await handler!(mockEvent, { key: 'colorTheme', value: 'dracula' });

        expect(db.setSetting).toHaveBeenCalledWith('colorTheme', 'dracula');
      });

      it('accepts valid theme variant setting', async () => {
        const handler = handlers['set-setting'];

        await handler!(mockEvent, { key: 'theme', value: 'dark' });

        expect(db.setSetting).toHaveBeenCalledWith('theme', 'dark');
      });

      it('throws IPCValidationError for invalid colorTheme', async () => {
        const handler = handlers['set-setting'];

        await expect(handler!(mockEvent, { key: 'colorTheme', value: 'invalid-theme' }))
          .rejects.toThrow('Invalid theme value');
      });

      it('throws IPCValidationError for invalid theme variant', async () => {
        const handler = handlers['set-setting'];

        await expect(handler!(mockEvent, { key: 'theme', value: 'auto' }))
          .rejects.toThrow('Invalid theme value');
      });

      it('provides specific error message for theme validation failure', async () => {
        const handler = handlers['set-setting'];

        try {
          await handler!(mockEvent, { key: 'colorTheme', value: 'bad-theme' });
          expect.fail('Should have thrown');
        } catch (error) {
          expect((error as Error).message).toContain('colorTheme');
          expect((error as Error).message).toContain('Invalid theme value');
        }
      });
    });
  });

  describe('get-all-settings handler', () => {
    it('returns all settings', async () => {
      const mockSettings = {
        theme: 'dark',
        colorTheme: 'dracula',
        fontSize: 14,
      };
      (db.getAllSettings as ReturnType<typeof vi.fn>).mockReturnValue(mockSettings);

      const handler = handlers['get-all-settings'];
      const result = await handler!(mockEvent);

      expect(db.getAllSettings).toHaveBeenCalled();
      expect(result).toEqual(mockSettings);
    });

    it('returns empty object when no settings exist', async () => {
      (db.getAllSettings as ReturnType<typeof vi.fn>).mockReturnValue({});

      const handler = handlers['get-all-settings'];
      const result = await handler!(mockEvent);

      expect(result).toEqual({});
    });

    it('does not validate input (no input required)', async () => {
      (db.getAllSettings as ReturnType<typeof vi.fn>).mockReturnValue({});

      const handler = handlers['get-all-settings'];
      // Should not throw regardless of extra arguments
      const result = await handler!(mockEvent);

      expect(result).toBeDefined();
    });
  });

  describe('get-app-version handler', () => {
    it('returns app version', async () => {
      const handler = handlers['get-app-version'];
      const result = await handler!(mockEvent);

      expect(app.getVersion).toHaveBeenCalled();
      expect(result).toBe('1.0.0');
    });

    it('returns correct version from app', async () => {
      (app.getVersion as ReturnType<typeof vi.fn>).mockReturnValue('2.3.4');

      const handler = handlers['get-app-version'];
      const result = await handler!(mockEvent);

      expect(result).toBe('2.3.4');
    });
  });

  describe('get-app-path handler', () => {
    it('returns path for valid name', async () => {
      const handler = handlers['get-app-path'];

      const result = await handler!(mockEvent, 'userData');

      expect(app.getPath).toHaveBeenCalledWith('userData');
      expect(result).toBe('/mock/path/userData');
    });

    it('returns different paths for different names', async () => {
      const handler = handlers['get-app-path'];

      await handler!(mockEvent, 'home');
      expect(app.getPath).toHaveBeenCalledWith('home');

      await handler!(mockEvent, 'documents');
      expect(app.getPath).toHaveBeenCalledWith('documents');

      await handler!(mockEvent, 'downloads');
      expect(app.getPath).toHaveBeenCalledWith('downloads');
    });

    it('throws IPCValidationError for invalid path name', async () => {
      const handler = handlers['get-app-path'];

      await expect(handler!(mockEvent, 'invalid')).rejects.toThrow('Invalid app path name');
      await expect(handler!(mockEvent, 'root')).rejects.toThrow('Invalid app path name');
    });

    it('throws IPCValidationError for wrong case', async () => {
      const handler = handlers['get-app-path'];

      await expect(handler!(mockEvent, 'HOME')).rejects.toThrow('Invalid app path name');
      await expect(handler!(mockEvent, 'USERDATA')).rejects.toThrow('Invalid app path name');
    });

    it('throws IPCValidationError for path traversal attempts', async () => {
      const handler = handlers['get-app-path'];

      await expect(handler!(mockEvent, '../etc/passwd')).rejects.toThrow('Invalid app path name');
      await expect(handler!(mockEvent, '/etc/passwd')).rejects.toThrow('Invalid app path name');
    });

    it('throws IPCValidationError for non-string input', async () => {
      const handler = handlers['get-app-path'];

      await expect(handler!(mockEvent, 123)).rejects.toThrow('Invalid app path name');
      await expect(handler!(mockEvent, null)).rejects.toThrow('Invalid app path name');
      await expect(handler!(mockEvent, {})).rejects.toThrow('Invalid app path name');
    });
  });
});

// ============================================================================
// ERROR HANDLING TESTS
// ============================================================================

describe('Error Handling', () => {
  let handlers: RegisteredHandlers;
  let mockEvent: IpcMainInvokeEvent;

  beforeEach(() => {
    // Only clear database mocks, not the ipcMain.handle mock
    vi.mocked(db.getSetting).mockReset();
    vi.mocked(db.setSetting).mockReset();
    vi.mocked(db.getAllSettings).mockReset();
    vi.mocked(app.getVersion).mockReturnValue('1.0.0');
    vi.mocked(app.getPath).mockImplementation((name: string) => `/mock/path/${name}`);
    handlers = getHandlers();
    mockEvent = createMockEvent();
  });

  it('IPCValidationError includes error code', async () => {
    const handler = handlers['get-setting'];

    try {
      await handler!(mockEvent, '');
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe('IPCValidationError');
      expect((error as { code?: string }).code).toBe('VALIDATION_ERROR');
    }
  });

  it('validation errors include details about the failure', async () => {
    const handler = handlers['set-setting'];

    try {
      await handler!(mockEvent, { key: '' });
      expect.fail('Should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('Invalid setting data');
    }
  });

  it('database errors propagate correctly', async () => {
    const dbError = new Error('Database connection failed');
    (db.getSetting as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw dbError;
    });

    const handler = handlers['get-setting'];

    await expect(handler!(mockEvent, 'validKey')).rejects.toThrow('Database connection failed');
  });
});

// ============================================================================
// SECURITY EDGE CASES
// ============================================================================

describe('Security Edge Cases', () => {
  let handlers: RegisteredHandlers;
  let mockEvent: IpcMainInvokeEvent;

  beforeEach(() => {
    // Only clear database mocks, not the ipcMain.handle mock
    vi.mocked(db.getSetting).mockReset();
    vi.mocked(db.setSetting).mockReset();
    vi.mocked(db.getAllSettings).mockReset();
    vi.mocked(app.getVersion).mockReturnValue('1.0.0');
    vi.mocked(app.getPath).mockImplementation((name: string) => `/mock/path/${name}`);
    handlers = getHandlers();
    mockEvent = createMockEvent();
  });

  describe('Injection Prevention', () => {
    const injectionPayloads = [
      { value: '; DROP TABLE settings;--', reason: 'SQL injection' },
      { value: "'; DELETE FROM settings; --", reason: 'SQL injection variant' },
      { value: '__proto__', reason: 'prototype pollution (starts with underscore)' },
      { value: '${process.env}', reason: 'template injection' },
      { value: '$(whoami)', reason: 'command injection' },
      { value: '`cat /etc/passwd`', reason: 'backtick injection' },
      { value: '<script>alert(1)</script>', reason: 'XSS injection' },
      { value: '../../../etc/passwd', reason: 'path traversal' },
      { value: 'key\x00value', reason: 'null byte injection' },
      { value: 'key\nvalue', reason: 'newline injection' },
    ];

    injectionPayloads.forEach(({ value, reason }) => {
      it(`rejects ${reason} in setting key`, async () => {
        const handler = handlers['get-setting'];
        await expect(handler!(mockEvent, value)).rejects.toThrow('Invalid setting key');
      });
    });
  });

  describe('Prototype Pollution Prevention', () => {
    it('rejects __proto__ as key (starts with underscore)', async () => {
      const handler = handlers['set-setting'];
      await expect(handler!(mockEvent, { key: '__proto__', value: { polluted: true } }))
        .rejects.toThrow('Invalid setting data');
    });

    it('handles constructor and prototype keys (valid but safe at runtime)', async () => {
      // These are valid setting key names per regex (start with letter)
      // Runtime protection handles prototype pollution
      const handler = handlers['set-setting'];

      // These should pass validation but database layer handles safety
      await handler!(mockEvent, { key: 'constructor', value: 'test' });
      expect(db.setSetting).toHaveBeenCalledWith('constructor', 'test');

      await handler!(mockEvent, { key: 'prototype', value: 'test' });
      expect(db.setSetting).toHaveBeenCalledWith('prototype', 'test');
    });

    it('does not pollute prototype through parsed JSON', async () => {
      const handler = handlers['set-setting'];
      const maliciousInput = JSON.parse('{"key": "validKey", "value": {"__proto__": {"polluted": true}}}');

      await handler!(mockEvent, maliciousInput);

      // Verify prototype wasn't polluted
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  });

  describe('Type Coercion Prevention', () => {
    it('rejects array input where object expected', async () => {
      const handler = handlers['set-setting'];
      await expect(handler!(mockEvent, ['key', 'value'])).rejects.toThrow('Invalid setting data');
    });

    it('rejects valueOf tricks', async () => {
      const handler = handlers['get-setting'];
      const tricky = { valueOf: () => 'theme' };
      await expect(handler!(mockEvent, tricky)).rejects.toThrow('Invalid setting key');
    });

    it('rejects toString tricks', async () => {
      const handler = handlers['get-setting'];
      const tricky = { toString: () => 'theme' };
      await expect(handler!(mockEvent, tricky)).rejects.toThrow('Invalid setting key');
    });
  });

  describe('Path Traversal Prevention for App Paths', () => {
    const pathTraversalAttempts = [
      '../../../etc/passwd',
      '..\\..\\..\\windows\\system32',
      '/root',
      'C:\\Windows\\System32',
      '~/.ssh/id_rsa',
      '/tmp/../etc/passwd',
    ];

    pathTraversalAttempts.forEach((attempt) => {
      it(`rejects path traversal: ${attempt}`, async () => {
        const handler = handlers['get-app-path'];
        await expect(handler!(mockEvent, attempt)).rejects.toThrow('Invalid app path name');
      });
    });
  });

  describe('Unicode/Encoding Edge Cases', () => {
    it('rejects keys with unicode control characters', async () => {
      const handler = handlers['get-setting'];
      await expect(handler!(mockEvent, 'key\u0000value')).rejects.toThrow('Invalid setting key');
      await expect(handler!(mockEvent, 'key\u200Bvalue')).rejects.toThrow('Invalid setting key');
    });

    it('rejects keys with right-to-left override', async () => {
      const handler = handlers['get-setting'];
      await expect(handler!(mockEvent, 'test\u202Eevil')).rejects.toThrow('Invalid setting key');
    });
  });

  describe('Large Input Handling', () => {
    it('rejects excessively long keys', async () => {
      const handler = handlers['get-setting'];
      const longKey = 'a'.repeat(101);
      await expect(handler!(mockEvent, longKey)).rejects.toThrow('Invalid setting key');
    });

    it('accepts key at maximum length', async () => {
      (db.getSetting as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const handler = handlers['get-setting'];
      const maxLengthKey = 'a' + 'b'.repeat(99); // 100 chars total

      const result = await handler!(mockEvent, maxLengthKey);
      expect(db.getSetting).toHaveBeenCalledWith(maxLengthKey);
      expect(result).toBeNull();
    });

    it('handles large values in set-setting', async () => {
      const handler = handlers['set-setting'];
      const largeValue = { data: 'x'.repeat(100000) };

      await handler!(mockEvent, { key: 'largeData', value: largeValue });

      expect(db.setSetting).toHaveBeenCalledWith('largeData', largeValue);
    });
  });
});

// ============================================================================
// INTEGRATION TESTS - Simulating Real IPC Flow
// ============================================================================

describe('IPC Flow Integration', () => {
  let handlers: RegisteredHandlers;
  let mockEvent: IpcMainInvokeEvent;

  beforeEach(() => {
    // Only clear database mocks, not the ipcMain.handle mock
    vi.mocked(db.getSetting).mockReset();
    vi.mocked(db.setSetting).mockReset();
    vi.mocked(db.getAllSettings).mockReset();
    vi.mocked(app.getVersion).mockReturnValue('1.0.0');
    vi.mocked(app.getPath).mockImplementation((name: string) => `/mock/path/${name}`);
    handlers = getHandlers();
    mockEvent = createMockEvent();
  });

  it('simulates complete settings read-write cycle', async () => {
    // Initial read returns null
    (db.getSetting as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const getSetting = handlers['get-setting'];
    let result = await getSetting!(mockEvent, 'fontSize');
    expect(result).toBeNull();

    // Write a value
    const setSetting = handlers['set-setting'];
    await setSetting!(mockEvent, { key: 'fontSize', value: 16 });
    expect(db.setSetting).toHaveBeenCalledWith('fontSize', 16);

    // Simulate database returning the value now
    (db.getSetting as ReturnType<typeof vi.fn>).mockReturnValue(16);

    result = await getSetting!(mockEvent, 'fontSize');
    expect(result).toBe(16);
  });

  it('simulates theme change flow', async () => {
    const setSetting = handlers['set-setting'];

    // Set colorTheme
    await setSetting!(mockEvent, { key: 'colorTheme', value: 'catppuccin-mocha' });
    expect(db.setSetting).toHaveBeenCalledWith('colorTheme', 'catppuccin-mocha');

    // Set theme mode
    await setSetting!(mockEvent, { key: 'theme', value: 'dark' });
    expect(db.setSetting).toHaveBeenCalledWith('theme', 'dark');

    // Verify all settings
    (db.getAllSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      colorTheme: 'catppuccin-mocha',
      theme: 'dark',
    });

    const getAllSettings = handlers['get-all-settings'];
    const allSettings = await getAllSettings!(mockEvent);

    expect(allSettings).toEqual({
      colorTheme: 'catppuccin-mocha',
      theme: 'dark',
    });
  });

  it('simulates app info retrieval', async () => {
    (app.getVersion as ReturnType<typeof vi.fn>).mockReturnValue('3.2.1');
    (app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      const paths: Record<string, string> = {
        userData: '/home/user/.config/app',
        home: '/home/user',
        documents: '/home/user/Documents',
      };
      return paths[name] || '/unknown';
    });

    const getVersion = handlers['get-app-version'];
    const getPath = handlers['get-app-path'];

    const version = await getVersion!(mockEvent);
    expect(version).toBe('3.2.1');

    const userDataPath = await getPath!(mockEvent, 'userData');
    expect(userDataPath).toBe('/home/user/.config/app');

    const homePath = await getPath!(mockEvent, 'home');
    expect(homePath).toBe('/home/user');

    const docsPath = await getPath!(mockEvent, 'documents');
    expect(docsPath).toBe('/home/user/Documents');
  });
});
