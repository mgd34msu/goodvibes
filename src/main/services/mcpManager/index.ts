// ============================================================================
// MCP MANAGER - MODULE EXPORTS
// ============================================================================

// Re-export all types
export type {
  MCPServerConfig,
  MCPTool,
  MCPServerInfo,
  MCPProjectConfig,
  MarketplaceMCPServer,
  MCPServer,
} from './types.js';

// Re-export service class and singleton functions
export {
  MCPManagerService,
  getMCPManager,
  shutdownMCPManager,
} from './service.js';

// Re-export marketplace data for direct access if needed
export { MARKETPLACE_SERVERS } from './marketplace.js';
