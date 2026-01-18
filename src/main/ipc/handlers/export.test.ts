// ============================================================================
// EXPORT IPC HANDLERS UNIT TESTS
// ============================================================================
//
// Comprehensive tests for export IPC handlers covering:
// - export-session handler with format options (markdown, json, html)
// - bulk-export handler for multiple sessions as ZIP
// - Zod validation for session IDs and format enums
// - File system operations and dialog interactions
// - Error handling via IPCValidationError
// - Stream and archive operations
// - Security edge cases
//
// ============================================================================

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { ipcMain, dialog, IpcMainInvokeEvent } from 'electron';
import type { Writable } from 'stream';

// ============================================================================
// MOCKS
// ============================================================================

// Mock electron before importing the module under test
vi.mock('electron', () => {
  return {
    ipcMain: {
      handle: vi.fn(),
    },
    dialog: {
      showSaveDialog: vi.fn(),
    },
  };
});

// Mock fs/promises for file writing
vi.mock('fs/promises', () => {
  return {
    default: {
      writeFile: vi.fn().mockResolvedValue(undefined),
    },
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
});

// Create mock stream and archive for testing
const mockArchiveInstance = {
  pipe: vi.fn(),
  append: vi.fn(),
  finalize: vi.fn(),
  on: vi.fn(),
};

const mockOutputInstance = {
  on: vi.fn(),
  close: vi.fn(),
};

// Mock fs for createWriteStream
vi.mock('fs', () => {
  return {
    createWriteStream: vi.fn(() => mockOutputInstance),
    default: {
      createWriteStream: vi.fn(() => mockOutputInstance),
    },
  };
});

// Mock archiver
vi.mock('archiver', () => {
  return {
    default: vi.fn(() => mockArchiveInstance),
  };
});

// Mock the database module
vi.mock('../../database/index.js', () => {
  return {
    getSession: vi.fn(),
    getSessionMessages: vi.fn(),
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
import { registerExportHandlers } from './export.js';
import * as db from '../../database/index.js';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import archiver from 'archiver';
import {
  exportSessionSchema,
  bulkExportSchema,
  validateInput,
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
 * Creates a mock session for testing
 */
function createMockSession(overrides: Record<string, unknown> = {}) {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    projectName: 'test-project',
    customTitle: 'Test Session',
    startTime: '2024-01-01T00:00:00Z',
    messageCount: 10,
    tokenCount: 1500,
    cost: 0.05,
    ...overrides,
  };
}

/**
 * Creates mock messages for testing
 */
function createMockMessages() {
  return [
    { id: '1', role: 'user', content: 'Hello, how are you?' },
    { id: '2', role: 'assistant', content: 'I am doing well, thank you!' },
    { id: '3', role: 'user', content: 'What is the weather today?' },
    { id: '4', role: 'assistant', content: 'I cannot check the weather, but I can help with other tasks.' },
  ];
}

/**
 * Captures registered IPC handlers for testing
 */
interface RegisteredHandlers {
  'export-session'?: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;
  'bulk-export'?: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;
}

// Capture handlers once at module level since registerExportHandlers modifies global ipcMain
const capturedHandlers: RegisteredHandlers = {};
let handlersInitialized = false;

function initializeHandlers(): void {
  if (handlersInitialized) return;

  const mockHandle = ipcMain.handle as ReturnType<typeof vi.fn>;
  mockHandle.mockImplementation((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
    capturedHandlers[channel as keyof RegisteredHandlers] = handler as RegisteredHandlers[keyof RegisteredHandlers];
  });

  registerExportHandlers();
  handlersInitialized = true;
}

function getHandlers(): RegisteredHandlers {
  initializeHandlers();
  return capturedHandlers;
}

// ============================================================================
// SCHEMA VALIDATION TESTS
// ============================================================================

describe('Export Schema Validation', () => {
  describe('exportSessionSchema', () => {
    describe('valid inputs', () => {
      const validFormats = ['markdown', 'json', 'html'];

      validFormats.forEach((format) => {
        it(`accepts valid UUID session ID with format "${format}"`, () => {
          const result = validateInput(exportSessionSchema, {
            sessionId: '550e8400-e29b-41d4-a716-446655440000',
            format,
          });
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.data.sessionId).toBe('550e8400-e29b-41d4-a716-446655440000');
            expect(result.data.format).toBe(format);
          }
        });

        it(`accepts agent-prefixed session ID with format "${format}"`, () => {
          const result = validateInput(exportSessionSchema, {
            sessionId: 'agent-abc123',
            format,
          });
          expect(result.success).toBe(true);
        });
      });

      it('accepts various valid UUID formats', () => {
        const validUUIDs = [
          '550e8400-e29b-41d4-a716-446655440000',
          'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
          'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11', // uppercase
        ];

        validUUIDs.forEach((uuid) => {
          const result = validateInput(exportSessionSchema, {
            sessionId: uuid,
            format: 'json',
          });
          expect(result.success).toBe(true);
        });
      });
    });

    describe('invalid inputs', () => {
      it('rejects missing sessionId', () => {
        const result = validateInput(exportSessionSchema, {
          format: 'json',
        });
        expect(result.success).toBe(false);
      });

      it('rejects missing format', () => {
        const result = validateInput(exportSessionSchema, {
          sessionId: '550e8400-e29b-41d4-a716-446655440000',
        });
        expect(result.success).toBe(false);
      });

      it('rejects invalid session ID format', () => {
        const result = validateInput(exportSessionSchema, {
          sessionId: 'invalid-session-id',
          format: 'json',
        });
        expect(result.success).toBe(false);
      });

      it('rejects invalid export format', () => {
        const invalidFormats = ['pdf', 'txt', 'docx', 'csv', 'xml'];

        invalidFormats.forEach((format) => {
          const result = validateInput(exportSessionSchema, {
            sessionId: '550e8400-e29b-41d4-a716-446655440000',
            format,
          });
          expect(result.success).toBe(false);
        });
      });

      it('rejects empty session ID', () => {
        const result = validateInput(exportSessionSchema, {
          sessionId: '',
          format: 'json',
        });
        expect(result.success).toBe(false);
      });

      it('rejects null input', () => {
        const result = validateInput(exportSessionSchema, null);
        expect(result.success).toBe(false);
      });

      it('rejects string instead of object', () => {
        const result = validateInput(exportSessionSchema, 'session-id');
        expect(result.success).toBe(false);
      });

      it('rejects array instead of object', () => {
        const result = validateInput(exportSessionSchema, ['session-id', 'json']);
        expect(result.success).toBe(false);
      });
    });

    describe('security edge cases', () => {
      it('rejects session ID with SQL injection attempt', () => {
        const result = validateInput(exportSessionSchema, {
          sessionId: "'; DROP TABLE sessions;--",
          format: 'json',
        });
        expect(result.success).toBe(false);
      });

      it('rejects session ID with command injection attempt', () => {
        const result = validateInput(exportSessionSchema, {
          sessionId: '$(whoami)',
          format: 'json',
        });
        expect(result.success).toBe(false);
      });

      it('rejects session ID exceeding max length', () => {
        const result = validateInput(exportSessionSchema, {
          sessionId: 'a'.repeat(101),
          format: 'json',
        });
        expect(result.success).toBe(false);
      });

      it('rejects session ID with path traversal', () => {
        const result = validateInput(exportSessionSchema, {
          sessionId: '../../../etc/passwd',
          format: 'json',
        });
        expect(result.success).toBe(false);
      });
    });
  });

  describe('bulkExportSchema', () => {
    describe('valid inputs', () => {
      it('accepts empty array', () => {
        const result = validateInput(bulkExportSchema, []);
        expect(result.success).toBe(true);
      });

      it('accepts single session ID', () => {
        const result = validateInput(bulkExportSchema, [
          '550e8400-e29b-41d4-a716-446655440000',
        ]);
        expect(result.success).toBe(true);
      });

      it('accepts multiple session IDs', () => {
        const result = validateInput(bulkExportSchema, [
          '550e8400-e29b-41d4-a716-446655440000',
          '550e8400-e29b-41d4-a716-446655440001',
          '550e8400-e29b-41d4-a716-446655440002',
        ]);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toHaveLength(3);
        }
      });

      it('accepts agent-prefixed session IDs', () => {
        const result = validateInput(bulkExportSchema, [
          'agent-abc123',
          'agent-xyz789',
        ]);
        expect(result.success).toBe(true);
      });

      it('accepts mixed UUID and agent-prefixed session IDs', () => {
        const result = validateInput(bulkExportSchema, [
          '550e8400-e29b-41d4-a716-446655440000',
          'agent-abc123',
        ]);
        expect(result.success).toBe(true);
      });
    });

    describe('invalid inputs', () => {
      it('rejects null', () => {
        const result = validateInput(bulkExportSchema, null);
        expect(result.success).toBe(false);
      });

      it('rejects string instead of array', () => {
        const result = validateInput(bulkExportSchema, '550e8400-e29b-41d4-a716-446655440000');
        expect(result.success).toBe(false);
      });

      it('rejects object instead of array', () => {
        const result = validateInput(bulkExportSchema, {
          sessionIds: ['550e8400-e29b-41d4-a716-446655440000'],
        });
        expect(result.success).toBe(false);
      });

      it('rejects array with invalid session ID', () => {
        const result = validateInput(bulkExportSchema, [
          '550e8400-e29b-41d4-a716-446655440000',
          'invalid-id',
        ]);
        expect(result.success).toBe(false);
      });

      it('rejects array with null element', () => {
        const result = validateInput(bulkExportSchema, [
          '550e8400-e29b-41d4-a716-446655440000',
          null,
        ]);
        expect(result.success).toBe(false);
      });

      it('rejects array with empty string', () => {
        const result = validateInput(bulkExportSchema, [
          '550e8400-e29b-41d4-a716-446655440000',
          '',
        ]);
        expect(result.success).toBe(false);
      });

      it('rejects array with undefined element', () => {
        const result = validateInput(bulkExportSchema, [
          '550e8400-e29b-41d4-a716-446655440000',
          undefined,
        ]);
        expect(result.success).toBe(false);
      });
    });

    describe('security edge cases', () => {
      it('rejects array with SQL injection attempt', () => {
        const result = validateInput(bulkExportSchema, [
          "'; DROP TABLE sessions;--",
        ]);
        expect(result.success).toBe(false);
      });

      it('rejects array with command injection attempt', () => {
        const result = validateInput(bulkExportSchema, [
          '$(rm -rf /)',
        ]);
        expect(result.success).toBe(false);
      });

      it('handles large array (schema allows, rate limiting elsewhere)', () => {
        const largeArray = Array.from({ length: 100 }, (_, i) =>
          `550e8400-e29b-41d4-a716-44665544${String(i).padStart(4, '0')}`
        );
        const result = validateInput(bulkExportSchema, largeArray);
        expect(result.success).toBe(true);
      });
    });
  });
});

// ============================================================================
// IPC HANDLER TESTS
// ============================================================================

describe('Export IPC Handlers', () => {
  let handlers: RegisteredHandlers;
  let mockEvent: IpcMainInvokeEvent;

  beforeEach(() => {
    // Reset mocks
    vi.mocked(dialog.showSaveDialog).mockReset();
    vi.mocked(db.getSession).mockReset();
    vi.mocked(db.getSessionMessages).mockReset();
    vi.mocked(fs.writeFile).mockReset();
    vi.mocked(createWriteStream).mockReset();
    vi.mocked(archiver).mockReset();

    // Reset archive mock
    mockArchiveInstance.pipe.mockReset();
    mockArchiveInstance.append.mockReset();
    mockArchiveInstance.finalize.mockReset();
    mockArchiveInstance.on.mockReset();
    mockOutputInstance.on.mockReset();
    mockOutputInstance.close.mockReset();

    // Set default mock return values
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(createWriteStream).mockReturnValue(mockOutputInstance as unknown as ReturnType<typeof createWriteStream>);
    vi.mocked(archiver).mockReturnValue(mockArchiveInstance as unknown as ReturnType<typeof archiver>);

    handlers = getHandlers();
    mockEvent = createMockEvent();
  });

  describe('Handler Registration', () => {
    it('registers all expected handlers', () => {
      expect(handlers['export-session']).toBeDefined();
      expect(handlers['bulk-export']).toBeDefined();
    });

    it('registers handlers as callable functions', () => {
      expect(typeof handlers['export-session']).toBe('function');
      expect(typeof handlers['bulk-export']).toBe('function');
    });
  });

  // ============================================================================
  // EXPORT-SESSION HANDLER TESTS
  // ============================================================================

  describe('export-session handler', () => {
    const validSessionId = '550e8400-e29b-41d4-a716-446655440000';
    const mockSession = createMockSession();
    const mockMessages = createMockMessages();

    describe('successful exports', () => {
      beforeEach(() => {
        vi.mocked(db.getSession).mockReturnValue(mockSession as never);
        vi.mocked(db.getSessionMessages).mockReturnValue(mockMessages as never);
      });

      it('exports session as JSON successfully', async () => {
        const filePath = '/home/user/session-export.json';
        vi.mocked(dialog.showSaveDialog).mockResolvedValue({
          canceled: false,
          filePath,
        });

        const handler = handlers['export-session'];
        const result = await handler!(mockEvent, {
          sessionId: validSessionId,
          format: 'json',
        });

        expect(db.getSession).toHaveBeenCalledWith(validSessionId);
        expect(db.getSessionMessages).toHaveBeenCalledWith(validSessionId);
        expect(dialog.showSaveDialog).toHaveBeenCalledWith({
          title: 'Export Session',
          defaultPath: `session-${validSessionId}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        expect(fs.writeFile).toHaveBeenCalledWith(
          filePath,
          expect.stringContaining('"session"'),
          'utf-8'
        );
        expect(result).toEqual({ success: true, path: filePath });
      });

      it('exports session as Markdown successfully', async () => {
        const filePath = '/home/user/session-export.markdown';
        vi.mocked(dialog.showSaveDialog).mockResolvedValue({
          canceled: false,
          filePath,
        });

        const handler = handlers['export-session'];
        const result = await handler!(mockEvent, {
          sessionId: validSessionId,
          format: 'markdown',
        });

        expect(dialog.showSaveDialog).toHaveBeenCalledWith({
          title: 'Export Session',
          defaultPath: `session-${validSessionId}.markdown`,
          filters: [{ name: 'MARKDOWN', extensions: ['markdown'] }],
        });
        expect(fs.writeFile).toHaveBeenCalledWith(
          filePath,
          expect.stringContaining('# Session:'),
          'utf-8'
        );
        expect(result).toEqual({ success: true, path: filePath });
      });

      it('exports session as HTML successfully', async () => {
        const filePath = '/home/user/session-export.html';
        vi.mocked(dialog.showSaveDialog).mockResolvedValue({
          canceled: false,
          filePath,
        });

        const handler = handlers['export-session'];
        const result = await handler!(mockEvent, {
          sessionId: validSessionId,
          format: 'html',
        });

        expect(dialog.showSaveDialog).toHaveBeenCalledWith({
          title: 'Export Session',
          defaultPath: `session-${validSessionId}.html`,
          filters: [{ name: 'HTML', extensions: ['html'] }],
        });
        expect(fs.writeFile).toHaveBeenCalledWith(
          filePath,
          expect.stringContaining('<!DOCTYPE html>'),
          'utf-8'
        );
        expect(result).toEqual({ success: true, path: filePath });
      });

      it('exports agent-prefixed session ID', async () => {
        const agentSessionId = 'agent-test123';
        const agentSession = createMockSession({ id: agentSessionId });
        vi.mocked(db.getSession).mockReturnValue(agentSession as never);
        vi.mocked(dialog.showSaveDialog).mockResolvedValue({
          canceled: false,
          filePath: '/export/agent-session.json',
        });

        const handler = handlers['export-session'];
        const result = await handler!(mockEvent, {
          sessionId: agentSessionId,
          format: 'json',
        });

        expect(db.getSession).toHaveBeenCalledWith(agentSessionId);
        expect(result).toEqual({ success: true, path: '/export/agent-session.json' });
      });
    });

    describe('error cases', () => {
      it('returns error when session not found', async () => {
        vi.mocked(db.getSession).mockReturnValue(null as never);

        const handler = handlers['export-session'];
        const result = await handler!(mockEvent, {
          sessionId: validSessionId,
          format: 'json',
        });

        expect(result).toEqual({ success: false, error: 'Session not found' });
        expect(dialog.showSaveDialog).not.toHaveBeenCalled();
      });

      it('returns error when user cancels dialog', async () => {
        vi.mocked(db.getSession).mockReturnValue(mockSession as never);
        vi.mocked(db.getSessionMessages).mockReturnValue(mockMessages as never);
        vi.mocked(dialog.showSaveDialog).mockResolvedValue({
          canceled: true,
          filePath: undefined,
        });

        const handler = handlers['export-session'];
        const result = await handler!(mockEvent, {
          sessionId: validSessionId,
          format: 'json',
        });

        expect(result).toEqual({ success: false, error: 'Export cancelled' });
        expect(fs.writeFile).not.toHaveBeenCalled();
      });

      it('returns error when filePath is undefined', async () => {
        vi.mocked(db.getSession).mockReturnValue(mockSession as never);
        vi.mocked(db.getSessionMessages).mockReturnValue(mockMessages as never);
        vi.mocked(dialog.showSaveDialog).mockResolvedValue({
          canceled: false,
          filePath: undefined,
        });

        const handler = handlers['export-session'];
        const result = await handler!(mockEvent, {
          sessionId: validSessionId,
          format: 'json',
        });

        expect(result).toEqual({ success: false, error: 'Export cancelled' });
      });

      it('throws IPCValidationError for invalid session ID', async () => {
        const handler = handlers['export-session'];

        await expect(handler!(mockEvent, {
          sessionId: 'invalid-id',
          format: 'json',
        })).rejects.toThrow('Invalid export data');
      });

      it('throws IPCValidationError for invalid format', async () => {
        const handler = handlers['export-session'];

        await expect(handler!(mockEvent, {
          sessionId: validSessionId,
          format: 'pdf',
        })).rejects.toThrow('Invalid export data');
      });

      it('throws IPCValidationError for missing sessionId', async () => {
        const handler = handlers['export-session'];

        await expect(handler!(mockEvent, {
          format: 'json',
        })).rejects.toThrow('Invalid export data');
      });

      it('throws IPCValidationError for missing format', async () => {
        const handler = handlers['export-session'];

        await expect(handler!(mockEvent, {
          sessionId: validSessionId,
        })).rejects.toThrow('Invalid export data');
      });

      it('throws IPCValidationError for null input', async () => {
        const handler = handlers['export-session'];

        await expect(handler!(mockEvent, null)).rejects.toThrow('Invalid export data');
      });

      it('throws IPCValidationError for empty session ID', async () => {
        const handler = handlers['export-session'];

        await expect(handler!(mockEvent, {
          sessionId: '',
          format: 'json',
        })).rejects.toThrow('Invalid export data');
      });
    });

    describe('format-specific content', () => {
      beforeEach(() => {
        vi.mocked(db.getSession).mockReturnValue(mockSession as never);
        vi.mocked(db.getSessionMessages).mockReturnValue(mockMessages as never);
        vi.mocked(dialog.showSaveDialog).mockResolvedValue({
          canceled: false,
          filePath: '/export/session.txt',
        });
      });

      it('JSON format includes session and messages structure', async () => {
        const handler = handlers['export-session'];
        await handler!(mockEvent, {
          sessionId: validSessionId,
          format: 'json',
        });

        const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
        const content = writeCall[1] as string;
        const parsed = JSON.parse(content);

        expect(parsed).toHaveProperty('session');
        expect(parsed).toHaveProperty('messages');
        expect(parsed.session.id).toBe(mockSession.id);
        expect(parsed.messages).toHaveLength(mockMessages.length);
      });

      it('Markdown format includes session header and messages', async () => {
        const handler = handlers['export-session'];
        await handler!(mockEvent, {
          sessionId: validSessionId,
          format: 'markdown',
        });

        const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
        const content = writeCall[1] as string;

        expect(content).toContain('# Session:');
        expect(content).toContain('**Project:**');
        expect(content).toContain('**Date:**');
        expect(content).toContain('**Messages:**');
        expect(content).toContain('**Tokens:**');
        expect(content).toContain('**Cost:**');
      });

      it('HTML format includes DOCTYPE and styled content', async () => {
        const handler = handlers['export-session'];
        await handler!(mockEvent, {
          sessionId: validSessionId,
          format: 'html',
        });

        const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
        const content = writeCall[1] as string;

        expect(content).toContain('<!DOCTYPE html>');
        expect(content).toContain('<html>');
        expect(content).toContain('<head>');
        expect(content).toContain('<style>');
        expect(content).toContain('</body></html>');
      });

      it('HTML format escapes special characters', async () => {
        const messagesWithSpecialChars = [
          { id: '1', role: 'user', content: 'Test <script>alert("xss")</script>' },
          { id: '2', role: 'assistant', content: 'Response with & and "quotes"' },
        ];
        vi.mocked(db.getSessionMessages).mockReturnValue(messagesWithSpecialChars as never);

        const handler = handlers['export-session'];
        await handler!(mockEvent, {
          sessionId: validSessionId,
          format: 'html',
        });

        const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
        const content = writeCall[1] as string;

        expect(content).toContain('&lt;script&gt;');
        expect(content).toContain('&amp;');
        expect(content).toContain('&quot;');
        expect(content).not.toContain('<script>alert');
      });
    });
  });

  // ============================================================================
  // BULK-EXPORT HANDLER TESTS
  // ============================================================================

  describe('bulk-export handler', () => {
    const validSessionIds = [
      '550e8400-e29b-41d4-a716-446655440000',
      '550e8400-e29b-41d4-a716-446655440001',
    ];

    describe('successful exports', () => {
      it('exports multiple sessions as ZIP successfully', async () => {
        const filePath = '/home/user/sessions-export.zip';
        vi.mocked(dialog.showSaveDialog).mockResolvedValue({
          canceled: false,
          filePath,
        });

        validSessionIds.forEach((id, index) => {
          vi.mocked(db.getSession).mockReturnValueOnce(
            createMockSession({ id, projectName: `project-${index}` }) as never
          );
          vi.mocked(db.getSessionMessages).mockReturnValueOnce(createMockMessages() as never);
        });

        // Simulate archive close event - needs to be set up before calling handler
        mockOutputInstance.on.mockImplementation((event: string, callback: () => void) => {
          if (event === 'close') {
            // Use setImmediate to ensure async behavior
            setImmediate(callback);
          }
          return mockOutputInstance;
        });

        const handler = handlers['bulk-export'];
        const result = await handler!(mockEvent, validSessionIds);

        expect(dialog.showSaveDialog).toHaveBeenCalledWith({
          title: 'Export Sessions as ZIP',
          defaultPath: expect.stringMatching(/sessions-export-\d+\.zip/),
          filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
        });
        // Since the createWriteStream is called inside the handler, we verify the flow completed
        expect(mockArchiveInstance.pipe).toHaveBeenCalled();
        expect(mockArchiveInstance.append).toHaveBeenCalledTimes(2);
        expect(mockArchiveInstance.finalize).toHaveBeenCalled();
        expect(result).toEqual({ success: true, path: filePath });
      });

      it('exports empty array without error', async () => {
        const filePath = '/home/user/empty-export.zip';
        vi.mocked(dialog.showSaveDialog).mockResolvedValue({
          canceled: false,
          filePath,
        });

        mockOutputInstance.on.mockImplementation((event: string, callback: () => void) => {
          if (event === 'close') {
            setTimeout(callback, 0);
          }
          return mockOutputInstance;
        });

        const handler = handlers['bulk-export'];
        const result = await handler!(mockEvent, []);

        expect(mockArchiveInstance.append).not.toHaveBeenCalled();
        expect(mockArchiveInstance.finalize).toHaveBeenCalled();
        expect(result).toEqual({ success: true, path: filePath });
      });

      it('skips non-existent sessions during bulk export', async () => {
        const filePath = '/home/user/partial-export.zip';
        vi.mocked(dialog.showSaveDialog).mockResolvedValue({
          canceled: false,
          filePath,
        });

        // First session exists, second doesn't
        vi.mocked(db.getSession)
          .mockReturnValueOnce(createMockSession() as never)
          .mockReturnValueOnce(null as never);
        vi.mocked(db.getSessionMessages).mockReturnValue(createMockMessages() as never);

        mockOutputInstance.on.mockImplementation((event: string, callback: () => void) => {
          if (event === 'close') {
            setTimeout(callback, 0);
          }
          return mockOutputInstance;
        });

        const handler = handlers['bulk-export'];
        const result = await handler!(mockEvent, validSessionIds);

        expect(mockArchiveInstance.append).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ success: true, path: filePath });
      });

      it('exports agent-prefixed session IDs', async () => {
        const agentSessionIds = ['agent-abc123', 'agent-xyz789'];
        const filePath = '/home/user/agent-sessions.zip';

        vi.mocked(dialog.showSaveDialog).mockResolvedValue({
          canceled: false,
          filePath,
        });

        agentSessionIds.forEach((id) => {
          vi.mocked(db.getSession).mockReturnValueOnce(
            createMockSession({ id }) as never
          );
          vi.mocked(db.getSessionMessages).mockReturnValueOnce(createMockMessages() as never);
        });

        mockOutputInstance.on.mockImplementation((event: string, callback: () => void) => {
          if (event === 'close') {
            setTimeout(callback, 0);
          }
          return mockOutputInstance;
        });

        const handler = handlers['bulk-export'];
        const result = await handler!(mockEvent, agentSessionIds);

        expect(db.getSession).toHaveBeenCalledWith('agent-abc123');
        expect(db.getSession).toHaveBeenCalledWith('agent-xyz789');
        expect(result).toEqual({ success: true, path: filePath });
      });
    });

    describe('error cases', () => {
      it('returns error when user cancels dialog', async () => {
        vi.mocked(dialog.showSaveDialog).mockResolvedValue({
          canceled: true,
          filePath: undefined,
        });

        const handler = handlers['bulk-export'];
        const result = await handler!(mockEvent, validSessionIds);

        expect(result).toEqual({ success: false, error: 'Export cancelled' });
        expect(createWriteStream).not.toHaveBeenCalled();
      });

      it('returns error when filePath is undefined', async () => {
        vi.mocked(dialog.showSaveDialog).mockResolvedValue({
          canceled: false,
          filePath: undefined,
        });

        const handler = handlers['bulk-export'];
        const result = await handler!(mockEvent, validSessionIds);

        expect(result).toEqual({ success: false, error: 'Export cancelled' });
      });

      it('handles write stream error', async () => {
        const filePath = '/home/user/error-export.zip';
        vi.mocked(dialog.showSaveDialog).mockResolvedValue({
          canceled: false,
          filePath,
        });

        mockOutputInstance.on.mockImplementation((event: string, callback: (err?: Error) => void) => {
          if (event === 'error') {
            setTimeout(() => callback(new Error('Write stream error')), 0);
          }
          return mockOutputInstance;
        });

        const handler = handlers['bulk-export'];
        const result = await handler!(mockEvent, validSessionIds);

        expect(result).toEqual({
          success: false,
          error: 'Write error: Write stream error',
        });
      });

      it('handles archive error', async () => {
        const filePath = '/home/user/archive-error.zip';
        vi.mocked(dialog.showSaveDialog).mockResolvedValue({
          canceled: false,
          filePath,
        });

        mockArchiveInstance.on.mockImplementation((event: string, callback: (err?: Error) => void) => {
          if (event === 'error') {
            setTimeout(() => callback(new Error('Archive compression failed')), 0);
          }
          return mockArchiveInstance;
        });

        const handler = handlers['bulk-export'];
        const result = await handler!(mockEvent, validSessionIds);

        expect(mockOutputInstance.close).toHaveBeenCalled();
        expect(result).toEqual({
          success: false,
          error: 'Archive error: Archive compression failed',
        });
      });

      it('throws IPCValidationError for invalid session ID in array', async () => {
        const handler = handlers['bulk-export'];

        await expect(handler!(mockEvent, [
          '550e8400-e29b-41d4-a716-446655440000',
          'invalid-id',
        ])).rejects.toThrow('Invalid session IDs');
      });

      it('throws IPCValidationError for null input', async () => {
        const handler = handlers['bulk-export'];

        await expect(handler!(mockEvent, null)).rejects.toThrow('Invalid session IDs');
      });

      it('throws IPCValidationError for string instead of array', async () => {
        const handler = handlers['bulk-export'];

        await expect(handler!(mockEvent, '550e8400-e29b-41d4-a716-446655440000'))
          .rejects.toThrow('Invalid session IDs');
      });

      it('throws IPCValidationError for object instead of array', async () => {
        const handler = handlers['bulk-export'];

        await expect(handler!(mockEvent, { ids: validSessionIds }))
          .rejects.toThrow('Invalid session IDs');
      });
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
    vi.mocked(dialog.showSaveDialog).mockReset();
    vi.mocked(db.getSession).mockReset();
    vi.mocked(db.getSessionMessages).mockReset();
    vi.mocked(fs.writeFile).mockReset();

    handlers = getHandlers();
    mockEvent = createMockEvent();
  });

  it('IPCValidationError includes error code', async () => {
    const handler = handlers['export-session'];

    try {
      await handler!(mockEvent, { sessionId: '', format: 'json' });
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe('IPCValidationError');
      expect((error as { code?: string }).code).toBe('VALIDATION_ERROR');
    }
  });

  it('validation errors include details about the failure', async () => {
    const handler = handlers['bulk-export'];

    try {
      await handler!(mockEvent, 'not-an-array');
      expect.fail('Should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('Invalid session IDs');
    }
  });

  it('file write errors propagate correctly', async () => {
    const mockSession = createMockSession();
    const mockMessages = createMockMessages();

    vi.mocked(db.getSession).mockReturnValue(mockSession as never);
    vi.mocked(db.getSessionMessages).mockReturnValue(mockMessages as never);
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({
      canceled: false,
      filePath: '/protected/file.json',
    });

    const writeError = new Error('Permission denied');
    vi.mocked(fs.writeFile).mockRejectedValue(writeError);

    const handler = handlers['export-session'];

    await expect(handler!(mockEvent, {
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      format: 'json',
    })).rejects.toThrow('Permission denied');
  });

  it('database errors propagate correctly from getSession', async () => {
    const dbError = new Error('Database connection failed');
    vi.mocked(db.getSession).mockImplementation(() => {
      throw dbError;
    });

    const handler = handlers['export-session'];

    await expect(handler!(mockEvent, {
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      format: 'json',
    })).rejects.toThrow('Database connection failed');
  });
});

// ============================================================================
// SECURITY EDGE CASES
// ============================================================================

describe('Security Edge Cases', () => {
  let handlers: RegisteredHandlers;
  let mockEvent: IpcMainInvokeEvent;

  beforeEach(() => {
    vi.mocked(dialog.showSaveDialog).mockReset();
    vi.mocked(db.getSession).mockReset();
    vi.mocked(db.getSessionMessages).mockReset();
    vi.mocked(fs.writeFile).mockReset();

    handlers = getHandlers();
    mockEvent = createMockEvent();
  });

  describe('Session ID Injection Prevention', () => {
    const injectionPayloads = [
      "'; DROP TABLE sessions;--",
      "' OR '1'='1",
      '$(whoami)',
      '`id`',
      '${PATH}',
      "'; DELETE FROM sessions; --",
      '1; SELECT * FROM users',
    ];

    injectionPayloads.forEach((payload) => {
      it(`rejects session ID with injection: ${payload.substring(0, 20)}...`, async () => {
        const handler = handlers['export-session'];

        await expect(handler!(mockEvent, {
          sessionId: payload,
          format: 'json',
        })).rejects.toThrow('Invalid export data');
      });

      it(`rejects bulk export with injection: ${payload.substring(0, 20)}...`, async () => {
        const handler = handlers['bulk-export'];

        await expect(handler!(mockEvent, [payload])).rejects.toThrow('Invalid session IDs');
      });
    });
  });

  describe('Prototype Pollution Prevention', () => {
    it('should not be affected by __proto__ in exportSessionSchema', async () => {
      const maliciousInput = JSON.parse(
        '{"__proto__": {"polluted": true}, "sessionId": "550e8400-e29b-41d4-a716-446655440000", "format": "json"}'
      );

      vi.mocked(db.getSession).mockReturnValue(createMockSession() as never);
      vi.mocked(db.getSessionMessages).mockReturnValue(createMockMessages() as never);
      vi.mocked(dialog.showSaveDialog).mockResolvedValue({
        canceled: false,
        filePath: '/export/file.json',
      });
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const handler = handlers['export-session'];
      await handler!(mockEvent, maliciousInput);

      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  });

  describe('Type Coercion Prevention', () => {
    it('rejects object with valueOf for sessionId', async () => {
      const handler = handlers['export-session'];

      await expect(handler!(mockEvent, {
        sessionId: { valueOf: () => '550e8400-e29b-41d4-a716-446655440000' },
        format: 'json',
      })).rejects.toThrow('Invalid export data');
    });

    it('rejects array where object expected for export-session', async () => {
      const handler = handlers['export-session'];

      await expect(handler!(mockEvent, [
        '550e8400-e29b-41d4-a716-446655440000',
        'json',
      ])).rejects.toThrow('Invalid export data');
    });

    it('rejects nested array in bulk-export', async () => {
      const handler = handlers['bulk-export'];

      await expect(handler!(mockEvent, [
        ['550e8400-e29b-41d4-a716-446655440000'],
      ])).rejects.toThrow('Invalid session IDs');
    });
  });

  describe('Path Traversal in Session IDs', () => {
    const pathTraversalPayloads = [
      '../../../etc/passwd',
      '..\\..\\..\\windows\\system32',
      '/root/../../../etc/shadow',
    ];

    pathTraversalPayloads.forEach((payload) => {
      it(`rejects path traversal in session ID: ${payload}`, async () => {
        const handler = handlers['export-session'];

        await expect(handler!(mockEvent, {
          sessionId: payload,
          format: 'json',
        })).rejects.toThrow('Invalid export data');
      });
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
    vi.mocked(dialog.showSaveDialog).mockReset();
    vi.mocked(db.getSession).mockReset();
    vi.mocked(db.getSessionMessages).mockReset();
    vi.mocked(fs.writeFile).mockReset().mockResolvedValue(undefined);
    vi.mocked(createWriteStream).mockReset().mockReturnValue(mockOutputInstance as unknown as ReturnType<typeof createWriteStream>);
    vi.mocked(archiver).mockReset().mockReturnValue(mockArchiveInstance as unknown as ReturnType<typeof archiver>);

    mockArchiveInstance.pipe.mockReset();
    mockArchiveInstance.append.mockReset();
    mockArchiveInstance.finalize.mockReset();
    mockArchiveInstance.on.mockReset();
    mockOutputInstance.on.mockReset();
    mockOutputInstance.close.mockReset();

    handlers = getHandlers();
    mockEvent = createMockEvent();
  });

  it('simulates complete single session export flow', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const mockSession = createMockSession({ id: sessionId });
    const mockMessages = createMockMessages();

    // Setup mocks
    vi.mocked(db.getSession).mockReturnValue(mockSession as never);
    vi.mocked(db.getSessionMessages).mockReturnValue(mockMessages as never);
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({
      canceled: false,
      filePath: '/home/user/my-session.json',
    });

    // Execute export
    const handler = handlers['export-session'];
    const result = await handler!(mockEvent, {
      sessionId,
      format: 'json',
    });

    // Verify complete flow
    expect(db.getSession).toHaveBeenCalledWith(sessionId);
    expect(db.getSessionMessages).toHaveBeenCalledWith(sessionId);
    expect(dialog.showSaveDialog).toHaveBeenCalled();
    expect(fs.writeFile).toHaveBeenCalledWith(
      '/home/user/my-session.json',
      expect.any(String),
      'utf-8'
    );
    expect(result).toEqual({ success: true, path: '/home/user/my-session.json' });

    // Verify content structure
    const writtenContent = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
    const parsed = JSON.parse(writtenContent);
    expect(parsed.session.id).toBe(sessionId);
    expect(parsed.messages).toEqual(mockMessages);
  });

  it('simulates export in all three formats sequentially', async () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const mockSession = createMockSession();
    const mockMessages = createMockMessages();

    vi.mocked(db.getSession).mockReturnValue(mockSession as never);
    vi.mocked(db.getSessionMessages).mockReturnValue(mockMessages as never);

    const formats: Array<'json' | 'markdown' | 'html'> = ['json', 'markdown', 'html'];
    const handler = handlers['export-session'];

    for (const format of formats) {
      vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({
        canceled: false,
        filePath: `/export/session.${format}`,
      });

      const result = await handler!(mockEvent, {
        sessionId,
        format,
      });

      expect(result).toEqual({ success: true, path: `/export/session.${format}` });
    }

    expect(fs.writeFile).toHaveBeenCalledTimes(3);
  });

  it('simulates bulk export with mixed results', async () => {
    const sessionIds = [
      '550e8400-e29b-41d4-a716-446655440000',
      '550e8400-e29b-41d4-a716-446655440001',
      '550e8400-e29b-41d4-a716-446655440002',
    ];

    // First and third exist, second doesn't
    vi.mocked(db.getSession)
      .mockReturnValueOnce(createMockSession({ id: sessionIds[0] }) as never)
      .mockReturnValueOnce(null as never)
      .mockReturnValueOnce(createMockSession({ id: sessionIds[2] }) as never);
    vi.mocked(db.getSessionMessages).mockReturnValue(createMockMessages() as never);

    vi.mocked(dialog.showSaveDialog).mockResolvedValue({
      canceled: false,
      filePath: '/export/bulk.zip',
    });

    mockOutputInstance.on.mockImplementation((event: string, callback: () => void) => {
      if (event === 'close') {
        setTimeout(callback, 0);
      }
      return mockOutputInstance;
    });

    const handler = handlers['bulk-export'];
    const result = await handler!(mockEvent, sessionIds);

    // Should have appended 2 sessions (skipped the non-existent one)
    expect(mockArchiveInstance.append).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ success: true, path: '/export/bulk.zip' });
  });
});
