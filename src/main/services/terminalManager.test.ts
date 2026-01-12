// ============================================================================
// TERMINAL MANAGER TESTS
// ============================================================================
//
// These tests verify the TerminalManager service functionality.
// Uses mocked node-pty to test terminal creation and management.
// ============================================================================

/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-non-null-assertion */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

function createMockPty() {
  const listeners: { [event: string]: ((...args: any[]) => void)[] } = {};

  return {
    pid: 12345,
    cols: 80,
    rows: 24,
    onData: vi.fn((callback) => {
      listeners['data'] = listeners['data'] || [];
      listeners['data'].push(callback);
      return { dispose: vi.fn() };
    }),
    onExit: vi.fn((callback) => {
      listeners['exit'] = listeners['exit'] || [];
      listeners['exit'].push(callback);
      return { dispose: vi.fn() };
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    // Helper to trigger events in tests
    _trigger: (event: string, ...args: any[]) => {
      listeners[event]?.forEach(cb => cb(...args));
    },
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('TerminalManager Service', () => {
  let mockPty: ReturnType<typeof createMockPty>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPty = createMockPty();
    vi.mocked(pty.spawn).mockReturnValue(mockPty as any);
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

      writeToTerminal(result.id!, 'test input');

      expect(mockPty.write).toHaveBeenCalledWith('test input');
    });

    it('should not throw for non-existent terminal', () => {
      expect(() => writeToTerminal(99999, 'test')).not.toThrow();
    });

    it('should handle write errors gracefully', async () => {
      const result = await startTerminal({ cwd: '/test/path' });
      mockPty.write.mockImplementation(() => {
        throw new Error('Write failed');
      });

      expect(() => writeToTerminal(result.id!, 'test')).not.toThrow();
    });
  });

  describe('resizeTerminal', () => {
    it('should resize terminal', async () => {
      const result = await startTerminal({ cwd: '/test/path' });

      resizeTerminal(result.id!, 120, 40);

      expect(mockPty.resize).toHaveBeenCalledWith(120, 40);
    });

    it('should not throw for non-existent terminal', () => {
      expect(() => resizeTerminal(99999, 120, 40)).not.toThrow();
    });

    it('should handle resize errors gracefully', async () => {
      const result = await startTerminal({ cwd: '/test/path' });
      mockPty.resize.mockImplementation(() => {
        throw new Error('Resize failed');
      });

      expect(() => resizeTerminal(result.id!, 120, 40)).not.toThrow();
    });
  });

  describe('killTerminal', () => {
    it('should kill terminal and return true', async () => {
      const result = await startTerminal({ cwd: '/test/path' });

      const killed = killTerminal(result.id!);

      expect(killed).toBe(true);
      expect(mockPty.kill).toHaveBeenCalled();
    });

    it('should return false for non-existent terminal', () => {
      const killed = killTerminal(99999);

      expect(killed).toBe(false);
    });

    it('should remove terminal from list after killing', async () => {
      const result = await startTerminal({ cwd: '/test/path' });
      const initialCount = getTerminalCount();

      killTerminal(result.id!);

      expect(getTerminalCount()).toBe(initialCount - 1);
    });

    it('should handle kill errors gracefully', async () => {
      const result = await startTerminal({ cwd: '/test/path' });
      mockPty.kill.mockImplementation(() => {
        throw new Error('Kill failed');
      });

      // Should return false when kill fails
      expect(killTerminal(result.id!)).toBe(false);
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
        .mockReturnValueOnce(mockPty1 as any)
        .mockReturnValueOnce(mockPty2 as any);

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
});
