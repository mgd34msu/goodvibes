// ============================================================================
// MCP MANAGER SERVICE TESTS
// ============================================================================
//
// These tests verify the MCPManager service functionality for managing
// Model Context Protocol (MCP) servers. Tests use mocked dependencies
// to isolate the service behavior from database and filesystem operations.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

// ============================================================================
// MOCKS
// ============================================================================

// Mock child_process spawn - needs to be a factory function
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  const mockSpawn = vi.fn();
  return {
    ...actual,
    default: {
      ...actual,
      spawn: mockSpawn,
    },
    spawn: mockSpawn,
  };
});

// Mock fs/promises
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  const mockReadFile = vi.fn();
  const mockWriteFile = vi.fn();
  return {
    ...actual,
    default: {
      ...actual,
      readFile: mockReadFile,
      writeFile: mockWriteFile,
    },
    readFile: mockReadFile,
    writeFile: mockWriteFile,
  };
});

// Mock fs (sync)
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  const mockExistsSync = vi.fn();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: mockExistsSync,
    },
    existsSync: mockExistsSync,
  };
});

// Mock path - use real path module but override join
vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  const mockJoin = (...args: string[]) => args.join('/');
  return {
    ...actual,
    default: {
      ...actual,
      join: mockJoin,
    },
    join: mockJoin,
  };
});

// Mock os
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  const mockHomedir = () => '/home/testuser';
  return {
    ...actual,
    default: {
      ...actual,
      homedir: mockHomedir,
    },
    homedir: mockHomedir,
  };
});

// Import MCPServer type for test fixtures
import type { MCPServer } from '../database/primitives.js';

// Mock database primitives
const mockMCPServer: MCPServer = {
  id: 1,
  name: 'Test Server',
  description: 'A test MCP server',
  transport: 'stdio' as const,
  command: 'npx',
  url: null,
  args: ['@test/mcp-server'],
  env: { TEST_KEY: 'test_value' },
  scope: 'user' as const,
  projectPath: null,
  enabled: true,
  status: 'disconnected' as const,
  lastConnected: null,
  errorMessage: null,
  toolCount: 0,
  createdAt: '2024-01-15T10:00:00Z',
  updatedAt: '2024-01-15T10:00:00Z',
};

vi.mock('../database/primitives.js', () => ({
  createMCPServer: vi.fn((config: Partial<MCPServer>) => ({
    id: 1,
    ...config,
    status: 'disconnected',
    lastConnected: null,
    errorMessage: null,
    toolCount: 0,
    createdAt: '2024-01-15T10:00:00Z',
    updatedAt: '2024-01-15T10:00:00Z',
  })),
  getMCPServer: vi.fn(),
  getAllMCPServers: vi.fn(() => []),
  updateMCPServer: vi.fn(),
  updateMCPServerStatus: vi.fn(),
  deleteMCPServer: vi.fn(),
}));

// Mock logger
vi.mock('./logger.js', () => ({
  Logger: class MockLogger {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
  },
}));

