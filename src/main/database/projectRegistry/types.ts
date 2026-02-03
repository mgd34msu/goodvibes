// ============================================================================
// PROJECT REGISTRY DATABASE - Shared Types
// ============================================================================

// ============================================================================
// DATABASE ROW TYPES (Raw SQLite rows before mapping)
// ============================================================================

/** Raw row from registered_projects table */
export interface RegisteredProjectRow {
  id: number;
  path: string;
  name: string;
  description: string | null;
  last_opened: string;
  settings: string;
  created_at: string;
  updated_at: string;
}

/** Raw row from project_agents table */
export interface ProjectAgentRow {
  id: number;
  project_id: number;
  agent_id: number;
  priority: number;
  settings: string;
  created_at: string;
  updated_at: string;
}

/** Raw row from project_templates table */
export interface ProjectTemplateRow {
  id: number;
  name: string;
  description: string | null;
  settings: string;
  agents: string;
  created_at: string;
  updated_at: string;
}

/** Raw row from cross_project_sessions table */
export interface CrossProjectSessionRow {
  id: number;
  session_id: string;
  project_id: number;
  agent_session_id: string | null;
  status: 'active' | 'completed' | 'failed';
  started_at: string;
  ended_at: string | null;
  tokens_used: number;
  cost_usd: number;
  metadata: string | null;
}

/** Raw row from analytics queries */
export interface AnalyticsStatsRow {
  total_sessions: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_cost: number;
  avg_duration: number;
  last_activity: string | null;
  completed_count: number;
}

/** Raw row for project analytics in global queries */
export interface ProjectAnalyticsRow {
  project_id: number;
  project_path: string;
  project_name: string;
  total_sessions: number;
  total_tokens: number;
  total_cost: number;
  last_activity: string | null;
}

/** Raw row for project distribution */
export interface ProjectDistributionRow {
  project_id: number;
  project_name: string;
  cost: number;
}

/** Raw row for recent activity */
export interface RecentActivityRow {
  project_id: number;
  project_name: string;
  last_activity: string;
}

/** Raw row for agent usage */
export interface AgentUsageRow {
  agent_id: number;
  project_id: number;
  project_name: string;
  session_count: number;
  total_cost: number;
}

/** Raw row for session distribution */
export interface SessionDistributionRow {
  project_id: number;
  project_name: string;
  session_count: number;
}

/** Raw row for global stats */
export interface GlobalStatsRow {
  total_projects: number;
  active_projects: number;
  total_tokens: number;
  total_cost: number;
  total_sessions: number;
}

// ============================================================================
// MAPPED TYPES
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
 * Agent assigned to a project
 */
export interface ProjectAgent {
  id: number;
  projectId: number;
  agentId: number;
  priority: number;
  settings: ProjectAgentSettings;
  createdAt: string;
  updatedAt: string;
}

/**
 * Project-specific agent settings
 */
export interface ProjectAgentSettings {
  autoActivate?: boolean;
  budgetAllocation?: number;
  customPrompt?: string;
  disabled?: boolean;
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
  settings?: ProjectAgentSettings;
}

/**
 * Cross-project session tracking entry
 */
export interface CrossProjectSession {
  id: number;
  sessionId: string;
  projectId: number;
  agentSessionId: string | null;
  status: 'active' | 'completed' | 'failed';
  startedAt: string;
  endedAt: string | null;
  tokensUsed: number;
  costUsd: number;
  metadata: string | null;
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

/**
 * Global analytics across all projects
 */
export interface GlobalAnalytics {
  totalProjects: number;
  activeProjects: number;
  totalSessions: number;
  totalTokens: number;
  totalCostUsd: number;
  avgCostPerProject: number;
  avgSessionsPerProject: number;
  topProjectsByCost: ProjectAnalytics[];
  topProjectsBySessions: ProjectAnalytics[];
  projectDistribution: { projectId: number; projectName: string; percentage: number }[];
  recentActivity: { projectId: number; projectName: string; lastActivity: string }[];
}
