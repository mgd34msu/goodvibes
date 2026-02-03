// ============================================================================
// ANALYTICS TYPES - Analytics, tools, and project analytics types
// ============================================================================

// ============================================================================
// Analytics Types
// ============================================================================

export interface Analytics {
  totalSessions: number;
  totalTokens: number;
  totalCost: number;
  dailyCost: number;
  avgTokensPerSession: number;
  costByProject: Record<string, number>;
  sessionsOverTime: SessionTimeData[];
  messageCount: number;
  totalMessages: number;
  messagesToday?: number;
  totalSubagents: number;
  favoriteCount: number;
}

export interface SessionTimeData {
  date: string;
  count: number;
  tokens: number;
  cost: number;
}

export interface ToolUsageStat {
  toolName: string;
  totalCount: number;
  lastUsed: string;
}

// ============================================================================
// Project Registry Types
// ============================================================================

/**
 * Registered project in the registry
 */
export interface RegisteredProject {
  id: number;
  path: string;
  name: string;
  description: string | null;
  lastOpened: string;
  settings: ProjectSettings;
  createdAt: string;
  updatedAt: string;
}

/**
 * Project-specific settings stored as JSON
 */
export interface ProjectSettings {
  defaultModel?: string;
  permissionMode?: 'default' | 'strict' | 'permissive';
  budgetLimitUsd?: number;
  autoInjectClaudeMd?: boolean;
  claudeMdTemplate?: string;
  enabledHooks?: string[];
  enabledMCPServers?: string[];
  customEnv?: Record<string, string>;
  tags?: string[];
  priority?: number;
}

/**
 * Project template for quick project setup
 */
export interface ProjectTemplate {
  id: number;
  name: string;
  description: string | null;
  settings: ProjectSettings;
  agents: TemplateAgent[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Agent configuration within a template
 */
export interface TemplateAgent {
  agentId: number;
  priority: number;
  settings: Record<string, unknown>;
}

/**
 * Project analytics summary
 */
export interface ProjectAnalytics {
  projectId: number;
  projectPath: string;
  projectName: string;
  totalSessions: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCostUsd: number;
  avgSessionDuration: number;
  avgTokensPerSession: number;
  avgCostPerSession: number;
  successRate: number;
  lastActivity: string | null;
}