// Mock inputSanitizer - must be defined before imports use it
vi.mock('./inputSanitizer.js', () => ({
  validateCommandName: vi.fn((command: string) => {
    // Simulate real validation behavior
    if (!command || typeof command !== 'string') {
      return { valid: false, error: 'Command must be a non-empty string' };
    }
    const trimmed = command.trim();
    if (trimmed.length === 0) {
      return { valid: false, error: 'Command cannot be empty' };
    }
    // Path traversal check
    if (/\.\.[/\\]/.test(trimmed)) {
      return { valid: false, error: 'Command contains path traversal characters' };
    }
    // Valid command pattern - alphanumeric, dots, hyphens, underscores, path separators
    if (!/^[\w.\-/\\:]+$/.test(trimmed)) {
      return { valid: false, error: 'Command contains invalid characters' };
    }
    return { valid: true, sanitized: trimmed };
  }),
  validateCommandArguments: vi.fn((args: string[]) => {
    if (!Array.isArray(args)) {
      return { valid: false, error: 'Arguments must be an array' };
    }
    const shellMetacharacters = /[;&|`$(){}[\]<>!\n\r\\'"]/;
    const cmdSubstitution = /\$\(|\$\{|`/;
    for (let i = 0; i < args.length; i++) {
      const arg = String(args[i]);
      if (shellMetacharacters.test(arg)) {
        return { valid: false, error: `Invalid argument at index ${i}: Argument contains potentially dangerous characters` };
      }
      if (cmdSubstitution.test(arg)) {
        return { valid: false, error: `Invalid argument at index ${i}: Argument contains command substitution pattern` };
      }
    }
    return { valid: true };
  }),
  validatePath: vi.fn((pathStr: string) => {
    if (!pathStr || typeof pathStr !== 'string') {
      return { valid: false, error: 'Path must be a non-empty string' };
    }
    const trimmed = pathStr.trim();
    if (trimmed.includes('\0')) {
      return { valid: false, error: 'Path contains null byte' };
    }
    if (/\.\.[/\\]/.test(trimmed)) {
      return { valid: false, error: 'Path contains directory traversal' };
    }
    return { valid: true, sanitized: trimmed };
  }),
  validateEnvironment: vi.fn((env: Record<string, string>) => {
    if (!env || typeof env !== 'object') {
      return { valid: false, error: 'Environment must be an object' };
    }
    const cmdSubstitution = /\$\(|\$\{|`/;
    for (const [name, value] of Object.entries(env)) {
      // Env var names should start with letter or underscore
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        return { valid: false, error: `Invalid env var name '${name}': Invalid environment variable name format` };
      }
      if (cmdSubstitution.test(String(value))) {
        return { valid: false, error: `Invalid env var value for '${name}': Value contains command substitution pattern` };
      }
    }
    return { valid: true };
  }),
  logSecurityEvent: vi.fn(),
}));

// Import after mocks are set up
import { spawn } from 'child_process';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import {
  getMCPManager,
  shutdownMCPManager,
  MCPManagerService,
  type MCPServerConfig,
} from './mcpManager.js';
import * as primitives from '../database/primitives.js';

// ============================================================================
// TEST HELPERS
// ============================================================================

// Create a mock child process factory
function createMockChildProcess() {
  return {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { write: vi.fn(), end: vi.fn() },
    kill: vi.fn(),
    on: vi.fn(),
    pid: 12345,
  };
}

// Current mock child process - reset between tests
let mockChildProcess = createMockChildProcess();

function createMockServer(overrides: Partial<MCPServer> = {}): MCPServer {
  return { ...mockMCPServer, ...overrides };
}

function resetMocks(): void {
  vi.clearAllMocks();
  mockChildProcess = createMockChildProcess();
  // Set up spawn mock to return the fresh mockChildProcess
  vi.mocked(spawn).mockReturnValue(mockChildProcess as unknown as ChildProcess);
}

// ============================================================================
// TESTS
// ============================================================================

describe('MCPManager Service', () => {
  let manager: MCPManagerService;

  beforeEach(() => {
    resetMocks();
    // Shutdown any existing manager to ensure clean state
    shutdownMCPManager();
    manager = getMCPManager();
  });

  afterEach(() => {
    shutdownMCPManager();
  });

  // ==========================================================================
  // SINGLETON PATTERN TESTS
  // ==========================================================================

  describe('Singleton Pattern', () => {
    it('should return the same instance on multiple calls', () => {
      const instance1 = getMCPManager();
      const instance2 = getMCPManager();
      expect(instance1).toBe(instance2);
    });

    it('should create new instance after shutdown', () => {
      const instance1 = getMCPManager();
      shutdownMCPManager();
      const instance2 = getMCPManager();
      expect(instance1).not.toBe(instance2);
    });

    it('should be an EventEmitter', () => {
      expect(manager).toBeInstanceOf(EventEmitter);
    });

    it('should have max listeners set to 50', () => {
      expect(manager.getMaxListeners()).toBe(50);
    });
  });

  // ==========================================================================
  // SERVER MANAGEMENT TESTS
  // ==========================================================================

  describe('Server Management', () => {
    describe('addServer', () => {
      it('should add a stdio server with minimal config', () => {
        const config: MCPServerConfig = {
          name: 'New Server',
          transport: 'stdio',
          command: 'npx',
        };

        const result = manager.addServer(config);

        expect(primitives.createMCPServer).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'New Server',
            transport: 'stdio',
            command: 'npx',
            description: null,
            url: null,
            args: [],
            env: {},
            scope: 'user',
            projectPath: null,
            enabled: true,
          })
        );
        expect(result.name).toBe('New Server');
      });

      it('should add a server with full config', () => {
        const config: MCPServerConfig = {
          name: 'Full Server',
          description: 'Full configuration',
          transport: 'stdio',
          command: 'node',
          args: ['server.js', '--port', '3000'],
          env: { API_KEY: 'secret123' },
          scope: 'project',
          projectPath: '/path/to/project',
        };

        const result = manager.addServer(config);

        expect(primitives.createMCPServer).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'Full Server',
            description: 'Full configuration',
            transport: 'stdio',
            command: 'node',
            args: ['server.js', '--port', '3000'],
            env: { API_KEY: 'secret123' },
            scope: 'project',
            projectPath: '/path/to/project',
            enabled: true,
          })
        );
        expect(result).toBeDefined();
      });

      it('should add an HTTP server', () => {
        const config: MCPServerConfig = {
          name: 'HTTP Server',
          transport: 'http',
          url: 'http://localhost:3000',
        };

        manager.addServer(config);

        expect(primitives.createMCPServer).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'HTTP Server',
            transport: 'http',
            url: 'http://localhost:3000',
          })
        );
      });

      it('should emit server:added event', () => {
        const listener = vi.fn();
        manager.on('server:added', listener);

        const config: MCPServerConfig = {
          name: 'Event Test',
          transport: 'stdio',
          command: 'test',
        };

        manager.addServer(config);

        expect(listener).toHaveBeenCalledWith(expect.objectContaining({ name: 'Event Test' }));
      });
    });

    describe('getServer', () => {
      it('should return server when found', () => {
        vi.mocked(primitives.getMCPServer).mockReturnValue(mockMCPServer);

        const result = manager.getServer(1);

        expect(primitives.getMCPServer).toHaveBeenCalledWith(1);
        expect(result).toEqual(mockMCPServer);
      });

      it('should return null when not found', () => {
        vi.mocked(primitives.getMCPServer).mockReturnValue(null);

        const result = manager.getServer(999);

        expect(result).toBeNull();
      });
    });

    describe('getAllServers', () => {
      it('should return all servers with no filter', () => {
        const servers = [
          createMockServer({ id: 1, name: 'Server 1' }),
          createMockServer({ id: 2, name: 'Server 2' }),
        ];
        vi.mocked(primitives.getAllMCPServers).mockReturnValue(servers);

        const result = manager.getAllServers();

        expect(primitives.getAllMCPServers).toHaveBeenCalledWith(undefined, undefined);
        expect(result).toEqual(servers);
      });

      it('should filter by scope', () => {
        manager.getAllServers('user');

        expect(primitives.getAllMCPServers).toHaveBeenCalledWith('user', undefined);
      });

      it('should filter by scope and project path', () => {
        manager.getAllServers('project', '/path/to/project');

        expect(primitives.getAllMCPServers).toHaveBeenCalledWith('project', '/path/to/project');
      });
    });

    describe('updateServer', () => {
      it('should update server and emit event', () => {
        vi.mocked(primitives.getMCPServer).mockReturnValue(
          createMockServer({ id: 1, name: 'Updated Server' })
        );

        const listener = vi.fn();
        manager.on('server:updated', listener);

        manager.updateServer(1, { name: 'Updated Server' });

        expect(primitives.updateMCPServer).toHaveBeenCalledWith(1, { name: 'Updated Server' });
        expect(listener).toHaveBeenCalledWith(expect.objectContaining({ name: 'Updated Server' }));
      });

      it('should not emit event if server not found after update', () => {
        vi.mocked(primitives.getMCPServer).mockReturnValue(null);

        const listener = vi.fn();
        manager.on('server:updated', listener);

        manager.updateServer(999, { name: 'Not Found' });

        expect(listener).not.toHaveBeenCalled();
      });
    });

    describe('deleteServer', () => {
      it('should stop server before deleting', () => {
        vi.mocked(primitives.getMCPServer).mockReturnValue(mockMCPServer);

        const listener = vi.fn();
        manager.on('server:deleted', listener);

        manager.deleteServer(1);

        expect(primitives.deleteMCPServer).toHaveBeenCalledWith(1);
        expect(listener).toHaveBeenCalledWith(mockMCPServer);
      });

      it('should do nothing if server not found', () => {
        vi.mocked(primitives.getMCPServer).mockReturnValue(null);

        const listener = vi.fn();
        manager.on('server:deleted', listener);

        manager.deleteServer(999);

        expect(primitives.deleteMCPServer).not.toHaveBeenCalled();
        expect(listener).not.toHaveBeenCalled();
      });
    });

    describe('setServerEnabled', () => {
      it('should enable server', () => {
        vi.mocked(primitives.getMCPServer).mockReturnValue(
          createMockServer({ enabled: true })
        );

        const listener = vi.fn();
        manager.on('server:toggled', listener);

        manager.setServerEnabled(1, true);

        expect(primitives.updateMCPServer).toHaveBeenCalledWith(1, { enabled: true });
        expect(listener).toHaveBeenCalled();
      });

      it('should disable server and stop it', () => {
        vi.mocked(primitives.getMCPServer).mockReturnValue(
          createMockServer({ enabled: false })
        );

        manager.setServerEnabled(1, false);

        expect(primitives.updateMCPServer).toHaveBeenCalledWith(1, { enabled: false });
      });
    });
  });

  // ==========================================================================
  // SERVER LIFECYCLE TESTS
  // ==========================================================================

  describe('Server Lifecycle', () => {
    describe('startServer', () => {
      it('should return false if server not found', async () => {
        vi.mocked(primitives.getMCPServer).mockReturnValue(null);

        const result = await manager.startServer(999);

        expect(result).toBe(false);
      });

      it('should return false if server is disabled', async () => {
        vi.mocked(primitives.getMCPServer).mockReturnValue(
          createMockServer({ enabled: false })
        );

        const result = await manager.startServer(1);

        expect(result).toBe(false);
      });

      it('should return true if server already running', async () => {
        const server = createMockServer({ id: 1 });
        vi.mocked(primitives.getMCPServer).mockReturnValue(server);

        // First start - will trigger connection
        const startPromise = manager.startServer(1);

        // Simulate server output to mark as connected
        setTimeout(() => {
          mockChildProcess.stdout.emit('data', Buffer.from('Ready'));
        }, 10);

        await startPromise;

        // Second start should return true immediately
        const result = await manager.startServer(1);
        expect(result).toBe(true);
      });

      it('should start stdio server', async () => {
        const server = createMockServer({ transport: 'stdio', command: 'npx' });
        vi.mocked(primitives.getMCPServer).mockReturnValue(server);

        const startPromise = manager.startServer(1);

        // Simulate server output to mark as connected
        setTimeout(() => {
          mockChildProcess.stdout.emit('data', Buffer.from('Server ready'));
        }, 10);

        const result = await startPromise;

        expect(result).toBe(true);
        expect(spawn).toHaveBeenCalledWith(
          'npx',
          ['@test/mcp-server'],
          expect.objectContaining({
            env: expect.any(Object),
            stdio: ['pipe', 'pipe', 'pipe'],
          })
        );
      });

      it('should handle stdio server without command', async () => {
        const server = createMockServer({ transport: 'stdio', command: null });
        vi.mocked(primitives.getMCPServer).mockReturnValue(server);

        const result = await manager.startServer(1);

        expect(result).toBe(false);
        expect(primitives.updateMCPServerStatus).toHaveBeenCalledWith(
          1,
          'error',
          'No command specified'
        );
      });

      it('should parse JSON tools from server output', async () => {
        const server = createMockServer({ transport: 'stdio', command: 'npx' });
        vi.mocked(primitives.getMCPServer).mockReturnValue(server);

        const startPromise = manager.startServer(1);

        // Simulate JSON output with tools
        setTimeout(() => {
          const toolsJson = JSON.stringify({
            tools: [
              { name: 'read_file', description: 'Read a file' },
              { name: 'write_file', description: 'Write a file' },
            ],
          });
          mockChildProcess.stdout.emit('data', Buffer.from(toolsJson));
        }, 10);

        await startPromise;

        expect(primitives.updateMCPServer).toHaveBeenCalledWith(1, { toolCount: 2 });
      });

      it('should handle connection timeout', async () => {
        const server = createMockServer({ transport: 'stdio', command: 'npx' });
        vi.mocked(primitives.getMCPServer).mockReturnValue(server);

        vi.useFakeTimers();

        const startPromise = manager.startServer(1);

        // Fast forward past timeout
        vi.advanceTimersByTime(11000);

        const result = await startPromise;

        vi.useRealTimers();

        expect(result).toBe(false);
        expect(primitives.updateMCPServerStatus).toHaveBeenCalledWith(
          1,
          'error',
          'Connection timeout'
        );
      });

      it('should handle process error event', async () => {
        const server = createMockServer({ transport: 'stdio', command: 'npx' });
        vi.mocked(primitives.getMCPServer).mockReturnValue(server);

        const errorListener = vi.fn();
        manager.on('server:error', errorListener);

        const startPromise = manager.startServer(1);

        // Simulate error
        const mockOnHandler = mockChildProcess.on as Mock;
        const calls = mockOnHandler.mock.calls as Array<[string, (...args: unknown[]) => void]>;
        const errorCallback = calls.find((call) => call[0] === 'error')?.[1];
        if (errorCallback) {
          setTimeout(() => errorCallback(new Error('Spawn error')), 10);
        }

        const result = await startPromise;

        expect(result).toBe(false);
      });

      it('should handle process close event', async () => {
        const server = createMockServer({ transport: 'stdio', command: 'npx' });
        vi.mocked(primitives.getMCPServer).mockReturnValue(server);

        const disconnectListener = vi.fn();
        manager.on('server:disconnected', disconnectListener);

        // First connect the server
        const startPromise = manager.startServer(1);

        setTimeout(() => {
          mockChildProcess.stdout.emit('data', Buffer.from('Ready'));
        }, 10);

        await startPromise;

        // Then simulate close
        const mockOnHandler = mockChildProcess.on as Mock;
        const calls = mockOnHandler.mock.calls as Array<[string, (...args: unknown[]) => void]>;
        const closeCallback = calls.find((call) => call[0] === 'close')?.[1];
        if (closeCallback) {
          closeCallback(0);
        }

        expect(primitives.updateMCPServerStatus).toHaveBeenCalledWith(1, 'disconnected');
      });

      it('should start HTTP server with successful connection', async () => {
        const server = createMockServer({
          transport: 'http',
          url: 'http://localhost:3000',
          command: null,
        });
        vi.mocked(primitives.getMCPServer).mockReturnValue(server);

        // Mock fetch
        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
        });

        const result = await manager.startServer(1);

        expect(result).toBe(true);
        expect(fetch).toHaveBeenCalledWith(
          'http://localhost:3000',
          expect.objectContaining({ method: 'GET' })
        );
        expect(primitives.updateMCPServerStatus).toHaveBeenCalledWith(1, 'connected');
      });

      it('should handle HTTP server without URL', async () => {
        const server = createMockServer({
          transport: 'http',
          url: null,
          command: null,
        });
        vi.mocked(primitives.getMCPServer).mockReturnValue(server);

        const result = await manager.startServer(1);

        expect(result).toBe(false);
        expect(primitives.updateMCPServerStatus).toHaveBeenCalledWith(
          1,
          'error',
          'No URL specified'
        );
      });

      it('should handle HTTP server with failed connection', async () => {
        const server = createMockServer({
          transport: 'http',
          url: 'http://localhost:3000',
          command: null,
        });
        vi.mocked(primitives.getMCPServer).mockReturnValue(server);

        global.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
        });

        const result = await manager.startServer(1);

        expect(result).toBe(false);
        expect(primitives.updateMCPServerStatus).toHaveBeenCalledWith(1, 'error', 'HTTP 500');
      });

      it('should handle HTTP server with network error', async () => {
        const server = createMockServer({
          transport: 'http',
          url: 'http://localhost:3000',
          command: null,
        });
        vi.mocked(primitives.getMCPServer).mockReturnValue(server);

        global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

        const result = await manager.startServer(1);

        expect(result).toBe(false);
        expect(primitives.updateMCPServerStatus).toHaveBeenCalledWith(1, 'error', 'Network error');
      });
    });

    describe('stopServer', () => {
      it('should stop running server', async () => {
        const server = createMockServer({ id: 1, command: 'npx' });
        vi.mocked(primitives.getMCPServer).mockReturnValue(server);

        const disconnectListener = vi.fn();
        manager.on('server:disconnected', disconnectListener);

        // Start server first
        const startPromise = manager.startServer(1);
        setTimeout(() => {
          mockChildProcess.stdout.emit('data', Buffer.from('Ready'));
        }, 10);
        await startPromise;

        // Then stop
        manager.stopServer(1);

        expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGTERM');
        expect(primitives.updateMCPServerStatus).toHaveBeenCalledWith(1, 'disconnected');
        expect(disconnectListener).toHaveBeenCalled();
      });

      it('should do nothing if server not running', () => {
        // Create a new mock that hasn't been started
        const freshMock = createMockChildProcess();
        manager.stopServer(999);

        expect(freshMock.kill).not.toHaveBeenCalled();
      });
    });

    describe('stopAllServers', () => {
      it('should stop all running servers', async () => {
        const server1 = createMockServer({ id: 1, command: 'npx' });
        const server2 = createMockServer({ id: 2, command: 'node' });

        const mockProcess1 = createMockChildProcess();
        const mockProcess2 = createMockChildProcess();

        // Set up to return different processes for each start
        vi.mocked(spawn)
          .mockReturnValueOnce(mockProcess1 as unknown as ChildProcess)
          .mockReturnValueOnce(mockProcess2 as unknown as ChildProcess);

        // Start first server
        vi.mocked(primitives.getMCPServer).mockReturnValue(server1);
        const start1 = manager.startServer(1);
        setTimeout(() => mockProcess1.stdout.emit('data', Buffer.from('Ready')), 10);
        await start1;

        // Start second server
        vi.mocked(primitives.getMCPServer).mockReturnValue(server2);
        const start2 = manager.startServer(2);
        setTimeout(() => mockProcess2.stdout.emit('data', Buffer.from('Ready')), 10);
        await start2;

        // Stop all
        manager.stopAllServers();

        expect(mockProcess1.kill).toHaveBeenCalled();
        expect(mockProcess2.kill).toHaveBeenCalled();
      });
    });

    describe('restartServer', () => {
      it('should stop and start server', async () => {
        const server = createMockServer({ id: 1, command: 'npx' });
        vi.mocked(primitives.getMCPServer).mockReturnValue(server);

        // First start
        const start1 = manager.startServer(1);
        setTimeout(() => {
          mockChildProcess.stdout.emit('data', Buffer.from('Ready'));
        }, 10);
        await start1;

        // Prepare for restart - create a new mock process
        const restartProcess = createMockChildProcess();
        vi.mocked(spawn).mockReturnValue(restartProcess as unknown as ChildProcess);

        // Restart
        const restartPromise = manager.restartServer(1);
        setTimeout(() => {
          restartProcess.stdout.emit('data', Buffer.from('Ready'));
        }, 600); // After 500ms delay

        const result = await restartPromise;
        expect(result).toBe(true);
      });
    });

    describe('getRunningServerInfo', () => {
      it('should return info for running server', async () => {
        const server = createMockServer({ id: 1, command: 'npx' });
        vi.mocked(primitives.getMCPServer).mockReturnValue(server);

        const startPromise = manager.startServer(1);
        setTimeout(() => {
          mockChildProcess.stdout.emit('data', Buffer.from('Ready'));
        }, 10);
        await startPromise;

        const info = manager.getRunningServerInfo(1);

        expect(info).toBeDefined();
        expect(info?.server).toEqual(server);
        expect(info?.connected).toBe(true);
      });

      it('should return undefined for non-running server', () => {
        const info = manager.getRunningServerInfo(999);
        expect(info).toBeUndefined();
      });
    });

    describe('getRunningServers', () => {
      it('should return all running servers', async () => {
        const server = createMockServer({ id: 1, command: 'npx' });
        vi.mocked(primitives.getMCPServer).mockReturnValue(server);

        const startPromise = manager.startServer(1);
        setTimeout(() => {
          mockChildProcess.stdout.emit('data', Buffer.from('Ready'));
        }, 10);
        await startPromise;

        const running = manager.getRunningServers();

        expect(running.length).toBeGreaterThan(0);
        expect(running[0].connected).toBe(true);
      });
    });
  });

  // ==========================================================================
  // CLAUDE CONFIG INTEGRATION TESTS
  // ==========================================================================

  describe('Claude Config Integration', () => {
    describe('readMCPConfig', () => {
      it('should read .mcp.json from project', async () => {
        const configData = {
          mcpServers: {
            'test-server': { command: 'npx', args: ['@test/server'] },
          },
        };

        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(configData));

        const result = await manager.readMCPConfig('/path/to/project');

        expect(existsSync).toHaveBeenCalledWith('/path/to/project/.mcp.json');
        expect(fs.readFile).toHaveBeenCalledWith('/path/to/project/.mcp.json', 'utf-8');
        expect(result).toEqual(configData);
      });

      it('should return null if file does not exist', async () => {
        vi.mocked(existsSync).mockReturnValue(false);

        const result = await manager.readMCPConfig('/path/to/project');

        expect(result).toBeNull();
        expect(fs.readFile).not.toHaveBeenCalled();
      });

      it('should throw error if file is invalid JSON', async () => {
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(fs.readFile).mockResolvedValue('invalid json');

        await expect(manager.readMCPConfig('/path/to/project')).rejects.toThrow(
          /Failed to read MCP config/
        );
      });
    });

    describe('writeMCPConfig', () => {
      it('should write .mcp.json to project', async () => {
        const config = {
          mcpServers: {
            'test-server': { command: 'npx', args: ['@test/server'] },
          },
        };

        await manager.writeMCPConfig('/path/to/project', config);

        expect(fs.writeFile).toHaveBeenCalledWith(
          '/path/to/project/.mcp.json',
          JSON.stringify(config, null, 2),
          'utf-8'
        );
      });
    });

    describe('readUserClaudeConfig', () => {
      it('should read .claude.json from home directory', async () => {
        const configData = { mcpServers: {}, theme: 'dark' };

        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(configData));

        const result = await manager.readUserClaudeConfig();

        expect(existsSync).toHaveBeenCalledWith('/home/testuser/.claude.json');
        expect(result).toEqual(configData);
      });

      it('should return null if file does not exist', async () => {
        vi.mocked(existsSync).mockReturnValue(false);

        const result = await manager.readUserClaudeConfig();

        expect(result).toBeNull();
      });
    });

    describe('syncToClaudeConfig', () => {
      it('should sync user servers to claude config', async () => {
        const userServer = createMockServer({
          id: 1,
          name: 'User Server',
          scope: 'user',
          enabled: true,
          command: 'npx',
          args: ['@test/server'],
          env: { KEY: 'value' },
        });

        vi.mocked(primitives.getAllMCPServers).mockReturnValue([userServer]);
        vi.mocked(existsSync).mockReturnValue(false);

        await manager.syncToClaudeConfig();

        expect(fs.writeFile).toHaveBeenCalledWith(
          '/home/testuser/.claude.json',
          expect.stringContaining('User Server'),
          'utf-8'
        );
      });

      it('should sync project servers to .mcp.json', async () => {
        const projectServer = createMockServer({
          id: 1,
          name: 'Project Server',
          scope: 'project',
          projectPath: '/path/to/project',
          enabled: true,
          command: 'node',
        });

        vi.mocked(primitives.getAllMCPServers).mockReturnValue([projectServer]);

        await manager.syncToClaudeConfig('/path/to/project');

        expect(fs.writeFile).toHaveBeenCalledWith(
          '/path/to/project/.mcp.json',
          expect.stringContaining('Project Server'),
          'utf-8'
        );
      });

      it('should skip disabled servers', async () => {
        const disabledServer = createMockServer({
          id: 1,
          name: 'Disabled Server',
          scope: 'user',
          enabled: false,
        });

        vi.mocked(primitives.getAllMCPServers).mockReturnValue([disabledServer]);

        await manager.syncToClaudeConfig();

        // Should not write if no enabled servers
        expect(fs.writeFile).not.toHaveBeenCalled();
      });

      it('should merge with existing user config', async () => {
        const userServer = createMockServer({
          id: 1,
          name: 'New Server',
          scope: 'user',
          enabled: true,
          command: 'npx',
        });

        const existingConfig = { theme: 'dark', existingKey: 'value' };

        vi.mocked(primitives.getAllMCPServers).mockReturnValue([userServer]);
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existingConfig));

        await manager.syncToClaudeConfig();

        const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
        const writtenConfig = JSON.parse(writeCall[1] as string);

        expect(writtenConfig.theme).toBe('dark');
        expect(writtenConfig.existingKey).toBe('value');
        expect(writtenConfig.mcpServers).toBeDefined();
      });
    });
  });

  // ==========================================================================
  // MARKETPLACE TESTS
  // ==========================================================================

  describe('Marketplace', () => {
    describe('getMarketplaceServers', () => {
      it('should return all marketplace servers', () => {
        const servers = manager.getMarketplaceServers();

        expect(Array.isArray(servers)).toBe(true);
        expect(servers.length).toBeGreaterThan(0);

        // Verify structure of marketplace server
        const server = servers[0];
        expect(server).toHaveProperty('id');
        expect(server).toHaveProperty('name');
        expect(server).toHaveProperty('description');
        expect(server).toHaveProperty('category');
        expect(server).toHaveProperty('transport');
      });
    });

    describe('getMarketplaceServer', () => {
      it('should return server by ID', () => {
        const server = manager.getMarketplaceServer('notion');

        expect(server).toBeDefined();
        expect(server?.name).toBe('Notion');
        expect(server?.category).toBe('productivity');
      });

      it('should return undefined for non-existent ID', () => {
        const server = manager.getMarketplaceServer('non-existent');
        expect(server).toBeUndefined();
      });
    });

    describe('getPopularServers', () => {
      it('should return only popular servers', () => {
        const popular = manager.getPopularServers();

        expect(Array.isArray(popular)).toBe(true);
        expect(popular.every(s => s.popular === true)).toBe(true);
      });
    });

    describe('getServersByCategory', () => {
      it('should filter by productivity category', () => {
        const servers = manager.getServersByCategory('productivity');

        expect(Array.isArray(servers)).toBe(true);
        expect(servers.every(s => s.category === 'productivity')).toBe(true);
      });

      it('should filter by devops category', () => {
        const servers = manager.getServersByCategory('devops');

        expect(servers.every(s => s.category === 'devops')).toBe(true);
      });

      it('should filter by database category', () => {
        const servers = manager.getServersByCategory('database');

        expect(servers.every(s => s.category === 'database')).toBe(true);
      });
    });

    describe('installMarketplaceServer', () => {
      it('should install marketplace server with required env vars', async () => {
        const result = await manager.installMarketplaceServer(
          'notion',
          { NOTION_API_KEY: 'test-key' },
          'user'
        );

        expect(result).toBeDefined();
        expect(primitives.createMCPServer).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'Notion',
            transport: 'stdio',
            command: 'npx',
            args: ['@notionhq/mcp-server'],
            env: { NOTION_API_KEY: 'test-key' },
            scope: 'user',
          })
        );
      });

      it('should install server with project scope', async () => {
        const result = await manager.installMarketplaceServer(
          'filesystem',
          {},
          'project',
          '/path/to/project'
        );

        expect(result).toBeDefined();
        expect(primitives.createMCPServer).toHaveBeenCalledWith(
          expect.objectContaining({
            scope: 'project',
            projectPath: '/path/to/project',
          })
        );
      });

      it('should return null for non-existent marketplace server', async () => {
        const result = await manager.installMarketplaceServer('non-existent');

        expect(result).toBeNull();
        expect(primitives.createMCPServer).not.toHaveBeenCalled();
      });

      it('should throw error if required env var missing', async () => {
        await expect(
          manager.installMarketplaceServer('notion', {})
        ).rejects.toThrow('Missing required environment variable: NOTION_API_KEY');
      });

      it('should install server without required env vars if none required', async () => {
        const result = await manager.installMarketplaceServer('filesystem', {});

        expect(result).toBeDefined();
        expect(primitives.createMCPServer).toHaveBeenCalled();
      });
    });
  });

  // ==========================================================================
  // SHUTDOWN TESTS
  // ==========================================================================

  describe('Shutdown', () => {
    it('should stop all servers on shutdown', async () => {
      const server = createMockServer({ id: 1, command: 'npx' });
      vi.mocked(primitives.getMCPServer).mockReturnValue(server);

      // Start server
      const startPromise = manager.startServer(1);
      setTimeout(() => {
        mockChildProcess.stdout.emit('data', Buffer.from('Ready'));
      }, 10);
      await startPromise;

      // Shutdown
      manager.shutdown();

      expect(mockChildProcess.kill).toHaveBeenCalled();
    });

    it('should remove all listeners on shutdown', () => {
      const listener = vi.fn();
      manager.on('server:added', listener);

      expect(manager.listenerCount('server:added')).toBe(1);

      manager.shutdown();

      expect(manager.listenerCount('server:added')).toBe(0);
    });
  });
});

// ============================================================================
// EXPORTED FUNCTION TESTS
// ============================================================================

describe('Module Exports', () => {
  beforeEach(() => {
    shutdownMCPManager();
  });

  afterEach(() => {
    shutdownMCPManager();
  });

  describe('getMCPManager', () => {
    it('should create and return manager instance', () => {
      const manager = getMCPManager();

      expect(manager).toBeInstanceOf(MCPManagerService);
    });
  });

  describe('shutdownMCPManager', () => {
    it('should safely shutdown when no manager exists', () => {
      expect(() => shutdownMCPManager()).not.toThrow();
    });

    it('should shutdown existing manager', () => {
      getMCPManager();
      expect(() => shutdownMCPManager()).not.toThrow();
    });
  });
});

// ============================================================================
// SECURITY VALIDATION TESTS
// ============================================================================

describe('Security Validations', () => {
  let manager: MCPManagerService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChildProcess = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mockChildProcess as unknown as ChildProcess);
    shutdownMCPManager();
    manager = getMCPManager();
  });

  afterEach(() => {
    shutdownMCPManager();
  });

  describe('Command Name Validation', () => {
    it('should reject server with invalid command containing shell metacharacters', async () => {
      const server = createMockServer({
        id: 1,
        transport: 'stdio',
        command: 'npx; rm -rf /',
      });
      vi.mocked(primitives.getMCPServer).mockReturnValue(server);

      const result = await manager.startServer(1);

      expect(result).toBe(false);
      expect(primitives.updateMCPServerStatus).toHaveBeenCalledWith(
        1,
        'error',
        expect.stringContaining('Security')
      );
    });

    it('should reject server with command substitution pattern', async () => {
      const server = createMockServer({
        id: 1,
        transport: 'stdio',
        command: '$(whoami)',
      });
      vi.mocked(primitives.getMCPServer).mockReturnValue(server);

      const result = await manager.startServer(1);

      expect(result).toBe(false);
      expect(primitives.updateMCPServerStatus).toHaveBeenCalledWith(
        1,
        'error',
        expect.stringContaining('Security')
      );
    });

    it('should reject server with path traversal in command', async () => {
      const server = createMockServer({
        id: 1,
        transport: 'stdio',
        command: '../../../etc/passwd',
      });
      vi.mocked(primitives.getMCPServer).mockReturnValue(server);

      const result = await manager.startServer(1);

      expect(result).toBe(false);
      expect(primitives.updateMCPServerStatus).toHaveBeenCalledWith(
        1,
        'error',
        expect.stringContaining('Security')
      );
    });
  });

  describe('Arguments Validation', () => {
    it('should reject server with dangerous arguments', async () => {
      const server = createMockServer({
        id: 1,
        transport: 'stdio',
        command: 'npx',
        args: ['@test/server', '; rm -rf /'],
      });
      vi.mocked(primitives.getMCPServer).mockReturnValue(server);

      const result = await manager.startServer(1);

      expect(result).toBe(false);
      expect(primitives.updateMCPServerStatus).toHaveBeenCalledWith(
        1,
        'error',
        expect.stringContaining('Security')
      );
    });

    it('should reject server with command substitution in arguments', async () => {
      const server = createMockServer({
        id: 1,
        transport: 'stdio',
        command: 'npx',
        args: ['@test/server', '$(cat /etc/passwd)'],
      });
      vi.mocked(primitives.getMCPServer).mockReturnValue(server);

      const result = await manager.startServer(1);

      expect(result).toBe(false);
      expect(primitives.updateMCPServerStatus).toHaveBeenCalledWith(
        1,
        'error',
        expect.stringContaining('Security')
      );
    });

    it('should reject server with backtick command substitution in arguments', async () => {
      const server = createMockServer({
        id: 1,
        transport: 'stdio',
        command: 'npx',
        args: ['@test/server', '`whoami`'],
      });
      vi.mocked(primitives.getMCPServer).mockReturnValue(server);

      const result = await manager.startServer(1);

      expect(result).toBe(false);
      expect(primitives.updateMCPServerStatus).toHaveBeenCalledWith(
        1,
        'error',
        expect.stringContaining('Security')
      );
    });
  });

  describe('Path Validation', () => {
    it('should reject server with path traversal in projectPath', async () => {
      const server = createMockServer({
        id: 1,
        transport: 'stdio',
        command: 'npx',
        projectPath: '/home/user/../../../etc',
      });
      vi.mocked(primitives.getMCPServer).mockReturnValue(server);

      const result = await manager.startServer(1);

      expect(result).toBe(false);
      expect(primitives.updateMCPServerStatus).toHaveBeenCalledWith(
        1,
        'error',
        expect.stringContaining('Security')
      );
    });
  });

  describe('Environment Validation', () => {
    it('should reject server with invalid env var names', async () => {
      const server = createMockServer({
        id: 1,
        transport: 'stdio',
        command: 'npx',
        env: { '123INVALID': 'value' },
      });
      vi.mocked(primitives.getMCPServer).mockReturnValue(server);

      const result = await manager.startServer(1);

      expect(result).toBe(false);
      expect(primitives.updateMCPServerStatus).toHaveBeenCalledWith(
        1,
        'error',
        expect.stringContaining('Security')
      );
    });

    it('should reject server with command substitution in env value', async () => {
      const server = createMockServer({
        id: 1,
        transport: 'stdio',
        command: 'npx',
        env: { SAFE_NAME: '$(whoami)' },
      });
      vi.mocked(primitives.getMCPServer).mockReturnValue(server);

      const result = await manager.startServer(1);

      expect(result).toBe(false);
      expect(primitives.updateMCPServerStatus).toHaveBeenCalledWith(
        1,
        'error',
        expect.stringContaining('Security')
      );
    });
  });
});

// ============================================================================
// ADDITIONAL EDGE CASE TESTS
// ============================================================================

describe('Additional Edge Cases', () => {
  let manager: MCPManagerService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChildProcess = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(mockChildProcess as unknown as ChildProcess);
    shutdownMCPManager();
    manager = getMCPManager();
  });

  afterEach(() => {
    shutdownMCPManager();
  });

  describe('Transport Types', () => {
    it('should return false for unknown transport type', async () => {
      const server = createMockServer({
        id: 1,
        transport: 'websocket' as 'stdio', // Force invalid transport
      });
      vi.mocked(primitives.getMCPServer).mockReturnValue(server);

      const result = await manager.startServer(1);

      expect(result).toBe(false);
    });
  });

  describe('Stderr Output', () => {
    it('should handle stderr output without affecting connection status', async () => {
      const server = createMockServer({ transport: 'stdio', command: 'npx' });
      vi.mocked(primitives.getMCPServer).mockReturnValue(server);

      const startPromise = manager.startServer(1);

      // Emit stderr first
      setTimeout(() => {
        mockChildProcess.stderr.emit('data', Buffer.from('Warning: something'));
      }, 5);

      // Then emit stdout to trigger connection
      setTimeout(() => {
        mockChildProcess.stdout.emit('data', Buffer.from('Ready'));
      }, 10);

      const result = await startPromise;

      expect(result).toBe(true);
    });
  });

  describe('Tool Discovery', () => {
    it('should handle JSON with inputSchema in tools', async () => {
      const server = createMockServer({ transport: 'stdio', command: 'npx' });
      vi.mocked(primitives.getMCPServer).mockReturnValue(server);

      const startPromise = manager.startServer(1);

      setTimeout(() => {
        const toolsJson = JSON.stringify({
          tools: [
            {
              name: 'read_file',
              description: 'Read a file',
              inputSchema: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'File path' },
                },
                required: ['path'],
              },
            },
          ],
        });
        mockChildProcess.stdout.emit('data', Buffer.from(toolsJson));
      }, 10);

      await startPromise;

      expect(primitives.updateMCPServer).toHaveBeenCalledWith(1, { toolCount: 1 });
    });

    it('should handle partial JSON output gracefully', async () => {
      const server = createMockServer({ transport: 'stdio', command: 'npx' });
      vi.mocked(primitives.getMCPServer).mockReturnValue(server);

      const startPromise = manager.startServer(1);

      // First emit partial JSON (should fail parse silently)
      setTimeout(() => {
        mockChildProcess.stdout.emit('data', Buffer.from('{"tools":'));
      }, 5);

      // Then emit valid ready message
      setTimeout(() => {
        mockChildProcess.stdout.emit('data', Buffer.from('Server is ready'));
      }, 10);

      const result = await startPromise;

      expect(result).toBe(true);
    });

    it('should handle non-JSON stdout output', async () => {
      const server = createMockServer({ transport: 'stdio', command: 'npx' });
      vi.mocked(primitives.getMCPServer).mockReturnValue(server);

      const startPromise = manager.startServer(1);

      setTimeout(() => {
        mockChildProcess.stdout.emit('data', Buffer.from('MCP Server v1.0 starting...'));
      }, 10);

      const result = await startPromise;

      expect(result).toBe(true);
    });
  });

  describe('Marketplace Categories', () => {
    it('should filter by communication category', () => {
      const servers = manager.getServersByCategory('communication');

      expect(Array.isArray(servers)).toBe(true);
      expect(servers.every(s => s.category === 'communication')).toBe(true);
    });

    it('should filter by custom category (empty result)', () => {
      const servers = manager.getServersByCategory('custom');

      expect(Array.isArray(servers)).toBe(true);
      // Custom category may be empty if no custom servers defined
    });
  });

  describe('Marketplace Installation', () => {
    it('should install server with npm package specified', async () => {
      // filesystem has an npmPackage specified
      const result = await manager.installMarketplaceServer(
        'filesystem',
        {},
        'user'
      );

      expect(result).toBeDefined();
      expect(primitives.createMCPServer).toHaveBeenCalled();
    });

    it('should install server with multiple env vars', async () => {
      // postgres requires DATABASE_URL
      const result = await manager.installMarketplaceServer(
        'postgres',
        { DATABASE_URL: 'postgres://localhost/test' },
        'project',
        '/my/project'
      );

      expect(result).toBeDefined();
      expect(primitives.createMCPServer).toHaveBeenCalledWith(
        expect.objectContaining({
          env: { DATABASE_URL: 'postgres://localhost/test' },
          scope: 'project',
          projectPath: '/my/project',
        })
      );
    });

    it('should throw when missing required env for github server', async () => {
      await expect(
        manager.installMarketplaceServer('github', {})
      ).rejects.toThrow('Missing required environment variable: GITHUB_TOKEN');
    });

    it('should throw when missing required env for slack server', async () => {
      await expect(
        manager.installMarketplaceServer('slack', {})
      ).rejects.toThrow('Missing required environment variable: SLACK_BOT_TOKEN');
    });
  });

  describe('Event Emission', () => {
    it('should emit server:connected event on successful stdio start', async () => {
      const server = createMockServer({ transport: 'stdio', command: 'npx' });
      vi.mocked(primitives.getMCPServer).mockReturnValue(server);

      const connectedListener = vi.fn();
      manager.on('server:connected', connectedListener);

      const startPromise = manager.startServer(1);

      setTimeout(() => {
        mockChildProcess.stdout.emit('data', Buffer.from('Ready'));
      }, 10);

      await startPromise;

      expect(connectedListener).toHaveBeenCalledWith(server);
    });

    it('should emit server:connected event on successful HTTP start', async () => {
      const server = createMockServer({
        transport: 'http',
        url: 'http://localhost:3000',
        command: null,
      });
      vi.mocked(primitives.getMCPServer).mockReturnValue(server);

      global.fetch = vi.fn().mockResolvedValue({ ok: true });

      const connectedListener = vi.fn();
      manager.on('server:connected', connectedListener);

      await manager.startServer(1);

      expect(connectedListener).toHaveBeenCalledWith(server);
    });
  });

  describe('Spawn Error Handling', () => {
    it('should handle spawn throwing synchronously', async () => {
      const server = createMockServer({ transport: 'stdio', command: 'npx' });
      vi.mocked(primitives.getMCPServer).mockReturnValue(server);
      vi.mocked(spawn).mockImplementation(() => {
        throw new Error('Command not found');
      });

      const result = await manager.startServer(1);

      expect(result).toBe(false);
      expect(primitives.updateMCPServerStatus).toHaveBeenCalledWith(
        1,
        'error',
        'Command not found'
      );
    });
  });

  describe('HTTP Server Edge Cases', () => {
    it('should handle HTTP timeout', async () => {
      const server = createMockServer({
        transport: 'http',
        url: 'http://localhost:3000',
        command: null,
      });
      vi.mocked(primitives.getMCPServer).mockReturnValue(server);

      const timeoutError = new Error('Timeout');
      timeoutError.name = 'TimeoutError';
      global.fetch = vi.fn().mockRejectedValue(timeoutError);

      const result = await manager.startServer(1);

      expect(result).toBe(false);
      expect(primitives.updateMCPServerStatus).toHaveBeenCalledWith(
        1,
        'error',
        'Timeout'
      );
    });

    it('should handle HTTP 401 unauthorized', async () => {
      const server = createMockServer({
        transport: 'http',
        url: 'http://localhost:3000',
        command: null,
      });
      vi.mocked(primitives.getMCPServer).mockReturnValue(server);

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
      });

      const result = await manager.startServer(1);

      expect(result).toBe(false);
      expect(primitives.updateMCPServerStatus).toHaveBeenCalledWith(1, 'error', 'HTTP 401');
    });

    it('should handle HTTP 503 service unavailable', async () => {
      const server = createMockServer({
        transport: 'http',
        url: 'http://localhost:3000',
        command: null,
      });
      vi.mocked(primitives.getMCPServer).mockReturnValue(server);

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
      });

      const result = await manager.startServer(1);

      expect(result).toBe(false);
      expect(primitives.updateMCPServerStatus).toHaveBeenCalledWith(1, 'error', 'HTTP 503');
    });
  });

  describe('Config Sync Error Handling', () => {
    it('should throw error when reading corrupted .claude.json', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(fs.readFile).mockResolvedValue('not valid json {{{');

      await expect(manager.readUserClaudeConfig()).rejects.toThrow(
        /Failed to read user claude config/
      );
    });
  });

  describe('Multiple Server Operations', () => {
    it('should handle stopping non-existent server gracefully', () => {
      // Stopping a server that was never started should not throw
      expect(() => manager.stopServer(999)).not.toThrow();
    });

    it('should handle restart of non-running server', async () => {
      const server = createMockServer({ id: 1, command: 'npx' });
      vi.mocked(primitives.getMCPServer).mockReturnValue(server);

      const restartProcess = createMockChildProcess();
      vi.mocked(spawn).mockReturnValue(restartProcess as unknown as ChildProcess);

      const restartPromise = manager.restartServer(1);

      setTimeout(() => {
        restartProcess.stdout.emit('data', Buffer.from('Ready'));
      }, 600);

      const result = await restartPromise;

      expect(result).toBe(true);
    });
  });
});
