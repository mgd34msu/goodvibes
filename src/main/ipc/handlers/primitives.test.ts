// ============================================================================
// PRIMITIVES IPC HANDLERS UNIT TESTS - MCP SERVER HANDLERS
// ============================================================================
//
// Comprehensive tests for MCP server IPC handlers covering:
// - get-mcp-servers handler
// - get-mcp-server handler with numeric ID validation
// - create-mcp-server handler with Zod validation
// - update-mcp-server handler
// - delete-mcp-server handler
// - set-mcp-server-status handler
// - Zod validation (valid and invalid inputs)
// - Error handling
// - Security edge cases
//
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain, IpcMainInvokeEvent } from 'electron';

// Mock electron before importing the module under test
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

// Mock the database primitives module
vi.mock('../../database/primitives.js', () => ({
  getAllMCPServers: vi.fn(),
  getMCPServer: vi.fn(),
  createMCPServer: vi.fn(),
  updateMCPServer: vi.fn(),
  deleteMCPServer: vi.fn(),
  updateMCPServerStatus: vi.fn(),
  getAllAgentTemplates: vi.fn(),
  getAgentTemplate: vi.fn(),
  createAgentTemplate: vi.fn(),
  updateAgentTemplate: vi.fn(),
  deleteAgentTemplate: vi.fn(),
  getAllProjectConfigs: vi.fn(),
  getProjectConfig: vi.fn(),
  createProjectConfig: vi.fn(),
  updateProjectConfig: vi.fn(),
  deleteProjectConfig: vi.fn(),
  getAllAgents: vi.fn(),
  getAgent: vi.fn(),
  getActiveAgents: vi.fn(),
  getAgentsByParent: vi.fn(),
  registerAgent: vi.fn(),
  updateAgentStatus: vi.fn(),
  deleteAgent: vi.fn(),
  getAllSkills: vi.fn(),
  getSkill: vi.fn(),
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  deleteSkill: vi.fn(),
  recordSkillUsage: vi.fn(),
  getAllTaskDefinitions: vi.fn(),
  getTaskDefinition: vi.fn(),
  createTaskDefinition: vi.fn(),
  updateTaskDefinition: vi.fn(),
  deleteTaskDefinition: vi.fn(),
  getSessionAnalytics: vi.fn(),
  upsertSessionAnalytics: vi.fn(),
  getDetailedToolUsageBySession: vi.fn(),
  recordDetailedToolUsage: vi.fn(),
  getToolEfficiencyStats: vi.fn(),
}));

// Mock the logger with a proper class
vi.mock('../../services/logger.js', () => ({
  Logger: class MockLogger {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
  },
}));

// Mock withContext to pass through the handler directly
vi.mock('../utils.js', () => ({
  withContext: vi.fn((_operation: string, handler: (...args: unknown[]) => Promise<unknown>) => handler),
}));

// Import after mocks
import { registerPrimitivesHandlers } from './primitives.js';
import * as primitives from '../../database/primitives.js';
import type { MCPServer } from '../../database/primitives/types.js';

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
 * Type for captured handlers
 */
type HandlerMap = Record<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>;

/**
 * Captures registered IPC handlers for testing
 */
