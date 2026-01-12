// ============================================================================
// MCP VIEW - MCP Server Management Dashboard
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import {
  Server,
  Plus,
  Play,
  Square,
  RefreshCw,
  Trash2,
  Edit2,
  Save,
  CheckCircle,
  XCircle,
  AlertCircle,
  ExternalLink,
  Package,
  Zap,
  Database,
  MessageSquare,
  Wrench,
  Search,
} from 'lucide-react';
import { createLogger } from '../../../shared/logger';

const logger = createLogger('MCPView');

// ============================================================================
// TYPES
// ============================================================================

interface MCPServer {
  id: number;
  name: string;
  description: string | null;
  transport: 'stdio' | 'http';
  command: string | null;
  url: string | null;
  args: string[];
  env: Record<string, string>;
  scope: 'user' | 'project';
  projectPath: string | null;
  enabled: boolean;
  status: 'connected' | 'disconnected' | 'error' | 'unknown';
  lastConnected: string | null;
  errorMessage: string | null;
  toolCount: number;
  createdAt: string;
  updatedAt: string;
}

interface MarketplaceServer {
  id: string;
  name: string;
  description: string;
  category: 'productivity' | 'devops' | 'communication' | 'database' | 'custom';
  transport: 'stdio' | 'http';
  npmPackage?: string;
  command?: string;
  args?: string[];
  requiredEnv?: string[];
  documentation?: string;
  popular?: boolean;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  productivity: <Zap className="w-4 h-4" />,
  devops: <Wrench className="w-4 h-4" />,
  communication: <MessageSquare className="w-4 h-4" />,
  database: <Database className="w-4 h-4" />,
  custom: <Package className="w-4 h-4" />,
};

const STATUS_STYLES: Record<string, { color: string; icon: React.ReactNode }> = {
  connected: { color: 'text-green-400', icon: <CheckCircle className="w-4 h-4" /> },
  disconnected: { color: 'text-surface-500', icon: <Square className="w-4 h-4" /> },
  error: { color: 'text-red-400', icon: <XCircle className="w-4 h-4" /> },
  unknown: { color: 'text-yellow-400', icon: <AlertCircle className="w-4 h-4" /> },
};

// Mock marketplace data
const MARKETPLACE_SERVERS: MarketplaceServer[] = [
  {
    id: 'notion',
    name: 'Notion',
    description: 'Access and manage Notion workspaces, pages, and databases',
    category: 'productivity',
    transport: 'stdio',
    npmPackage: '@notionhq/mcp-server',
    requiredEnv: ['NOTION_API_KEY'],
    documentation: 'https://developers.notion.com/',
    popular: true,
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Access GitHub repositories, issues, PRs, and more',
    category: 'devops',
    transport: 'stdio',
    npmPackage: '@github/mcp-server',
    requiredEnv: ['GITHUB_TOKEN'],
    documentation: 'https://docs.github.com/en/rest',
    popular: true,
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Send messages and interact with Slack workspaces',
    category: 'communication',
    transport: 'stdio',
    npmPackage: '@slack/mcp-server',
    requiredEnv: ['SLACK_BOT_TOKEN'],
    popular: true,
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Query and manage PostgreSQL databases',
    category: 'database',
    transport: 'stdio',
    npmPackage: '@modelcontextprotocol/server-postgres',
    requiredEnv: ['DATABASE_URL'],
    popular: true,
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read and write files on the local filesystem',
    category: 'productivity',
    transport: 'stdio',
    npmPackage: '@modelcontextprotocol/server-filesystem',
    popular: true,
  },
  {
    id: 'memory',
    name: 'Memory',
    description: 'Persistent memory store for conversations',
    category: 'productivity',
    transport: 'stdio',
    npmPackage: '@modelcontextprotocol/server-memory',
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Search the web using Brave Search API',
    category: 'productivity',
    transport: 'stdio',
    npmPackage: '@modelcontextprotocol/server-brave-search',
    requiredEnv: ['BRAVE_API_KEY'],
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Query and manage SQLite databases',
    category: 'database',
    transport: 'stdio',
    npmPackage: '@modelcontextprotocol/server-sqlite',
    requiredEnv: ['SQLITE_DB_PATH'],
  },
];

