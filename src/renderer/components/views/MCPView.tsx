// ============================================================================
// MCP VIEW - MCP Server Management Dashboard
// ============================================================================

import { useState, useEffect, useCallback } from 'react';
import {
  Server,
  Plus,
  Search,
} from 'lucide-react';
import { useConfirm } from '../overlays/ConfirmModal';
import { createLogger } from '../../../shared/logger';
import { MCPServerCard, type MCPServer } from './MCPServerCard';
import { MCPMarketplaceCard, MARKETPLACE_SERVERS, type MarketplaceServer } from './MCPMarketplaceCard';
import { MCPServerForm } from './MCPServerForm';

const logger = createLogger('MCPView');

// ============================================================================
// MAIN MCP VIEW
// ============================================================================

export default function MCPView() {
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [loading, setLoading] = useState(true);
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

  const loadServers = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.goodvibes.getMCPServers();
      setServers(result || []);
    } catch (error) {
      logger.error('Failed to load MCP servers:', error);
      setServers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadServers();
  }, [loadServers]);

  const handleSave = async (serverData: Partial<MCPServer>) => {
    try {
      if (serverData.id) {
        await window.goodvibes.updateMCPServer(serverData.id, serverData);
      } else {
        await window.goodvibes.createMCPServer({
          name: serverData.name || '',
          transport: serverData.transport || 'stdio',
          command: serverData.command || undefined,
          args: serverData.args || [],
          url: serverData.url || undefined,
          env: serverData.env || {},
          enabled: serverData.enabled ?? true,
        });
      }
      setShowForm(false);
      setEditingServer(undefined);
      loadServers();
    } catch (error) {
      logger.error('Failed to save MCP server:', error);
    }
  };

  const handleStart = async (id: number) => {
    try {
      await window.goodvibes.setMCPServerStatus(id, 'connected');
      loadServers();
    } catch (error) {
      logger.error('Failed to start MCP server:', error);
    }
  };

  const handleStop = async (id: number) => {
    try {
      await window.goodvibes.setMCPServerStatus(id, 'disconnected');
      loadServers();
    } catch (error) {
      logger.error('Failed to stop MCP server:', error);
    }
  };

  const handleRestart = async (id: number) => {
    try {
      await window.goodvibes.setMCPServerStatus(id, 'disconnected');
      await new Promise(resolve => setTimeout(resolve, 500));
      await window.goodvibes.setMCPServerStatus(id, 'connected');
      loadServers();
    } catch (error) {
      logger.error('Failed to restart MCP server:', error);
    }
  };

  const handleDelete = async (id: number) => {
    const confirmed = await confirmDelete();
    if (confirmed) {
      try {
        await window.goodvibes.deleteMCPServer(id);
        loadServers();
      } catch (error) {
        logger.error('Failed to delete MCP server:', error);
      }
    }
  };

  const handleInstall = async (server: MarketplaceServer) => {
    try {
      await window.goodvibes.createMCPServer({
        name: server.name,
        transport: server.transport,
        command: server.npmPackage ? `npx ${server.npmPackage}` : server.command,
        args: server.args || [],
        env: {},
        enabled: true,
      });
      loadServers();
      setActiveTab('installed');
    } catch (error) {
      logger.error('Failed to install MCP server:', error);
    }
  };

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
