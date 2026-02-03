// ============================================================================
// DATABASE PRIMITIVES - Shared Types
// ============================================================================

// ============================================================================
// DATABASE ROW TYPES (Raw SQLite rows before mapping)
// ============================================================================

/** Raw row from agent_templates table */
export interface AgentTemplateRow {
  id: string;
  name: string;
  description: string | null;
  cwd: string | null;
  initial_prompt: string | null;
  claude_md_content: string | null;
  flags: string;
  model: string | null;
  permission_mode: 'default' | 'plan' | 'bypassPermissions' | null;
  allowed_tools: string | null;
  denied_tools: string | null;
  created_at: string;
  updated_at: string;
}

/** Raw row from hooks table */
export interface HookRow {
  id: number;
  name: string;
  event_type: string;
  matcher: string | null;
  command: string;
  timeout: number;
  enabled: number;
  scope: 'user' | 'project';
  project_path: string | null;
  execution_count: number;
  last_executed: string | null;
  last_result: 'success' | 'failure' | 'timeout' | null;
  created_at: string;
  updated_at: string;
  hook_type: 'command' | 'prompt';
  prompt: string | null;
}

/** Raw row from mcp_servers table */
export interface MCPServerRow {
  id: number;
  name: string;
  description: string | null;
  transport: 'stdio' | 'http';
  command: string | null;
  url: string | null;
  args: string;
  env: string;
  scope: 'user' | 'project';
  project_path: string | null;
  enabled: number;
  status: 'connected' | 'disconnected' | 'error' | 'unknown';
  last_connected: string | null;
  error_message: string | null;
  tool_count: number;
  created_at: string;
  updated_at: string;
}

/** Raw row from agent_registry table */
export interface AgentRecordRow {
  id: string;
  name: string;
  pid: number | null;
  cwd: string;
  parent_id: string | null;
  template_id: string | null;
  status: string;
  session_path: string | null;
  initial_prompt: string | null;
  spawned_at: string;
  last_activity: string;
  completed_at: string | null;
  exit_code: number | null;
  error_message: string | null;
}

/** Raw row from skills table */
export interface SkillRow {
  id: number;
  name: string;
  description: string | null;
  content: string;
  allowed_tools: string | null;
  scope: 'user' | 'project';
  project_path: string | null;
  use_count: number;
  last_used: string | null;
  created_at: string;
  updated_at: string;
}

/** Raw row from task_definitions table */
export interface TaskDefinitionRow {
  id: number;
  name: string;
  description: string | null;
  template_id: string | null;
  prompt: string;
  schedule: string | null;
  enabled: number;
  last_run: string | null;
  last_result: 'success' | 'failure' | null;
  run_count: number;
  created_at: string;
  updated_at: string;
}

/** Raw row from project_configs table */
export interface ProjectConfigRow {
  project_path: string;
  default_template_id: string | null;
  settings: string;
  hooks: string;
  mcp_servers: string;
  claude_md_override: string | null;
  created_at: string;
  updated_at: string;
}

/** Raw row from session_analytics table */
export interface SessionAnalyticsRow {
  session_id: string;
  success_score: number | null;
  iteration_count: number;
  tool_efficiency: number | null;
  context_usage_peak: number | null;
  estimated_roi: number | null;
  tags_auto: string;
  outcome_analysis: string | null;
  created_at: string;
  updated_at: string;
}

/** Raw row from tool_usage_detailed table */
export interface ToolUsageDetailedRow {
  id: number;
  session_id: string | null;
  tool_name: string;
  tool_input: string | null;
  tool_result_preview: string | null;
  success: number;
  duration_ms: number | null;
  token_cost: number | null;
  timestamp: string;
}

/** Raw row from tool efficiency stats query */
export interface ToolEfficiencyRow {
  tool_name: string;
  total_calls: number;
  success_rate: number;
  avg_duration: number | null;
  total_tokens: number;
}

// ============================================================================
// MAPPED TYPES
// ============================================================================

export interface AgentTemplate {
  id: string;
  name: string;
  description: string | null;
  cwd: string | null;
  initialPrompt: string | null;
  claudeMdContent: string | null;
  flags: string[]; // JSON array in DB
  model: string | null;
  permissionMode: 'default' | 'plan' | 'bypassPermissions' | null;
  allowedTools: string[] | null; // JSON array
  deniedTools: string[] | null; // JSON array
  createdAt: string;
  updatedAt: string;
}

export interface ProjectConfig {
  projectPath: string;
  defaultTemplateId: string | null;
  settings: Record<string, unknown>; // JSON object
  hooks: HookConfig[];
  mcpServers: string[]; // IDs of MCP servers
  claudeMdOverride: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HookConfig {
  id: number;
  name: string;
  eventType: HookEventType;
  matcher: string | null;
  command: string;
  timeout: number;
  enabled: boolean;
  scope: 'user' | 'project';
  projectPath: string | null;
  executionCount: number;
  lastExecuted: string | null;
  lastResult: 'success' | 'failure' | 'timeout' | null;
  createdAt: string;
  updatedAt: string;
  hookType: 'command' | 'prompt';
  prompt: string | null;
}

export type HookEventType =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Notification'
  | 'Stop';

export interface MCPServer {
  id: number;
  name: string;
  description: string | null;
  transport: 'stdio' | 'http';
  command: string | null;
  url: string | null;
  args: string[]; // JSON array
  env: Record<string, string>; // JSON object
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

export interface AgentRecord {
  id: string;
  name: string;
  pid: number | null;
  cwd: string;
  parentId: string | null;
  templateId: string | null;
  status: AgentStatus;
  sessionPath: string | null;
  initialPrompt: string | null;
  spawnedAt: string;
  lastActivity: string;
  completedAt: string | null;
  exitCode: number | null;
  errorMessage: string | null;
}

export type AgentStatus =
  | 'spawning'
  | 'ready'
  | 'active'
  | 'idle'
  | 'completed'
  | 'error'
  | 'terminated';

export interface Skill {
  id: number;
  name: string;
  description: string | null;
  content: string; // SKILL.md content
  allowedTools: string[] | null;
  scope: 'user' | 'project';
  projectPath: string | null;
  useCount: number;
  lastUsed: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDefinition {
  id: number;
  name: string;
  description: string | null;
  templateId: string | null;
  prompt: string;
  schedule: string | null; // cron expression
  enabled: boolean;
  lastRun: string | null;
  lastResult: 'success' | 'failure' | null;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionAnalytics {
  sessionId: string;
  successScore: number | null;
  iterationCount: number;
  toolEfficiency: number | null;
  contextUsagePeak: number | null;
  estimatedRoi: number | null;
  tagsAuto: string[];
  outcomeAnalysis: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DetailedToolUsage {
  id: number;
  sessionId: string | null;
  toolName: string;
  toolInput: string | null;
  toolResultPreview: string | null;
  success: boolean;
  durationMs: number | null;
  tokenCost: number | null;
  timestamp: string;
}
