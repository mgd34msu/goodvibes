// ============================================================================
// MCP MANAGER SERVICE - Model Context Protocol Server Management
// ============================================================================
//
// This file re-exports from the modular mcpManager/ directory for backward
// compatibility. All functionality has been split into:
//
// - mcpManager/types.ts        - Type definitions
// - mcpManager/marketplace.ts  - Marketplace server data and operations
// - mcpManager/serverManagement.ts - Add/update/delete operations
// - mcpManager/serverLifecycle.ts  - Start/stop/restart operations
// - mcpManager/claudeConfig.ts - Claude config file integration
// - mcpManager/service.ts      - Main MCPManagerService class
// - mcpManager/index.ts        - Module exports
//
// ============================================================================

export {
  // Types
  type MCPServerConfig,
  type MCPTool,
  type MCPServerInfo,
  type MCPProjectConfig,
  type MarketplaceMCPServer,

  // Service class and singleton functions
  MCPManagerService,
  getMCPManager,
  shutdownMCPManager,
} from './mcpManager/index.js';
