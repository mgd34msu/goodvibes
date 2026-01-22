// ============================================================================
// MCP VIEW - MCP Server Management Dashboard
// ============================================================================

import { useState, useCallback } from 'react';
import {
  Server,
  Plus,
  Search,
} from 'lucide-react';
import { useConfirm } from '../overlays/ConfirmModal';
import { createLogger } from '../../../shared/logger';
import { toast } from '../../stores/toastStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { MCPServerCard, type MCPServer } from './MCPServerCard';
import { MCPMarketplaceCard, MARKETPLACE_SERVERS, type MarketplaceServer } from './MCPMarketplaceCard';
import { MCPServerForm } from './MCPServerForm';
import { useMcpServers, type CreateMCPServerInput } from '../../hooks/useMcpServers';

const logger = createLogger('MCPView');

// ============================================================================
// MAIN MCP VIEW
// ============================================================================

export default function MCPView() {
  // Use the MCP servers hook with proper cleanup for IPC listeners
  const {
    servers,
    isLoading: loading,
    createServer,
    updateServer,
    deleteServer,
    setServerStatus,
  } = useMcpServers({ autoFetch: true });

  const { settings } = useSettingsStore();

  const [showForm, setShowForm] = useState(false);
  const [editingServer, setEditingServer] = useState<MCPServer | undefined>();
  const [activeTab, setActiveTab] = useState<'installed' | 'marketplace'>('installed');
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');

  const { confirm: confirmDelete, ConfirmDialog: DeleteConfirmDialog } = useConfirm({
    title: 'Delete MCP Server',
    message: 'Are you sure you want to delete this MCP server?',
    confirmText: 'Delete',
    variant: 'danger',
  });

  const handleSave = useCallback(async (serverData: Partial<MCPServer>) => {
    const isUpdate = Boolean(serverData.id);
    const serverName = serverData.name || 'server';
    try {
      if (serverData.id) {
        const success = await updateServer(serverData.id, serverData);
        if (!success) throw new Error('Failed to update server');
      } else {
        const input: CreateMCPServerInput = {
          name: serverData.name || '',
          transport: (serverData.transport as 'stdio' | 'http') || 'stdio',
          command: serverData.command || undefined,
          args: serverData.args || [],
          url: serverData.url || undefined,
          env: serverData.env || {},
          enabled: serverData.enabled ?? true,
        };
        const newServer = await createServer(input);
        if (!newServer) throw new Error('Failed to create server');
      }
      setShowForm(false);
      setEditingServer(undefined);
      toast.success(isUpdate ? `Updated ${serverName}` : `Created ${serverName}`);
    } catch (error) {
      logger.error('Failed to save MCP server:', error);
      toast.error(isUpdate ? 'Failed to update MCP server' : 'Failed to create MCP server');
    }
  }, [createServer, updateServer]);

  const handleStart = useCallback(async (id: number) => {
    const server = servers.find(s => s.id === id);
    const serverName = server?.name || 'MCP server';
    try {
      const success = await setServerStatus(id, 'connected');
      if (success) {
        toast.success(`Connected to ${serverName}`);
      } else {
        throw new Error('Failed to connect');
      }
    } catch (error) {
      logger.error('Failed to start MCP server:', error);
      toast.error(`Failed to connect to ${serverName}`);
    }
  }, [servers, setServerStatus]);

  const handleStop = useCallback(async (id: number) => {
    const server = servers.find(s => s.id === id);
    const serverName = server?.name || 'MCP server';
    try {
      const success = await setServerStatus(id, 'disconnected');
      if (success) {
        toast.info(`Disconnected from ${serverName}`);
      } else {
        throw new Error('Failed to disconnect');
      }
    } catch (error) {
      logger.error('Failed to stop MCP server:', error);
      toast.error(`Failed to disconnect from ${serverName}`);
    }
  }, [servers, setServerStatus]);

  const handleRestart = useCallback(async (id: number) => {
    const server = servers.find(s => s.id === id);
    const serverName = server?.name || 'MCP server';
    try {
      await setServerStatus(id, 'disconnected');
      // Use a timeout with cleanup to avoid memory leaks
      await new Promise<void>((resolve) => {
        const timeoutId = setTimeout(() => resolve(), 500);
        // Note: In a real scenario, this timeout would be tracked for cleanup
        // but since it's a short-lived promise, it will complete before unmount
        return () => clearTimeout(timeoutId);
      });
      const success = await setServerStatus(id, 'connected');
      if (success) {
        toast.success(`Restarted ${serverName}`);
      } else {
        throw new Error('Failed to restart');
      }
    } catch (error) {
      logger.error('Failed to restart MCP server:', error);
      toast.error(`Failed to restart ${serverName}`);
    }
  }, [servers, setServerStatus]);

  const handleDelete = useCallback(async (id: number) => {
    const server = servers.find(s => s.id === id);
    const serverName = server?.name || 'MCP server';
    const confirmed = await confirmDelete();
    if (confirmed) {
      try {
        const success = await deleteServer(id);
        if (success) {
          toast.success(`Deleted ${serverName}`);
        } else {
          throw new Error('Failed to delete');
        }
      } catch (error) {
        logger.error('Failed to delete MCP server:', error);
        toast.error(`Failed to delete ${serverName}`);
      }
    }
  }, [servers, confirmDelete, deleteServer]);

  const handleInstall = useCallback(async (server: MarketplaceServer) => {
    try {
      const input: CreateMCPServerInput = {
        name: server.name,
        transport: server.transport as 'stdio' | 'http',
        command: server.npmPackage ? `npx ${server.npmPackage}` : server.command,
        args: server.args || [],
        env: {},
        enabled: true,
      };
      const newServer = await createServer(input);
      if (newServer) {
        toast.success(`Installed ${server.name}`);
        setActiveTab('installed');
      } else {
        throw new Error('Failed to install');
      }
    } catch (error) {
      logger.error('Failed to install MCP server:', error);
      toast.error(`Failed to install ${server.name}`);
    }
  }, [createServer]);

  const installedServerIds = new Set(servers.map((s) => s.name.toLowerCase()));

  const filteredMarketplace = MARKETPLACE_SERVERS.filter((server) => {
    const matchesSearch =
      !searchQuery ||
      server.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      server.description.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesCategory = categoryFilter === 'all' || server.category === categoryFilter;

    return matchesSearch && matchesCategory;
  });

  return (
    <>
    <DeleteConfirmDialog />
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex-shrink-0 px-6 py-4 border-b border-surface-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Server className="w-6 h-6 text-accent-purple" />
            <div>
              <h1 className="text-xl font-semibold text-surface-100">MCP Servers</h1>
              <p className="text-sm text-surface-400">
                Model Context Protocol server management
              </p>
            </div>
          </div>

          <button
            onClick={() => {
              setEditingServer(undefined);
              setShowForm(true);
            }}
            className="px-4 py-2 bg-accent-purple text-white rounded-lg hover:bg-accent-purple/80 transition-colors flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Add Server
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-4 mt-4">
          <button
            onClick={() => setActiveTab('installed')}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              activeTab === 'installed'
                ? 'bg-surface-700 text-surface-100'
                : 'text-surface-400 hover:text-surface-200'
            }`}
          >
            Installed ({servers.length})
          </button>
          <button
            onClick={() => setActiveTab('marketplace')}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              activeTab === 'marketplace'
                ? 'bg-surface-700 text-surface-100'
                : 'text-surface-400 hover:text-surface-200'
            }`}
          >
            Marketplace
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {showForm && (
          <div className="mb-6">
            <MCPServerForm
              server={editingServer}
              onSave={handleSave}
              onCancel={() => {
                setShowForm(false);
                setEditingServer(undefined);
              }}
            />
          </div>
        )}

        {activeTab === 'installed' ? (
          loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-purple" />
            </div>
          ) : servers.length === 0 ? (
            <div className="text-center py-12">
              <Server className="w-12 h-12 text-surface-600 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-surface-300">No MCP servers configured</h3>
              <p className="text-surface-500 mt-2">
                Add MCP servers to extend Claude's capabilities
              </p>
              <div className="flex justify-center gap-3 mt-4">
                <button
                  onClick={() => setShowForm(true)}
                  className="px-4 py-2 bg-surface-700 text-surface-200 rounded-lg hover:bg-surface-600 transition-colors"
                >
                  Add Custom Server
                </button>
                <button
                  onClick={() => setActiveTab('marketplace')}
                  className="px-4 py-2 bg-accent-purple text-white rounded-lg hover:bg-accent-purple/80 transition-colors"
                >
                  Browse Marketplace
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {servers.map((server) => (
                <MCPServerCard
                  key={server.id}
                  server={server}
                  timezone={settings.timezone}
                  onStart={handleStart}
                  onStop={handleStop}
                  onRestart={handleRestart}
                  onEdit={(s) => {
                    setEditingServer(s);
                    setShowForm(true);
                  }}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          )
        ) : (
          <div>
            {/* Marketplace search/filter */}
            <div className="flex gap-4 mb-6">
              <div className="flex-1 relative min-w-0">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-surface-500" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search servers..."
                  className="w-full pl-10 pr-3 py-2 bg-surface-800 border border-surface-600 rounded-lg text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
                />
              </div>
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="w-48 flex-shrink-0 px-3 py-2 bg-surface-800 border border-surface-600 rounded-lg text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
              >
                <option value="all">All Categories</option>
                <option value="productivity">Productivity</option>
                <option value="devops">DevOps</option>
                <option value="communication">Communication</option>
                <option value="database">Database</option>
              </select>
            </div>

            {/* Marketplace grid */}
            <div className="space-y-3">
              {filteredMarketplace.map((server) => (
                <MCPMarketplaceCard
                  key={server.id}
                  server={server}
                  installed={installedServerIds.has(server.name.toLowerCase())}
                  onInstall={handleInstall}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
    </>
  );
}