// ============================================================================
// SERVER FORM COMPONENT
// ============================================================================

interface ServerFormProps {
  server?: MCPServer;
  onSave: (server: Partial<MCPServer>) => void;
  onCancel: () => void;
}

function ServerForm({ server, onSave, onCancel }: ServerFormProps) {
  const [name, setName] = useState(server?.name || '');
  const [description, setDescription] = useState(server?.description || '');
  const [transport, setTransport] = useState<'stdio' | 'http'>(server?.transport || 'stdio');
  const [command, setCommand] = useState(server?.command || '');
  const [url, setUrl] = useState(server?.url || '');
  const [args, setArgs] = useState(server?.args.join(' ') || '');
  const [envString, setEnvString] = useState(
    server?.env ? Object.entries(server.env).map(([k, v]) => `${k}=${v}`).join('\n') : ''
  );
  const [scope, setScope] = useState<'user' | 'project'>(server?.scope || 'user');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const env: Record<string, string> = {};
    envString.split('\n').forEach((line) => {
      const [key, ...valueParts] = line.split('=');
      if (key && valueParts.length > 0) {
        env[key.trim()] = valueParts.join('=').trim();
      }
    });

    onSave({
      id: server?.id,
      name,
      description: description || null,
      transport,
      command: transport === 'stdio' ? command : null,
      url: transport === 'http' ? url : null,
      args: args.split(' ').filter(Boolean),
      env,
      scope,
      enabled: server?.enabled ?? true,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 bg-surface-900 rounded-lg p-4 border border-surface-700">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-surface-300 mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My MCP Server"
            className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-surface-300 mb-1">Transport</label>
          <select
            value={transport}
            onChange={(e) => setTransport(e.target.value as 'stdio' | 'http')}
            className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
          >
            <option value="stdio">STDIO</option>
            <option value="http">HTTP</option>
          </select>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-surface-300 mb-1">Description</label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional description"
          className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
        />
      </div>

      {transport === 'stdio' ? (
        <>
          <div>
            <label className="block text-sm font-medium text-surface-300 mb-1">Command</label>
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx @example/mcp-server"
              className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 font-mono text-sm focus:ring-2 focus:ring-accent-purple focus:border-transparent"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-surface-300 mb-1">Arguments (space-separated)</label>
            <input
              type="text"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="--flag value"
              className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 font-mono text-sm focus:ring-2 focus:ring-accent-purple focus:border-transparent"
            />
          </div>
        </>
      ) : (
        <div>
          <label className="block text-sm font-medium text-surface-300 mb-1">URL</label>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://localhost:3000"
            className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
            required
          />
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-surface-300 mb-1">
          Environment Variables (one per line, KEY=value)
        </label>
        <textarea
          value={envString}
          onChange={(e) => setEnvString(e.target.value)}
          placeholder="API_KEY=your-key&#10;OTHER_VAR=value"
          rows={3}
          className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 font-mono text-sm focus:ring-2 focus:ring-accent-purple focus:border-transparent"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-surface-300 mb-1">Scope</label>
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as 'user' | 'project')}
          className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
        >
          <option value="user">User (Global)</option>
          <option value="project">Project</option>
        </select>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-surface-300 hover:text-surface-100 hover:bg-surface-700 rounded-md transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="px-4 py-2 bg-accent-purple text-white rounded-md hover:bg-accent-purple/80 transition-colors flex items-center gap-2"
        >
          <Save className="w-4 h-4" />
          {server ? 'Update Server' : 'Add Server'}
        </button>
      </div>
    </form>
  );
}

// ============================================================================
// SERVER CARD COMPONENT
// ============================================================================

interface ServerCardProps {
  server: MCPServer;
  onStart: (id: number) => void;
  onStop: (id: number) => void;
  onRestart: (id: number) => void;
  onEdit: (server: MCPServer) => void;
  onDelete: (id: number) => void;
}

function ServerCard({ server, onStart, onStop, onRestart, onEdit, onDelete }: ServerCardProps) {
  const statusStyle = STATUS_STYLES[server.status] ?? STATUS_STYLES.unknown;

  return (
    <div className="bg-surface-900 rounded-lg border border-surface-700 p-4">
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3">
          <div className={`mt-1 ${statusStyle?.color ?? ''}`}>{statusStyle?.icon ?? null}</div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-medium text-surface-100">{server.name}</h3>
              <span className="text-xs px-2 py-0.5 bg-surface-700 rounded text-surface-400">
                {server.transport.toUpperCase()}
              </span>
              <span className="text-xs px-2 py-0.5 bg-surface-700 rounded text-surface-400">
                {server.scope}
              </span>
            </div>
            {server.description && (
              <p className="text-sm text-surface-400 mt-1">{server.description}</p>
            )}
            <div className="flex items-center gap-4 mt-2 text-xs text-surface-500">
              <span>Tools: {server.toolCount}</span>
              {server.lastConnected && (
                <span>Last connected: {new Date(server.lastConnected).toLocaleString()}</span>
              )}
            </div>
            {server.errorMessage && (
              <p className="text-xs text-red-400 mt-1">{server.errorMessage}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1">
          {server.status === 'connected' ? (
            <button
              onClick={() => onStop(server.id)}
              className="p-1.5 text-red-400 hover:bg-red-400/10 rounded transition-colors"
              title="Stop"
            >
              <Square className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={() => onStart(server.id)}
              className="p-1.5 text-green-400 hover:bg-green-400/10 rounded transition-colors"
              title="Start"
            >
              <Play className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={() => onRestart(server.id)}
            className="p-1.5 text-surface-400 hover:text-surface-200 hover:bg-surface-700 rounded transition-colors"
            title="Restart"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => onEdit(server)}
            className="p-1.5 text-surface-400 hover:text-surface-200 hover:bg-surface-700 rounded transition-colors"
            title="Edit"
          >
            <Edit2 className="w-4 h-4" />
          </button>
          <button
            onClick={() => onDelete(server.id)}
            className="p-1.5 text-surface-400 hover:text-red-400 hover:bg-red-400/10 rounded transition-colors"
            title="Delete"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// MARKETPLACE CARD COMPONENT
// ============================================================================

interface MarketplaceCardProps {
  server: MarketplaceServer;
  installed: boolean;
  onInstall: (server: MarketplaceServer) => void;
}

function MarketplaceCard({ server, installed, onInstall }: MarketplaceCardProps) {
  return (
    <div className="bg-surface-900 rounded-lg border border-surface-700 p-4">
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 bg-surface-700 rounded-lg flex items-center justify-center text-surface-300">
            {CATEGORY_ICONS[server.category]}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-medium text-surface-100">{server.name}</h3>
              {server.popular && (
                <span className="text-xs px-2 py-0.5 bg-accent-purple/20 text-accent-purple rounded">
                  Popular
                </span>
              )}
            </div>
            <p className="text-sm text-surface-400 mt-1">{server.description}</p>
            {server.requiredEnv && server.requiredEnv.length > 0 && (
              <p className="text-xs text-surface-500 mt-2">
                Requires: {server.requiredEnv.join(', ')}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {server.documentation && (
            <a
              href={server.documentation}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1.5 text-surface-400 hover:text-surface-200 hover:bg-surface-700 rounded transition-colors"
              title="Documentation"
            >
              <ExternalLink className="w-4 h-4" />
            </a>
          )}
          {installed ? (
            <span className="px-3 py-1.5 text-sm bg-green-400/20 text-green-400 rounded">
              Installed
            </span>
          ) : (
            <button
              onClick={() => onInstall(server)}
              className="px-3 py-1.5 text-sm bg-accent-purple text-white rounded hover:bg-accent-purple/80 transition-colors"
            >
              Install
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

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
      setTimeout(async () => {
        await window.goodvibes.setMCPServerStatus(id, 'connected');
        loadServers();
      }, 500);
    } catch (error) {
      logger.error('Failed to restart MCP server:', error);
    }
  };

  const handleDelete = async (id: number) => {
    if (confirm('Are you sure you want to delete this MCP server?')) {
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
            <ServerForm
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
                <ServerCard
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
              <div className="flex-1 relative">
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
                className="px-3 py-2 bg-surface-800 border border-surface-600 rounded-lg text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
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
                <MarketplaceCard
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
  );
}
