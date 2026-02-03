// ============================================================================
// MCP MANAGER TYPES
// ============================================================================

import type { ChildProcess } from 'child_process';
import type { MCPServer } from '../../database/primitives.js';

// ============================================================================
// SERVER CONFIGURATION
// ============================================================================

export interface MCPServerConfig {
  name: string;
  description?: string;
  transport: 'stdio' | 'http';
  command?: string;
  url?: string;
  args?: string[];
  env?: Record<string, string>;
  scope?: 'user' | 'project';
  projectPath?: string;
}

// ============================================================================
// TOOLS
// ============================================================================

export interface MCPTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

// ============================================================================
// SERVER INFO
// ============================================================================

export interface MCPServerInfo {
  server: MCPServer;
  tools: MCPTool[];
  process?: ChildProcess;
  connected: boolean;
}

// ============================================================================
// PROJECT CONFIG
// ============================================================================

export interface MCPProjectConfig {
  mcpServers: Record<string, {
    command?: string;
    url?: string;
    args?: string[];
    env?: Record<string, string>;
  }>;
}

// ============================================================================
// MARKETPLACE
// ============================================================================

export interface MarketplaceMCPServer {
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

// Re-export MCPServer type for convenience
export type { MCPServer };
