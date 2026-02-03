// ============================================================================
// MCP MANAGER SERVICE TESTS
// ============================================================================
//
// Comprehensive tests for the MCPManagerService class.
// Tests cover:
// - Server lifecycle management (start, stop, restart)
// - Server installation from marketplace
// - Server discovery and management
// - Configuration integration (Claude config)
// - Error handling and edge cases
// - Singleton pattern
//
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi, type MockedFunction } from 'vitest';
import type { ChildProcess } from 'child_process';
import type { EventEmitter } from 'events';

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

vi.mock('../../logger.js', () => ({
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

// Mock database primitives
const mockServers = new Map<number, any>();
let nextServerId = 1;

vi.mock('../../../database/primitives.js', () => ({
  db: {
    run: vi.fn(),
    get: vi.fn(),
    all: vi.fn(),
  },
  createMCPServer: vi.fn((config: any) => {
    const id = nextServerId++;
    const server = {
      id,
      name: config.name,
      description: config.description || null,
      transport: config.transport,
      command: config.command || null,
      url: config.url || null,
      args: config.args ? JSON.stringify(config.args) : null,
      env: config.env ? JSON.stringify(config.env) : null,
      scope: config.scope || 'user',
      project_path: config.projectPath || null,
      enabled: true,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    mockServers.set(id, server);
    return server;
  }),
  getMCPServer: vi.fn((id: number) => mockServers.get(id) || null),
  getMCPServerById: vi.fn((id: number) => mockServers.get(id) || null),
  getAllMCPServers: vi.fn((scope?: string, projectPath?: string) => {
    let servers = Array.from(mockServers.values());
    if (scope) {
      servers = servers.filter(s => s.scope === scope);
    }
    if (projectPath) {
      servers = servers.filter(s => s.project_path === projectPath);
    }
    return servers;
  }),
  updateMCPServer: vi.fn((id: number, updates: any) => {
    const server = mockServers.get(id);
    if (server) {
      Object.assign(server, updates, { updated_at: Date.now() });
    }
  }),
  deleteMCPServer: vi.fn((id: number) => {
    mockServers.delete(id);
  }),
  updateMCPServerStatus: vi.fn((id: number, status: string, error?: string) => {
    const server = mockServers.get(id);
    if (server) {
      server.status = status;
      server.error = error || null;
    }
  }),
}));

// Mock child_process
const mockProcesses = new Map<number, any>();

function createMockChildProcess(): any {
  const process: any = {
    pid: Math.floor(Math.random() * 10000),
    stdin: {
      write: vi.fn(),
      end: vi.fn(),
    },
    stdout: {
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    },
    stderr: {
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    },
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    kill: vi.fn(() => {
      // Simulate process killed
      const exitHandler = process.on.mock.calls.find((call: any) => call[0] === 'exit');
      if (exitHandler) {
        exitHandler[1](0, null);
      }
    }),
  };
  return process;
}

vi.mock('child_process', () => ({
  spawn: vi.fn((command: string, args: string[], options: any) => {
    const process = createMockChildProcess();
    // Simulate successful startup
    setTimeout(() => {
      const dataHandler = process.stdout.on.mock.calls.find((call: any) => call[0] === 'data');
      if (dataHandler) {
        dataHandler[1](Buffer.from('Server started\n'));
      }
    }, 10);
    return process;
  }),
  exec: vi.fn(),
  default: {
    spawn: vi.fn((command: string, args: string[], options: any) => {
      const process = createMockChildProcess();
      setTimeout(() => {
        const dataHandler = process.stdout.on.mock.calls.find((call: any) => call[0] === 'data');
        if (dataHandler) {
          dataHandler[1](Buffer.from('Server started\n'));
        }
      }, 10);
      return process;
    }),
    exec: vi.fn(),
  },
}));

// Mock fs
const fsMockState = {
  existsSyncResult: false as boolean | ((path: string) => boolean),
  readFileResult: '' as string | Error,
  writeFileResult: undefined as void | Error,
  mkdirResult: undefined as void | Error,
};

vi.mock('fs', () => {
  return {
    existsSync: vi.fn((filePath: string) => {
      if (typeof fsMockState.existsSyncResult === 'function') {
        return fsMockState.existsSyncResult(filePath);
      }
      return fsMockState.existsSyncResult;
    }),
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
  };
});

vi.mock('fs/promises', () => {
  return {
    default: {
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
  };
});

// Mock path
vi.mock('path', () => ({
  default: {
    join: (...args: string[]) => args.join('/'),
    dirname: (p: string) => p.split('/').slice(0, -1).join('/'),
  },
}));

// Mock os
vi.mock('os', () => ({
  default: {
    homedir: () => '/mock/home',
  },
}));

// Mock inputSanitizer
vi.mock('../../inputSanitizer.js', () => ({
  validateCommandName: vi.fn((cmd: string) => ({ valid: true, sanitized: cmd })),
  validateCommandArguments: vi.fn((args: string[]) => ({ valid: true, sanitized: args })),
  validatePath: vi.fn((path: string) => ({ valid: true, sanitized: path })),
  validateEnvironment: vi.fn((env: Record<string, unknown>) => ({ valid: true, sanitized: env })),
  logSecurityEvent: vi.fn(),
}));

// ============================================================================
// TEST SUITE
// ============================================================================

import { MCPManagerService, getMCPManager, shutdownMCPManager } from '../service.js';
import type { MCPServerConfig } from '../types.js';

describe('MCPManagerService', () => {
  let service: MCPManagerService;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();
    clearLoggerCalls();
    mockServers.clear();
    mockProcesses.clear();
    nextServerId = 1;

    // Reset fs mock state
    fsMockState.existsSyncResult = false;
    fsMockState.readFileResult = '';
    fsMockState.writeFileResult = undefined;
    fsMockState.mkdirResult = undefined;

    // Create fresh service instance
    service = new MCPManagerService();
  });

  afterEach(() => {
    service.shutdown();
  });

  // ==========================================================================
  // CONSTRUCTOR
  // ==========================================================================

  describe('constructor', () => {
    it('initializes with empty running servers', () => {
      expect(service.getRunningServers()).toHaveLength(0);
    });

    it('sets max listeners to 50', () => {
      expect(service.getMaxListeners()).toBe(50);
    });
  });

  // ==========================================================================
  // SERVER MANAGEMENT
  // ==========================================================================

  describe('addServer', () => {
    it('creates a new server with valid config', () => {
      const config: MCPServerConfig = {
        name: 'Test Server',
        description: 'A test server',
        transport: 'stdio',
        command: 'node',
        args: ['test.js'],
        env: { TEST: 'value' },
        scope: 'user',
      };

      const server = service.addServer(config);

      expect(server).toBeDefined();
      expect(server.id).toBe(1);
      expect(server.name).toBe('Test Server');
      expect(server.transport).toBe('stdio');
      expect(mockServers.size).toBe(1);
    });

    it('creates server with minimal config', () => {
      const config: MCPServerConfig = {
        name: 'Minimal Server',
        transport: 'stdio',
        command: 'node',
      };

      const server = service.addServer(config);

      expect(server).toBeDefined();
      expect(server.name).toBe('Minimal Server');
      expect(server.description).toBeNull();
    });

    it('increments server IDs', () => {
      const server1 = service.addServer({
        name: 'Server 1',
        transport: 'stdio',
        command: 'node',
      });
      const server2 = service.addServer({
        name: 'Server 2',
        transport: 'stdio',
        command: 'node',
      });

      expect(server1.id).toBe(1);
      expect(server2.id).toBe(2);
    });
  });

  describe('getServer', () => {
    it('retrieves existing server by id', () => {
      const created = service.addServer({
        name: 'Test Server',
        transport: 'stdio',
        command: 'node',
      });

      const retrieved = service.getServer(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.name).toBe('Test Server');
    });

    it('returns null for non-existent server', () => {
      const server = service.getServer(999);
      expect(server).toBeNull();
    });
  });

  describe('getAllServers', () => {
    beforeEach(() => {
      service.addServer({
        name: 'User Server 1',
        transport: 'stdio',
        command: 'node',
        scope: 'user',
      });
      service.addServer({
        name: 'User Server 2',
        transport: 'stdio',
        command: 'node',
        scope: 'user',
      });
      service.addServer({
        name: 'Project Server',
        transport: 'stdio',
        command: 'node',
        scope: 'project',
        projectPath: '/test/project',
      });
    });

    it('returns all servers when no filter provided', () => {
      const servers = service.getAllServers();
      expect(servers).toHaveLength(3);
    });

    it('filters by user scope', () => {
      const servers = service.getAllServers('user');
      expect(servers).toHaveLength(2);
      expect(servers.every(s => s.scope === 'user')).toBe(true);
    });

    it('filters by project scope', () => {
      const servers = service.getAllServers('project');
      expect(servers).toHaveLength(1);
      expect(servers[0].scope).toBe('project');
    });

    it('filters by project path', () => {
      const servers = service.getAllServers('project', '/test/project');
      expect(servers).toHaveLength(1);
      expect(servers[0].project_path).toBe('/test/project');
    });
  });

  describe('updateServer', () => {
    it('updates server properties', () => {
      const server = service.addServer({
        name: 'Original Name',
        transport: 'stdio',
        command: 'node',
      });

      service.updateServer(server.id, {
        name: 'Updated Name',
        description: 'New description',
      });

      const updated = service.getServer(server.id);
      expect(updated?.name).toBe('Updated Name');
      expect(updated?.description).toBe('New description');
    });

    it('emits server-updated event', () => {
      const server = service.addServer({
        name: 'Test Server',
        transport: 'stdio',
        command: 'node',
      });

      const listener = vi.fn();
      service.on('server:updated', listener);

      service.updateServer(server.id, { name: 'New Name' });

      expect(listener).toHaveBeenCalled();
    });
  });

  describe('deleteServer', () => {
    it('deletes existing server', () => {
      const server = service.addServer({
        name: 'Test Server',
        transport: 'stdio',
        command: 'node',
      });

      service.deleteServer(server.id);

      expect(service.getServer(server.id)).toBeNull();
      expect(mockServers.size).toBe(0);
    });

    it('stops server before deleting if running', async () => {
      const server = service.addServer({
        name: 'Test Server',
        transport: 'stdio',
        command: 'node',
      });

      await service.startServer(server.id);
      expect(service.getRunningServers()).toHaveLength(1);

      service.deleteServer(server.id);

      expect(service.getRunningServers()).toHaveLength(0);
    });

    it('emits server-deleted event', () => {
      const server = service.addServer({
        name: 'Test Server',
        transport: 'stdio',
        command: 'node',
      });

      const listener = vi.fn();
      service.on('server:deleted', listener);

      service.deleteServer(server.id);

      expect(listener).toHaveBeenCalled();
    });
  });

  describe('setServerEnabled', () => {
    it('enables server', () => {
      const server = service.addServer({
        name: 'Test Server',
        transport: 'stdio',
        command: 'node',
      });

      service.setServerEnabled(server.id, true);

      const updated = service.getServer(server.id);
      expect(updated?.enabled).toBe(true);
    });

    it('disables server', () => {
      const server = service.addServer({
        name: 'Test Server',
        transport: 'stdio',
        command: 'node',
      });

      service.setServerEnabled(server.id, false);

      const updated = service.getServer(server.id);
      expect(updated?.enabled).toBe(false);
    });

    it('stops running server when disabled', async () => {
      const server = service.addServer({
        name: 'Test Server',
        transport: 'stdio',
        command: 'node',
      });

      await service.startServer(server.id);
      expect(service.getRunningServers()).toHaveLength(1);

      service.setServerEnabled(server.id, false);

      expect(service.getRunningServers()).toHaveLength(0);
    });

    it('emits server-updated event', () => {
      const server = service.addServer({
        name: 'Test Server',
        transport: 'stdio',
        command: 'node',
      });

      const listener = vi.fn();
      service.on('server:toggled', listener);

      service.setServerEnabled(server.id, false);

      expect(listener).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // SERVER LIFECYCLE
  // ==========================================================================

  describe('startServer', () => {
    it('starts a stdio server successfully', async () => {
      const server = service.addServer({
        name: 'Test Server',
        transport: 'stdio',
        command: 'node',
        args: ['test.js'],
      });

      const result = await service.startServer(server.id);

      expect(result).toBe(true);
      expect(service.getRunningServers()).toHaveLength(1);
    });

    it('adds server to running servers map', async () => {
      const server = service.addServer({
        name: 'Test Server',
        transport: 'stdio',
        command: 'node',
      });

      await service.startServer(server.id);

      const runningInfo = service.getRunningServerInfo(server.id);
      expect(runningInfo).toBeDefined();
      expect(runningInfo?.server.id).toBe(server.id);
      expect(runningInfo?.connected).toBe(true);
    });

    it('emits server-started event', async () => {
      const server = service.addServer({
        name: 'Test Server',
        transport: 'stdio',
        command: 'node',
      });

      const listener = vi.fn();
      service.on('server:connected', listener);

      await service.startServer(server.id);

      expect(listener).toHaveBeenCalled();
    });

    it('returns false if server does not exist', async () => {
      const result = await service.startServer(999);
      expect(result).toBe(false);
    });

    it('returns false if server is disabled', async () => {
      const server = service.addServer({
        name: 'Test Server',
        transport: 'stdio',
        command: 'node',
      });
      service.setServerEnabled(server.id, false);

      const result = await service.startServer(server.id);

      expect(result).toBe(false);
    });

    it('does not start server if already running', async () => {
      const server = service.addServer({
        name: 'Test Server',
        transport: 'stdio',
        command: 'node',
      });

      await service.startServer(server.id);
      const result = await service.startServer(server.id);

      // Implementation returns true when server is already running
      expect(result).toBe(true);
      expect(loggerCalls.debug.some(c => c.message.includes('already running'))).toBe(true);
    });
  });

  describe('stopServer', () => {
    it('stops a running server', async () => {
      const server = service.addServer({
        name: 'Test Server',
        transport: 'stdio',
        command: 'node',
      });

      await service.startServer(server.id);
      expect(service.getRunningServers()).toHaveLength(1);

      service.stopServer(server.id);

      expect(service.getRunningServers()).toHaveLength(0);
    });

    it('kills the child process', async () => {
      const server = service.addServer({
        name: 'Test Server',
        transport: 'stdio',
        command: 'node',
      });

      await service.startServer(server.id);
      const runningInfo = service.getRunningServerInfo(server.id);
      const killSpy = runningInfo?.process?.kill;

      service.stopServer(server.id);

      expect(killSpy).toHaveBeenCalled();
    });

    it('emits server-stopped event', async () => {
      const server = service.addServer({
        name: 'Test Server',
        transport: 'stdio',
        command: 'node',
      });

      await service.startServer(server.id);

      const listener = vi.fn();
      service.on('server:disconnected', listener);

      service.stopServer(server.id);

      expect(listener).toHaveBeenCalled();
    });

    it('handles stopping non-running server gracefully', () => {
      const server = service.addServer({
        name: 'Test Server',
        transport: 'stdio',
        command: 'node',
      });

      expect(() => service.stopServer(server.id)).not.toThrow();
    });
  });

  describe('stopAllServers', () => {
    it('stops all running servers', async () => {
      const server1 = service.addServer({
        name: 'Server 1',
        transport: 'stdio',
        command: 'node',
      });
      const server2 = service.addServer({
        name: 'Server 2',
        transport: 'stdio',
        command: 'node',
      });

      await service.startServer(server1.id);
      await service.startServer(server2.id);
      expect(service.getRunningServers()).toHaveLength(2);

      service.stopAllServers();

      expect(service.getRunningServers()).toHaveLength(0);
    });

    it('handles empty running servers list', () => {
      expect(() => service.stopAllServers()).not.toThrow();
    });
  });

  describe('restartServer', () => {
    it('restarts a running server', async () => {
      const server = service.addServer({
        name: 'Test Server',
        transport: 'stdio',
        command: 'node',
      });

      await service.startServer(server.id);
      const result = await service.restartServer(server.id);

      expect(result).toBe(true);
      expect(service.getRunningServers()).toHaveLength(1);
    });

    it('starts server if not currently running', async () => {
      const server = service.addServer({
        name: 'Test Server',
        transport: 'stdio',
        command: 'node',
      });

      const result = await service.restartServer(server.id);

      expect(result).toBe(true);
      expect(service.getRunningServers()).toHaveLength(1);
    });
  });

  describe('getRunningServerInfo', () => {
    it('returns info for running server', async () => {
      const server = service.addServer({
        name: 'Test Server',
        transport: 'stdio',
        command: 'node',
      });

      await service.startServer(server.id);
      const info = service.getRunningServerInfo(server.id);

      expect(info).toBeDefined();
      expect(info?.server.id).toBe(server.id);
      expect(info?.connected).toBe(true);
    });

    it('returns undefined for non-running server', () => {
      const server = service.addServer({
        name: 'Test Server',
        transport: 'stdio',
        command: 'node',
      });

      const info = service.getRunningServerInfo(server.id);
      expect(info).toBeUndefined();
    });
  });

  describe('getRunningServers', () => {
    it('returns empty array when no servers running', () => {
      expect(service.getRunningServers()).toHaveLength(0);
    });

    it('returns all running servers', async () => {
      const server1 = service.addServer({
        name: 'Server 1',
        transport: 'stdio',
        command: 'node',
      });
      const server2 = service.addServer({
        name: 'Server 2',
        transport: 'stdio',
        command: 'node',
      });

      await service.startServer(server1.id);
      await service.startServer(server2.id);

      const running = service.getRunningServers();
      expect(running).toHaveLength(2);
      expect(running.map(r => r.server.id)).toContain(server1.id);
      expect(running.map(r => r.server.id)).toContain(server2.id);
    });
  });

  // ==========================================================================
  // MARKETPLACE
  // ==========================================================================

  describe('getMarketplaceServers', () => {
    it('returns array of marketplace servers', () => {
      const servers = service.getMarketplaceServers();
      expect(Array.isArray(servers)).toBe(true);
      expect(servers.length).toBeGreaterThan(0);
    });

    it('returns servers with required properties', () => {
      const servers = service.getMarketplaceServers();
      const server = servers[0];

      expect(server).toHaveProperty('id');
      expect(server).toHaveProperty('name');
      expect(server).toHaveProperty('description');
      expect(server).toHaveProperty('category');
      expect(server).toHaveProperty('transport');
    });
  });

  describe('getMarketplaceServer', () => {
    it('retrieves server by id', () => {
      const allServers = service.getMarketplaceServers();
      const firstId = allServers[0].id;

      const server = service.getMarketplaceServer(firstId);

      expect(server).toBeDefined();
      expect(server?.id).toBe(firstId);
    });

    it('returns undefined for non-existent id', () => {
      const server = service.getMarketplaceServer('non-existent-id');
      expect(server).toBeUndefined();
    });
  });

  describe('getPopularServers', () => {
    it('returns only popular servers', () => {
      const popular = service.getPopularServers();
      expect(Array.isArray(popular)).toBe(true);
      expect(popular.every(s => s.popular === true)).toBe(true);
    });
  });

  describe('getServersByCategory', () => {
    it('filters servers by category', () => {
      const productivity = service.getServersByCategory('productivity');
      expect(Array.isArray(productivity)).toBe(true);
      expect(productivity.every(s => s.category === 'productivity')).toBe(true);
    });

    it('returns empty array for category with no servers', () => {
      const custom = service.getServersByCategory('custom');
      expect(Array.isArray(custom)).toBe(true);
    });
  });

  describe('installMarketplaceServer', () => {
    it('installs marketplace server successfully', async () => {
      const allServers = service.getMarketplaceServers();
      const serverToInstall = allServers.find(s => !s.requiredEnv || s.requiredEnv.length === 0);

      if (serverToInstall) {
        const installed = await service.installMarketplaceServer(serverToInstall.id);

        expect(installed).toBeDefined();
        expect(installed?.name).toBe(serverToInstall.name);
        expect(mockServers.size).toBe(1);
      }
    });

    it('throws error for missing required env vars', async () => {
      const allServers = service.getMarketplaceServers();
      const serverWithEnv = allServers.find(s => s.requiredEnv && s.requiredEnv.length > 0);

      if (serverWithEnv) {
        await expect(
          service.installMarketplaceServer(serverWithEnv.id, {})
        ).rejects.toThrow(/Missing required environment variable/);
      }
    });

    it('returns null for non-existent marketplace server', async () => {
      const installed = await service.installMarketplaceServer('non-existent-id');
      expect(installed).toBeNull();
    });

    it('installs with provided env vars', async () => {
      const allServers = service.getMarketplaceServers();
      const serverWithEnv = allServers.find(s => s.requiredEnv && s.requiredEnv.length > 0);

      if (serverWithEnv && serverWithEnv.requiredEnv) {
        const env: Record<string, string> = {};
        serverWithEnv.requiredEnv.forEach(key => {
          env[key] = 'test-value';
        });

        const installed = await service.installMarketplaceServer(serverWithEnv.id, env);

        expect(installed).toBeDefined();
        expect(installed?.name).toBe(serverWithEnv.name);
      }
    });

    it('installs to project scope when specified', async () => {
      const allServers = service.getMarketplaceServers();
      const serverToInstall = allServers.find(s => !s.requiredEnv || s.requiredEnv.length === 0);

      if (serverToInstall) {
        const installed = await service.installMarketplaceServer(
          serverToInstall.id,
          {},
          'project',
          '/test/project'
        );

        expect(installed).toBeDefined();
        expect(installed?.scope).toBe('project');
        expect(installed?.project_path).toBe('/test/project');
      }
    });

    it('logs installation progress', async () => {
      const allServers = service.getMarketplaceServers();
      const serverToInstall = allServers.find(s => !s.requiredEnv || s.requiredEnv.length === 0);

      if (serverToInstall) {
        await service.installMarketplaceServer(serverToInstall.id);

        expect(loggerCalls.info.some(c => c.message.includes('Installed marketplace server'))).toBe(true);
      }
    });
  });

  // ==========================================================================
  // CONFIGURATION INTEGRATION
  // ==========================================================================

  describe('readMCPConfig', () => {
    it('reads project config successfully', async () => {
      fsMockState.existsSyncResult = true;
      fsMockState.readFileResult = JSON.stringify({
        mcpServers: {
          'test-server': {
            command: 'node',
            args: ['test.js'],
          },
        },
      });

      const config = await service.readMCPConfig('/test/project');

      expect(config).toBeDefined();
      expect(config?.mcpServers).toHaveProperty('test-server');
    });

    it('returns null for non-existent config', async () => {
      fsMockState.existsSyncResult = false;

      const config = await service.readMCPConfig('/test/project');

      expect(config).toBeNull();
    });

    it('throws error for invalid JSON', async () => {
      fsMockState.existsSyncResult = true;
      fsMockState.readFileResult = 'invalid json';

      await expect(
        service.readMCPConfig('/test/project')
      ).rejects.toThrow('Failed to read MCP config');
    });
  });

  describe('writeMCPConfig', () => {
    it('writes config successfully', async () => {
      const config = {
        mcpServers: {
          'test-server': {
            command: 'node',
            args: ['test.js'],
          },
        },
      };

      await service.writeMCPConfig('/test/project', config);

      expect(loggerCalls.info.some(c => c.message.includes('Wrote MCP config'))).toBe(true);
    });

    it('handles write errors', async () => {
      fsMockState.writeFileResult = new Error('Write failed');

      const config = {
        mcpServers: {},
      };

      await expect(
        service.writeMCPConfig('/test/project', config)
      ).rejects.toThrow('Write failed');
    });
  });

  describe('readUserClaudeConfig', () => {
    it('reads user config successfully', async () => {
      fsMockState.existsSyncResult = true;
      fsMockState.readFileResult = JSON.stringify({
        mcpServers: {
          'user-server': {
            command: 'node',
          },
        },
      });

      const config = await service.readUserClaudeConfig();

      expect(config).toBeDefined();
      expect(config).toHaveProperty('mcpServers');
    });

    it('returns null for non-existent config', async () => {
      fsMockState.existsSyncResult = false;

      const config = await service.readUserClaudeConfig();

      expect(config).toBeNull();
    });
  });

  describe('syncToClaudeConfig', () => {
    it('syncs servers to Claude config', async () => {
      service.addServer({
        name: 'Test Server',
        transport: 'stdio',
        command: 'node',
        scope: 'user',
      });

      fsMockState.existsSyncResult = true;
      fsMockState.readFileResult = JSON.stringify({});

      await service.syncToClaudeConfig();

      expect(loggerCalls.info.some(c => c.message.includes('Updated user MCP config'))).toBe(true);
    });

    it('handles sync errors gracefully', async () => {
      service.addServer({
        name: 'Test Server',
        transport: 'stdio',
        command: 'node',
        scope: 'user',
      });

      fsMockState.existsSyncResult = true;
      fsMockState.readFileResult = JSON.stringify({});
      fsMockState.writeFileResult = new Error('Sync failed');

      await expect(
        service.syncToClaudeConfig()
      ).rejects.toThrow('Failed to sync user MCP config');
    });
  });

  // ==========================================================================
  // SHUTDOWN
  // ==========================================================================

  describe('shutdown', () => {
    it('stops all running servers on shutdown', async () => {
      const server = service.addServer({
        name: 'Test Server',
        transport: 'stdio',
        command: 'node',
      });

      await service.startServer(server.id);
      expect(service.getRunningServers()).toHaveLength(1);

      service.shutdown();

      expect(service.getRunningServers()).toHaveLength(0);
    });

    it('removes all event listeners', () => {
      service.on('test-event', () => {});
      expect(service.listenerCount('test-event')).toBe(1);

      service.shutdown();

      expect(service.listenerCount('test-event')).toBe(0);
    });

    it('logs shutdown message', () => {
      service.shutdown();
      expect(loggerCalls.info.some(c => c.message.includes('shut down'))).toBe(true);
    });
  });

  // ==========================================================================
  // SINGLETON FUNCTIONS
  // ==========================================================================

  describe('getMCPManager', () => {
    afterEach(() => {
      shutdownMCPManager();
    });

    it('returns singleton instance', () => {
      const instance1 = getMCPManager();
      const instance2 = getMCPManager();

      expect(instance1).toBe(instance2);
    });

    it('creates instance on first call', () => {
      const instance = getMCPManager();
      expect(instance).toBeInstanceOf(MCPManagerService);
    });
  });

  describe('shutdownMCPManager', () => {
    it('shuts down singleton instance', () => {
      const instance = getMCPManager();
      const shutdownSpy = vi.spyOn(instance, 'shutdown');

      shutdownMCPManager();

      expect(shutdownSpy).toHaveBeenCalled();
    });

    it('allows creating new instance after shutdown', () => {
      const instance1 = getMCPManager();
      shutdownMCPManager();
      const instance2 = getMCPManager();

      expect(instance1).not.toBe(instance2);
    });

    it('handles shutdown when no instance exists', () => {
      expect(() => shutdownMCPManager()).not.toThrow();
    });
  });
});
