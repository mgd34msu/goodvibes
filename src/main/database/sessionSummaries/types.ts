// ============================================================================
// SESSION SUMMARIES - Type definitions
// ============================================================================

// ============================================================================
// DATABASE ROW TYPES (Raw SQLite rows before mapping)
// ============================================================================

/** Raw row from session_summaries table */
export interface SessionSummaryRow {
  id: number;
  session_id: string;
  project_path: string;
  title: string;
  description: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number;
  status: 'completed' | 'aborted' | 'error';
  tool_calls: number;
  files_modified: number;
  files_created: number;
  tests_run: number;
  tests_passed: number;
  tests_failed: number;
  tokens_used: number;
  cost_usd: number;
  active_agent_ids: string;
  injected_skill_ids: string;
  key_topics: string;
  file_changes: string;
  last_prompt: string | null;
  context_snapshot: string | null;
  created_at: string;
  updated_at: string;
}

/** Raw row from session_checkpoints table */
export interface SessionCheckpointRow {
  id: number;
  session_id: string;
  checkpoint_name: string;
  context: string;
  created_at: string;
}

// ============================================================================
// TYPES
// ============================================================================

/**
 * Session summary record
 */
export interface SessionSummary {
  id: number;
  sessionId: string;
  projectPath: string;
  title: string;
  description: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  status: 'completed' | 'aborted' | 'error';

  // Metrics
  toolCalls: number;
  filesModified: number;
  filesCreated: number;
  testsRun: number;
  testsPassed: number;
  testsFailed: number;
  tokensUsed: number;
  costUsd: number;

  // Context
  activeAgentIds: string;  // JSON array
  injectedSkillIds: string;  // JSON array
  keyTopics: string;  // JSON array of extracted topics
  fileChanges: string;  // JSON array of file change summaries

  // Resumption
  lastPrompt: string | null;
  contextSnapshot: string | null;  // JSON object for resumption

  createdAt: string;
  updatedAt: string;
}

/**
 * Session checkpoint for resumption
 */
export interface SessionCheckpoint {
  id: number;
  sessionId: string;
  checkpointName: string;
  context: string;  // JSON snapshot
  createdAt: string;
}

/**
 * Session comparison result
 */
export interface SessionComparison {
  session1: SessionSummary;
  session2: SessionSummary;
  commonFiles: string[];
  session1OnlyFiles: string[];
  session2OnlyFiles: string[];
  durationDiff: number;
  costDiff: number;
  toolCallsDiff: number;
}
