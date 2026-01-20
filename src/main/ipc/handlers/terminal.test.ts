// ============================================================================
// TERMINAL IPC HANDLER TESTS
// ============================================================================
//
// These tests verify that the terminal IPC handlers:
// 1. Properly validate inputs using Zod schemas
// 2. Correctly delegate to terminalManager functions
// 3. Handle errors gracefully
// 4. Return properly formatted responses
//
// This is critical for security since terminal operations can execute shell commands.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import {
  terminalStartOptionsSchema,
  plainTerminalStartOptionsSchema,
  terminalInputSchema,
  terminalResizeSchema,
  terminalIdSchema,
} from '../schemas/terminal.js';

// ============================================================================
// SCHEMA VALIDATION TESTS (UNIT TESTS)
// ============================================================================
//
// These tests verify the Zod schemas used by handlers to validate input.

// ============================================================================
// TERMINAL START OPTIONS SCHEMA TESTS
// ============================================================================

describe('terminalStartOptionsSchema', () => {
  describe('valid inputs', () => {
    it('should accept empty object (all fields optional)', () => {
      const result = terminalStartOptionsSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('should accept valid cwd path', () => {
      const result = terminalStartOptionsSchema.safeParse({
        cwd: '/home/user/project',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.cwd).toBe('/home/user/project');
      }
    });

    it('should accept Windows path', () => {
      const result = terminalStartOptionsSchema.safeParse({
        cwd: 'C:\\Users\\user\\project',
      });
      expect(result.success).toBe(true);
    });

    it('should accept valid name', () => {
      const result = terminalStartOptionsSchema.safeParse({
        name: 'My Terminal',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe('My Terminal');
      }
    });

    it('should accept valid UUID session ID', () => {
      const result = terminalStartOptionsSchema.safeParse({
        resumeSessionId: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(result.success).toBe(true);
    });

    it('should accept agent-prefixed session ID', () => {
      const result = terminalStartOptionsSchema.safeParse({
        resumeSessionId: 'agent-abc123',
      });
      expect(result.success).toBe(true);
    });

    it('should accept user session type', () => {
      const result = terminalStartOptionsSchema.safeParse({
        sessionType: 'user',
      });
      expect(result.success).toBe(true);
    });

    it('should accept subagent session type', () => {
      const result = terminalStartOptionsSchema.safeParse({
        sessionType: 'subagent',
      });
      expect(result.success).toBe(true);
    });

    it('should accept all valid fields together', () => {
      const result = terminalStartOptionsSchema.safeParse({
        cwd: '/home/user/project',
        name: 'Project Terminal',
        resumeSessionId: '550e8400-e29b-41d4-a716-446655440000',
        sessionType: 'user',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('should reject path traversal attempts', () => {
      const result = terminalStartOptionsSchema.safeParse({
        cwd: '/home/user/../../../etc/passwd',
      });
      expect(result.success).toBe(false);
    });

    it('should reject name exceeding max length', () => {
      const result = terminalStartOptionsSchema.safeParse({
        name: 'a'.repeat(201),
      });
      expect(result.success).toBe(false);
    });

    it('should reject invalid session ID format', () => {
      const result = terminalStartOptionsSchema.safeParse({
        resumeSessionId: 'invalid; rm -rf /',
      });
      expect(result.success).toBe(false);
    });

    it('should reject session ID with special characters', () => {
      const result = terminalStartOptionsSchema.safeParse({
        resumeSessionId: '$(whoami)',
      });
      expect(result.success).toBe(false);
    });

    it('should reject invalid session type', () => {
      const result = terminalStartOptionsSchema.safeParse({
        sessionType: 'admin',
      });
      expect(result.success).toBe(false);
    });

    it('should reject non-object input', () => {
      const result = terminalStartOptionsSchema.safeParse('string');
      expect(result.success).toBe(false);
    });

    it('should reject null input', () => {
      const result = terminalStartOptionsSchema.safeParse(null);
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// PLAIN TERMINAL START OPTIONS SCHEMA TESTS
// ============================================================================

describe('plainTerminalStartOptionsSchema', () => {
  describe('valid inputs', () => {
    it('should accept empty object', () => {
      const result = plainTerminalStartOptionsSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('should accept valid cwd and name', () => {
      const result = plainTerminalStartOptionsSchema.safeParse({
        cwd: '/home/user',
        name: 'Shell',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('should reject path traversal in cwd', () => {
      const result = plainTerminalStartOptionsSchema.safeParse({
        cwd: '../../../etc',
      });
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// TERMINAL INPUT SCHEMA TESTS
// ============================================================================

describe('terminalInputSchema', () => {
  describe('valid inputs', () => {
    it('should accept valid id and data', () => {
      const result = terminalInputSchema.safeParse({
        id: 1,
        data: 'ls -la',
      });
      expect(result.success).toBe(true);
    });

    it('should accept zero as valid id', () => {
      const result = terminalInputSchema.safeParse({
        id: 0,
        data: 'echo hello',
      });
      expect(result.success).toBe(true);
    });

    it('should accept empty string data', () => {
      const result = terminalInputSchema.safeParse({
        id: 1,
        data: '',
      });
      expect(result.success).toBe(true);
    });

    it('should accept data with special characters (terminal handles this)', () => {
      // Note: The schema allows any string because the terminal itself
      // is the execution context - we just validate structure
      const result = terminalInputSchema.safeParse({
        id: 1,
        data: 'rm -rf / && echo "done"',
      });
      expect(result.success).toBe(true);
    });

    it('should accept multiline data', () => {
      const result = terminalInputSchema.safeParse({
        id: 1,
        data: 'line1\nline2\nline3',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('should reject negative id', () => {
      const result = terminalInputSchema.safeParse({
        id: -1,
        data: 'test',
      });
      expect(result.success).toBe(false);
    });

    it('should reject non-integer id', () => {
      const result = terminalInputSchema.safeParse({
        id: 1.5,
        data: 'test',
      });
      expect(result.success).toBe(false);
    });

    it('should reject string id', () => {
      const result = terminalInputSchema.safeParse({
        id: '1',
        data: 'test',
      });
      expect(result.success).toBe(false);
    });

    it('should reject missing id', () => {
      const result = terminalInputSchema.safeParse({
        data: 'test',
      });
      expect(result.success).toBe(false);
    });

    it('should reject missing data', () => {
      const result = terminalInputSchema.safeParse({
        id: 1,
      });
      expect(result.success).toBe(false);
    });

    it('should reject non-string data', () => {
      const result = terminalInputSchema.safeParse({
        id: 1,
        data: 123,
      });
      expect(result.success).toBe(false);
    });

    it('should reject null input', () => {
      const result = terminalInputSchema.safeParse(null);
      expect(result.success).toBe(false);
    });

    it('should reject undefined input', () => {
      const result = terminalInputSchema.safeParse(undefined);
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// TERMINAL RESIZE SCHEMA TESTS
// ============================================================================

describe('terminalResizeSchema', () => {
  describe('valid inputs', () => {
    it('should accept valid resize dimensions', () => {
      const result = terminalResizeSchema.safeParse({
        id: 1,
        cols: 80,
        rows: 24,
      });
      expect(result.success).toBe(true);
    });

    it('should accept minimum dimensions (1x1)', () => {
      const result = terminalResizeSchema.safeParse({
        id: 0,
        cols: 1,
        rows: 1,
      });
      expect(result.success).toBe(true);
    });

    it('should accept maximum dimensions', () => {
      const result = terminalResizeSchema.safeParse({
        id: 1,
        cols: 500,
        rows: 200,
      });
      expect(result.success).toBe(true);
    });

    it('should accept large terminal dimensions', () => {
      const result = terminalResizeSchema.safeParse({
        id: 1,
        cols: 300,
        rows: 100,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('should reject zero cols', () => {
      const result = terminalResizeSchema.safeParse({
        id: 1,
        cols: 0,
        rows: 24,
      });
      expect(result.success).toBe(false);
    });

    it('should reject zero rows', () => {
      const result = terminalResizeSchema.safeParse({
        id: 1,
        cols: 80,
        rows: 0,
      });
      expect(result.success).toBe(false);
    });

    it('should reject negative cols', () => {
      const result = terminalResizeSchema.safeParse({
        id: 1,
        cols: -1,
        rows: 24,
      });
      expect(result.success).toBe(false);
    });

    it('should reject negative rows', () => {
      const result = terminalResizeSchema.safeParse({
        id: 1,
        cols: 80,
        rows: -1,
      });
      expect(result.success).toBe(false);
    });

    it('should reject cols exceeding maximum', () => {
      const result = terminalResizeSchema.safeParse({
        id: 1,
        cols: 501,
        rows: 24,
      });
      expect(result.success).toBe(false);
    });

    it('should reject rows exceeding maximum', () => {
      const result = terminalResizeSchema.safeParse({
        id: 1,
        cols: 80,
        rows: 201,
      });
      expect(result.success).toBe(false);
    });

    it('should reject non-integer cols', () => {
      const result = terminalResizeSchema.safeParse({
        id: 1,
        cols: 80.5,
        rows: 24,
      });
      expect(result.success).toBe(false);
    });

    it('should reject non-integer rows', () => {
      const result = terminalResizeSchema.safeParse({
        id: 1,
        cols: 80,
        rows: 24.5,
      });
      expect(result.success).toBe(false);
    });

    it('should reject missing cols', () => {
      const result = terminalResizeSchema.safeParse({
        id: 1,
        rows: 24,
      });
      expect(result.success).toBe(false);
    });

    it('should reject missing rows', () => {
      const result = terminalResizeSchema.safeParse({
        id: 1,
        cols: 80,
      });
      expect(result.success).toBe(false);
    });

    it('should reject negative id', () => {
      const result = terminalResizeSchema.safeParse({
        id: -1,
        cols: 80,
        rows: 24,
      });
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// TERMINAL ID SCHEMA TESTS
// ============================================================================

describe('terminalIdSchema', () => {
  describe('valid inputs', () => {
    it('should accept zero', () => {
      const result = terminalIdSchema.safeParse(0);
      expect(result.success).toBe(true);
    });

    it('should accept positive integers', () => {
      const result = terminalIdSchema.safeParse(42);
      expect(result.success).toBe(true);
    });

    it('should accept large positive integers', () => {
      const result = terminalIdSchema.safeParse(999999);
      expect(result.success).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('should reject negative numbers', () => {
      const result = terminalIdSchema.safeParse(-1);
      expect(result.success).toBe(false);
    });

    it('should reject non-integers', () => {
      const result = terminalIdSchema.safeParse(1.5);
      expect(result.success).toBe(false);
    });

    it('should reject strings', () => {
      const result = terminalIdSchema.safeParse('1');
      expect(result.success).toBe(false);
    });

    it('should reject null', () => {
      const result = terminalIdSchema.safeParse(null);
      expect(result.success).toBe(false);
    });

    it('should reject undefined', () => {
      const result = terminalIdSchema.safeParse(undefined);
      expect(result.success).toBe(false);
    });

    it('should reject objects', () => {
      const result = terminalIdSchema.safeParse({ id: 1 });
      expect(result.success).toBe(false);
    });

    it('should reject arrays', () => {
      const result = terminalIdSchema.safeParse([1]);
      expect(result.success).toBe(false);
    });

    it('should reject NaN', () => {
      const result = terminalIdSchema.safeParse(NaN);
      expect(result.success).toBe(false);
    });

    it('should reject Infinity', () => {
      const result = terminalIdSchema.safeParse(Infinity);
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// EDGE CASE TESTS - Security focused
// ============================================================================

describe('Security Edge Cases', () => {
  describe('Command Injection via Session ID', () => {
    const injectionPayloads = [
      '; rm -rf /',
      '| cat /etc/passwd',
      '&& whoami',
      '`id`',
      '$(id)',
      '\n; malicious',
      '\r\n; malicious',
      '${PATH}',
      '> /tmp/pwned',
      '< /etc/shadow',
    ];

    injectionPayloads.forEach((payload) => {
      it(`should reject session ID with injection: ${JSON.stringify(payload)}`, () => {
        const result = terminalStartOptionsSchema.safeParse({
          resumeSessionId: `valid${payload}`,
        });
        expect(result.success).toBe(false);
      });
    });
  });

  describe('Path Traversal Attempts', () => {
    const traversalPayloads = [
      '../../../etc/passwd',
      '..\\..\\..\\windows\\system32',
      '/home/user/../../../root',
      'C:\\Users\\..\\..\\Windows',
    ];

    traversalPayloads.forEach((payload) => {
      it(`should reject cwd with path traversal: ${payload}`, () => {
        const result = terminalStartOptionsSchema.safeParse({
          cwd: payload,
        });
        expect(result.success).toBe(false);
      });
    });
  });

  describe('Prototype Pollution Prevention', () => {
    it('should not be affected by __proto__ in input', () => {
      const maliciousInput = JSON.parse('{"__proto__": {"polluted": true}, "id": 1, "data": "test"}');
      const result = terminalInputSchema.safeParse(maliciousInput);
      // Should parse without throwing, and result should be clean
      expect(result.success).toBe(true);
      // Verify prototype wasn't polluted
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('should not be affected by constructor.prototype', () => {
      const maliciousInput = {
        id: 1,
        data: 'test',
        constructor: { prototype: { polluted: true } },
      };
      const result = terminalInputSchema.safeParse(maliciousInput);
      expect(result.success).toBe(true);
    });
  });

  describe('Type Coercion Attacks', () => {
    it('should reject array where object expected', () => {
      const result = terminalInputSchema.safeParse([1, 'test']);
      expect(result.success).toBe(false);
    });

    it('should reject nested objects for primitive fields', () => {
      const result = terminalInputSchema.safeParse({
        id: { valueOf: () => 1 },
        data: 'test',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('Buffer/Binary Handling', () => {
    it('should reject Buffer objects', () => {
      const result = terminalInputSchema.safeParse({
        id: 1,
        data: Buffer.from('test'),
      });
      expect(result.success).toBe(false);
    });
  });

  describe('Unicode/Encoding Edge Cases', () => {
    it('should accept unicode in terminal data', () => {
      const result = terminalInputSchema.safeParse({
        id: 1,
        data: 'echo "\u0000\u001b[31mred\u001b[0m"',
      });
      expect(result.success).toBe(true);
    });

    it('should accept emoji in terminal name', () => {
      const result = terminalStartOptionsSchema.safeParse({
        name: 'Terminal 1',
      });
      expect(result.success).toBe(true);
    });
  });
});

// ============================================================================
// IPC HANDLER INTEGRATION TESTS
// ============================================================================
//
// These tests verify the actual IPC handler functions work correctly with
// mocked dependencies. They test the full handler flow including validation,
// error handling, and delegation to terminalManager.
// ============================================================================

// Store registered handlers for testing
const registeredHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> = new Map();

// Mock ipcMain before importing the handler module
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      registeredHandlers.set(channel, handler);
    }),
  },
}));

// Mock terminalManager functions
vi.mock('../../services/terminalManager.js', () => ({
  startTerminal: vi.fn(),
  startPlainTerminal: vi.fn(),
  writeToTerminal: vi.fn(),
  resizeTerminal: vi.fn(),
  killTerminal: vi.fn(),
  getAllTerminals: vi.fn(),
}));

// Mock safeExec for text editor detection
vi.mock('../../services/safeExec.js', () => ({
  commandExists: vi.fn(),
}));

// Mock logger
vi.mock('../../services/logger.js', () => ({
  Logger: class MockLogger {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
  },
}));

// Mock the withContext utility to pass through the handler
vi.mock('../utils.js', () => ({
  withContext: vi.fn((_operation: string, handler: (...args: unknown[]) => Promise<unknown>) => handler),
}));

// Import after mocks are set up
import { ipcMain } from 'electron';
import {
  startTerminal,
  startPlainTerminal,
  writeToTerminal,
  resizeTerminal,
  killTerminal,
  getAllTerminals,
} from '../../services/terminalManager.js';
import { commandExists } from '../../services/safeExec.js';
import { registerTerminalHandlers } from './terminal.js';

describe('Terminal IPC Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredHandlers.clear();
    // Register handlers for each test
    registerTerminalHandlers();
  });

  afterEach(() => {
    registeredHandlers.clear();
  });

  describe('registerTerminalHandlers', () => {
    it('should register all expected IPC handlers', () => {
      expect(ipcMain.handle).toHaveBeenCalledWith('start-claude', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('start-plain-terminal', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('terminal-input', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('terminal-resize', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('kill-terminal', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('get-terminals', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('get-available-editors', expect.any(Function));
      expect(ipcMain.handle).toHaveBeenCalledWith('get-default-editor', expect.any(Function));
    });

    it('should register exactly 8 handlers', () => {
      expect(ipcMain.handle).toHaveBeenCalledTimes(8);
    });
  });

  describe('start-claude handler', () => {
    it('should call startTerminal with validated options', async () => {
      const mockResult = { id: 1, name: 'Test', cwd: '/test/path' };
      vi.mocked(startTerminal).mockResolvedValue(mockResult);

      const handler = registeredHandlers.get('start-claude');
      expect(handler).toBeDefined();

      const result = await handler!({}, {
        cwd: '/test/path',
        name: 'Test Terminal',
      });

      expect(startTerminal).toHaveBeenCalledWith({
        cwd: '/test/path',
        name: 'Test Terminal',
      });
      expect(result).toEqual(mockResult);
    });

    it('should accept options with resumeSessionId', async () => {
      const mockResult = { id: 1, name: 'Test', cwd: '/test' };
      vi.mocked(startTerminal).mockResolvedValue(mockResult);

      const handler = registeredHandlers.get('start-claude');
      const result = await handler!({}, {
        cwd: '/test',
        resumeSessionId: '550e8400-e29b-41d4-a716-446655440000',
        sessionType: 'user',
      });

      expect(startTerminal).toHaveBeenCalledWith({
        cwd: '/test',
        resumeSessionId: '550e8400-e29b-41d4-a716-446655440000',
        sessionType: 'user',
      });
      expect(result).toEqual(mockResult);
    });

    it('should return validation error for invalid options', async () => {
      const handler = registeredHandlers.get('start-claude');

      const result = await handler!({}, {
        cwd: '../../../etc/passwd',
      });

      expect(startTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
        error: expect.stringContaining('Validation failed'),
      });
    });

    it('should return validation error for invalid session ID', async () => {
      const handler = registeredHandlers.get('start-claude');

      const result = await handler!({}, {
        resumeSessionId: '; rm -rf /',
      });

      expect(startTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('should return validation error for invalid session type', async () => {
      const handler = registeredHandlers.get('start-claude');

      const result = await handler!({}, {
        sessionType: 'admin',
      });

      expect(startTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('should return validation error for non-object input', async () => {
      const handler = registeredHandlers.get('start-claude');

      const result = await handler!({}, 'not an object');

      expect(startTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('should return validation error for null input', async () => {
      const handler = registeredHandlers.get('start-claude');

      const result = await handler!({}, null);

      expect(startTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('should accept empty object (all fields optional)', async () => {
      const mockResult = { id: 1, name: 'Terminal', cwd: process.cwd() };
      vi.mocked(startTerminal).mockResolvedValue(mockResult);

      const handler = registeredHandlers.get('start-claude');
      const result = await handler!({}, {});

      expect(startTerminal).toHaveBeenCalledWith({});
      expect(result).toEqual(mockResult);
    });

    it('should handle terminalManager errors gracefully', async () => {
      vi.mocked(startTerminal).mockResolvedValue({ error: 'Failed to spawn' });

      const handler = registeredHandlers.get('start-claude');
      const result = await handler!({}, { cwd: '/test' });

      expect(result).toEqual({ error: 'Failed to spawn' });
    });
  });

  describe('start-plain-terminal handler', () => {
    it('should call startPlainTerminal with validated options', async () => {
      const mockResult = { id: 2, name: 'Shell', cwd: '/home', isPlainTerminal: true };
      vi.mocked(startPlainTerminal).mockResolvedValue(mockResult);

      const handler = registeredHandlers.get('start-plain-terminal');
      expect(handler).toBeDefined();

      const result = await handler!({}, {
        cwd: '/home',
        name: 'Shell',
      });

      expect(startPlainTerminal).toHaveBeenCalledWith({
        cwd: '/home',
        name: 'Shell',
      });
      expect(result).toEqual(mockResult);
    });

    it('should return validation error for path traversal', async () => {
      const handler = registeredHandlers.get('start-plain-terminal');

      const result = await handler!({}, {
        cwd: '../../../etc',
      });

      expect(startPlainTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('should return validation error for name exceeding max length', async () => {
      const handler = registeredHandlers.get('start-plain-terminal');

      const result = await handler!({}, {
        name: 'a'.repeat(201),
      });

      expect(startPlainTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('should accept empty object', async () => {
      const mockResult = { id: 3, name: 'Terminal', cwd: process.cwd(), isPlainTerminal: true };
      vi.mocked(startPlainTerminal).mockResolvedValue(mockResult);

      const handler = registeredHandlers.get('start-plain-terminal');
      const result = await handler!({}, {});

      expect(startPlainTerminal).toHaveBeenCalledWith({});
      expect(result).toEqual(mockResult);
    });
  });

  describe('terminal-input handler', () => {
    it('should call writeToTerminal with validated input', async () => {
      const handler = registeredHandlers.get('terminal-input');
      expect(handler).toBeDefined();

      const result = await handler!({}, {
        id: 1,
        data: 'ls -la',
      });

      expect(writeToTerminal).toHaveBeenCalledWith(1, 'ls -la');
      expect(result).toEqual({ success: true });
    });

    it('should accept empty string data', async () => {
      const handler = registeredHandlers.get('terminal-input');

      const result = await handler!({}, {
        id: 1,
        data: '',
      });

      expect(writeToTerminal).toHaveBeenCalledWith(1, '');
      expect(result).toEqual({ success: true });
    });

    it('should accept multiline data', async () => {
      const handler = registeredHandlers.get('terminal-input');

      const multilineData = 'line1\nline2\nline3';
      const result = await handler!({}, {
        id: 1,
        data: multilineData,
      });

      expect(writeToTerminal).toHaveBeenCalledWith(1, multilineData);
      expect(result).toEqual({ success: true });
    });

    it('should accept zero as valid terminal id', async () => {
      const handler = registeredHandlers.get('terminal-input');

      const result = await handler!({}, {
        id: 0,
        data: 'test',
      });

      expect(writeToTerminal).toHaveBeenCalledWith(0, 'test');
      expect(result).toEqual({ success: true });
    });

    it('should return validation error for negative id', async () => {
      const handler = registeredHandlers.get('terminal-input');

      const result = await handler!({}, {
        id: -1,
        data: 'test',
      });

      expect(writeToTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('should return validation error for non-integer id', async () => {
      const handler = registeredHandlers.get('terminal-input');

      const result = await handler!({}, {
        id: 1.5,
        data: 'test',
      });

      expect(writeToTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('should return validation error for string id', async () => {
      const handler = registeredHandlers.get('terminal-input');

      const result = await handler!({}, {
        id: '1',
        data: 'test',
      });

      expect(writeToTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('should return validation error for missing id', async () => {
      const handler = registeredHandlers.get('terminal-input');

      const result = await handler!({}, {
        data: 'test',
      });

      expect(writeToTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('should return validation error for missing data', async () => {
      const handler = registeredHandlers.get('terminal-input');

      const result = await handler!({}, {
        id: 1,
      });

      expect(writeToTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('should return validation error for non-string data', async () => {
      const handler = registeredHandlers.get('terminal-input');

      const result = await handler!({}, {
        id: 1,
        data: 123,
      });

      expect(writeToTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('should return validation error for null input', async () => {
      const handler = registeredHandlers.get('terminal-input');

      const result = await handler!({}, null);

      expect(writeToTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });
  });

  describe('terminal-resize handler', () => {
    it('should call resizeTerminal with validated dimensions', async () => {
      const handler = registeredHandlers.get('terminal-resize');
      expect(handler).toBeDefined();

      const result = await handler!({}, {
        id: 1,
        cols: 120,
        rows: 40,
      });

      expect(resizeTerminal).toHaveBeenCalledWith(1, 120, 40);
      expect(result).toEqual({ success: true });
    });

    it('should accept minimum dimensions (1x1)', async () => {
      const handler = registeredHandlers.get('terminal-resize');

      const result = await handler!({}, {
        id: 0,
        cols: 1,
        rows: 1,
      });

      expect(resizeTerminal).toHaveBeenCalledWith(0, 1, 1);
      expect(result).toEqual({ success: true });
    });

    it('should accept maximum dimensions (500x200)', async () => {
      const handler = registeredHandlers.get('terminal-resize');

      const result = await handler!({}, {
        id: 1,
        cols: 500,
        rows: 200,
      });

      expect(resizeTerminal).toHaveBeenCalledWith(1, 500, 200);
      expect(result).toEqual({ success: true });
    });

    it('should return validation error for zero cols', async () => {
      const handler = registeredHandlers.get('terminal-resize');

      const result = await handler!({}, {
        id: 1,
        cols: 0,
        rows: 24,
      });

      expect(resizeTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('should return validation error for zero rows', async () => {
      const handler = registeredHandlers.get('terminal-resize');

      const result = await handler!({}, {
        id: 1,
        cols: 80,
        rows: 0,
      });

      expect(resizeTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('should return validation error for cols exceeding max', async () => {
      const handler = registeredHandlers.get('terminal-resize');

      const result = await handler!({}, {
        id: 1,
        cols: 501,
        rows: 24,
      });

      expect(resizeTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('should return validation error for rows exceeding max', async () => {
      const handler = registeredHandlers.get('terminal-resize');

      const result = await handler!({}, {
        id: 1,
        cols: 80,
        rows: 201,
      });

      expect(resizeTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('should return validation error for negative id', async () => {
      const handler = registeredHandlers.get('terminal-resize');

      const result = await handler!({}, {
        id: -1,
        cols: 80,
        rows: 24,
      });

      expect(resizeTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('should return validation error for non-integer cols', async () => {
      const handler = registeredHandlers.get('terminal-resize');

      const result = await handler!({}, {
        id: 1,
        cols: 80.5,
        rows: 24,
      });

      expect(resizeTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('should return validation error for missing cols', async () => {
      const handler = registeredHandlers.get('terminal-resize');

      const result = await handler!({}, {
        id: 1,
        rows: 24,
      });

      expect(resizeTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('should return validation error for missing rows', async () => {
      const handler = registeredHandlers.get('terminal-resize');

      const result = await handler!({}, {
        id: 1,
        cols: 80,
      });

      expect(resizeTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('should return validation error for negative dimensions', async () => {
      const handler = registeredHandlers.get('terminal-resize');

      const result = await handler!({}, {
        id: 1,
        cols: -10,
        rows: -5,
      });

      expect(resizeTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });
  });

  describe('kill-terminal handler', () => {
    it('should call killTerminal with validated id', async () => {
      vi.mocked(killTerminal).mockReturnValue(true);

      const handler = registeredHandlers.get('kill-terminal');
      expect(handler).toBeDefined();

      const result = await handler!({}, 1);

      expect(killTerminal).toHaveBeenCalledWith(1);
      expect(result).toBe(true);
    });

    it('should accept zero as valid id', async () => {
      vi.mocked(killTerminal).mockReturnValue(true);

      const handler = registeredHandlers.get('kill-terminal');
      const result = await handler!({}, 0);

      expect(killTerminal).toHaveBeenCalledWith(0);
      expect(result).toBe(true);
    });

    it('should return false when terminal does not exist', async () => {
      vi.mocked(killTerminal).mockReturnValue(false);

      const handler = registeredHandlers.get('kill-terminal');
      const result = await handler!({}, 999);

      expect(killTerminal).toHaveBeenCalledWith(999);
      expect(result).toBe(false);
    });

    it('should return validation error for negative id', async () => {
      const handler = registeredHandlers.get('kill-terminal');

      const result = await handler!({}, -1);

      expect(killTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('should return validation error for non-integer id', async () => {
      const handler = registeredHandlers.get('kill-terminal');

      const result = await handler!({}, 1.5);

      expect(killTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('should return validation error for string id', async () => {
      const handler = registeredHandlers.get('kill-terminal');

      const result = await handler!({}, '1');

      expect(killTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('should return validation error for null id', async () => {
      const handler = registeredHandlers.get('kill-terminal');

      const result = await handler!({}, null);

      expect(killTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('should return validation error for undefined id', async () => {
      const handler = registeredHandlers.get('kill-terminal');

      const result = await handler!({}, undefined);

      expect(killTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('should return validation error for object id', async () => {
      const handler = registeredHandlers.get('kill-terminal');

      const result = await handler!({}, { id: 1 });

      expect(killTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('should return validation error for NaN', async () => {
      const handler = registeredHandlers.get('kill-terminal');

      const result = await handler!({}, NaN);

      expect(killTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('should return validation error for Infinity', async () => {
      const handler = registeredHandlers.get('kill-terminal');

      const result = await handler!({}, Infinity);

      expect(killTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });
  });

  describe('get-terminals handler', () => {
    it('should return all terminals from terminalManager', async () => {
      const mockTerminals = [
        { id: 1, name: 'Terminal 1', cwd: '/path1', startTime: new Date(), isPlainTerminal: false },
        { id: 2, name: 'Terminal 2', cwd: '/path2', startTime: new Date(), isPlainTerminal: true },
      ];
      vi.mocked(getAllTerminals).mockReturnValue(mockTerminals);

      const handler = registeredHandlers.get('get-terminals');
      expect(handler).toBeDefined();

      const result = await handler!({});

      expect(getAllTerminals).toHaveBeenCalled();
      expect(result).toEqual(mockTerminals);
    });

    it('should return empty array when no terminals exist', async () => {
      vi.mocked(getAllTerminals).mockReturnValue([]);

      const handler = registeredHandlers.get('get-terminals');
      const result = await handler!({});

      expect(result).toEqual([]);
    });
  });

  describe('get-available-editors handler', () => {
    it('should detect available text editors', async () => {
      vi.mocked(commandExists).mockImplementation((cmd: string) => {
        return cmd === 'nvim' || cmd === 'code';
      });

      const handler = registeredHandlers.get('get-available-editors');
      expect(handler).toBeDefined();

      const result = await handler!({}) as Array<{ name: string; command: string; available: boolean }>;

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);

      // Check that result includes expected editors
      const nvim = result.find((e: { name: string }) => e.name === 'Neovim');
      expect(nvim).toBeDefined();
    });

    it('should return all editors with availability status', async () => {
      vi.mocked(commandExists).mockReturnValue(false);

      const handler = registeredHandlers.get('get-available-editors');
      const result = await handler!({}) as Array<{ name: string; command: string; available: boolean }>;

      // Should include all editors in the list
      expect(result.some((e: { name: string }) => e.name === 'Neovim')).toBe(true);
      expect(result.some((e: { name: string }) => e.name === 'Vim')).toBe(true);
      expect(result.some((e: { name: string }) => e.name === 'VS Code')).toBe(true);
      expect(result.some((e: { name: string }) => e.name === 'Nano')).toBe(true);

      // When no editors are available, all should be marked unavailable
      expect(result.every((e: { available: boolean }) => !e.available)).toBe(true);
    });
  });

  describe('get-default-editor handler', () => {
    it('should return first available editor command', async () => {
      // Only vim is available
      vi.mocked(commandExists).mockImplementation((cmd: string) => {
        return cmd === 'vim';
      });

      const handler = registeredHandlers.get('get-default-editor');
      expect(handler).toBeDefined();

      const result = await handler!({});

      expect(result).toBe('vim');
    });

    it('should return null when no editors are available', async () => {
      vi.mocked(commandExists).mockReturnValue(false);

      const handler = registeredHandlers.get('get-default-editor');
      const result = await handler!({});

      expect(result).toBeNull();
    });

    it('should prefer nvim over vim when both available', async () => {
      vi.mocked(commandExists).mockImplementation((cmd: string) => {
        return cmd === 'nvim' || cmd === 'vim';
      });

      const handler = registeredHandlers.get('get-default-editor');
      const result = await handler!({});

      // nvim comes before vim in the list, so it should be preferred
      expect(result).toBe('nvim');
    });
  });
});

// ============================================================================
// VALIDATION ERROR FORMATTING TESTS
// ============================================================================

describe('Validation Error Response Format', () => {
  it('should include all required fields in validation error', async () => {
    // Clear and re-register handlers
    registeredHandlers.clear();
    registerTerminalHandlers();

    const handler = registeredHandlers.get('terminal-input');
    const result = await handler!({}, { id: 'not-a-number' }) as {
      success: boolean;
      error: string;
      code: string;
      details?: Array<{ path: string; message: string }>;
    };

    expect(result.success).toBe(false);
    expect(result.code).toBe('VALIDATION_ERROR');
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
  });

  it('should include details array with path and message', async () => {
    registeredHandlers.clear();
    registerTerminalHandlers();

    const handler = registeredHandlers.get('terminal-resize');
    const result = await handler!({}, { id: 1, cols: 'bad', rows: 'bad' }) as {
      success: boolean;
      details?: Array<{ path: string; message: string }>;
    };

    expect(result.success).toBe(false);
    expect(Array.isArray(result.details)).toBe(true);
    expect(result.details!.length).toBeGreaterThan(0);

    result.details!.forEach((detail: { path: string; message: string }) => {
      expect(typeof detail.path).toBe('string');
      expect(typeof detail.message).toBe('string');
    });
  });

  it('should format multiple validation errors correctly', async () => {
    registeredHandlers.clear();
    registerTerminalHandlers();

    const handler = registeredHandlers.get('terminal-resize');
    // Missing all required fields
    const result = await handler!({}, {}) as {
      success: boolean;
      error: string;
      details?: Array<{ path: string; message: string }>;
    };

    expect(result.success).toBe(false);
    // Should mention multiple issues
    expect(result.details!.length).toBeGreaterThanOrEqual(3); // id, cols, rows
  });
});

// ============================================================================
// HANDLER SECURITY EDGE CASES
// ============================================================================

describe('Handler Security Edge Cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredHandlers.clear();
    registerTerminalHandlers();
  });

  describe('Command Injection Prevention', () => {
    const injectionPayloads = [
      '; rm -rf /',
      '| cat /etc/passwd',
      '&& whoami',
      '`id`',
      '$(id)',
      '\n; malicious',
      '${PATH}',
    ];

    injectionPayloads.forEach((payload) => {
      it(`should reject session ID with injection payload: ${JSON.stringify(payload)}`, async () => {
        const handler = registeredHandlers.get('start-claude');
        const result = await handler!({}, {
          resumeSessionId: `valid${payload}`,
        });

        expect(startTerminal).not.toHaveBeenCalled();
        expect(result).toMatchObject({
          success: false,
          code: 'VALIDATION_ERROR',
        });
      });
    });
  });

  describe('Path Traversal Prevention', () => {
    const traversalPayloads = [
      '../../../etc/passwd',
      '..\\..\\..\\windows\\system32',
      '/home/user/../../../root',
    ];

    traversalPayloads.forEach((payload) => {
      it(`should reject cwd with path traversal: ${payload}`, async () => {
        const handler = registeredHandlers.get('start-claude');
        const result = await handler!({}, { cwd: payload });

        expect(startTerminal).not.toHaveBeenCalled();
        expect(result).toMatchObject({
          success: false,
          code: 'VALIDATION_ERROR',
        });
      });

      it(`should reject plain terminal cwd with path traversal: ${payload}`, async () => {
        const handler = registeredHandlers.get('start-plain-terminal');
        const result = await handler!({}, { cwd: payload });

        expect(startPlainTerminal).not.toHaveBeenCalled();
        expect(result).toMatchObject({
          success: false,
          code: 'VALIDATION_ERROR',
        });
      });
    });
  });

  describe('Prototype Pollution Prevention', () => {
    it('should handle __proto__ in terminal-input safely', async () => {
      const handler = registeredHandlers.get('terminal-input');
      const maliciousInput = JSON.parse('{"__proto__": {"polluted": true}, "id": 1, "data": "test"}');

      const result = await handler!({}, maliciousInput);

      // Should succeed with valid fields
      expect(writeToTerminal).toHaveBeenCalledWith(1, 'test');
      expect(result).toEqual({ success: true });

      // Prototype should not be polluted
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('should handle constructor.prototype attack', async () => {
      const handler = registeredHandlers.get('terminal-resize');
      const maliciousInput = {
        id: 1,
        cols: 80,
        rows: 24,
        constructor: { prototype: { polluted: true } },
      };

      const result = await handler!({}, maliciousInput);

      expect(resizeTerminal).toHaveBeenCalledWith(1, 80, 24);
      expect(result).toEqual({ success: true });
    });
  });

  describe('Type Coercion Attack Prevention', () => {
    it('should reject array where object expected', async () => {
      const handler = registeredHandlers.get('terminal-input');
      const result = await handler!({}, [1, 'test']);

      expect(writeToTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('should reject nested objects for primitive fields', async () => {
      const handler = registeredHandlers.get('terminal-input');
      const result = await handler!({}, {
        id: { valueOf: () => 1 },
        data: 'test',
      });

      expect(writeToTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });

    it('should reject Buffer in data field', async () => {
      const handler = registeredHandlers.get('terminal-input');
      const result = await handler!({}, {
        id: 1,
        data: Buffer.from('test'),
      });

      expect(writeToTerminal).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        success: false,
        code: 'VALIDATION_ERROR',
      });
    });
  });
});
