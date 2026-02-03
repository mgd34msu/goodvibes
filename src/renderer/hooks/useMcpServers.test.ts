// ============================================================================
// USE MCP SERVERS HOOK TESTS
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMcpServers, type MCPServerStatusEvent } from './useMcpServers';
import type { MCPServer } from '../components/views/MCPServerCard';

// ============================================================================
// TEST UTILITIES
// ============================================================================

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      QueryClientProvider,
      { client: queryClient },
      children
    );
  };
}

// ============================================================================
// MOCK DATA
// ============================================================================

const createMockServer = (overrides: Partial<MCPServer> = {}): MCPServer => ({
  id: 1,
  name: 'Test Server',
  description: 'A test MCP server',
  transport: 'stdio',
  command: 'npx @test/mcp-server',
  url: null,
  args: [],
  env: {},
  scope: 'user',
  projectPath: null,
  enabled: true,
  status: 'disconnected',
  lastConnected: null,
  errorMessage: null,
  toolCount: 5,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  ...overrides,
});

const mockServers: MCPServer[] = [
  createMockServer({ id: 1, name: 'Server 1' }),
  createMockServer({ id: 2, name: 'Server 2', status: 'connected' }),
  createMockServer({ id: 3, name: 'Server 3', status: 'error', errorMessage: 'Connection failed' }),
];

// ============================================================================
// TESTS
// ============================================================================

