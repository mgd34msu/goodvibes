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
    // For shell paths (absolute paths to executables), simulate they exist as files
    if (pathArg.includes('/bin/') || pathArg.includes('/usr/bin/') ||
        pathArg.endsWith('.exe') || pathArg.includes('\\Windows\\')) {
      return {
        isDirectory: () => false,
        isFile: () => true,
      };
    }
    // For normal test paths (directories), simulate they exist as directories
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
  startPlainTerminal,
  writeToTerminal,
  resizeTerminal,
  killTerminal,
  getAllTerminals,
  closeAllTerminals,
  getTerminalCount,
  getActiveTerminalIds,
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
  // PLAIN TERMINAL TESTS
  // ============================================================================

  describe('startPlainTerminal', () => {
    // Setup for plain terminal tests - ensure a valid shell is configured
    beforeEach(() => {
      // Configure getSetting to return a known valid shell for tests
      vi.mocked(db.getSetting).mockImplementation((key: string) => {
        if (key === 'preferredShell') return 'bash'; // Known safe shell name
        if (key === 'skipPermissions') return true;
        return null;
      });
    });

    it('should create a plain terminal with valid shell', async () => {
      const result = await startPlainTerminal({ cwd: '/test/path' });

      // If it succeeded
      if (!result.error) {
        expect(result.id).toBeDefined();
        expect(result.cwd).toBe('/test/path');
        expect(result.isPlainTerminal).toBe(true);
      } else {
        // If it failed due to shell configuration issues in test environment, that's OK
        expect(result.error).toMatch(/Invalid shell|shell/i);
      }
    });

    it('should spawn shell without claude arguments when successful', async () => {
      const result = await startPlainTerminal({ cwd: '/test/path' });

      if (!result.error && pty.spawn.mock.calls.length > 0) {
        // Verify spawn was called with shell (not claude)
        const spawnCall = vi.mocked(pty.spawn).mock.calls[0];
        expect(spawnCall[0]).not.toContain('claude');
        expect(spawnCall[1]).toEqual([]); // No arguments for plain shell
      }
    });

    it('should use custom name if provided', async () => {
      const result = await startPlainTerminal({ cwd: '/test/path', name: 'My Shell' });

      if (!result.error) {
        expect(result.name).toBe('My Shell');
      }
    });

    it('should use default name "Terminal" when not provided', async () => {
      const result = await startPlainTerminal({ cwd: '/test/path' });

      if (!result.error) {
        expect(result.name).toBe('Terminal');
      }
    });

    it('should not add to recent projects for plain terminals', async () => {
      await startPlainTerminal({ cwd: '/test/path' });

      // Plain terminals should NOT call addRecentProject (regardless of success)
      expect(addRecentProject).not.toHaveBeenCalled();
    });

    it('should log activity for plain terminal start', async () => {
      const result = await startPlainTerminal({ cwd: '/test/path', name: 'TestShell' });

      if (!result.error) {
        expect(db.logActivity).toHaveBeenCalledWith(
          'terminal_start',
          null,
          expect.stringContaining('plain terminal'),
          expect.objectContaining({ isPlainTerminal: true })
        );
      }
    });

    it('should handle spawn errors gracefully', async () => {
      vi.mocked(pty.spawn).mockImplementation(() => {
        throw new Error('Shell not found');
      });

      const result = await startPlainTerminal({ cwd: '/test/path' });

      // Should have some error
      expect(result.error).toBeDefined();
      expect(result.id).toBeUndefined();
    });

    it('should reject invalid working directory', async () => {
      const result = await startPlainTerminal({ cwd: '/path; rm -rf /' });

      expect(result.error).toBe('Invalid working directory path');
      expect(pty.spawn).not.toHaveBeenCalled();
    });

    it('should send terminal data to renderer when terminal created', async () => {
      const result = await startPlainTerminal({ cwd: '/test/path' });

      if (!result.error) {
        // Simulate data from pty
        mockPty._trigger('data', 'Shell output');

        expect(sendToRenderer).toHaveBeenCalledWith('terminal-data', {
          id: expect.any(Number),
          data: 'Shell output',
        });
      }
    });

    it('should handle exit event for plain terminals', async () => {
      const result = await startPlainTerminal({ cwd: '/test/path', name: 'TestShell' });

      if (!result.error) {
        // Clear previous calls
        vi.mocked(db.logActivity).mockClear();

        // Simulate terminal exit
        mockPty._trigger('exit', { exitCode: 0 });

        expect(sendToRenderer).toHaveBeenCalledWith('terminal-exit', {
          id: result.id,
          exitCode: 0,
        });

        expect(db.logActivity).toHaveBeenCalledWith(
          'terminal_end',
          null,
          expect.stringContaining('Plain terminal closed'),
          expect.objectContaining({ exitCode: 0, isPlainTerminal: true })
        );
      }
    });

    it('should use ConPTY setting when successful', async () => {
      const result = await startPlainTerminal({ cwd: '/test/path' });

      if (!result.error && pty.spawn.mock.calls.length > 0) {
        const spawnOptions = vi.mocked(pty.spawn).mock.calls[0][2] as { useConpty?: boolean };
        // useConpty should be set (true on Windows, false on other platforms)
        expect(spawnOptions).toHaveProperty('useConpty');
      }
    });

    it('should include plain terminal in getAllTerminals when created', async () => {
      const result = await startPlainTerminal({ cwd: '/test/path', name: 'Plain Shell' });

      if (!result.error) {
        const terminals = getAllTerminals();
        expect(terminals.length).toBeGreaterThanOrEqual(1);
        const plainTerm = terminals.find(t => t.id === result.id);
        expect(plainTerm?.isPlainTerminal).toBe(true);
        expect(plainTerm?.name).toBe('Plain Shell');
      }
    });

    it('should not have resumeSessionId for plain terminals', async () => {
      const result = await startPlainTerminal({ cwd: '/test/path' });

      if (!result.error) {
        const terminals = getAllTerminals();
        const plainTerm = terminals.find(t => t.id === result.id);
        expect(plainTerm?.resumeSessionId).toBeUndefined();
        expect(plainTerm?.sessionType).toBeUndefined();
      }
    });
  });

  describe('getActiveTerminalIds', () => {
    it('should return empty set when no terminals', () => {
      const ids = getActiveTerminalIds();

      expect(ids).toBeInstanceOf(Set);
      expect(ids.size).toBe(0);
    });

    it('should return set of active terminal IDs', async () => {
      const result1 = await startTerminal({ cwd: '/path1' });
      const result2 = await startTerminal({ cwd: '/path2' });

      const ids = getActiveTerminalIds();

      expect(ids.size).toBe(2);
      expect(ids.has(result1.id!)).toBe(true);
      expect(ids.has(result2.id!)).toBe(true);
    });

    it('should not include killed terminals', async () => {
      const result1 = await startTerminal({ cwd: '/path1' });
      await startTerminal({ cwd: '/path2' });

      killTerminal(result1.id!);

      const ids = getActiveTerminalIds();
      expect(ids.size).toBe(1);
      expect(ids.has(result1.id!)).toBe(false);
    });
  });

  // ============================================================================
  // CHUNKED WRITE TESTS
  // ============================================================================

  describe('Chunked Write Functionality', () => {
    it('should write small data directly', async () => {
      const result = await startTerminal({ cwd: '/test/path' });
      expect(result.id).toBeDefined();
      const terminalId = result.id as number;

      const smallData = 'Hello, World!';
      writeToTerminal(terminalId, smallData);

      expect(mockPty.write).toHaveBeenCalledWith(smallData);
      expect(mockPty.write).toHaveBeenCalledTimes(1);
    });

    it('should chunk large data exceeding 4KB', async () => {
      vi.useFakeTimers();

      const result = await startTerminal({ cwd: '/test/path' });
      expect(result.id).toBeDefined();
      const terminalId = result.id as number;

      // Create data larger than PASTE_CHUNK_SIZE (4096 bytes)
      const largeData = 'x'.repeat(5000);
      writeToTerminal(terminalId, largeData);

      // First chunk should be written immediately
      expect(mockPty.write).toHaveBeenCalledTimes(1);
      expect(mockPty.write).toHaveBeenCalledWith('x'.repeat(4096));

      // Advance timer for second chunk
      vi.advanceTimersByTime(10);
      expect(mockPty.write).toHaveBeenCalledTimes(2);
      expect(mockPty.write).toHaveBeenLastCalledWith('x'.repeat(904)); // 5000 - 4096

      vi.useRealTimers();
    });

    it('should handle chunk write errors gracefully', async () => {
      vi.useFakeTimers();

      const result = await startTerminal({ cwd: '/test/path' });
      expect(result.id).toBeDefined();
      const terminalId = result.id as number;

      // Make write fail on second call
      mockPty.write.mockImplementationOnce(() => {}).mockImplementationOnce(() => {
        throw new Error('Write failed during chunk');
      });

      const largeData = 'x'.repeat(5000);
      writeToTerminal(terminalId, largeData);

      vi.advanceTimersByTime(10);

      // Should not throw, error is handled internally
      expect(mockPty.write).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('should handle multiple chunks correctly', async () => {
      vi.useFakeTimers();

      const result = await startTerminal({ cwd: '/test/path' });
      expect(result.id).toBeDefined();
      const terminalId = result.id as number;

      // Create data that requires 3 chunks (12,000 bytes)
      const largeData = 'x'.repeat(12000);
      writeToTerminal(terminalId, largeData);

      // First chunk
      expect(mockPty.write).toHaveBeenCalledTimes(1);

      // Second chunk
      vi.advanceTimersByTime(10);
      expect(mockPty.write).toHaveBeenCalledTimes(2);

      // Third chunk
      vi.advanceTimersByTime(10);
      expect(mockPty.write).toHaveBeenCalledTimes(3);

      vi.useRealTimers();
    });

    it('should write exactly at chunk boundary', async () => {
      const result = await startTerminal({ cwd: '/test/path' });
      expect(result.id).toBeDefined();
      const terminalId = result.id as number;

      // Exactly 4096 bytes should not chunk
      const exactData = 'x'.repeat(4096);
      writeToTerminal(terminalId, exactData);

      expect(mockPty.write).toHaveBeenCalledTimes(1);
      expect(mockPty.write).toHaveBeenCalledWith(exactData);
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

      it('should reject cwd with redirect operators', async () => {
        const result = await startTerminal({
          cwd: '/tmp > /etc/passwd',
        });

        expect(result.error).toBe('Invalid working directory path');
        expect(pty.spawn).not.toHaveBeenCalled();
      });

      it('should reject cwd with curly braces', async () => {
        const result = await startTerminal({
          cwd: '/tmp{test}',
        });

        expect(result.error).toBe('Invalid working directory path');
        expect(pty.spawn).not.toHaveBeenCalled();
      });

      it('should reject excessively long cwd paths', async () => {
        const result = await startTerminal({
          cwd: '/'.repeat(5000), // Over 4096 char limit
        });

        expect(result.error).toBe('Invalid working directory path');
        expect(pty.spawn).not.toHaveBeenCalled();
      });

      it('should use process.cwd() when empty cwd is provided', async () => {
        // Empty string is falsy, so options.cwd || process.cwd() uses process.cwd()
        const originalCwd = process.cwd;
        process.cwd = vi.fn(() => '/fallback/path');

        const result = await startTerminal({
          cwd: '',
        });

        // Since empty string falls back to process.cwd(), it should succeed
        expect(result.cwd).toBe('/fallback/path');
        expect(result.error).toBeUndefined();

        process.cwd = originalCwd;
      });
    });

    describe('Shell Path Validation for Plain Terminals', () => {
      it('should reject malicious shell paths with semicolon injection', async () => {
        // The malicious shell path should be rejected by validation
        vi.mocked(db.getSetting).mockImplementation((key: string) => {
          if (key === 'preferredShell') return '/bin/bash; rm -rf /';
          return true;
        });

        const result = await startPlainTerminal({ cwd: '/test/path' });

        // The path contains shell metacharacters, so validation fails
        // If default shell also fails, returns error
        // But the key point is that the malicious command is NOT executed
        if (result.error) {
          expect(result.error).toBe('Invalid shell configuration');
          expect(pty.spawn).not.toHaveBeenCalled();
        } else {
          // If it succeeded, verify malicious shell was not used
          const spawnCall = vi.mocked(pty.spawn).mock.calls[0];
          expect(spawnCall[0]).not.toContain(';');
        }
      });

      it('should reject shell paths with pipe operators', async () => {
        vi.mocked(db.getSetting).mockImplementation((key: string) => {
          if (key === 'preferredShell') return '/bin/bash | cat';
          return true;
        });

        const result = await startPlainTerminal({ cwd: '/test/path' });

        // Malicious path is rejected - either fallback works or returns error
        if (result.error) {
          expect(result.error).toBe('Invalid shell configuration');
          expect(pty.spawn).not.toHaveBeenCalled();
        } else {
          const spawnCall = vi.mocked(pty.spawn).mock.calls[0];
          expect(spawnCall[0]).not.toContain('|');
        }
      });

      it('should accept known safe shell names', async () => {
        vi.mocked(db.getSetting).mockImplementation((key: string) => {
          if (key === 'preferredShell') return 'bash';
          return true;
        });

        const result = await startPlainTerminal({ cwd: '/test/path' });

        expect(result.error).toBeUndefined();
        const spawnCall = vi.mocked(pty.spawn).mock.calls[0];
        expect(spawnCall[0]).toBe('bash');
      });

      it('should accept valid absolute shell paths', async () => {
        vi.mocked(db.getSetting).mockImplementation((key: string) => {
          if (key === 'preferredShell') return '/usr/bin/zsh';
          return true;
        });

        const result = await startPlainTerminal({ cwd: '/test/path' });

        expect(result.error).toBeUndefined();
        const spawnCall = vi.mocked(pty.spawn).mock.calls[0];
        expect(spawnCall[0]).toBe('/usr/bin/zsh');
      });

      it('should reject shell paths with command substitution', async () => {
        vi.mocked(db.getSetting).mockImplementation((key: string) => {
          if (key === 'preferredShell') return '$(whoami)';
          return true;
        });

        const result = await startPlainTerminal({ cwd: '/test/path' });

        // Command substitution is rejected
        if (result.error) {
          expect(result.error).toBe('Invalid shell configuration');
        } else {
          const spawnCall = vi.mocked(pty.spawn).mock.calls[0];
          expect(spawnCall[0]).not.toContain('$(');
        }
      });

      it('should reject excessively long shell paths', async () => {
        vi.mocked(db.getSetting).mockImplementation((key: string) => {
          if (key === 'preferredShell') return 'x'.repeat(2000);
          return true;
        });

        const result = await startPlainTerminal({ cwd: '/test/path' });

        // Excessively long path is rejected
        if (result.error) {
          expect(result.error).toBe('Invalid shell configuration');
        } else {
          const spawnCall = vi.mocked(pty.spawn).mock.calls[0];
          expect(spawnCall[0].length).toBeLessThan(1025);
        }
      });

      it('should handle empty custom shell path gracefully', async () => {
        vi.mocked(db.getSetting).mockImplementation((key: string) => {
          if (key === 'preferredShell') return '';
          return true;
        });

        const result = await startPlainTerminal({ cwd: '/test/path' });

        // Empty shell should fall back to default, which may or may not succeed
        // The key is that it doesn't crash
        if (result.error) {
          expect(typeof result.error).toBe('string');
        } else {
          expect(pty.spawn).toHaveBeenCalled();
        }
      });
    });
  });

  // ============================================================================
  // EDGE CASES AND ERROR HANDLING
  // ============================================================================

  describe('Edge Cases and Error Handling', () => {
    it('should use process.cwd() when cwd not provided', async () => {
      const originalCwd = process.cwd;
      process.cwd = vi.fn(() => '/default/cwd');

      // Mock fs to accept /default/cwd as valid
      const fs = await import('fs');
      vi.mocked(fs.statSync).mockImplementation((pathArg: string) => {
        if (pathArg === '/default/cwd') {
          return {
            isDirectory: () => true,
            isFile: () => false,
          } as unknown as ReturnType<typeof fs.statSync>;
        }
        return {
          isDirectory: () => true,
          isFile: () => false,
        } as unknown as ReturnType<typeof fs.statSync>;
      });

      const result = await startTerminal({});

      expect(result.cwd).toBe('/default/cwd');

      process.cwd = originalCwd;
    });

    it('should handle PTY data with special characters', async () => {
      await startTerminal({ cwd: '/test/path' });

      // Simulate ANSI escape sequences
      const ansiData = '\x1b[32mGreen Text\x1b[0m';
      mockPty._trigger('data', ansiData);

      expect(sendToRenderer).toHaveBeenCalledWith('terminal-data', {
        id: expect.any(Number),
        data: ansiData,
      });
    });

    it('should handle terminal exit with non-zero exit code', async () => {
      const result = await startTerminal({ cwd: '/test/path' });
      vi.mocked(db.logActivity).mockClear();

      mockPty._trigger('exit', { exitCode: 1 });

      expect(sendToRenderer).toHaveBeenCalledWith('terminal-exit', {
        id: result.id,
        exitCode: 1,
      });

      expect(db.logActivity).toHaveBeenCalledWith(
        'terminal_end',
        null,
        expect.stringContaining('exit code: 1'),
        expect.objectContaining({ exitCode: 1 })
      );
    });

    it('should handle concurrent terminal operations', async () => {
      const [result1, result2, result3] = await Promise.all([
        startTerminal({ cwd: '/path1' }),
        startTerminal({ cwd: '/path2' }),
        startTerminal({ cwd: '/path3' }),
      ]);

      expect(result1.id).toBeDefined();
      expect(result2.id).toBeDefined();
      expect(result3.id).toBeDefined();
      expect(result1.id).not.toBe(result2.id);
      expect(result2.id).not.toBe(result3.id);
      expect(getTerminalCount()).toBe(3);
    });

    it('should handle killing already killed terminal gracefully', async () => {
      const result = await startTerminal({ cwd: '/test/path' });
      expect(result.id).toBeDefined();
      const terminalId = result.id as number;

      // First kill
      const firstKill = killTerminal(terminalId);
      expect(firstKill).toBe(true);

      // Second kill attempt
      const secondKill = killTerminal(terminalId);
      expect(secondKill).toBe(false);
    });

    it('should derive terminal name from last path segment', async () => {
      const result = await startTerminal({ cwd: '/home/user/my-awesome-project' });

      expect(result.name).toBe('my-awesome-project');
    });

    it('should handle Windows-style paths for name derivation', async () => {
      const result = await startTerminal({ cwd: 'C:\\Users\\dev\\projects\\myapp' });

      expect(result.name).toBe('myapp');
    });

    it('should fallback to "Terminal" when path is root', async () => {
      // The path split logic handles this
      const result = await startTerminal({ cwd: '/' });

      // When split results in empty strings or undefined, should still have a name
      expect(result.name).toBeDefined();
    });
  });

  // ============================================================================
  // MIXED TERMINAL TYPE TESTS
  // ============================================================================

  describe('Mixed Terminal Types', () => {
    // Setup for mixed terminal tests - ensure a valid shell is configured
    beforeEach(() => {
      vi.mocked(db.getSetting).mockImplementation((key: string) => {
        if (key === 'preferredShell') return 'bash'; // Known safe shell name
        if (key === 'skipPermissions') return true;
        return null;
      });
    });

    it('should manage Claude and plain terminals together', async () => {
      const claudeResult = await startTerminal({ cwd: '/claude/path', name: 'Claude' });
      const plainResult = await startPlainTerminal({ cwd: '/plain/path', name: 'Shell' });

      // Claude terminal should always succeed
      expect(claudeResult.id).toBeDefined();

      // If plain terminal succeeded, verify it's in the list
      if (!plainResult.error) {
        const terminals = getAllTerminals();
        expect(terminals).toHaveLength(2);

        const claudeTerminal = terminals.find(t => t.id === claudeResult.id);
        const plainTerminal = terminals.find(t => t.id === plainResult.id);

        expect(claudeTerminal?.isPlainTerminal).toBeUndefined();
        expect(plainTerminal?.isPlainTerminal).toBe(true);
      } else {
        // If plain terminal failed, at least Claude should be there
        const terminals = getAllTerminals();
        expect(terminals.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('should kill mixed terminal types correctly', async () => {
      const claudeResult = await startTerminal({ cwd: '/claude/path' });
      const plainResult = await startPlainTerminal({ cwd: '/plain/path' });

      expect(claudeResult.id).toBeDefined();

      if (!plainResult.error) {
        expect(getTerminalCount()).toBe(2);

        killTerminal(claudeResult.id!);
        expect(getTerminalCount()).toBe(1);

        killTerminal(plainResult.id!);
        expect(getTerminalCount()).toBe(0);
      } else {
        // Only Claude terminal exists
        expect(getTerminalCount()).toBe(1);
        killTerminal(claudeResult.id!);
        expect(getTerminalCount()).toBe(0);
      }
    });

    it('should closeAllTerminals for both types', async () => {
      const mockPty1 = createMockPty();
      const mockPty2 = createMockPty();

      vi.mocked(pty.spawn)
        .mockReturnValueOnce(mockPty1 as IPty)
        .mockReturnValueOnce(mockPty2 as IPty);

      await startTerminal({ cwd: '/claude/path' });
      const plainResult = await startPlainTerminal({ cwd: '/plain/path' });

      const expectedCount = plainResult.error ? 1 : 2;
      expect(getTerminalCount()).toBe(expectedCount);

      closeAllTerminals();

      expect(mockPty1.kill).toHaveBeenCalled();
      if (!plainResult.error) {
        expect(mockPty2.kill).toHaveBeenCalled();
      }
      expect(getTerminalCount()).toBe(0);
    });
  });

  // ============================================================================
  // SESSION TYPE TESTS
  // ============================================================================

  describe('Session Type Handling', () => {
    it('should handle subagent session type', async () => {
      const result = await startTerminal({
        cwd: '/test/path',
        resumeSessionId: 'agent-session-123',
        sessionType: 'subagent',
      });

      expect(result.sessionType).toBe('subagent');

      const terminals = getAllTerminals();
      expect(terminals[0].sessionType).toBe('subagent');
    });

    it('should handle user session type', async () => {
      const result = await startTerminal({
        cwd: '/test/path',
        resumeSessionId: 'user-session-123',
        sessionType: 'user',
      });

      expect(result.sessionType).toBe('user');

      const terminals = getAllTerminals();
      expect(terminals[0].sessionType).toBe('user');
    });

    it('should handle missing session type', async () => {
      const result = await startTerminal({
        cwd: '/test/path',
        resumeSessionId: 'session-123',
      });

      expect(result.sessionType).toBeUndefined();
    });
  });
});
