// ============================================================================
// MCP MARKETPLACE CARD - Premium Glass Morphism Design
// ============================================================================

import React from 'react';
import {
  ExternalLink,
  Package,
  Zap,
  Database,
  MessageSquare,
  Wrench,
  CheckCircle,
  Download,
  Sparkles,
} from 'lucide-react';

// ============================================================================
// TYPES
// ============================================================================

export interface MarketplaceServer {
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
  repository?: string;
  popular?: boolean;
  featured?: boolean;
  vibes?: 'good' | 'great' | 'immaculate';
}

// ============================================================================
// CONSTANTS
// ============================================================================

interface CategoryConfig {
  icon: React.ReactNode;
  iconClass: string;
}

const CATEGORY_CONFIG: Record<string, CategoryConfig> = {
  productivity: {
    icon: <Zap className="w-5 h-5" />,
    iconClass: 'card-icon',
  },
  devops: {
    icon: <Wrench className="w-5 h-5" />,
    iconClass: 'card-icon',
  },
  communication: {
    icon: <MessageSquare className="w-5 h-5" />,
    iconClass: 'card-icon',
  },
  database: {
    icon: <Database className="w-5 h-5" />,
    iconClass: 'card-icon',
  },
  custom: {
    icon: <Package className="w-5 h-5" />,
    iconClass: 'card-icon',
  },
};

// Marketplace data
export const MARKETPLACE_SERVERS: MarketplaceServer[] = [
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
// MARKETPLACE CARD COMPONENT
// ============================================================================

interface MarketplaceCardProps {
  server: MarketplaceServer;
  installed: boolean;
  onInstall: (server: MarketplaceServer) => void;
}

const DEFAULT_CATEGORY: CategoryConfig = {
  icon: <Package className="w-5 h-5" />,
  iconClass: 'card-icon',
};

export function MCPMarketplaceCard({ server, installed, onInstall }: MarketplaceCardProps): React.JSX.Element {
  const categoryConfig: CategoryConfig = CATEGORY_CONFIG[server.category] ?? DEFAULT_CATEGORY;
  const isFeatured = server.featured;

  // Featured card gets special rainbow treatment
  const cardClasses = isFeatured
    ? `card-hover card-featured group ${installed ? 'card-selected' : ''}`
    : `card-hover group ${installed ? 'card-selected' : ''}`;

  // Featured items use sparkles icon with special styling
  const iconElement = isFeatured ? (
    <div className="card-icon card-icon-featured">
      <Sparkles className="w-5 h-5" />
    </div>
  ) : (
    <div className={categoryConfig.iconClass}>
      {categoryConfig.icon}
    </div>
  );

  return (
    <div className={cardClasses}>
      {/* Main Content */}
      <div className="flex items-start justify-between gap-4">
        {/* Left Section: Icon + Info */}
        <div className="flex items-start gap-3 flex-1 min-w-0">
          {/* Icon */}
          {iconElement}

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className={isFeatured ? "card-title-rainbow text-base" : "card-title-gradient text-base"}>
                {server.name}
              </h3>
              {isFeatured && server.vibes && (
                <span className="card-badge card-badge-rainbow">
                  <Sparkles className="w-3 h-3" />
                  {server.vibes} vibes
                </span>
              )}
              {server.popular && !isFeatured && (
                <span className="card-badge card-badge-primary card-badge-pulse">
                  Popular
                </span>
              )}
            </div>
            <p className="card-description line-clamp-2">{server.description}</p>
            {server.requiredEnv && server.requiredEnv.length > 0 && (
              <div className="card-meta mt-3">
                <span className="card-meta-item text-warning-400">
                  Requires: {server.requiredEnv.join(', ')}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Right Section: Actions */}
        <div className="card-actions">
          {server.documentation && (
            <a
              href={server.documentation}
              target="_blank"
              rel="noopener noreferrer"
              className="card-action-btn card-action-btn-primary"
              title="Documentation"
            >
              <ExternalLink className="w-4 h-4" />
            </a>
          )}
          {installed ? (
            <span className="card-badge card-badge-success">
              <CheckCircle className="w-3 h-3" />
              Installed
            </span>
          ) : (
            <button
              onClick={() => onInstall(server)}
              className={isFeatured ? "card-action-rainbow" : "card-action-primary"}
            >
              <Download className="w-3.5 h-3.5" />
              Install
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default MCPMarketplaceCard;
