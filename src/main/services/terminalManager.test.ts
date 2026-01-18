// ============================================================================
// TERMINAL MANAGER TESTS
// ============================================================================
//
// These tests verify the TerminalManager service functionality.
// Uses mocked node-pty to test terminal creation and management.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi, type MockedFunction } from 'vitest';
import type { IPty, IDisposable } from 'node-pty';

// Mock modules before importing the module under test
vi.mock('node-pty', () => ({
  default: {
    spawn: vi.fn(),
  },
  spawn: vi.fn(),
}));

vi.mock('../window.js', () => ({
  sendToRenderer: vi.fn(),
}));

vi.mock('../database/index.js', () => ({
  getSetting: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock('./recentProjects.js', () => ({
  addRecentProject: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  Logger: class MockLogger {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    emit: vi.fn(),
  },
}));

vi.mock('./ptyStreamAnalyzer.js', () => ({
  getPTYStreamAnalyzer: vi.fn(() => ({
    analyze: vi.fn(),
    clearTerminal: vi.fn(),
    startPeriodicCleanup: vi.fn(),
    stopPeriodicCleanup: vi.fn(),
  })),
}));

// Mock fs module for directory/file existence checks
vi.mock('fs', () => ({
  statSync: vi.fn((pathArg: string) => {
    // For security test paths with injection characters, simulate "not found"
    if (/[;|&$`(){}<>!?*[\]]/.test(pathArg)) {
      const error = new Error('ENOENT: no such file or directory');
      (error as NodeJS.ErrnoException).code = 'ENOENT';
      throw error;
    }
    // For normal test paths, simulate they exist as directories
    return {
      isDirectory: () => true,
      isFile: () => false,
    };
  }),
  existsSync: vi.fn(() => true),
}));

// Import after mocks are set up
import * as pty from 'node-pty';
import { sendToRenderer } from '../window.js';
import * as db from '../database/index.js';
import { addRecentProject } from './recentProjects.js';
import {
  initTerminalManager,
  startTerminal,
  writeToTerminal,
  resizeTerminal,
  killTerminal,
  getAllTerminals,
  closeAllTerminals,
  getTerminalCount,
} from './terminalManager.js';

// ============================================================================
// TEST FIXTURES
// ============================================================================

// Type for event listener callbacks in mock PTY
type DataListener = (data: string) => void;
type ExitListener = (exitCode: { exitCode: number; signal?: number }) => void;

interface MockPtyListeners {
  data: DataListener[];
  exit: ExitListener[];
}

// Extended mock type that includes test helper methods and required mocked methods
interface MockPty extends Partial<IPty> {
  write: MockedFunction<(data: string) => void>;
  resize: MockedFunction<(columns: number, rows: number) => void>;
  kill: MockedFunction<(signal?: string) => void>;
  _trigger: (event: keyof MockPtyListeners, ...args: unknown[]) => void;
}

function createMockPty(): MockPty {
  const listeners: MockPtyListeners = { data: [], exit: [] };

  return {
    pid: 12345,
    cols: 80,
    rows: 24,
    onData: vi.fn((callback: DataListener): IDisposable => {
      listeners.data.push(callback);
      return { dispose: vi.fn() };
    }),
    onExit: vi.fn((callback: ExitListener): IDisposable => {
      listeners.exit.push(callback);
      return { dispose: vi.fn() };
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    // Helper to trigger events in tests
    _trigger: (event: keyof MockPtyListeners, ...args: unknown[]) => {
      if (event === 'data') {
        listeners.data.forEach(cb => cb(args[0] as string));
      } else if (event === 'exit') {
        listeners.exit.forEach(cb => cb(args[0] as { exitCode: number; signal?: number }));
      }
    },
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('TerminalManager Service', () => {
  let mockPty: MockPty;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPty = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mockPty as IPty);
    vi.mocked(db.getSetting).mockReturnValue(true); // skipPermissions enabled

    // Initialize the terminal manager
    initTerminalManager();
  });

  afterEach(() => {
    // Clean up all terminals
    closeAllTerminals();
  });

  describe('initTerminalManager', () => {
    it('should initialize without error', () => {
      expect(() => initTerminalManager()).not.toThrow();
    });
  });

  describe('startTerminal', () => {
    it('should create a new terminal with default options', async () => {
      const result = await startTerminal({ cwd: '/test/path' });

      expect(result.id).toBeDefined();
      expect(result.cwd).toBe('/test/path');
      expect(result.error).toBeUndefined();
    });

    it('should spawn pty with correct shell command', async () => {
      await startTerminal({ cwd: '/test/path' });

      expect(pty.spawn).toHaveBeenCalledWith(
        expect.stringContaining('claude'),
        expect.arrayContaining(['--dangerously-skip-permissions']),
        expect.objectContaining({
          cwd: '/test/path',
          env: expect.any(Object),
        })
      );
    });

    it('should use custom name if provided', async () => {
      const result = await startTerminal({ cwd: '/test/path', name: 'My Terminal' });

      expect(result.name).toBe('My Terminal');
    });

    it('should derive name from directory if not provided', async () => {
      const result = await startTerminal({ cwd: '/home/user/my-project' });

      expect(result.name).toBe('my-project');
    });

    it('should include resume session ID when provided', async () => {
      await startTerminal({
        cwd: '/test/path',
        resumeSessionId: 'session-123',
        sessionType: 'user',
      });

      expect(pty.spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['--resume', 'session-123']),
        expect.any(Object)
      );
    });

    it('should return terminal info with session metadata', async () => {
      const result = await startTerminal({
        cwd: '/test/path',
        resumeSessionId: 'session-123',
        sessionType: 'subagent',
      });

      expect(result.resumeSessionId).toBe('session-123');
      expect(result.sessionType).toBe('subagent');
    });

    it('should add to recent projects', async () => {
      await startTerminal({ cwd: '/test/path', name: 'Test Project' });

      expect(addRecentProject).toHaveBeenCalledWith('/test/path', 'Test Project');
    });

    it('should log activity on terminal start', async () => {
      await startTerminal({ cwd: '/test/path', name: 'Test' });

      expect(db.logActivity).toHaveBeenCalledWith(
        'terminal_start',
        null, // resumeSessionId is undefined, which becomes null
        expect.stringContaining('Started terminal'),
        expect.any(Object)
      );
    });

    it('should handle spawn errors gracefully', async () => {
      vi.mocked(pty.spawn).mockImplementation(() => {
        throw new Error('Failed to spawn');
      });

      const result = await startTerminal({ cwd: '/test/path' });

      expect(result.error).toBe('Failed to spawn');
      expect(result.id).toBeUndefined();
    });

    it('should not include skip permissions flag when disabled', async () => {
      vi.mocked(db.getSetting).mockReturnValue(false);

      await startTerminal({ cwd: '/test/path' });

      const args = vi.mocked(pty.spawn).mock.calls[0][1];
      expect(args).not.toContain('--dangerously-skip-permissions');
    });

    it('should send terminal data to renderer', async () => {
      await startTerminal({ cwd: '/test/path' });

      // Simulate data from pty
      mockPty._trigger('data', 'Hello, World!');

      expect(sendToRenderer).toHaveBeenCalledWith('terminal-data', {
        id: expect.any(Number),
        data: 'Hello, World!',
      });
    });

    it('should send exit event to renderer on terminal exit', async () => {
      const result = await startTerminal({ cwd: '/test/path' });

      // Simulate terminal exit
      mockPty._trigger('exit', { exitCode: 0 });

      expect(sendToRenderer).toHaveBeenCalledWith('terminal-exit', {
        id: result.id,
        exitCode: 0,
      });
    });

    it('should log activity on terminal exit', async () => {
      await startTerminal({ cwd: '/test/path', name: 'Test' });

      // Clear previous calls
      vi.mocked(db.logActivity).mockClear();

      // Simulate terminal exit
      mockPty._trigger('exit', { exitCode: 0 });

      expect(db.logActivity).toHaveBeenCalledWith(
        'terminal_end',
        null, // resumeSessionId is undefined, which becomes null
        expect.stringContaining('Terminal closed'),
        expect.objectContaining({ exitCode: 0 })
      );
    });
  });

  describe('writeToTerminal', () => {
    it('should write data to terminal', async () => {
      const result = await startTerminal({ cwd: '/test/path' });
      expect(result.id).toBeDefined();
      const terminalId = result.id as number;

      writeToTerminal(terminalId, 'test input');

      expect(mockPty.write).toHaveBeenCalledWith('test input');
    });

    it('should not throw for non-existent terminal', () => {
      expect(() => writeToTerminal(99999, 'test')).not.toThrow();
    });

    it('should handle write errors gracefully', async () => {
      const result = await startTerminal({ cwd: '/test/path' });
      expect(result.id).toBeDefined();
      const terminalId = result.id as number;
      mockPty.write.mockImplementation(() => {
        throw new Error('Write failed');
      });

      expect(() => writeToTerminal(terminalId, 'test')).not.toThrow();
    });
  });

  describe('resizeTerminal', () => {
    it('should resize terminal', async () => {
      const result = await startTerminal({ cwd: '/test/path' });
      expect(result.id).toBeDefined();
      const terminalId = result.id as number;

      resizeTerminal(terminalId, 120, 40);

      expect(mockPty.resize).toHaveBeenCalledWith(120, 40);
    });

    it('should not throw for non-existent terminal', () => {
      expect(() => resizeTerminal(99999, 120, 40)).not.toThrow();
    });

    it('should handle resize errors gracefully', async () => {
      const result = await startTerminal({ cwd: '/test/path' });
      expect(result.id).toBeDefined();
      const terminalId = result.id as number;
      mockPty.resize.mockImplementation(() => {
        throw new Error('Resize failed');
      });

      expect(() => resizeTerminal(terminalId, 120, 40)).not.toThrow();
    });
  });

  describe('killTerminal', () => {
    it('should kill terminal and return true', async () => {
      const result = await startTerminal({ cwd: '/test/path' });
      expect(result.id).toBeDefined();
      const terminalId = result.id as number;

      const killed = killTerminal(terminalId);

      expect(killed).toBe(true);
      expect(mockPty.kill).toHaveBeenCalled();
    });

    it('should return false for non-existent terminal', () => {
      const killed = killTerminal(99999);

      expect(killed).toBe(false);
    });

    it('should remove terminal from list after killing', async () => {
      const result = await startTerminal({ cwd: '/test/path' });
      expect(result.id).toBeDefined();
      const terminalId = result.id as number;
      const initialCount = getTerminalCount();

      killTerminal(terminalId);

      expect(getTerminalCount()).toBe(initialCount - 1);
    });

    it('should handle kill errors gracefully', async () => {
      const result = await startTerminal({ cwd: '/test/path' });
      expect(result.id).toBeDefined();
      const terminalId = result.id as number;
      mockPty.kill.mockImplementation(() => {
        throw new Error('Kill failed');
      });

      // Should return false when kill fails
      expect(killTerminal(terminalId)).toBe(false);
    });
  });

  describe('getAllTerminals', () => {
    it('should return empty array when no terminals', () => {
      const terminals = getAllTerminals();

      expect(terminals).toEqual([]);
    });

    it('should return all active terminals', async () => {
      await startTerminal({ cwd: '/path1', name: 'Terminal 1' });
      await startTerminal({ cwd: '/path2', name: 'Terminal 2' });

      const terminals = getAllTerminals();

      expect(terminals).toHaveLength(2);
      expect(terminals[0].name).toBe('Terminal 1');
      expect(terminals[1].name).toBe('Terminal 2');
    });

    it('should include terminal metadata in response', async () => {
      await startTerminal({
        cwd: '/test/path',
        name: 'Test',
        resumeSessionId: 'session-123',
        sessionType: 'user',
      });

      const terminals = getAllTerminals();

      expect(terminals[0]).toMatchObject({
        id: expect.any(Number),
        name: 'Test',
        cwd: '/test/path',
        resumeSessionId: 'session-123',
        sessionType: 'user',
        startTime: expect.any(Date),
      });
    });
  });

  describe('closeAllTerminals', () => {
    it('should close all terminals', async () => {
      const mockPty1 = createMockPty();
      const mockPty2 = createMockPty();

      vi.mocked(pty.spawn)
        .mockReturnValueOnce(mockPty1 as IPty)
        .mockReturnValueOnce(mockPty2 as IPty);

      await startTerminal({ cwd: '/path1' });
      await startTerminal({ cwd: '/path2' });

      expect(getTerminalCount()).toBe(2);

      closeAllTerminals();

      expect(mockPty1.kill).toHaveBeenCalled();
      expect(mockPty2.kill).toHaveBeenCalled();
      expect(getTerminalCount()).toBe(0);
    });

    it('should handle kill errors during close all', async () => {
      mockPty.kill.mockImplementation(() => {
        throw new Error('Kill failed');
      });

      await startTerminal({ cwd: '/test/path' });

      // Should not throw
      expect(() => closeAllTerminals()).not.toThrow();
      expect(getTerminalCount()).toBe(0);
    });
  });

  describe('getTerminalCount', () => {
    it('should return 0 when no terminals', () => {
      expect(getTerminalCount()).toBe(0);
    });

    it('should return correct count', async () => {
      await startTerminal({ cwd: '/path1' });
      expect(getTerminalCount()).toBe(1);

      await startTerminal({ cwd: '/path2' });
      expect(getTerminalCount()).toBe(2);

      // Kill one
      const terminals = getAllTerminals();
      killTerminal(terminals[0].id);
      expect(getTerminalCount()).toBe(1);
    });
  });

  describe('Terminal Environment', () => {
    it('should set TERM environment variable', async () => {
      await startTerminal({ cwd: '/test/path' });

      const spawnOptions = vi.mocked(pty.spawn).mock.calls[0][2];
      expect(spawnOptions?.env?.TERM).toBe('xterm-256color');
    });

    it('should enable color support', async () => {
      await startTerminal({ cwd: '/test/path' });

      const spawnOptions = vi.mocked(pty.spawn).mock.calls[0][2];
      expect(spawnOptions?.env?.FORCE_COLOR).toBe('1');
      expect(spawnOptions?.env?.COLORTERM).toBe('truecolor');
    });

    it('should use conpty on Windows', async () => {
      await startTerminal({ cwd: '/test/path' });

      const spawnOptions = vi.mocked(pty.spawn).mock.calls[0][2] as { useConpty?: boolean };
      expect(spawnOptions?.useConpty).toBe(true);
    });
  });

  // ============================================================================
  // SECURITY TESTS - Command Injection Prevention
  // ============================================================================

  describe('Security: Command Injection Prevention', () => {
    describe('Session ID Validation', () => {
      it('should accept valid UUID session IDs', async () => {
        const result = await startTerminal({
          cwd: '/test/path',
          resumeSessionId: '550e8400-e29b-41d4-a716-446655440000',
        });

        expect(result.error).toBeUndefined();
        expect(pty.spawn).toHaveBeenCalled();
      });

      it('should accept valid alphanumeric session IDs', async () => {
        const result = await startTerminal({
          cwd: '/test/path',
          resumeSessionId: 'session-abc123-def456',
        });

        expect(result.error).toBeUndefined();
        expect(pty.spawn).toHaveBeenCalled();
      });

      it('should reject session IDs with shell metacharacters - semicolon', async () => {
        const result = await startTerminal({
          cwd: '/test/path',
          resumeSessionId: 'valid-id; rm -rf /',
        });

        expect(result.error).toBe('Invalid session ID format');
        expect(pty.spawn).not.toHaveBeenCalled();
      });

      it('should reject session IDs with pipe operator', async () => {
        const result = await startTerminal({
          cwd: '/test/path',
          resumeSessionId: 'id | cat /etc/passwd',
        });

        expect(result.error).toBe('Invalid session ID format');
        expect(pty.spawn).not.toHaveBeenCalled();
      });

      it('should reject session IDs with command substitution', async () => {
        const result = await startTerminal({
          cwd: '/test/path',
          resumeSessionId: '$(whoami)',
        });

        expect(result.error).toBe('Invalid session ID format');
        expect(pty.spawn).not.toHaveBeenCalled();
      });

      it('should reject session IDs with backtick substitution', async () => {
        const result = await startTerminal({
          cwd: '/test/path',
          resumeSessionId: '`id`',
        });

        expect(result.error).toBe('Invalid session ID format');
        expect(pty.spawn).not.toHaveBeenCalled();
      });

      it('should reject session IDs with ampersand', async () => {
        const result = await startTerminal({
          cwd: '/test/path',
          resumeSessionId: 'id && cat /etc/shadow',
        });

        expect(result.error).toBe('Invalid session ID format');
        expect(pty.spawn).not.toHaveBeenCalled();
      });

      it('should reject excessively long session IDs', async () => {
        const result = await startTerminal({
          cwd: '/test/path',
          resumeSessionId: 'a'.repeat(200), // Over 128 char limit
        });

        expect(result.error).toBe('Invalid session ID format');
        expect(pty.spawn).not.toHaveBeenCalled();
      });

      it('should reject session IDs with newlines', async () => {
        const result = await startTerminal({
          cwd: '/test/path',
          resumeSessionId: 'id\nmalicious-command',
        });

        expect(result.error).toBe('Invalid session ID format');
        expect(pty.spawn).not.toHaveBeenCalled();
      });
    });

    describe('Working Directory Validation', () => {
      it('should reject cwd with semicolon injection', async () => {
        const result = await startTerminal({
          cwd: '/tmp; rm -rf /',
        });

        expect(result.error).toBe('Invalid working directory path');
        expect(pty.spawn).not.toHaveBeenCalled();
      });

      it('should reject cwd with pipe injection', async () => {
        const result = await startTerminal({
          cwd: '/tmp | cat /etc/passwd',
        });

        expect(result.error).toBe('Invalid working directory path');
        expect(pty.spawn).not.toHaveBeenCalled();
      });

      it('should reject cwd with command substitution', async () => {
        const result = await startTerminal({
          cwd: '/$(whoami)',
        });

        expect(result.error).toBe('Invalid working directory path');
        expect(pty.spawn).not.toHaveBeenCalled();
      });

      it('should reject cwd with backtick substitution', async () => {
        const result = await startTerminal({
          cwd: '/`id`',
        });

        expect(result.error).toBe('Invalid working directory path');
        expect(pty.spawn).not.toHaveBeenCalled();
      });
    });
  });
});
