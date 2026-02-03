// ============================================================================
// AGENCY INDEX DATABASE - Shared Types
// ============================================================================

// ============================================================================
// DATABASE ROW TYPES (Raw SQLite rows before mapping)
// ============================================================================

/** Raw row from agency_categories table */
export interface CategoryRow {
  id: number;
  name: string;
  path: string;
  parent_id: number | null;
  type: 'agent' | 'skill';
  item_count: number;
  created_at: string;
  updated_at: string;
}

/** Raw row from indexed_agents table */
export interface IndexedAgentRow {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  content: string;
  category_id: number;
  category_path: string;
  file_path: string;
  skills: string;
  tags: string;
  use_count: number;
  last_used: string | null;
  last_indexed: string;
  created_at: string;
  updated_at: string;
  rank?: number; // For FTS results
}

/** Raw row from indexed_skills table */
export interface IndexedSkillRow {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  content: string;
  category_id: number;
  category_path: string;
  file_path: string;
  agent_slug: string | null;
  triggers: string;
  tags: string;
  use_count: number;
  last_used: string | null;
  last_indexed: string;
  created_at: string;
  updated_at: string;
  rank?: number; // For FTS results
}

/** Raw row from active_agents table */
export interface ActiveAgentRow {
  id: number;
  session_id: string | null;
  project_path: string | null;
  agent_id: number;
  priority: number;
  activated_at: string;
  deactivated_at: string | null;
  is_active: number; // SQLite stores boolean as 0/1
}

/** Raw row from queued_skills table */
export interface QueuedSkillRow {
  id: number;
  session_id: string | null;
  project_path: string | null;
  skill_id: number;
  priority: number;
  injected: number; // SQLite stores boolean as 0/1
  injected_at: string | null;
  queued_at: string;
}

// ============================================================================
// MAPPED TYPES
// ============================================================================

/**
 * Category in the agent/skill hierarchy
 */
export interface AgencyCategory {
  id: number;
  name: string;
  path: string;  // e.g., "webdev/ai-ml" or "webdev/backend"
  parentId: number | null;
  type: 'agent' | 'skill';
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Indexed agent from agency directory
 */
export interface IndexedAgent {
  id: number;
  name: string;
  slug: string;  // File name without extension
  description: string | null;
  content: string;  // Full markdown content
  categoryId: number;
  categoryPath: string;  // e.g., "webdev/ai-ml"
  filePath: string;  // Absolute path to the .md file
  skills: string[];  // Related skill slugs (JSON array)
  tags: string[];  // Extracted tags (JSON array)
  useCount: number;
  lastUsed: string | null;
  lastIndexed: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Indexed skill from agency directory
 */
export interface IndexedSkill {
  id: number;
  name: string;
  slug: string;  // Directory name containing SKILL.md
  description: string | null;
  content: string;  // Full SKILL.md content
  categoryId: number;
  categoryPath: string;  // e.g., "webdev/ai-ml/implementing-anthropic-patterns"
  filePath: string;  // Absolute path to the SKILL.md file
  agentSlug: string | null;  // Related agent if any
  triggers: string[];  // Trigger keywords (JSON array)
  tags: string[];  // Extracted tags (JSON array)
  useCount: number;
  lastUsed: string | null;
  lastIndexed: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Active agent configuration for a session
 */
export interface ActiveAgent {
  id: number;
  sessionId: string | null;  // null for global activation
  projectPath: string | null;
  agentId: number;
  priority: number;  // Higher = processed first
  activatedAt: string;
  deactivatedAt: string | null;
  isActive: boolean;
}

/**
 * Queued skill for injection
 */
export interface QueuedSkill {
  id: number;
  sessionId: string | null;
  projectPath: string | null;
  skillId: number;
  priority: number;
  injected: boolean;
  injectedAt: string | null;
  queuedAt: string;
}

/**
 * Search result with relevance score
 */
export interface SearchResult<T> {
  item: T;
  score: number;
  matchedFields: string[];
}
