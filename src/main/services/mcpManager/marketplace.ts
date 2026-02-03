// ============================================================================
// MCP MARKETPLACE - Known MCP Servers Registry
// ============================================================================

import type { MarketplaceMCPServer } from './types.js';

// ============================================================================
// MARKETPLACE SERVER DEFINITIONS
// ============================================================================

export const MARKETPLACE_SERVERS: MarketplaceMCPServer[] = [
  {
    id: 'notion',
    name: 'Notion',
    description: 'Access and manage Notion workspaces, pages, and databases',
    category: 'productivity',
    transport: 'stdio',
    npmPackage: '@notionhq/mcp-server',
    command: 'npx',
    args: ['@notionhq/mcp-server'],
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
    command: 'npx',
    args: ['@github/mcp-server'],
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
    command: 'npx',
    args: ['@slack/mcp-server'],
    requiredEnv: ['SLACK_BOT_TOKEN'],
    documentation: 'https://api.slack.com/',
    popular: true,
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Query and manage PostgreSQL databases',
    category: 'database',
    transport: 'stdio',
    npmPackage: '@modelcontextprotocol/server-postgres',
    command: 'npx',
    args: ['@modelcontextprotocol/server-postgres'],
    requiredEnv: ['DATABASE_URL'],
    documentation: 'https://www.postgresql.org/docs/',
    popular: true,
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read and write files on the local filesystem',
    category: 'productivity',
    transport: 'stdio',
    npmPackage: '@modelcontextprotocol/server-filesystem',
    command: 'npx',
    args: ['@modelcontextprotocol/server-filesystem'],
    requiredEnv: [],
    documentation: 'https://modelcontextprotocol.io/servers/filesystem',
    popular: true,
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Search the web using Brave Search API',
    category: 'productivity',
    transport: 'stdio',
    npmPackage: '@modelcontextprotocol/server-brave-search',
    command: 'npx',
    args: ['@modelcontextprotocol/server-brave-search'],
    requiredEnv: ['BRAVE_API_KEY'],
    documentation: 'https://brave.com/search/api/',
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer',
    description: 'Automate browser interactions with Puppeteer',
    category: 'devops',
    transport: 'stdio',
    npmPackage: '@modelcontextprotocol/server-puppeteer',
    command: 'npx',
    args: ['@modelcontextprotocol/server-puppeteer'],
    requiredEnv: [],
    documentation: 'https://pptr.dev/',
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Query and manage SQLite databases',
    category: 'database',
    transport: 'stdio',
    npmPackage: '@modelcontextprotocol/server-sqlite',
    command: 'npx',
    args: ['@modelcontextprotocol/server-sqlite'],
    requiredEnv: ['SQLITE_DB_PATH'],
    documentation: 'https://www.sqlite.org/docs.html',
  },
  {
    id: 'memory',
    name: 'Memory',
    description: 'Persistent memory store for conversations',
    category: 'productivity',
    transport: 'stdio',
    npmPackage: '@modelcontextprotocol/server-memory',
    command: 'npx',
    args: ['@modelcontextprotocol/server-memory'],
    requiredEnv: [],
    documentation: 'https://modelcontextprotocol.io/servers/memory',
  },
];

// ============================================================================
// MARKETPLACE OPERATIONS
// ============================================================================

/**
 * Get all marketplace servers
 */
export function getMarketplaceServers(): MarketplaceMCPServer[] {
  return MARKETPLACE_SERVERS;
}

/**
 * Get marketplace server by ID
 */
export function getMarketplaceServer(id: string): MarketplaceMCPServer | undefined {
  return MARKETPLACE_SERVERS.find(s => s.id === id);
}

/**
 * Get popular marketplace servers
 */
export function getPopularServers(): MarketplaceMCPServer[] {
  return MARKETPLACE_SERVERS.filter(s => s.popular);
}

/**
 * Get servers by category
 */
export function getServersByCategory(
  category: MarketplaceMCPServer['category']
): MarketplaceMCPServer[] {
  return MARKETPLACE_SERVERS.filter(s => s.category === category);
}

/**
 * Validate required environment variables for a marketplace server
 */
export function validateRequiredEnv(
  marketplace: MarketplaceMCPServer,
  env: Record<string, string>
): string | null {
  for (const required of marketplace.requiredEnv || []) {
    if (!env[required]) {
      return required;
    }
  }
  return null;
}