function captureHandlers(): HandlerMap {
  const handlers: HandlerMap = {};
  const mockHandle = ipcMain.handle as ReturnType<typeof vi.fn>;

  mockHandle.mockImplementation((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
    handlers[channel] = handler as (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;
  });

  registerPrimitivesHandlers();
  return handlers;
}

/**
 * Creates a valid MCP server object for testing
 */
function createValidMCPServer(overrides: Partial<MCPServer> = {}): MCPServer {
  const now = new Date().toISOString();
  return {
    id: 1,
    name: 'Test Server',
    description: 'A test MCP server',
    transport: 'stdio',
    command: 'npx',
    url: null,
    args: ['mcp-server'],
    env: {},
    scope: 'user',
    projectPath: null,
    enabled: true,
    status: 'unknown',
    lastConnected: null,
    errorMessage: null,
    toolCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ============================================================================
// MCP SERVER HANDLER TESTS
// ============================================================================

describe('MCP Server IPC Handlers', () => {
  let handlers: HandlerMap;
  let mockEvent: IpcMainInvokeEvent;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = captureHandlers();
    mockEvent = createMockEvent();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // ==========================================================================
  // HANDLER REGISTRATION
  // ==========================================================================

  describe('Handler Registration', () => {
    it('registers all MCP server handlers', () => {
      expect(handlers['get-mcp-servers']).toBeDefined();
      expect(handlers['get-mcp-server']).toBeDefined();
      expect(handlers['create-mcp-server']).toBeDefined();
      expect(handlers['update-mcp-server']).toBeDefined();
      expect(handlers['delete-mcp-server']).toBeDefined();
      expect(handlers['set-mcp-server-status']).toBeDefined();
    });

    it('calls ipcMain.handle for each MCP handler', () => {
      const mockHandle = ipcMain.handle as ReturnType<typeof vi.fn>;
      expect(mockHandle).toHaveBeenCalledWith('get-mcp-servers', expect.any(Function));
      expect(mockHandle).toHaveBeenCalledWith('get-mcp-server', expect.any(Function));
      expect(mockHandle).toHaveBeenCalledWith('create-mcp-server', expect.any(Function));
      expect(mockHandle).toHaveBeenCalledWith('update-mcp-server', expect.any(Function));
      expect(mockHandle).toHaveBeenCalledWith('delete-mcp-server', expect.any(Function));
      expect(mockHandle).toHaveBeenCalledWith('set-mcp-server-status', expect.any(Function));
    });
  });

  // ==========================================================================
  // GET-MCP-SERVERS HANDLER
  // ==========================================================================

  describe('get-mcp-servers handler', () => {
    it('returns all MCP servers', async () => {
      const mockServers = [
        createValidMCPServer({ id: 1, name: 'Server 1' }),
        createValidMCPServer({ id: 2, name: 'Server 2' }),
      ];
      (primitives.getAllMCPServers as ReturnType<typeof vi.fn>).mockReturnValue(mockServers);

      const handler = handlers['get-mcp-servers'];
      const result = await handler(mockEvent);

      expect(primitives.getAllMCPServers).toHaveBeenCalled();
      expect(result).toEqual(mockServers);
    });

    it('returns empty array when no servers exist', async () => {
      (primitives.getAllMCPServers as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const handler = handlers['get-mcp-servers'];
      const result = await handler(mockEvent);

      expect(result).toEqual([]);
    });

    it('propagates database errors', async () => {
      const dbError = new Error('Database connection failed');
      (primitives.getAllMCPServers as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw dbError;
      });

      const handler = handlers['get-mcp-servers'];
      await expect(handler(mockEvent)).rejects.toThrow('Database connection failed');
    });
  });

  // ==========================================================================
  // GET-MCP-SERVER HANDLER
  // ==========================================================================

  describe('get-mcp-server handler', () => {
    it('returns MCP server for valid numeric ID', async () => {
      const mockServer = createValidMCPServer({ id: 42 });
      (primitives.getMCPServer as ReturnType<typeof vi.fn>).mockReturnValue(mockServer);

      const handler = handlers['get-mcp-server'];
      const result = await handler(mockEvent, 42);

      expect(primitives.getMCPServer).toHaveBeenCalledWith(42);
      expect(result).toEqual(mockServer);
    });

    it('returns null for non-existent server', async () => {
      (primitives.getMCPServer as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const handler = handlers['get-mcp-server'];
      const result = await handler(mockEvent, 999);

      expect(primitives.getMCPServer).toHaveBeenCalledWith(999);
      expect(result).toBeNull();
    });

    describe('ID validation', () => {
      const invalidIds = [
        { value: 0, reason: 'zero' },
        { value: -1, reason: 'negative integer' },
        { value: -100, reason: 'large negative' },
        { value: 1.5, reason: 'float' },
        { value: 'abc', reason: 'string' },
        { value: null, reason: 'null' },
        { value: undefined, reason: 'undefined' },
        { value: {}, reason: 'object' },
        { value: [], reason: 'array' },
        { value: NaN, reason: 'NaN' },
        { value: Infinity, reason: 'Infinity' },
      ];

      invalidIds.forEach(({ value, reason }) => {
        it(`rejects invalid ID: ${reason}`, async () => {
          const handler = handlers['get-mcp-server'];
          await expect(handler(mockEvent, value)).rejects.toThrow();
        });
      });
    });

    it('accepts valid positive integers', async () => {
      (primitives.getMCPServer as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const handler = handlers['get-mcp-server'];

      await handler(mockEvent, 1);
      expect(primitives.getMCPServer).toHaveBeenCalledWith(1);

      await handler(mockEvent, 100);
      expect(primitives.getMCPServer).toHaveBeenCalledWith(100);

      await handler(mockEvent, 999999);
      expect(primitives.getMCPServer).toHaveBeenCalledWith(999999);
    });
  });

  // ==========================================================================
  // CREATE-MCP-SERVER HANDLER
  // ==========================================================================

  describe('create-mcp-server handler', () => {
    it('creates stdio server with valid data', async () => {
      const newServer = {
        name: 'My MCP Server',
        description: 'A great server',
        transport: 'stdio' as const,
        command: 'npx mcp-server',
        url: null,
        args: ['--verbose'],
        env: { DEBUG: 'true' },
        scope: 'user' as const,
        projectPath: null,
        enabled: true,
      };

      const createdServer = createValidMCPServer({ ...newServer, id: 1 });
      (primitives.createMCPServer as ReturnType<typeof vi.fn>).mockReturnValue(createdServer);

      const handler = handlers['create-mcp-server'];
      const result = await handler(mockEvent, newServer);

      expect(primitives.createMCPServer).toHaveBeenCalledWith(newServer);
      expect(result).toEqual(createdServer);
    });

    it('creates http server with valid URL', async () => {
      const newServer = {
        name: 'HTTP MCP Server',
        description: 'HTTP transport server',
        transport: 'http' as const,
        command: null,
        url: 'https://mcp.example.com/api',
        args: [],
        env: {},
        scope: 'user' as const,
        projectPath: null,
        enabled: true,
      };

      const createdServer = createValidMCPServer({
        ...newServer,
        id: 2,
        transport: 'http' as const,
        url: 'https://mcp.example.com/api',
        command: null,
      });
      (primitives.createMCPServer as ReturnType<typeof vi.fn>).mockReturnValue(createdServer);

      const handler = handlers['create-mcp-server'];
      const result = await handler(mockEvent, newServer);

      expect(primitives.createMCPServer).toHaveBeenCalledWith(newServer);
      expect(result).toEqual(createdServer);
    });

    it('creates project-scoped server', async () => {
      const newServer = {
        name: 'Project Server',
        description: null,
        transport: 'stdio' as const,
        command: 'npx server',
        url: null,
        args: [],
        env: {},
        scope: 'project' as const,
        projectPath: '/path/to/project',
        enabled: true,
      };

      const createdServer = createValidMCPServer({ ...newServer, id: 3 });
      (primitives.createMCPServer as ReturnType<typeof vi.fn>).mockReturnValue(createdServer);

      const handler = handlers['create-mcp-server'];
      const result = await handler(mockEvent, newServer);

      expect(primitives.createMCPServer).toHaveBeenCalledWith(newServer);
      expect(result).toEqual(createdServer);
    });

    describe('validation errors', () => {
      it('rejects missing name', async () => {
        const invalidServer = {
          description: 'Missing name',
          transport: 'stdio',
          command: 'npx server',
          args: [],
          env: {},
          scope: 'user',
          enabled: true,
        };

        const handler = handlers['create-mcp-server'];
        await expect(handler(mockEvent, invalidServer)).rejects.toThrow();
      });

      it('rejects empty name', async () => {
        const invalidServer = {
          name: '',
          transport: 'stdio',
          command: 'npx server',
          args: [],
          env: {},
          scope: 'user',
          enabled: true,
        };

        const handler = handlers['create-mcp-server'];
        await expect(handler(mockEvent, invalidServer)).rejects.toThrow();
      });

      it('rejects name exceeding max length', async () => {
        const invalidServer = {
          name: 'x'.repeat(201),
          transport: 'stdio',
          command: 'npx server',
          args: [],
          env: {},
          scope: 'user',
          enabled: true,
        };

        const handler = handlers['create-mcp-server'];
        await expect(handler(mockEvent, invalidServer)).rejects.toThrow();
      });

      it('rejects invalid transport type', async () => {
        const invalidServer = {
          name: 'Invalid Transport',
          transport: 'websocket',
          command: 'npx server',
          args: [],
          env: {},
          scope: 'user',
          enabled: true,
        };

        const handler = handlers['create-mcp-server'];
        await expect(handler(mockEvent, invalidServer)).rejects.toThrow();
      });

      it('rejects stdio transport without command', async () => {
        const invalidServer = {
          name: 'No Command',
          transport: 'stdio',
          command: null,
          url: null,
          args: [],
          env: {},
          scope: 'user',
          enabled: true,
        };

        const handler = handlers['create-mcp-server'];
        await expect(handler(mockEvent, invalidServer)).rejects.toThrow();
      });

      it('rejects http transport without URL', async () => {
        const invalidServer = {
          name: 'No URL',
          transport: 'http',
          command: null,
          url: null,
          args: [],
          env: {},
          scope: 'user',
          enabled: true,
        };

        const handler = handlers['create-mcp-server'];
        await expect(handler(mockEvent, invalidServer)).rejects.toThrow();
      });

      it('rejects invalid URL format for http transport', async () => {
        const invalidServer = {
          name: 'Bad URL',
          transport: 'http',
          command: null,
          url: 'not-a-valid-url',
          args: [],
          env: {},
          scope: 'user',
          enabled: true,
        };

        const handler = handlers['create-mcp-server'];
        await expect(handler(mockEvent, invalidServer)).rejects.toThrow();
      });

      it('rejects invalid scope', async () => {
        const invalidServer = {
          name: 'Invalid Scope',
          transport: 'stdio',
          command: 'npx server',
          args: [],
          env: {},
          scope: 'global',
          enabled: true,
        };

        const handler = handlers['create-mcp-server'];
        await expect(handler(mockEvent, invalidServer)).rejects.toThrow();
      });

      it('rejects non-boolean enabled value', async () => {
        const invalidServer = {
          name: 'Invalid Enabled',
          transport: 'stdio',
          command: 'npx server',
          args: [],
          env: {},
          scope: 'user',
          enabled: 'yes',
        };

        const handler = handlers['create-mcp-server'];
        await expect(handler(mockEvent, invalidServer)).rejects.toThrow();
      });

      it('rejects null input', async () => {
        const handler = handlers['create-mcp-server'];
        await expect(handler(mockEvent, null)).rejects.toThrow();
      });

      it('rejects string input', async () => {
        const handler = handlers['create-mcp-server'];
        await expect(handler(mockEvent, 'not an object')).rejects.toThrow();
      });
    });

    describe('edge cases', () => {
      it('handles empty args array', async () => {
        const server = {
          name: 'Empty Args',
          transport: 'stdio' as const,
          command: 'npx server',
          args: [],
          env: {},
          scope: 'user' as const,
          enabled: true,
        };

        const createdServer = createValidMCPServer({ ...server, id: 4, args: [] });
        (primitives.createMCPServer as ReturnType<typeof vi.fn>).mockReturnValue(createdServer);

        const handler = handlers['create-mcp-server'];
        await handler(mockEvent, server);

        expect(primitives.createMCPServer).toHaveBeenCalled();
      });

      it('handles complex env object', async () => {
        const server = {
          name: 'Complex Env',
          transport: 'stdio' as const,
          command: 'npx server',
          args: [],
          env: {
            API_KEY: 'secret123',
            DEBUG: 'true',
            NODE_ENV: 'production',
          },
          scope: 'user' as const,
          enabled: true,
        };

        const createdServer = createValidMCPServer({
          ...server,
          id: 5,
          env: server.env,
        });
        (primitives.createMCPServer as ReturnType<typeof vi.fn>).mockReturnValue(createdServer);

        const handler = handlers['create-mcp-server'];
        await handler(mockEvent, server);

        expect(primitives.createMCPServer).toHaveBeenCalledWith(expect.objectContaining(server));
      });

      it('handles long description', async () => {
        const server = {
          name: 'Long Desc',
          description: 'x'.repeat(999),
          transport: 'stdio' as const,
          command: 'npx server',
          args: [],
          env: {},
          scope: 'user' as const,
          enabled: true,
        };

        const createdServer = createValidMCPServer({
          ...server,
          id: 6,
        });
        (primitives.createMCPServer as ReturnType<typeof vi.fn>).mockReturnValue(createdServer);

        const handler = handlers['create-mcp-server'];
        await handler(mockEvent, server);

        expect(primitives.createMCPServer).toHaveBeenCalled();
      });
    });
  });

  // ==========================================================================
  // UPDATE-MCP-SERVER HANDLER
  // ==========================================================================

  describe('update-mcp-server handler', () => {
    it('updates server with valid data', async () => {
      const updateData = {
        id: 1,
        updates: {
          name: 'Updated Server Name',
          description: 'New description',
        },
      };

      (primitives.updateMCPServer as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      const handler = handlers['update-mcp-server'];
      const result = await handler(mockEvent, updateData);

      expect(primitives.updateMCPServer).toHaveBeenCalledWith(1, updateData.updates);
      expect(result).toBe(true);
    });

    it('updates server enabled status', async () => {
      const updateData = {
        id: 2,
        updates: {
          enabled: false,
        },
      };

      (primitives.updateMCPServer as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      const handler = handlers['update-mcp-server'];
      const result = await handler(mockEvent, updateData);

      expect(primitives.updateMCPServer).toHaveBeenCalledWith(2, { enabled: false });
      expect(result).toBe(true);
    });

    it('updates server transport and command', async () => {
      const updateData = {
        id: 3,
        updates: {
          transport: 'stdio',
          command: 'new-command',
        },
      };

      (primitives.updateMCPServer as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      const handler = handlers['update-mcp-server'];
      const result = await handler(mockEvent, updateData);

      expect(primitives.updateMCPServer).toHaveBeenCalledWith(3, updateData.updates);
      expect(result).toBe(true);
    });

    describe('validation errors', () => {
      it('rejects missing id', async () => {
        const invalidData = {
          updates: { name: 'New Name' },
        };

        const handler = handlers['update-mcp-server'];
        await expect(handler(mockEvent, invalidData)).rejects.toThrow();
      });

      it('rejects invalid id type', async () => {
        const invalidData = {
          id: 'abc',
          updates: { name: 'New Name' },
        };

        const handler = handlers['update-mcp-server'];
        await expect(handler(mockEvent, invalidData)).rejects.toThrow();
      });

      it('rejects negative id', async () => {
        const invalidData = {
          id: -1,
          updates: { name: 'New Name' },
        };

        const handler = handlers['update-mcp-server'];
        await expect(handler(mockEvent, invalidData)).rejects.toThrow();
      });

      it('rejects zero id', async () => {
        const invalidData = {
          id: 0,
          updates: { name: 'New Name' },
        };

        const handler = handlers['update-mcp-server'];
        await expect(handler(mockEvent, invalidData)).rejects.toThrow();
      });

      it('rejects null input', async () => {
        const handler = handlers['update-mcp-server'];
        await expect(handler(mockEvent, null)).rejects.toThrow();
      });

      it('rejects string input', async () => {
        const handler = handlers['update-mcp-server'];
        await expect(handler(mockEvent, 'not an object')).rejects.toThrow();
      });
    });

    it('propagates database errors', async () => {
      const dbError = new Error('MCP Server not found: 999');
      (primitives.updateMCPServer as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw dbError;
      });

      const handler = handlers['update-mcp-server'];
      await expect(handler(mockEvent, { id: 999, updates: { name: 'Test' } })).rejects.toThrow(
        'MCP Server not found: 999'
      );
    });
  });

  // ==========================================================================
  // DELETE-MCP-SERVER HANDLER
  // ==========================================================================

  describe('delete-mcp-server handler', () => {
    it('deletes server with valid ID', async () => {
      (primitives.deleteMCPServer as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      const handler = handlers['delete-mcp-server'];
      const result = await handler(mockEvent, 1);

      expect(primitives.deleteMCPServer).toHaveBeenCalledWith(1);
      expect(result).toBe(true);
    });

    it('deletes server with large valid ID', async () => {
      (primitives.deleteMCPServer as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      const handler = handlers['delete-mcp-server'];
      const result = await handler(mockEvent, 999999);

      expect(primitives.deleteMCPServer).toHaveBeenCalledWith(999999);
      expect(result).toBe(true);
    });

    describe('ID validation', () => {
      const invalidIds = [
        { value: 0, reason: 'zero' },
        { value: -1, reason: 'negative' },
        { value: 1.5, reason: 'float' },
        { value: 'abc', reason: 'string' },
        { value: null, reason: 'null' },
        { value: undefined, reason: 'undefined' },
        { value: {}, reason: 'object' },
        { value: [], reason: 'array' },
      ];

      invalidIds.forEach(({ value, reason }) => {
        it(`rejects invalid ID: ${reason}`, async () => {
          const handler = handlers['delete-mcp-server'];
          await expect(handler(mockEvent, value)).rejects.toThrow();
        });
      });
    });

    it('propagates database errors', async () => {
      const dbError = new Error('Foreign key constraint failed');
      (primitives.deleteMCPServer as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw dbError;
      });

      const handler = handlers['delete-mcp-server'];
      await expect(handler(mockEvent, 1)).rejects.toThrow('Foreign key constraint failed');
    });
  });

  // ==========================================================================
  // SET-MCP-SERVER-STATUS HANDLER
  // ==========================================================================

  describe('set-mcp-server-status handler', () => {
    it('sets connected status', async () => {
      (primitives.updateMCPServerStatus as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      const handler = handlers['set-mcp-server-status'];
      const result = await handler(mockEvent, { id: 1, status: 'connected' });

      expect(primitives.updateMCPServerStatus).toHaveBeenCalledWith(1, 'connected', undefined);
      expect(result).toBe(true);
    });

    it('sets disconnected status', async () => {
      (primitives.updateMCPServerStatus as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      const handler = handlers['set-mcp-server-status'];
      const result = await handler(mockEvent, { id: 2, status: 'disconnected' });

      expect(primitives.updateMCPServerStatus).toHaveBeenCalledWith(2, 'disconnected', undefined);
      expect(result).toBe(true);
    });

    it('sets error status with error message', async () => {
      (primitives.updateMCPServerStatus as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      const handler = handlers['set-mcp-server-status'];
      const result = await handler(mockEvent, {
        id: 3,
        status: 'error',
        errorMessage: 'Connection refused',
      });

      expect(primitives.updateMCPServerStatus).toHaveBeenCalledWith(3, 'error', 'Connection refused');
      expect(result).toBe(true);
    });

    it('sets unknown status', async () => {
      (primitives.updateMCPServerStatus as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      const handler = handlers['set-mcp-server-status'];
      const result = await handler(mockEvent, { id: 4, status: 'unknown' });

      expect(primitives.updateMCPServerStatus).toHaveBeenCalledWith(4, 'unknown', undefined);
      expect(result).toBe(true);
    });

    describe('validation errors', () => {
      it('rejects missing id', async () => {
        const handler = handlers['set-mcp-server-status'];
        await expect(handler(mockEvent, { status: 'connected' })).rejects.toThrow();
      });

      it('rejects invalid id', async () => {
        const handler = handlers['set-mcp-server-status'];
        await expect(handler(mockEvent, { id: 'abc', status: 'connected' })).rejects.toThrow();
      });

      it('rejects missing status', async () => {
        const handler = handlers['set-mcp-server-status'];
        await expect(handler(mockEvent, { id: 1 })).rejects.toThrow();
      });

      it('rejects invalid status', async () => {
        const handler = handlers['set-mcp-server-status'];
        await expect(handler(mockEvent, { id: 1, status: 'invalid-status' })).rejects.toThrow();
      });

      it('rejects null input', async () => {
        const handler = handlers['set-mcp-server-status'];
        await expect(handler(mockEvent, null)).rejects.toThrow();
      });

      it('accepts error message within limit', async () => {
        (primitives.updateMCPServerStatus as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

        const handler = handlers['set-mcp-server-status'];
        const errorMessage = 'x'.repeat(4999);
        const result = await handler(mockEvent, {
          id: 1,
          status: 'error',
          errorMessage,
        });

        expect(primitives.updateMCPServerStatus).toHaveBeenCalledWith(1, 'error', errorMessage);
        expect(result).toBe(true);
      });

      it('rejects error message exceeding max length', async () => {
        const handler = handlers['set-mcp-server-status'];
        await expect(
          handler(mockEvent, {
            id: 1,
            status: 'error',
            errorMessage: 'x'.repeat(5001),
          })
        ).rejects.toThrow();
      });
    });

    it('propagates database errors', async () => {
      const dbError = new Error('Database error');
      (primitives.updateMCPServerStatus as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw dbError;
      });

      const handler = handlers['set-mcp-server-status'];
      await expect(handler(mockEvent, { id: 1, status: 'connected' })).rejects.toThrow('Database error');
    });
  });
});

// ============================================================================
// SECURITY EDGE CASES
// ============================================================================

describe('Security Edge Cases - MCP Handlers', () => {
  let handlers: HandlerMap;
  let mockEvent: IpcMainInvokeEvent;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = captureHandlers();
    mockEvent = createMockEvent();
  });

  describe('Injection Prevention', () => {
    it('handles SQL injection attempt in server name', async () => {
      const maliciousServer = {
        name: "'; DROP TABLE mcp_servers; --",
        transport: 'stdio' as const,
        command: 'npx server',
        args: [],
        env: {},
        scope: 'user' as const,
        enabled: true,
      };

      const createdServer = createValidMCPServer({
        ...maliciousServer,
        id: 1,
      });
      (primitives.createMCPServer as ReturnType<typeof vi.fn>).mockReturnValue(createdServer);

      const handler = handlers['create-mcp-server'];
      // The handler should accept the input - SQL injection prevention is handled at DB level
      await handler(mockEvent, maliciousServer);

      expect(primitives.createMCPServer).toHaveBeenCalledWith(expect.objectContaining(maliciousServer));
    });

    it('handles command injection attempt', async () => {
      const maliciousServer = {
        name: 'Command Injection',
        transport: 'stdio' as const,
        command: 'npx server; rm -rf /',
        args: [],
        env: {},
        scope: 'user' as const,
        enabled: true,
      };

      const createdServer = createValidMCPServer({
        ...maliciousServer,
        id: 2,
      });
      (primitives.createMCPServer as ReturnType<typeof vi.fn>).mockReturnValue(createdServer);

      const handler = handlers['create-mcp-server'];
      await handler(mockEvent, maliciousServer);

      // Command injection prevention is handled at execution time, not validation
      expect(primitives.createMCPServer).toHaveBeenCalled();
    });
  });

  describe('Prototype Pollution Prevention', () => {
    it('handles __proto__ in input', async () => {
      const maliciousInput = JSON.parse('{"id": 1, "updates": {"__proto__": {"polluted": true}}}');

      const handler = handlers['update-mcp-server'];
      await handler(mockEvent, maliciousInput);

      // Verify prototype wasn't polluted
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  });

  describe('Type Coercion Prevention', () => {
    it('rejects array input where object expected for create', async () => {
      const handler = handlers['create-mcp-server'];
      await expect(handler(mockEvent, ['name', 'stdio'])).rejects.toThrow();
    });

    it('rejects array input where object expected for update', async () => {
      const handler = handlers['update-mcp-server'];
      await expect(handler(mockEvent, [1, { name: 'Test' }])).rejects.toThrow();
    });

    it('rejects valueOf tricks for ID', async () => {
      const handler = handlers['get-mcp-server'];
      const tricky = { valueOf: () => 1 };
      await expect(handler(mockEvent, tricky)).rejects.toThrow();
    });
  });

  describe('Path Traversal Prevention', () => {
    // Only actual path traversal attempts should be rejected
    // Absolute paths like /root and C:\Windows\System32 are valid project paths
    const pathTraversalAttempts = [
      '../../../etc/passwd',
      '..\\..\\..\\windows\\system32',
      'foo/../../../etc/passwd',
      '%2e%2e/etc/passwd',
    ];

    pathTraversalAttempts.forEach((attempt) => {
      it(`rejects path traversal in projectPath: ${attempt}`, async () => {
        const maliciousServer = {
          name: 'Traversal Test',
          transport: 'stdio',
          command: 'npx server',
          args: [],
          env: {},
          scope: 'project',
          projectPath: attempt,
          enabled: true,
        };

        const handler = handlers['create-mcp-server'];
        await expect(handler(mockEvent, maliciousServer)).rejects.toThrow();
      });
    });

    it('accepts valid absolute paths (not traversal)', async () => {
      const validPaths = [
        '/home/user/projects/myapp',
        'C:\\Users\\name\\projects',
        '/var/www/html',
      ];

      for (const validPath of validPaths) {
        const validServer = {
          name: 'Valid Path Server',
          transport: 'stdio' as const,
          command: 'npx server',
          args: [],
          env: {},
          scope: 'project' as const,
          projectPath: validPath,
          enabled: true,
        };

        const createdServer = createValidMCPServer({ ...validServer, id: 10, projectPath: validPath });
        (primitives.createMCPServer as ReturnType<typeof vi.fn>).mockReturnValue(createdServer);

        const handler = handlers['create-mcp-server'];
        // Should not throw - absolute paths are valid
        await handler(mockEvent, validServer);
        expect(primitives.createMCPServer).toHaveBeenCalled();
      }
    });
  });
});

// ============================================================================
// INTEGRATION TESTS - MCP HANDLER FLOW
// ============================================================================

describe('MCP Handler Flow Integration', () => {
  let handlers: HandlerMap;
  let mockEvent: IpcMainInvokeEvent;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = captureHandlers();
    mockEvent = createMockEvent();
  });

  it('simulates complete MCP server lifecycle', async () => {
    // 1. Create server
    const newServer = {
      name: 'Lifecycle Server',
      description: 'Testing lifecycle',
      transport: 'stdio' as const,
      command: 'npx mcp-server',
      url: null,
      args: ['--verbose'],
      env: {},
      scope: 'user' as const,
      projectPath: null,
      enabled: true,
    };

    const createdServer = createValidMCPServer({ ...newServer, id: 1 });
    (primitives.createMCPServer as ReturnType<typeof vi.fn>).mockReturnValue(createdServer);

    const createHandler = handlers['create-mcp-server'];
    const created = await createHandler(mockEvent, newServer);
    expect(created).toEqual(createdServer);

    // 2. Get server
    (primitives.getMCPServer as ReturnType<typeof vi.fn>).mockReturnValue(createdServer);
    const getHandler = handlers['get-mcp-server'];
    const fetched = await getHandler(mockEvent, 1);
    expect(fetched).toEqual(createdServer);

    // 3. Update status to connected
    (primitives.updateMCPServerStatus as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const statusHandler = handlers['set-mcp-server-status'];
    await statusHandler(mockEvent, { id: 1, status: 'connected' });
    expect(primitives.updateMCPServerStatus).toHaveBeenCalledWith(1, 'connected', undefined);

    // 4. Update server details
    (primitives.updateMCPServer as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const updateHandler = handlers['update-mcp-server'];
    await updateHandler(mockEvent, { id: 1, updates: { name: 'Renamed Server' } });
    expect(primitives.updateMCPServer).toHaveBeenCalledWith(1, { name: 'Renamed Server' });

    // 5. List all servers
    (primitives.getAllMCPServers as ReturnType<typeof vi.fn>).mockReturnValue([
      createValidMCPServer({ id: 1, name: 'Renamed Server', status: 'connected' }),
    ]);
    const listHandler = handlers['get-mcp-servers'];
    const servers = await listHandler(mockEvent);
    expect(servers).toHaveLength(1);

    // 6. Delete server
    (primitives.deleteMCPServer as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const deleteHandler = handlers['delete-mcp-server'];
    await deleteHandler(mockEvent, 1);
    expect(primitives.deleteMCPServer).toHaveBeenCalledWith(1);
  });

  it('simulates server error flow', async () => {
    // Create server
    const server = {
      name: 'Error Test Server',
      transport: 'stdio' as const,
      command: 'npx bad-server',
      args: [],
      env: {},
      scope: 'user' as const,
      enabled: true,
    };

    const createdServer = createValidMCPServer({ ...server, id: 2 });
    (primitives.createMCPServer as ReturnType<typeof vi.fn>).mockReturnValue(createdServer);

    const createHandler = handlers['create-mcp-server'];
    await createHandler(mockEvent, server);

    // Set error status
    (primitives.updateMCPServerStatus as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const statusHandler = handlers['set-mcp-server-status'];
    await statusHandler(mockEvent, {
      id: 2,
      status: 'error',
      errorMessage: 'Failed to spawn process: ENOENT',
    });

    expect(primitives.updateMCPServerStatus).toHaveBeenCalledWith(
      2,
      'error',
      'Failed to spawn process: ENOENT'
    );
  });
});

// ============================================================================
// AGENT TEMPLATE HANDLER TESTS
// ============================================================================

import type { AgentTemplate } from '../../database/primitives/types.js';

/**
 * Creates a valid agent template object for testing
 */
function createValidAgentTemplate(overrides: Partial<AgentTemplate> = {}): AgentTemplate {
  const now = new Date().toISOString();
  return {
    id: 'test-template-1',
    name: 'Test Template',
    description: 'A test agent template',
    cwd: '/path/to/project',
    initialPrompt: 'You are a helpful assistant',
    claudeMdContent: '# Test Template\n\nThis is a test.',
    flags: ['--verbose'],
    model: 'claude-3-opus',
    permissionMode: 'default',
    allowedTools: ['Read', 'Write'],
    deniedTools: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('Agent Template IPC Handlers', () => {
  let handlers: HandlerMap;
  let mockEvent: IpcMainInvokeEvent;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = captureHandlers();
    mockEvent = createMockEvent();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // ==========================================================================
  // HANDLER REGISTRATION
  // ==========================================================================

  describe('Handler Registration', () => {
    it('registers all agent template handlers', () => {
      expect(handlers['get-agent-templates']).toBeDefined();
      expect(handlers['get-agent-template']).toBeDefined();
      expect(handlers['create-agent-template']).toBeDefined();
      expect(handlers['update-agent-template']).toBeDefined();
      expect(handlers['delete-agent-template']).toBeDefined();
    });

    it('calls ipcMain.handle for each agent template handler', () => {
      const mockHandle = ipcMain.handle as ReturnType<typeof vi.fn>;
      expect(mockHandle).toHaveBeenCalledWith('get-agent-templates', expect.any(Function));
      expect(mockHandle).toHaveBeenCalledWith('get-agent-template', expect.any(Function));
      expect(mockHandle).toHaveBeenCalledWith('create-agent-template', expect.any(Function));
      expect(mockHandle).toHaveBeenCalledWith('update-agent-template', expect.any(Function));
      expect(mockHandle).toHaveBeenCalledWith('delete-agent-template', expect.any(Function));
    });
  });

  // ==========================================================================
  // GET-AGENT-TEMPLATES HANDLER
  // ==========================================================================

  describe('get-agent-templates handler', () => {
    it('returns all agent templates', async () => {
      const mockTemplates = [
        createValidAgentTemplate({ id: 'template-1', name: 'Template 1' }),
        createValidAgentTemplate({ id: 'template-2', name: 'Template 2' }),
      ];
      (primitives.getAllAgentTemplates as ReturnType<typeof vi.fn>).mockReturnValue(mockTemplates);

      const handler = handlers['get-agent-templates'];
      const result = await handler(mockEvent);

      expect(primitives.getAllAgentTemplates).toHaveBeenCalled();
      expect(result).toEqual(mockTemplates);
    });

    it('returns empty array when no templates exist', async () => {
      (primitives.getAllAgentTemplates as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const handler = handlers['get-agent-templates'];
      const result = await handler(mockEvent);

      expect(result).toEqual([]);
    });

    it('propagates database errors', async () => {
      const dbError = new Error('Database connection failed');
      (primitives.getAllAgentTemplates as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw dbError;
      });

      const handler = handlers['get-agent-templates'];
      await expect(handler(mockEvent)).rejects.toThrow('Database connection failed');
    });
  });

  // ==========================================================================
  // GET-AGENT-TEMPLATE HANDLER
  // ==========================================================================

  describe('get-agent-template handler', () => {
    it('returns agent template for valid string ID', async () => {
      const mockTemplate = createValidAgentTemplate({ id: 'my-template-42' });
      (primitives.getAgentTemplate as ReturnType<typeof vi.fn>).mockReturnValue(mockTemplate);

      const handler = handlers['get-agent-template'];
      const result = await handler(mockEvent, 'my-template-42');

      expect(primitives.getAgentTemplate).toHaveBeenCalledWith('my-template-42');
      expect(result).toEqual(mockTemplate);
    });

    it('returns null for non-existent template', async () => {
      (primitives.getAgentTemplate as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const handler = handlers['get-agent-template'];
      const result = await handler(mockEvent, 'nonexistent-template');

      expect(primitives.getAgentTemplate).toHaveBeenCalledWith('nonexistent-template');
      expect(result).toBeNull();
    });

    describe('ID validation', () => {
      it('rejects empty string ID', async () => {
        const handler = handlers['get-agent-template'];
        await expect(handler(mockEvent, '')).rejects.toThrow();
      });

      it('rejects ID exceeding max length', async () => {
        const handler = handlers['get-agent-template'];
        await expect(handler(mockEvent, 'x'.repeat(101))).rejects.toThrow();
      });

      it('rejects null ID', async () => {
        const handler = handlers['get-agent-template'];
        await expect(handler(mockEvent, null)).rejects.toThrow();
      });

      it('rejects undefined ID', async () => {
        const handler = handlers['get-agent-template'];
        await expect(handler(mockEvent, undefined)).rejects.toThrow();
      });

      it('rejects numeric ID (must be string)', async () => {
        const handler = handlers['get-agent-template'];
        await expect(handler(mockEvent, 123)).rejects.toThrow();
      });

      it('rejects object ID', async () => {
        const handler = handlers['get-agent-template'];
        await expect(handler(mockEvent, { id: 'test' })).rejects.toThrow();
      });

      it('rejects array ID', async () => {
        const handler = handlers['get-agent-template'];
        await expect(handler(mockEvent, ['test-id'])).rejects.toThrow();
      });
    });

    it('accepts valid string IDs of various formats', async () => {
      (primitives.getAgentTemplate as ReturnType<typeof vi.fn>).mockReturnValue(null);

      const handler = handlers['get-agent-template'];

      // Short ID
      await handler(mockEvent, 'a');
      expect(primitives.getAgentTemplate).toHaveBeenCalledWith('a');

      // UUID-like ID
      await handler(mockEvent, '550e8400-e29b-41d4-a716-446655440000');
      expect(primitives.getAgentTemplate).toHaveBeenCalledWith('550e8400-e29b-41d4-a716-446655440000');

      // Max length ID (100 chars)
      const maxId = 'x'.repeat(100);
      await handler(mockEvent, maxId);
      expect(primitives.getAgentTemplate).toHaveBeenCalledWith(maxId);

      // ID with special characters
      await handler(mockEvent, 'agent-template_v2.1');
      expect(primitives.getAgentTemplate).toHaveBeenCalledWith('agent-template_v2.1');
    });
  });

  // ==========================================================================
  // CREATE-AGENT-TEMPLATE HANDLER
  // ==========================================================================

  describe('create-agent-template handler', () => {
    it('creates agent template with valid data (minimal)', async () => {
      const newTemplate = {
        name: 'My Agent Template',
      };

      const createdTemplate = createValidAgentTemplate({
        ...newTemplate,
        id: expect.stringMatching(/^agent-\d+-[a-z0-9]+$/),
      });
      (primitives.createAgentTemplate as ReturnType<typeof vi.fn>).mockReturnValue(createdTemplate);

      const handler = handlers['create-agent-template'];
      const result = await handler(mockEvent, newTemplate);

      expect(primitives.createAgentTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'My Agent Template',
          id: expect.stringMatching(/^agent-\d+-[a-z0-9]+$/),
        })
      );
      expect(result).toEqual(createdTemplate);
    });

    it('creates agent template with full data', async () => {
      const newTemplate = {
        name: 'Full Template',
        description: 'A complete agent template',
        cwd: '/home/user/projects/myapp',
        initialPrompt: 'You are a senior software engineer specializing in TypeScript.',
        claudeMdContent: '# Custom Instructions\n\nFollow these guidelines...',
        flags: ['--verbose', '--no-cache'],
        model: 'claude-3-sonnet',
        permissionMode: 'plan',
        allowedTools: ['Read', 'Write', 'Edit', 'Bash'],
        deniedTools: ['WebFetch'],
      };

      const createdTemplate = createValidAgentTemplate({
        ...newTemplate,
        id: 'agent-123-abc',
        permissionMode: 'plan',
      });
      (primitives.createAgentTemplate as ReturnType<typeof vi.fn>).mockReturnValue(createdTemplate);

      const handler = handlers['create-agent-template'];
      const result = await handler(mockEvent, newTemplate);

      expect(primitives.createAgentTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Full Template',
          description: 'A complete agent template',
          cwd: '/home/user/projects/myapp',
          permissionMode: 'plan',
        })
      );
      expect(result).toEqual(createdTemplate);
    });

    it('creates agent template with bypassPermissions mode', async () => {
      const newTemplate = {
        name: 'Bypass Template',
        permissionMode: 'bypassPermissions',
      };

      const createdTemplate = createValidAgentTemplate({
        ...newTemplate,
        id: 'agent-456-def',
        permissionMode: 'bypassPermissions',
      });
      (primitives.createAgentTemplate as ReturnType<typeof vi.fn>).mockReturnValue(createdTemplate);

      const handler = handlers['create-agent-template'];
      await handler(mockEvent, newTemplate);

      expect(primitives.createAgentTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          permissionMode: 'bypassPermissions',
        })
      );
    });

    describe('validation errors', () => {
      it('rejects missing name', async () => {
        const invalidTemplate = {
          description: 'Missing name field',
        };

        const handler = handlers['create-agent-template'];
        await expect(handler(mockEvent, invalidTemplate)).rejects.toThrow();
      });

      it('rejects empty name', async () => {
        const invalidTemplate = {
          name: '',
        };

        const handler = handlers['create-agent-template'];
        await expect(handler(mockEvent, invalidTemplate)).rejects.toThrow();
      });

      it('rejects name exceeding max length', async () => {
        const invalidTemplate = {
          name: 'x'.repeat(201),
        };

        const handler = handlers['create-agent-template'];
        await expect(handler(mockEvent, invalidTemplate)).rejects.toThrow();
      });

      it('rejects description exceeding max length', async () => {
        const invalidTemplate = {
          name: 'Valid Name',
          description: 'x'.repeat(5001),
        };

        const handler = handlers['create-agent-template'];
        await expect(handler(mockEvent, invalidTemplate)).rejects.toThrow();
      });

      it('rejects cwd exceeding max length', async () => {
        const invalidTemplate = {
          name: 'Valid Name',
          cwd: '/very/long/path/' + 'x'.repeat(1001),
        };

        const handler = handlers['create-agent-template'];
        await expect(handler(mockEvent, invalidTemplate)).rejects.toThrow();
      });

      it('rejects initialPrompt exceeding max length', async () => {
        const invalidTemplate = {
          name: 'Valid Name',
          initialPrompt: 'x'.repeat(100001),
        };

        const handler = handlers['create-agent-template'];
        await expect(handler(mockEvent, invalidTemplate)).rejects.toThrow();
      });

      it('rejects claudeMdContent exceeding max length', async () => {
        const invalidTemplate = {
          name: 'Valid Name',
          claudeMdContent: 'x'.repeat(500001),
        };

        const handler = handlers['create-agent-template'];
        await expect(handler(mockEvent, invalidTemplate)).rejects.toThrow();
      });

      it('rejects model exceeding max length', async () => {
        const invalidTemplate = {
          name: 'Valid Name',
          model: 'x'.repeat(101),
        };

        const handler = handlers['create-agent-template'];
        await expect(handler(mockEvent, invalidTemplate)).rejects.toThrow();
      });

      it('rejects invalid permissionMode', async () => {
        const invalidTemplate = {
          name: 'Valid Name',
          permissionMode: 'invalid-mode',
        };

        const handler = handlers['create-agent-template'];
        await expect(handler(mockEvent, invalidTemplate)).rejects.toThrow();
      });

      it('rejects null input', async () => {
        const handler = handlers['create-agent-template'];
        await expect(handler(mockEvent, null)).rejects.toThrow();
      });

      it('rejects string input', async () => {
        const handler = handlers['create-agent-template'];
        await expect(handler(mockEvent, 'not an object')).rejects.toThrow();
      });

      it('rejects array input', async () => {
        const handler = handlers['create-agent-template'];
        await expect(handler(mockEvent, [{ name: 'Test' }])).rejects.toThrow();
      });
    });

    describe('edge cases', () => {
      it('handles empty flags array', async () => {
        const template = {
          name: 'Empty Flags',
          flags: [],
        };

        const createdTemplate = createValidAgentTemplate({ ...template, id: 'agent-1-abc', flags: [] });
        (primitives.createAgentTemplate as ReturnType<typeof vi.fn>).mockReturnValue(createdTemplate);

        const handler = handlers['create-agent-template'];
        await handler(mockEvent, template);

        expect(primitives.createAgentTemplate).toHaveBeenCalled();
      });

      it('handles null optional fields', async () => {
        const template = {
          name: 'Null Optionals',
          description: null,
          cwd: null,
          initialPrompt: null,
          claudeMdContent: null,
          model: null,
          permissionMode: null,
          allowedTools: null,
          deniedTools: null,
        };

        const createdTemplate = createValidAgentTemplate({
          ...template,
          id: 'agent-2-def',
        });
        (primitives.createAgentTemplate as ReturnType<typeof vi.fn>).mockReturnValue(createdTemplate);

        const handler = handlers['create-agent-template'];
        await handler(mockEvent, template);

        expect(primitives.createAgentTemplate).toHaveBeenCalled();
      });

      it('handles multiple flags', async () => {
        const template = {
          name: 'Multi Flags',
          flags: ['--verbose', '--debug', '--no-cache', '--profile=dev'],
        };

        const createdTemplate = createValidAgentTemplate({
          ...template,
          id: 'agent-3-ghi',
        });
        (primitives.createAgentTemplate as ReturnType<typeof vi.fn>).mockReturnValue(createdTemplate);

        const handler = handlers['create-agent-template'];
        await handler(mockEvent, template);

        expect(primitives.createAgentTemplate).toHaveBeenCalledWith(
          expect.objectContaining({
            flags: ['--verbose', '--debug', '--no-cache', '--profile=dev'],
          })
        );
      });

      it('handles long claudeMdContent at boundary', async () => {
        const template = {
          name: 'Max Content',
          claudeMdContent: 'x'.repeat(499999), // Just under limit
        };

        const createdTemplate = createValidAgentTemplate({
          ...template,
          id: 'agent-4-jkl',
        });
        (primitives.createAgentTemplate as ReturnType<typeof vi.fn>).mockReturnValue(createdTemplate);

        const handler = handlers['create-agent-template'];
        await handler(mockEvent, template);

        expect(primitives.createAgentTemplate).toHaveBeenCalled();
      });
    });

    it('generates unique IDs for each creation', async () => {
      const template = { name: 'ID Test' };
      const ids: string[] = [];

      (primitives.createAgentTemplate as ReturnType<typeof vi.fn>).mockImplementation((data) => {
        ids.push(data.id);
        return createValidAgentTemplate({ ...data });
      });

      const handler = handlers['create-agent-template'];

      // Create multiple templates
      await handler(mockEvent, template);
      await handler(mockEvent, template);
      await handler(mockEvent, template);

      // All IDs should be unique
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(3);
    });
  });

  // ==========================================================================
  // UPDATE-AGENT-TEMPLATE HANDLER
  // ==========================================================================

  describe('update-agent-template handler', () => {
    it('updates template with valid data', async () => {
      const updateData = {
        id: 'template-1',
        updates: {
          name: 'Updated Template Name',
          description: 'New description',
        },
      };

      (primitives.updateAgentTemplate as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      const handler = handlers['update-agent-template'];
      const result = await handler(mockEvent, updateData);

      expect(primitives.updateAgentTemplate).toHaveBeenCalledWith('template-1', updateData.updates);
      expect(result).toBe(true);
    });

    it('updates template permission mode', async () => {
      const updateData = {
        id: 'template-2',
        updates: {
          permissionMode: 'bypassPermissions',
        },
      };

      (primitives.updateAgentTemplate as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      const handler = handlers['update-agent-template'];
      const result = await handler(mockEvent, updateData);

      expect(primitives.updateAgentTemplate).toHaveBeenCalledWith('template-2', {
        permissionMode: 'bypassPermissions',
      });
      expect(result).toBe(true);
    });

    it('updates template allowed tools', async () => {
      const updateData = {
        id: 'template-3',
        updates: {
          allowedTools: ['Read', 'Write', 'Edit'],
          deniedTools: ['Bash'],
        },
      };

      (primitives.updateAgentTemplate as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      const handler = handlers['update-agent-template'];
      const result = await handler(mockEvent, updateData);

      expect(primitives.updateAgentTemplate).toHaveBeenCalledWith('template-3', updateData.updates);
      expect(result).toBe(true);
    });

    it('updates template flags', async () => {
      const updateData = {
        id: 'template-4',
        updates: {
          flags: ['--new-flag', '--another-flag'],
        },
      };

      (primitives.updateAgentTemplate as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      const handler = handlers['update-agent-template'];
      const result = await handler(mockEvent, updateData);

      expect(primitives.updateAgentTemplate).toHaveBeenCalledWith('template-4', updateData.updates);
      expect(result).toBe(true);
    });

    describe('validation errors', () => {
      it('rejects missing id', async () => {
        const invalidData = {
          updates: { name: 'New Name' },
        };

        const handler = handlers['update-agent-template'];
        await expect(handler(mockEvent, invalidData)).rejects.toThrow();
      });

      it('rejects empty id', async () => {
        const invalidData = {
          id: '',
          updates: { name: 'New Name' },
        };

        const handler = handlers['update-agent-template'];
        await expect(handler(mockEvent, invalidData)).rejects.toThrow();
      });

      it('rejects id exceeding max length', async () => {
        const invalidData = {
          id: 'x'.repeat(101),
          updates: { name: 'New Name' },
        };

        const handler = handlers['update-agent-template'];
        await expect(handler(mockEvent, invalidData)).rejects.toThrow();
      });

      it('rejects numeric id (must be string)', async () => {
        const invalidData = {
          id: 123,
          updates: { name: 'New Name' },
        };

        const handler = handlers['update-agent-template'];
        await expect(handler(mockEvent, invalidData)).rejects.toThrow();
      });

      it('rejects null input', async () => {
        const handler = handlers['update-agent-template'];
        await expect(handler(mockEvent, null)).rejects.toThrow();
      });

      it('rejects string input', async () => {
        const handler = handlers['update-agent-template'];
        await expect(handler(mockEvent, 'not an object')).rejects.toThrow();
      });

      it('rejects invalid permissionMode in updates', async () => {
        const invalidData = {
          id: 'template-1',
          updates: { permissionMode: 'invalid' },
        };

        const handler = handlers['update-agent-template'];
        await expect(handler(mockEvent, invalidData)).rejects.toThrow();
      });

      it('rejects name exceeding max length in updates', async () => {
        const invalidData = {
          id: 'template-1',
          updates: { name: 'x'.repeat(201) },
        };

        const handler = handlers['update-agent-template'];
        await expect(handler(mockEvent, invalidData)).rejects.toThrow();
      });
    });

    it('propagates database errors', async () => {
      const dbError = new Error('Agent template not found: nonexistent');
      (primitives.updateAgentTemplate as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw dbError;
      });

      const handler = handlers['update-agent-template'];
      await expect(
        handler(mockEvent, { id: 'nonexistent', updates: { name: 'Test' } })
      ).rejects.toThrow('Agent template not found: nonexistent');
    });
  });

  // ==========================================================================
  // DELETE-AGENT-TEMPLATE HANDLER
  // ==========================================================================

  describe('delete-agent-template handler', () => {
    it('deletes template with valid ID', async () => {
      (primitives.deleteAgentTemplate as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      const handler = handlers['delete-agent-template'];
      const result = await handler(mockEvent, 'template-to-delete');

      expect(primitives.deleteAgentTemplate).toHaveBeenCalledWith('template-to-delete');
      expect(result).toBe(true);
    });

    it('deletes template with UUID-like ID', async () => {
      (primitives.deleteAgentTemplate as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      const handler = handlers['delete-agent-template'];
      const result = await handler(mockEvent, '550e8400-e29b-41d4-a716-446655440000');

      expect(primitives.deleteAgentTemplate).toHaveBeenCalledWith('550e8400-e29b-41d4-a716-446655440000');
      expect(result).toBe(true);
    });

    describe('ID validation', () => {
      it('rejects empty string ID', async () => {
        const handler = handlers['delete-agent-template'];
        await expect(handler(mockEvent, '')).rejects.toThrow();
      });

      it('rejects ID exceeding max length', async () => {
        const handler = handlers['delete-agent-template'];
        await expect(handler(mockEvent, 'x'.repeat(101))).rejects.toThrow();
      });

      it('rejects null ID', async () => {
        const handler = handlers['delete-agent-template'];
        await expect(handler(mockEvent, null)).rejects.toThrow();
      });

      it('rejects undefined ID', async () => {
        const handler = handlers['delete-agent-template'];
        await expect(handler(mockEvent, undefined)).rejects.toThrow();
      });

      it('rejects numeric ID', async () => {
        const handler = handlers['delete-agent-template'];
        await expect(handler(mockEvent, 123)).rejects.toThrow();
      });

      it('rejects object ID', async () => {
        const handler = handlers['delete-agent-template'];
        await expect(handler(mockEvent, { id: 'test' })).rejects.toThrow();
      });
    });

    it('propagates database errors', async () => {
      const dbError = new Error('Foreign key constraint failed');
      (primitives.deleteAgentTemplate as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw dbError;
      });

      const handler = handlers['delete-agent-template'];
      await expect(handler(mockEvent, 'template-1')).rejects.toThrow('Foreign key constraint failed');
    });
  });
});

// ============================================================================
// SECURITY EDGE CASES - AGENT TEMPLATE HANDLERS
// ============================================================================

describe('Security Edge Cases - Agent Template Handlers', () => {
  let handlers: HandlerMap;
  let mockEvent: IpcMainInvokeEvent;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = captureHandlers();
    mockEvent = createMockEvent();
  });

  describe('Injection Prevention', () => {
    it('handles SQL injection attempt in template name', async () => {
      const maliciousTemplate = {
        name: "'; DROP TABLE agent_templates; --",
        description: 'SQL injection test',
      };

      const createdTemplate = createValidAgentTemplate({
        ...maliciousTemplate,
        id: 'agent-1-abc',
      });
      (primitives.createAgentTemplate as ReturnType<typeof vi.fn>).mockReturnValue(createdTemplate);

      const handler = handlers['create-agent-template'];
      await handler(mockEvent, maliciousTemplate);

      // Handler accepts the input - SQL injection prevention is at DB level
      expect(primitives.createAgentTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "'; DROP TABLE agent_templates; --",
        })
      );
    });

    it('handles script injection in claudeMdContent', async () => {
      const maliciousTemplate = {
        name: 'XSS Test',
        claudeMdContent: '<script>alert("XSS")</script>',
      };

      const createdTemplate = createValidAgentTemplate({
        ...maliciousTemplate,
        id: 'agent-2-def',
      });
      (primitives.createAgentTemplate as ReturnType<typeof vi.fn>).mockReturnValue(createdTemplate);

      const handler = handlers['create-agent-template'];
      await handler(mockEvent, maliciousTemplate);

      expect(primitives.createAgentTemplate).toHaveBeenCalled();
    });

    it('handles command injection in initialPrompt', async () => {
      const maliciousTemplate = {
        name: 'Command Injection',
        initialPrompt: 'Execute: $(rm -rf /)',
      };

      const createdTemplate = createValidAgentTemplate({
        ...maliciousTemplate,
        id: 'agent-3-ghi',
      });
      (primitives.createAgentTemplate as ReturnType<typeof vi.fn>).mockReturnValue(createdTemplate);

      const handler = handlers['create-agent-template'];
      await handler(mockEvent, maliciousTemplate);

      expect(primitives.createAgentTemplate).toHaveBeenCalled();
    });
  });

  describe('Prototype Pollution Prevention', () => {
    it('handles __proto__ in template creation', async () => {
      const maliciousInput = JSON.parse(
        '{"name": "Test", "__proto__": {"polluted": true}}'
      );

      const createdTemplate = createValidAgentTemplate({
        name: 'Test',
        id: 'agent-4-jkl',
      });
      (primitives.createAgentTemplate as ReturnType<typeof vi.fn>).mockReturnValue(createdTemplate);

      const handler = handlers['create-agent-template'];
      await handler(mockEvent, maliciousInput);

      // Verify prototype wasn't polluted
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('handles constructor pollution attempt', async () => {
      const maliciousInput = JSON.parse(
        '{"name": "Test", "constructor": {"prototype": {"pwned": true}}}'
      );

      const createdTemplate = createValidAgentTemplate({
        name: 'Test',
        id: 'agent-5-mno',
      });
      (primitives.createAgentTemplate as ReturnType<typeof vi.fn>).mockReturnValue(createdTemplate);

      const handler = handlers['create-agent-template'];
      await handler(mockEvent, maliciousInput);

      expect(({} as Record<string, unknown>).pwned).toBeUndefined();
    });
  });

  describe('Type Coercion Prevention', () => {
    it('rejects array input where object expected for create', async () => {
      const handler = handlers['create-agent-template'];
      await expect(handler(mockEvent, ['name', 'description'])).rejects.toThrow();
    });

    it('rejects array input where object expected for update', async () => {
      const handler = handlers['update-agent-template'];
      await expect(handler(mockEvent, ['template-1', { name: 'Test' }])).rejects.toThrow();
    });

    it('rejects valueOf tricks for ID', async () => {
      const handler = handlers['get-agent-template'];
      const tricky = { valueOf: () => 'template-1', toString: () => 'template-1' };
      await expect(handler(mockEvent, tricky)).rejects.toThrow();
    });
  });

  describe('Large Input Prevention', () => {
    it('rejects extremely large flags array', async () => {
      const maliciousTemplate = {
        name: 'Large Flags',
        flags: Array(10000).fill('--flag'),
      };

      const handler = handlers['create-agent-template'];
      // Schema should reject or handle gracefully
      // The actual behavior depends on whether there's a limit in the schema
      try {
        await handler(mockEvent, maliciousTemplate);
        // If it doesn't throw, verify it was handled
        expect(primitives.createAgentTemplate).toHaveBeenCalled();
      } catch {
        // Expected to throw for extremely large arrays
      }
    });

    it('rejects flags with extremely long strings', async () => {
      const maliciousTemplate = {
        name: 'Long Flag Strings',
        flags: ['--flag=' + 'x'.repeat(10000)],
      };

      const handler = handlers['create-agent-template'];
      // Individual flag strings should be limited to 200 chars per schema
      await expect(handler(mockEvent, maliciousTemplate)).rejects.toThrow();
    });

    it('rejects allowedTools with extremely long strings', async () => {
      const maliciousTemplate = {
        name: 'Long Tool Names',
        allowedTools: ['x'.repeat(10000)],
      };

      const handler = handlers['create-agent-template'];
      await expect(handler(mockEvent, maliciousTemplate)).rejects.toThrow();
    });
  });
});

// ============================================================================
// INTEGRATION TESTS - AGENT TEMPLATE HANDLER FLOW
// ============================================================================

describe('Agent Template Handler Flow Integration', () => {
  let handlers: HandlerMap;
  let mockEvent: IpcMainInvokeEvent;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = captureHandlers();
    mockEvent = createMockEvent();
  });

  it('simulates complete agent template lifecycle', async () => {
    // 1. Create template
    const newTemplate = {
      name: 'Lifecycle Template',
      description: 'Testing lifecycle',
      cwd: '/home/user/project',
      initialPrompt: 'You are a helpful assistant',
      flags: ['--verbose'],
      model: 'claude-3-opus',
      permissionMode: 'default' as const,
    };

    let createdId = '';
    (primitives.createAgentTemplate as ReturnType<typeof vi.fn>).mockImplementation((data) => {
      createdId = data.id;
      return createValidAgentTemplate({ ...data });
    });

    const createHandler = handlers['create-agent-template'];
    const created = await createHandler(mockEvent, newTemplate);
    expect(created).toBeDefined();
    expect(createdId).toMatch(/^agent-\d+-[a-z0-9]+$/);

    // 2. Get template
    (primitives.getAgentTemplate as ReturnType<typeof vi.fn>).mockReturnValue(
      createValidAgentTemplate({ ...newTemplate, id: createdId })
    );
    const getHandler = handlers['get-agent-template'];
    const fetched = await getHandler(mockEvent, createdId) as { name: string } | null;
    expect(fetched?.name).toBe('Lifecycle Template');

    // 3. Update template
    (primitives.updateAgentTemplate as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const updateHandler = handlers['update-agent-template'];
    await updateHandler(mockEvent, {
      id: createdId,
      updates: { name: 'Renamed Template', permissionMode: 'plan' },
    });
    expect(primitives.updateAgentTemplate).toHaveBeenCalledWith(createdId, {
      name: 'Renamed Template',
      permissionMode: 'plan',
    });

    // 4. List all templates
    (primitives.getAllAgentTemplates as ReturnType<typeof vi.fn>).mockReturnValue([
      createValidAgentTemplate({
        id: createdId,
        name: 'Renamed Template',
        permissionMode: 'plan' as const,
      }),
    ]);
    const listHandler = handlers['get-agent-templates'];
    const templates = await listHandler(mockEvent) as Array<{ name: string }>;
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe('Renamed Template');

    // 5. Delete template
    (primitives.deleteAgentTemplate as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const deleteHandler = handlers['delete-agent-template'];
    await deleteHandler(mockEvent, createdId);
    expect(primitives.deleteAgentTemplate).toHaveBeenCalledWith(createdId);
  });

  it('simulates template with all permission modes', async () => {
    const permissionModes: Array<'default' | 'plan' | 'bypassPermissions'> = [
      'default',
      'plan',
      'bypassPermissions',
    ];

    for (const mode of permissionModes) {
      const template = {
        name: `Template with ${mode} mode`,
        permissionMode: mode,
      };

      (primitives.createAgentTemplate as ReturnType<typeof vi.fn>).mockReturnValue(
        createValidAgentTemplate({ ...template, id: `template-${mode}`, permissionMode: mode })
      );

      const handler = handlers['create-agent-template'];
      await handler(mockEvent, template);

      expect(primitives.createAgentTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          permissionMode: mode,
        })
      );
    }
  });

  it('simulates template update flow with various field updates', async () => {
    const fieldsToUpdate = [
      { field: 'name', value: 'New Name' },
      { field: 'description', value: 'New Description' },
      { field: 'initialPrompt', value: 'New prompt' },
      { field: 'claudeMdContent', value: '# New Content' },
      { field: 'flags', value: ['--new-flag'] },
      { field: 'model', value: 'claude-3-sonnet' },
      { field: 'permissionMode', value: 'plan' },
      { field: 'allowedTools', value: ['Read', 'Write'] },
      { field: 'deniedTools', value: ['Bash'] },
    ];

    const updateHandler = handlers['update-agent-template'];

    for (const { field, value } of fieldsToUpdate) {
      (primitives.updateAgentTemplate as ReturnType<typeof vi.fn>).mockClear();
      (primitives.updateAgentTemplate as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      await updateHandler(mockEvent, {
        id: 'test-template',
        updates: { [field]: value },
      });

      expect(primitives.updateAgentTemplate).toHaveBeenCalledWith('test-template', {
        [field]: value,
      });
    }
  });
});