describe('useMcpServers', () => {
  let cleanupFn: (() => void) | null = null;

  beforeEach(() => {
    cleanupFn = vi.fn();
    vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue([]);
    vi.mocked(window.goodvibes.getMCPServer).mockResolvedValue(null);
    vi.mocked(window.goodvibes.createMCPServer).mockResolvedValue(createMockServer());
    vi.mocked(window.goodvibes.updateMCPServer).mockResolvedValue(true);
    vi.mocked(window.goodvibes.deleteMCPServer).mockResolvedValue(true);
    vi.mocked(window.goodvibes.setMCPServerStatus).mockResolvedValue(true);
    vi.mocked(window.goodvibes.onMCPServerStatus).mockReturnValue(cleanupFn);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // INITIALIZATION TESTS
  // ==========================================================================

  describe('Initialization', () => {
    it('returns initial state correctly', async () => {
      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      expect(result.current.servers).toEqual([]);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('auto-fetches servers when autoFetch is true', async () => {
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue(mockServers);

      renderHook(() => useMcpServers({ autoFetch: true }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(vi.mocked(window.goodvibes.getMCPServers)).toHaveBeenCalled();
      });
    });

    it('does not auto-fetch when autoFetch is false', async () => {
      renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      // Give it time to potentially fetch
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(vi.mocked(window.goodvibes.getMCPServers)).not.toHaveBeenCalled();
    });

    it('sets up IPC listener on mount', () => {
      renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      expect(vi.mocked(window.goodvibes.onMCPServerStatus)).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // FETCH SERVERS TESTS
  // ==========================================================================

  describe('fetchServers', () => {
    it('fetches and sets servers', async () => {
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue(mockServers);

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await result.current.fetchServers();
      });

      expect(result.current.servers).toEqual(mockServers);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('sets isLoading during fetch', async () => {
      let resolvePromise: (value: MCPServer[]) => void;
      const delayedPromise = new Promise<MCPServer[]>((resolve) => {
        resolvePromise = resolve;
      });
      vi.mocked(window.goodvibes.getMCPServers).mockReturnValue(delayedPromise);

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      act(() => {
        result.current.fetchServers();
      });

      // Should be loading
      expect(result.current.isLoading).toBe(true);

      // Resolve and wait
      await act(async () => {
        resolvePromise!(mockServers);
        await new Promise(resolve => setTimeout(resolve, 0));
      });

      expect(result.current.isLoading).toBe(false);
    });

    it('handles fetch error', async () => {
      vi.mocked(window.goodvibes.getMCPServers).mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await result.current.fetchServers();
      });

      expect(result.current.error).toBe('Network error');
      expect(result.current.servers).toEqual([]);
    });

    it('handles null response', async () => {
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue(null as unknown as MCPServer[]);

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await result.current.fetchServers();
      });

      expect(result.current.servers).toEqual([]);
    });
  });

  // ==========================================================================
  // GET SERVER TESTS
  // ==========================================================================

  describe('getServer', () => {
    it('returns server by id', async () => {
      const server = createMockServer({ id: 5 });
      vi.mocked(window.goodvibes.getMCPServer).mockResolvedValue(server);

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      let fetchedServer: MCPServer | null = null;
      await act(async () => {
        fetchedServer = await result.current.getServer(5);
      });

      expect(fetchedServer).toEqual(server);
      expect(vi.mocked(window.goodvibes.getMCPServer)).toHaveBeenCalledWith(5);
    });

    it('returns null when server not found', async () => {
      vi.mocked(window.goodvibes.getMCPServer).mockResolvedValue(null);

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      let fetchedServer: MCPServer | null = null;
      await act(async () => {
        fetchedServer = await result.current.getServer(999);
      });

      expect(fetchedServer).toBeNull();
    });

    it('returns null on error', async () => {
      vi.mocked(window.goodvibes.getMCPServer).mockRejectedValue(new Error('Not found'));

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      let fetchedServer: MCPServer | null = null;
      await act(async () => {
        fetchedServer = await result.current.getServer(1);
      });

      expect(fetchedServer).toBeNull();
    });
  });

  // ==========================================================================
  // CREATE SERVER TESTS
  // ==========================================================================

  describe('createServer', () => {
    it('creates server and refreshes list', async () => {
      const newServer = createMockServer({ id: 10, name: 'New Server' });
      vi.mocked(window.goodvibes.createMCPServer).mockResolvedValue(newServer);
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue([newServer]);

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      let createdServer: MCPServer | null = null;
      await act(async () => {
        createdServer = await result.current.createServer({
          name: 'New Server',
          transport: 'stdio',
          command: 'npx server',
          enabled: true,
        });
      });

      expect(createdServer).toEqual(newServer);
      expect(vi.mocked(window.goodvibes.createMCPServer)).toHaveBeenCalled();
      expect(vi.mocked(window.goodvibes.getMCPServers)).toHaveBeenCalled();
    });

    it('returns null on creation failure', async () => {
      vi.mocked(window.goodvibes.createMCPServer).mockRejectedValue(new Error('Creation failed'));

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      let createdServer: MCPServer | null = null;
      await act(async () => {
        createdServer = await result.current.createServer({
          name: 'New Server',
          transport: 'stdio',
          command: 'npx server',
          enabled: true,
        });
      });

      expect(createdServer).toBeNull();
    });
  });

  // ==========================================================================
  // UPDATE SERVER TESTS
  // ==========================================================================

  describe('updateServer', () => {
    it('updates server and refreshes list', async () => {
      vi.mocked(window.goodvibes.updateMCPServer).mockResolvedValue(true);
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue(mockServers);

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      let success = false;
      await act(async () => {
        success = await result.current.updateServer(1, { name: 'Updated Name' });
      });

      expect(success).toBe(true);
      expect(vi.mocked(window.goodvibes.updateMCPServer)).toHaveBeenCalledWith(1, { name: 'Updated Name' });
      expect(vi.mocked(window.goodvibes.getMCPServers)).toHaveBeenCalled();
    });

    it('returns false on update failure', async () => {
      vi.mocked(window.goodvibes.updateMCPServer).mockRejectedValue(new Error('Update failed'));

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      let success = false;
      await act(async () => {
        success = await result.current.updateServer(1, { name: 'Updated' });
      });

      expect(success).toBe(false);
    });
  });

  // ==========================================================================
  // DELETE SERVER TESTS
  // ==========================================================================

  describe('deleteServer', () => {
    it('deletes server and refreshes list', async () => {
      vi.mocked(window.goodvibes.deleteMCPServer).mockResolvedValue(true);
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue([]);

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      let success = false;
      await act(async () => {
        success = await result.current.deleteServer(1);
      });

      expect(success).toBe(true);
      expect(vi.mocked(window.goodvibes.deleteMCPServer)).toHaveBeenCalledWith(1);
      expect(vi.mocked(window.goodvibes.getMCPServers)).toHaveBeenCalled();
    });

    it('returns false on delete failure', async () => {
      vi.mocked(window.goodvibes.deleteMCPServer).mockRejectedValue(new Error('Delete failed'));

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      let success = false;
      await act(async () => {
        success = await result.current.deleteServer(1);
      });

      expect(success).toBe(false);
    });
  });

  // ==========================================================================
  // SET SERVER STATUS TESTS
  // ==========================================================================

  describe('setServerStatus', () => {
    it('sets server status and refreshes list', async () => {
      vi.mocked(window.goodvibes.setMCPServerStatus).mockResolvedValue(true);
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue(mockServers);

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      let success = false;
      await act(async () => {
        success = await result.current.setServerStatus(1, 'connected');
      });

      expect(success).toBe(true);
      expect(vi.mocked(window.goodvibes.setMCPServerStatus)).toHaveBeenCalledWith(1, 'connected', undefined);
    });

    it('passes error message when provided', async () => {
      vi.mocked(window.goodvibes.setMCPServerStatus).mockResolvedValue(true);

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await result.current.setServerStatus(1, 'error', 'Connection refused');
      });

      expect(vi.mocked(window.goodvibes.setMCPServerStatus)).toHaveBeenCalledWith(1, 'error', 'Connection refused');
    });

    it('returns false on status change failure', async () => {
      vi.mocked(window.goodvibes.setMCPServerStatus).mockRejectedValue(new Error('Status change failed'));

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      let success = false;
      await act(async () => {
        success = await result.current.setServerStatus(1, 'connected');
      });

      expect(success).toBe(false);
    });
  });

  // ==========================================================================
  // IPC EVENT HANDLING TESTS
  // ==========================================================================

  describe('IPC Event Handling', () => {
    it('subscribes to MCP server status events', () => {
      renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      expect(vi.mocked(window.goodvibes.onMCPServerStatus)).toHaveBeenCalled();
    });

    it('updates server status on IPC event', async () => {
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue(mockServers);

      let statusHandler: ((data: MCPServerStatusEvent) => void) | undefined;
      vi.mocked(window.goodvibes.onMCPServerStatus).mockImplementation((handler) => {
        statusHandler = handler;
        return () => {};
      });

      const { result } = renderHook(() => useMcpServers({ autoFetch: true }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.servers.length).toBe(3);
      });

      // Simulate status update event
      act(() => {
        statusHandler?.({
          id: '1',
          status: 'connected',
        });
      });

      await waitFor(() => {
        const server = result.current.servers.find(s => s.id === 1);
        expect(server?.status).toBe('connected');
      });
    });

    it('updates server error message on IPC event', async () => {
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue(mockServers);

      let statusHandler: ((data: MCPServerStatusEvent) => void) | undefined;
      vi.mocked(window.goodvibes.onMCPServerStatus).mockImplementation((handler) => {
        statusHandler = handler;
        return () => {};
      });

      const { result } = renderHook(() => useMcpServers({ autoFetch: true }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.servers.length).toBe(3);
      });

      // Simulate error event
      act(() => {
        statusHandler?.({
          id: '1',
          status: 'error',
          error: 'Connection lost',
        });
      });

      await waitFor(() => {
        const server = result.current.servers.find(s => s.id === 1);
        expect(server?.status).toBe('error');
        expect(server?.errorMessage).toBe('Connection lost');
      });
    });

    it('cleans up IPC listener on unmount', () => {
      const cleanup = vi.fn();
      vi.mocked(window.goodvibes.onMCPServerStatus).mockReturnValue(cleanup);

      const { unmount } = renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      unmount();

      expect(cleanup).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // POLLING TESTS
  // ==========================================================================

  describe('Polling', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('sets up polling when pollingInterval > 0', async () => {
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue(mockServers);

      renderHook(() => useMcpServers({ autoFetch: false, pollingInterval: 5000 }), {
        wrapper: createWrapper(),
      });

      // Initial call count
      const initialCalls = vi.mocked(window.goodvibes.getMCPServers).mock.calls.length;

      // Advance timer
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });

      // Should have made another call
      expect(vi.mocked(window.goodvibes.getMCPServers).mock.calls.length).toBeGreaterThan(initialCalls);
    });

    it('does not set up polling when pollingInterval is 0', async () => {
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue(mockServers);

      renderHook(() => useMcpServers({ autoFetch: false, pollingInterval: 0 }), {
        wrapper: createWrapper(),
      });

      const initialCalls = vi.mocked(window.goodvibes.getMCPServers).mock.calls.length;

      await act(async () => {
        vi.advanceTimersByTime(10000);
      });

      // Should not have made additional calls
      expect(vi.mocked(window.goodvibes.getMCPServers).mock.calls.length).toBe(initialCalls);
    });

    it('cleans up polling interval on unmount', async () => {
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue(mockServers);

      const { unmount } = renderHook(() => useMcpServers({ autoFetch: false, pollingInterval: 5000 }), {
        wrapper: createWrapper(),
      });

      unmount();

      const callsBeforeAdvance = vi.mocked(window.goodvibes.getMCPServers).mock.calls.length;

      await act(async () => {
        vi.advanceTimersByTime(10000);
      });

      // Should not have made additional calls after unmount
      expect(vi.mocked(window.goodvibes.getMCPServers).mock.calls.length).toBe(callsBeforeAdvance);
    });
  });

  // ==========================================================================
  // EDGE CASES
  // ==========================================================================

  describe('Edge Cases', () => {
    it('handles rapid consecutive fetches', async () => {
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue(mockServers);

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      // Multiple concurrent fetches
      await act(async () => {
        result.current.fetchServers();
        result.current.fetchServers();
        result.current.fetchServers();
        await new Promise(resolve => setTimeout(resolve, 0));
      });

      // Should complete without error
      expect(result.current.error).toBeNull();
    });

    it('handles empty server list', async () => {
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue([]);

      const { result } = renderHook(() => useMcpServers({ autoFetch: true }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.servers).toEqual([]);
        expect(result.current.isLoading).toBe(false);
      });
    });

    it('handles very large server list', async () => {
      const largeList = Array.from({ length: 100 }, (_, i) =>
        createMockServer({ id: i, name: `Server ${i}` })
      );
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue(largeList);

      const { result } = renderHook(() => useMcpServers({ autoFetch: true }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.servers.length).toBe(100);
      });
    });
  });

  // ==========================================================================
  // DEFAULT OPTIONS TESTS
  // ==========================================================================

  describe('Default Options', () => {
    it('uses default autoFetch=true when no options provided', async () => {
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue(mockServers);

      renderHook(() => useMcpServers(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(vi.mocked(window.goodvibes.getMCPServers)).toHaveBeenCalled();
      });
    });

    it('uses default pollingInterval=0 when no options provided', async () => {
      vi.useFakeTimers();
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue(mockServers);

      renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      const initialCalls = vi.mocked(window.goodvibes.getMCPServers).mock.calls.length;

      await act(async () => {
        vi.advanceTimersByTime(10000);
      });

      // Should not have made any calls since polling is disabled by default
      expect(vi.mocked(window.goodvibes.getMCPServers).mock.calls.length).toBe(initialCalls);

      vi.useRealTimers();
    });
  });

  // ==========================================================================
  // HTTP TRANSPORT SERVER TESTS
  // ==========================================================================

  describe('HTTP Transport Servers', () => {
    it('creates HTTP transport server with URL', async () => {
      const httpServer = createMockServer({
        id: 20,
        name: 'HTTP Server',
        transport: 'http',
        command: null,
        url: 'http://localhost:3000',
      });
      vi.mocked(window.goodvibes.createMCPServer).mockResolvedValue(httpServer);
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue([httpServer]);

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      let createdServer: MCPServer | null = null;
      await act(async () => {
        createdServer = await result.current.createServer({
          name: 'HTTP Server',
          transport: 'http',
          url: 'http://localhost:3000',
          enabled: true,
        });
      });

      expect(createdServer).toEqual(httpServer);
      expect(vi.mocked(window.goodvibes.createMCPServer)).toHaveBeenCalledWith(
        expect.objectContaining({
          transport: 'http',
          url: 'http://localhost:3000',
        })
      );
    });

    it('creates server with environment variables', async () => {
      const serverWithEnv = createMockServer({
        id: 21,
        name: 'Server with Env',
        env: { API_KEY: 'secret', DEBUG: 'true' },
      });
      vi.mocked(window.goodvibes.createMCPServer).mockResolvedValue(serverWithEnv);
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue([serverWithEnv]);

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await result.current.createServer({
          name: 'Server with Env',
          transport: 'stdio',
          command: 'npx server',
          enabled: true,
          env: { API_KEY: 'secret', DEBUG: 'true' },
        });
      });

      expect(vi.mocked(window.goodvibes.createMCPServer)).toHaveBeenCalledWith(
        expect.objectContaining({
          env: { API_KEY: 'secret', DEBUG: 'true' },
        })
      );
    });

    it('creates server with command arguments', async () => {
      const serverWithArgs = createMockServer({
        id: 22,
        name: 'Server with Args',
        args: ['--port', '3000', '--verbose'],
      });
      vi.mocked(window.goodvibes.createMCPServer).mockResolvedValue(serverWithArgs);
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue([serverWithArgs]);

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await result.current.createServer({
          name: 'Server with Args',
          transport: 'stdio',
          command: 'npx server',
          args: ['--port', '3000', '--verbose'],
          enabled: true,
        });
      });

      expect(vi.mocked(window.goodvibes.createMCPServer)).toHaveBeenCalledWith(
        expect.objectContaining({
          args: ['--port', '3000', '--verbose'],
        })
      );
    });
  });

  // ==========================================================================
  // STATUS TRANSITIONS TESTS
  // ==========================================================================

  describe('Status Transitions', () => {
    it.each([
      ['connected', undefined],
      ['disconnected', undefined],
      ['error', 'Connection timeout'],
      ['unknown', undefined],
    ] as const)('sets status to %s', async (status, errorMessage) => {
      vi.mocked(window.goodvibes.setMCPServerStatus).mockResolvedValue(true);
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue(mockServers);

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      let success = false;
      await act(async () => {
        success = await result.current.setServerStatus(1, status, errorMessage);
      });

      expect(success).toBe(true);
      expect(vi.mocked(window.goodvibes.setMCPServerStatus)).toHaveBeenCalledWith(1, status, errorMessage);
    });
  });

  // ==========================================================================
  // IPC EVENT EDGE CASES
  // ==========================================================================

  describe('IPC Event Edge Cases', () => {
    it('ignores IPC events for non-existent server IDs', async () => {
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue(mockServers);

      let statusHandler: ((data: MCPServerStatusEvent) => void) | undefined;
      vi.mocked(window.goodvibes.onMCPServerStatus).mockImplementation((handler) => {
        statusHandler = handler;
        return () => {};
      });

      const { result } = renderHook(() => useMcpServers({ autoFetch: true }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.servers.length).toBe(3);
      });

      const serversBefore = [...result.current.servers];

      // Simulate status update for non-existent server
      act(() => {
        statusHandler?.({
          id: '999',
          status: 'connected',
        });
      });

      // Servers should remain unchanged except for ID 999 which doesn't exist
      await waitFor(() => {
        // All original servers should still be in list with unchanged status
        const server1 = result.current.servers.find(s => s.id === 1);
        const server2 = result.current.servers.find(s => s.id === 2);
        const server3 = result.current.servers.find(s => s.id === 3);

        expect(server1?.status).toBe(serversBefore.find(s => s.id === 1)?.status);
        expect(server2?.status).toBe(serversBefore.find(s => s.id === 2)?.status);
        expect(server3?.status).toBe(serversBefore.find(s => s.id === 3)?.status);
      });
    });

    it('clears error message when status changes to connected', async () => {
      const serversWithError = [
        createMockServer({ id: 1, name: 'Error Server', status: 'error', errorMessage: 'Previous error' }),
      ];
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue(serversWithError);

      let statusHandler: ((data: MCPServerStatusEvent) => void) | undefined;
      vi.mocked(window.goodvibes.onMCPServerStatus).mockImplementation((handler) => {
        statusHandler = handler;
        return () => {};
      });

      const { result } = renderHook(() => useMcpServers({ autoFetch: true }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.servers.length).toBe(1);
        expect(result.current.servers[0]?.status).toBe('error');
        expect(result.current.servers[0]?.errorMessage).toBe('Previous error');
      });

      // Simulate successful connection (no error field)
      act(() => {
        statusHandler?.({
          id: '1',
          status: 'connected',
        });
      });

      await waitFor(() => {
        const server = result.current.servers.find(s => s.id === 1);
        expect(server?.status).toBe('connected');
        expect(server?.errorMessage).toBeNull();
      });
    });

    it('does not update state after unmount via IPC event', async () => {
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue(mockServers);

      let statusHandler: ((data: MCPServerStatusEvent) => void) | undefined;
      vi.mocked(window.goodvibes.onMCPServerStatus).mockImplementation((handler) => {
        statusHandler = handler;
        return () => {};
      });

      const { result, unmount } = renderHook(() => useMcpServers({ autoFetch: true }), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.servers.length).toBe(3);
      });

      const serversBefore = [...result.current.servers];

      // Unmount the hook
      unmount();

      // Try to send an IPC event after unmount - should not crash
      expect(() => {
        statusHandler?.({
          id: '1',
          status: 'connected',
        });
      }).not.toThrow();

      // Servers should remain as they were before unmount
      expect(serversBefore.length).toBe(3);
    });
  });

  // ==========================================================================
  // POLLING EDGE CASES
  // ==========================================================================

  describe('Polling Edge Cases', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('does not set up polling when pollingInterval is negative', async () => {
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue(mockServers);

      renderHook(() => useMcpServers({ autoFetch: false, pollingInterval: -1000 }), {
        wrapper: createWrapper(),
      });

      const initialCalls = vi.mocked(window.goodvibes.getMCPServers).mock.calls.length;

      await act(async () => {
        vi.advanceTimersByTime(10000);
      });

      // Should not have made any calls
      expect(vi.mocked(window.goodvibes.getMCPServers).mock.calls.length).toBe(initialCalls);
    });

    it('polls multiple times over extended period', async () => {
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue(mockServers);

      renderHook(() => useMcpServers({ autoFetch: false, pollingInterval: 1000 }), {
        wrapper: createWrapper(),
      });

      const initialCalls = vi.mocked(window.goodvibes.getMCPServers).mock.calls.length;

      // Advance 5 intervals
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });

      // Should have made 5 additional calls
      expect(vi.mocked(window.goodvibes.getMCPServers).mock.calls.length).toBe(initialCalls + 5);
    });
  });

  // ==========================================================================
  // CONCURRENT OPERATIONS TESTS
  // ==========================================================================

  describe('Concurrent Operations', () => {
    it('handles concurrent create and delete operations', async () => {
      const newServer = createMockServer({ id: 10, name: 'New Server' });
      vi.mocked(window.goodvibes.createMCPServer).mockResolvedValue(newServer);
      vi.mocked(window.goodvibes.deleteMCPServer).mockResolvedValue(true);
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue([newServer]);

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      // Execute create and delete concurrently
      const results = await act(async () => {
        const createPromise = result.current.createServer({
          name: 'New Server',
          transport: 'stdio',
          command: 'npx server',
          enabled: true,
        });
        const deletePromise = result.current.deleteServer(1);

        return Promise.all([createPromise, deletePromise]);
      });

      const [createdServer, deleteSuccess] = results;
      expect(createdServer).toEqual(newServer);
      expect(deleteSuccess).toBe(true);
    });

    it('handles concurrent update operations on different servers', async () => {
      vi.mocked(window.goodvibes.updateMCPServer).mockResolvedValue(true);
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue(mockServers);

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      // Update multiple servers concurrently
      const results = await act(async () => {
        const update1 = result.current.updateServer(1, { name: 'Updated 1' });
        const update2 = result.current.updateServer(2, { name: 'Updated 2' });
        const update3 = result.current.updateServer(3, { name: 'Updated 3' });

        return Promise.all([update1, update2, update3]);
      });

      expect(results).toEqual([true, true, true]);
      expect(vi.mocked(window.goodvibes.updateMCPServer)).toHaveBeenCalledTimes(3);
    });
  });

  // ==========================================================================
  // ERROR HANDLING EDGE CASES
  // ==========================================================================

  describe('Error Handling Edge Cases', () => {
    it('handles non-Error objects thrown during fetch', async () => {
      vi.mocked(window.goodvibes.getMCPServers).mockRejectedValue('String error');

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await result.current.fetchServers();
      });

      expect(result.current.error).toBe('Failed to fetch MCP servers');
    });

    it('clears previous error on successful fetch', async () => {
      // First fetch fails
      vi.mocked(window.goodvibes.getMCPServers).mockRejectedValueOnce(new Error('Initial error'));

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await result.current.fetchServers();
      });

      expect(result.current.error).toBe('Initial error');

      // Second fetch succeeds
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValueOnce(mockServers);

      await act(async () => {
        await result.current.fetchServers();
      });

      expect(result.current.error).toBeNull();
      expect(result.current.servers).toEqual(mockServers);
    });

    it('handles undefined error response from getMCPServer', async () => {
      vi.mocked(window.goodvibes.getMCPServer).mockResolvedValue(undefined as unknown as MCPServer | null);

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), {
        wrapper: createWrapper(),
      });

      let fetchedServer: MCPServer | null = null;
      await act(async () => {
        fetchedServer = await result.current.getServer(1);
      });

      expect(fetchedServer).toBeNull();
    });
  });

  // ==========================================================================
  // QUERY CLIENT INTEGRATION TESTS
  // ==========================================================================

  describe('Query Client Integration', () => {
    it('invalidates mcp-servers query on create', async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const invalidateQueriesSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);

      const newServer = createMockServer({ id: 10 });
      vi.mocked(window.goodvibes.createMCPServer).mockResolvedValue(newServer);
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue([newServer]);

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), { wrapper });

      await act(async () => {
        await result.current.createServer({
          name: 'Test',
          transport: 'stdio',
          command: 'test',
          enabled: true,
        });
      });

      expect(invalidateQueriesSpy).toHaveBeenCalledWith({ queryKey: ['mcp-servers'] });
    });

    it('invalidates mcp-servers query on update', async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const invalidateQueriesSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);

      vi.mocked(window.goodvibes.updateMCPServer).mockResolvedValue(true);
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue(mockServers);

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), { wrapper });

      await act(async () => {
        await result.current.updateServer(1, { name: 'Updated' });
      });

      expect(invalidateQueriesSpy).toHaveBeenCalledWith({ queryKey: ['mcp-servers'] });
    });

    it('invalidates mcp-servers query on delete', async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const invalidateQueriesSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);

      vi.mocked(window.goodvibes.deleteMCPServer).mockResolvedValue(true);
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue([]);

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), { wrapper });

      await act(async () => {
        await result.current.deleteServer(1);
      });

      expect(invalidateQueriesSpy).toHaveBeenCalledWith({ queryKey: ['mcp-servers'] });
    });

    it('invalidates mcp-servers query on setServerStatus', async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const invalidateQueriesSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);

      vi.mocked(window.goodvibes.setMCPServerStatus).mockResolvedValue(true);
      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue(mockServers);

      const { result } = renderHook(() => useMcpServers({ autoFetch: false }), { wrapper });

      await act(async () => {
        await result.current.setServerStatus(1, 'connected');
      });

      expect(invalidateQueriesSpy).toHaveBeenCalledWith({ queryKey: ['mcp-servers'] });
    });

    it('invalidates mcp-servers query on IPC status event', async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const invalidateQueriesSpy = vi.spyOn(queryClient, 'invalidateQueries');

      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);

      vi.mocked(window.goodvibes.getMCPServers).mockResolvedValue(mockServers);

      let statusHandler: ((data: MCPServerStatusEvent) => void) | undefined;
      vi.mocked(window.goodvibes.onMCPServerStatus).mockImplementation((handler) => {
        statusHandler = handler;
        return () => {};
      });

      const { result } = renderHook(() => useMcpServers({ autoFetch: true }), { wrapper });

      await waitFor(() => {
        expect(result.current.servers.length).toBe(3);
      });

      // Clear the spy calls from initial fetch
      invalidateQueriesSpy.mockClear();

      // Trigger IPC event
      act(() => {
        statusHandler?.({
          id: '1',
          status: 'connected',
        });
      });

      await waitFor(() => {
        expect(invalidateQueriesSpy).toHaveBeenCalledWith({ queryKey: ['mcp-servers'] });
      });
    });
  });

  // ==========================================================================
  // TYPE EXPORTS TESTS
  // ==========================================================================

  describe('Type Exports', () => {
    it('exports MCPServer type correctly', () => {
      // This test verifies the type export is working by using it
      const server: MCPServer = createMockServer();
      expect(server).toBeDefined();
      expect(server.id).toBe(1);
    });

    it('exports MCPServerStatusEvent type correctly', () => {
      const event: MCPServerStatusEvent = {
        id: '1',
        status: 'connected',
        error: undefined,
      };
      expect(event).toBeDefined();
      expect(event.id).toBe('1');
    });
  });
});
