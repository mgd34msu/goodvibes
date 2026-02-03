// ============================================================================
// MCP MANAGER SERVICE - Main Service Class
// ============================================================================

import { EventEmitter } from 'events';
import { Logger } from '../logger.js';
import type { MCPServer } from '../../database/primitives.js';
import type {
  MCPServerConfig,
  MCPServerInfo,
  MCPProjectConfig,
  MarketplaceMCPServer,
} from './types.js';

// Import server management operations
import * as serverManagement from './serverManagement.js';

// Import server lifecycle operations
import * as serverLifecycle from './serverLifecycle.js';

// Import Claude config operations
import * as claudeConfig from './claudeConfig.js';

// Import marketplace operations
import * as marketplace from './marketplace.js';

const logger = new Logger('MCPManager');

// ============================================================================
// MCP MANAGER SERVICE
// ============================================================================

export class MCPManagerService extends EventEmitter {
  private runningServers: Map<number, MCPServerInfo> = new Map();

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  // ==========================================================================
  // SERVER MANAGEMENT
  // ==========================================================================

  addServer(config: MCPServerConfig): MCPServer {
    return serverManagement.addServer(config, this);
  }

  getServer(id: number): MCPServer | null {
    return serverManagement.getServer(id);
  }

  getAllServers(scope?: 'user' | 'project', projectPath?: string): MCPServer[] {
    return serverManagement.getServers(scope, projectPath);
  }

  updateServer(id: number, updates: Partial<MCPServer>): void {
    serverManagement.updateServer(id, updates, this);
  }

  deleteServer(id: number): void {
    serverManagement.deleteServer(id, this, (serverId) => this.stopServer(serverId));
  }

  setServerEnabled(id: number, enabled: boolean): void {
    serverManagement.setServerEnabled(id, enabled, this, (serverId) => this.stopServer(serverId));
  }

  // ==========================================================================
  // SERVER LIFECYCLE
  // ==========================================================================

  async startServer(id: number): Promise<boolean> {
    return serverLifecycle.startServer(id, this.runningServers, this);
  }

  stopServer(id: number): void {
    serverLifecycle.stopServer(id, this.runningServers, this);
  }

  stopAllServers(): void {
    serverLifecycle.stopAllServers(this.runningServers, this);
  }

  async restartServer(id: number): Promise<boolean> {
    return serverLifecycle.restartServer(id, this.runningServers, this);
  }

  getRunningServerInfo(id: number): MCPServerInfo | undefined {
    return this.runningServers.get(id);
  }

  getRunningServers(): MCPServerInfo[] {
    return Array.from(this.runningServers.values());
  }

  // ==========================================================================
  // CLAUDE CONFIG INTEGRATION
  // ==========================================================================

  async readMCPConfig(projectPath: string): Promise<MCPProjectConfig | null> {
    return claudeConfig.readMCPConfig(projectPath);
  }

  async writeMCPConfig(projectPath: string, config: MCPProjectConfig): Promise<void> {
    return claudeConfig.writeMCPConfig(projectPath, config);
  }

  async readUserClaudeConfig(): Promise<Record<string, unknown> | null> {
    return claudeConfig.readUserClaudeConfig();
  }

  async syncToClaudeConfig(projectPath?: string): Promise<void> {
    return claudeConfig.syncToClaudeConfig(projectPath);
  }

  // ==========================================================================
  // MARKETPLACE
  // ==========================================================================

  getMarketplaceServers(): MarketplaceMCPServer[] {
    return marketplace.getMarketplaceServers();
  }

  getMarketplaceServer(id: string): MarketplaceMCPServer | undefined {
    return marketplace.getMarketplaceServer(id);
  }

  getPopularServers(): MarketplaceMCPServer[] {
    return marketplace.getPopularServers();
  }

  getServersByCategory(category: MarketplaceMCPServer['category']): MarketplaceMCPServer[] {
    return marketplace.getServersByCategory(category);
  }

  async installMarketplaceServer(
    marketplaceId: string,
    env: Record<string, string> = {},
    scope: 'user' | 'project' = 'user',
    projectPath?: string
  ): Promise<MCPServer | null> {
    const marketplaceServer = this.getMarketplaceServer(marketplaceId);
    if (!marketplaceServer) {
      logger.error(`Marketplace server not found: ${marketplaceId}`);
      return null;
    }

    // Validate required env vars
    const missingEnv = marketplace.validateRequiredEnv(marketplaceServer, env);
    if (missingEnv) {
      logger.error(`Missing required environment variable: ${missingEnv}`);
      throw new Error(`Missing required environment variable: ${missingEnv}`);
    }

    // Install npm package if needed
    if (marketplaceServer.npmPackage) {
      logger.info(`Installing npm package: ${marketplaceServer.npmPackage}`);
      // Note: In a real implementation, you might want to actually run npm install
      // For now, we assume npx will handle it
    }

    // Create server entry
    const server = this.addServer({
      name: marketplaceServer.name,
      description: marketplaceServer.description,
      transport: marketplaceServer.transport,
      command: marketplaceServer.command,
      args: marketplaceServer.args,
      env,
      scope,
      projectPath,
    });

    logger.info(`Installed marketplace server: ${marketplaceServer.name}`);
    return server;
  }

  // ==========================================================================
  // SHUTDOWN
  // ==========================================================================

  shutdown(): void {
    this.stopAllServers();
    this.removeAllListeners();
    logger.info('MCP Manager shut down');
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let mcpManager: MCPManagerService | null = null;

export function getMCPManager(): MCPManagerService {
  if (!mcpManager) {
    mcpManager = new MCPManagerService();
  }
  return mcpManager;
}

export function shutdownMCPManager(): void {
  if (mcpManager) {
    mcpManager.shutdown();
    mcpManager = null;
  }
}
