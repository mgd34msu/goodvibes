// ============================================================================
// USE MCP SERVERS HOOK
// ============================================================================
//
// This hook manages MCP server state, subscriptions, and CRUD operations.
// All IPC event listeners and intervals are properly cleaned up on unmount.
//
// Features:
// - Real-time server status updates via IPC events
// - CRUD operations for MCP servers
// - Proper cleanup of all subscriptions
// - Optional polling interval with cleanup
//
// ============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createLogger } from '../../shared/logger';
import type { MCPServer } from '../components/views/MCPServerCard';

const logger = createLogger('useMcpServers');

// Re-export MCPServer type for consumers
export type { MCPServer };

export interface MCPServerStatusEvent {
  id: string;
  status: string;
  error?: string;
}

export interface CreateMCPServerInput {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  enabled: boolean;
  description?: string;
}

export interface UseMcpServersOptions {
  /** Enable polling for server status updates (interval in ms, 0 to disable) */
  pollingInterval?: number;
  /** Auto-fetch servers on mount */
  autoFetch?: boolean;
}

export interface UseMcpServersReturn {
  /** List of MCP servers */
  servers: MCPServer[];
  /** Whether servers are being loaded */
  isLoading: boolean;
  /** Error message if any */
  error: string | null;
  /** Fetch/refresh all servers */
  fetchServers: () => Promise<void>;
  /** Create a new MCP server */
  createServer: (server: CreateMCPServerInput) => Promise<MCPServer | null>;
  /** Update an existing MCP server */
  updateServer: (id: number, updates: Partial<MCPServer>) => Promise<boolean>;
  /** Delete an MCP server */
  deleteServer: (id: number) => Promise<boolean>;
  /** Set server status (connect/disconnect) */
  setServerStatus: (id: number, status: 'connected' | 'disconnected' | 'error' | 'unknown', errorMessage?: string) => Promise<boolean>;
  /** Get a single server by ID */
  getServer: (id: number) => Promise<MCPServer | null>;
}

// ============================================================================
// HOOK
// ============================================================================

export function useMcpServers(options: UseMcpServersOptions = {}): UseMcpServersReturn {
  const { pollingInterval = 0, autoFetch = true } = options;

  const queryClient = useQueryClient();
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs for cleanup tracking
  const ipcCleanupRef = useRef<(() => void) | null>(null);
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMountedRef = useRef(true);

  // ============================================================================
  // FETCH SERVERS
  // ============================================================================

  const fetchServers = useCallback(async (): Promise<void> => {
    if (!isMountedRef.current) return;

    setIsLoading(true);
    setError(null);

    try {
      const result = await window.goodvibes.getMCPServers();
      if (isMountedRef.current) {
        setServers(result || []);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch MCP servers';
      logger.error('Failed to fetch MCP servers:', err);
      if (isMountedRef.current) {
        setError(message);
        setServers([]);
      }
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  // ============================================================================
  // GET SINGLE SERVER
  // ============================================================================

  const getServer = useCallback(async (id: number): Promise<MCPServer | null> => {
    try {
      const server = await window.goodvibes.getMCPServer(id);
      return server || null;
    } catch (err) {
      logger.error('Failed to get MCP server:', err);
      return null;
    }
  }, []);

  // ============================================================================
  // CREATE SERVER
  // ============================================================================

  const createServer = useCallback(async (serverData: CreateMCPServerInput): Promise<MCPServer | null> => {
    try {
      const newServer = await window.goodvibes.createMCPServer(serverData);
      if (isMountedRef.current) {
        await fetchServers();
        queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
      }
      return newServer;
    } catch (err) {
      logger.error('Failed to create MCP server:', err);
      return null;
    }
  }, [fetchServers, queryClient]);

  // ============================================================================
  // UPDATE SERVER
  // ============================================================================

  const updateServer = useCallback(async (id: number, updates: Partial<MCPServer>): Promise<boolean> => {
    try {
      await window.goodvibes.updateMCPServer(id, updates);
      if (isMountedRef.current) {
        await fetchServers();
        queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
      }
      return true;
    } catch (err) {
      logger.error('Failed to update MCP server:', err);
      return false;
    }
  }, [fetchServers, queryClient]);

  // ============================================================================
  // DELETE SERVER
  // ============================================================================

  const deleteServer = useCallback(async (id: number): Promise<boolean> => {
    try {
      await window.goodvibes.deleteMCPServer(id);
      if (isMountedRef.current) {
        await fetchServers();
        queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
      }
      return true;
    } catch (err) {
      logger.error('Failed to delete MCP server:', err);
      return false;
    }
  }, [fetchServers, queryClient]);

  // ============================================================================
  // SET SERVER STATUS
  // ============================================================================

  const setServerStatus = useCallback(async (
    id: number,
    status: 'connected' | 'disconnected' | 'error' | 'unknown',
    errorMessage?: string
  ): Promise<boolean> => {
    try {
      await window.goodvibes.setMCPServerStatus(id, status, errorMessage);
      if (isMountedRef.current) {
        await fetchServers();
        queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
      }
      return true;
    } catch (err) {
      logger.error('Failed to set MCP server status:', err);
      return false;
    }
  }, [fetchServers, queryClient]);

  // ============================================================================
  // IPC EVENT SUBSCRIPTION - MCP Server Status Updates
  // ============================================================================

  useEffect(() => {
    isMountedRef.current = true;

    // Subscribe to MCP server status events for real-time updates
    const handleStatusUpdate = (data: MCPServerStatusEvent): void => {
      if (!isMountedRef.current) return;

      logger.debug('MCP server status update:', data);

      // Update the local state with the new status
      setServers((prevServers) =>
        prevServers.map((server) => {
          if (String(server.id) === data.id) {
            return {
              ...server,
              status: data.status as MCPServer['status'],
              errorMessage: data.error ?? null,
            };
          }
          return server;
        })
      );

      // Invalidate query cache to ensure consistency
      queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
    };

    // Subscribe to the IPC event
    const cleanup = window.goodvibes.onMCPServerStatus(handleStatusUpdate);
    ipcCleanupRef.current = cleanup;

    // Cleanup on unmount
    return () => {
      isMountedRef.current = false;
      if (ipcCleanupRef.current) {
        ipcCleanupRef.current();
        ipcCleanupRef.current = null;
      }
    };
  }, [queryClient]);

  // ============================================================================
  // POLLING INTERVAL (Optional)
  // ============================================================================

  useEffect(() => {
    // Skip if polling is disabled or already set up
    if (pollingInterval <= 0) return;

    // Clear any existing interval
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }

    // Set up new polling interval
    pollingIntervalRef.current = setInterval(() => {
      if (isMountedRef.current) {
        fetchServers();
      }
    }, pollingInterval);

    logger.debug(`MCP server polling started with interval: ${pollingInterval}ms`);

    // Cleanup interval on unmount or when pollingInterval changes
    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
        logger.debug('MCP server polling stopped');
      }
    };
  }, [pollingInterval, fetchServers]);

  // ============================================================================
  // AUTO-FETCH ON MOUNT
  // ============================================================================

  useEffect(() => {
    if (autoFetch) {
      fetchServers();
    }
  }, [autoFetch, fetchServers]);

  // ============================================================================
  // RETURN
  // ============================================================================

  return {
    servers,
    isLoading,
    error,
    fetchServers,
    createServer,
    updateServer,
    deleteServer,
    setServerStatus,
    getServer,
  };
}

export default useMcpServers;
