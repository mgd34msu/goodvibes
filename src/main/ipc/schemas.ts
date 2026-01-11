// ============================================================================
// IPC INPUT VALIDATION SCHEMAS - Zod-based validation for IPC handlers
// ============================================================================
//
// This module provides comprehensive input validation for all IPC handlers
// using Zod schemas. This ensures type safety and prevents injection attacks.
// ============================================================================

import { z } from 'zod';

// ============================================================================
// PRIMITIVE SCHEMAS
// ============================================================================

/**
 * Session ID schema - validates UUID or agent-* format
 */
export const sessionIdSchema = z.string()
  .min(1, 'Session ID is required')
  .max(100, 'Session ID too long')
  .refine(
    (val) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val) ||
             /^agent-[a-z0-9]+$/i.test(val),
    { message: 'Invalid session ID format' }
  );

/**
 * Numeric ID schema - positive integer
 */
export const numericIdSchema = z.number()
  .int('ID must be an integer')
  .positive('ID must be positive');

/**
 * File path schema - validates against path traversal attacks
 */
export const filePathSchema = z.string()
  .min(1, 'Path is required')
  .max(1000, 'Path too long')
  .refine(
    (val) => !val.includes('..'),
    { message: 'Path traversal not allowed' }
  );

/**
 * Optional file path schema
 */
export const optionalFilePathSchema = filePathSchema.optional();

/**
 * Hex color schema
 */
export const hexColorSchema = z.string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Invalid hex color format');

// ============================================================================
// TERMINAL SCHEMAS
// ============================================================================

/**
 * Terminal start options schema
 */
export const terminalStartOptionsSchema = z.object({
  cwd: filePathSchema.optional(),
  name: z.string().max(200).optional(),
  resumeSessionId: sessionIdSchema.optional(),
  sessionType: z.enum(['user', 'subagent']).optional(),
});

/**
 * Terminal input schema
 */
export const terminalInputSchema = z.object({
  id: z.number().int().nonnegative(),
  data: z.string(),
});

/**
 * Terminal resize schema
 */
export const terminalResizeSchema = z.object({
  id: z.number().int().nonnegative(),
  cols: z.number().int().positive().max(500),
  rows: z.number().int().positive().max(200),
});

// ============================================================================
// SETTINGS SCHEMAS
// ============================================================================

/**
 * Setting key schema - alphanumeric with some special chars
 */
export const settingKeySchema = z.string()
  .min(1, 'Setting key is required')
  .max(100, 'Setting key too long')
  .regex(/^[a-zA-Z][a-zA-Z0-9_.]*$/, 'Invalid setting key format');

/**
 * Setting update schema
 */
export const settingUpdateSchema = z.object({
  key: settingKeySchema,
  value: z.unknown(), // Allow any JSON-serializable value
});

// ============================================================================
// COLLECTION SCHEMAS
// ============================================================================

/**
 * Collection creation schema
 */
export const createCollectionSchema = z.object({
  name: z.string().min(1).max(100),
  color: hexColorSchema.optional(),
  icon: z.string().max(10).optional(),
});

/**
 * Collection update schema
 */
export const updateCollectionSchema = z.object({
  id: numericIdSchema,
  name: z.string().min(1).max(100),
  color: hexColorSchema,
  icon: z.string().max(10),
});

/**
 * Session-collection association schema
 */
export const sessionCollectionSchema = z.object({
  sessionId: sessionIdSchema,
  collectionId: numericIdSchema,
});

/**
 * Smart collection rule schema
 */
export const smartCollectionRuleSchema = z.object({
  field: z.enum(['projectName', 'messageCount', 'tokenCount', 'cost', 'customTitle', 'tags']),
  operator: z.enum(['contains', 'equals', 'startsWith', 'endsWith', 'greaterThan', 'lessThan', 'hasTag']),
  value: z.union([z.string(), z.number()]),
});

/**
 * Smart collection creation schema
 */
export const createSmartCollectionSchema = z.object({
  name: z.string().min(1).max(100),
  rules: z.array(smartCollectionRuleSchema).min(1),
  color: hexColorSchema.optional(),
  icon: z.string().max(10).optional(),
  matchMode: z.enum(['all', 'any']).optional(),
});

// ============================================================================
// TAG SCHEMAS
// ============================================================================

/**
 * Tag creation schema
 */
export const createTagSchema = z.object({
  name: z.string().min(1).max(50),
  color: hexColorSchema,
});

/**
 * Session-tag association schema
 */
export const sessionTagSchema = z.object({
  sessionId: sessionIdSchema,
  tagId: numericIdSchema,
});

// ============================================================================
// PROMPT SCHEMAS
// ============================================================================

/**
 * Prompt save schema
 */
export const savePromptSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(50000),
  category: z.string().max(100).optional(),
});

// ============================================================================
// NOTES SCHEMAS
// ============================================================================

/**
 * Quick note creation schema
 */
export const createQuickNoteSchema = z.object({
  content: z.string().min(1).max(10000),
  sessionId: sessionIdSchema.optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
});

/**
 * Quick note update schema
 */
export const updateQuickNoteSchema = z.object({
  id: numericIdSchema,
  content: z.string().min(1).max(10000),
});

/**
 * Quick note status schema
 */
export const setQuickNoteStatusSchema = z.object({
  id: numericIdSchema,
  status: z.enum(['active', 'completed', 'archived']),
});

// ============================================================================
// NOTIFICATION SCHEMAS
// ============================================================================

/**
 * Get notifications schema
 */
export const getNotificationsSchema = z.object({
  includeRead: z.boolean().optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

// ============================================================================
// KNOWLEDGE SCHEMAS
// ============================================================================

/**
 * Knowledge entry creation schema
 */
export const createKnowledgeEntrySchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().min(1).max(100000),
  category: z.string().max(100).optional(),
  tags: z.string().max(500).optional(),
});

/**
 * Knowledge entry update schema
 */
export const updateKnowledgeEntrySchema = z.object({
  id: numericIdSchema,
  title: z.string().min(1).max(500),
  content: z.string().min(1).max(100000),
  category: z.string().max(100).optional(),
  tags: z.string().max(500).optional(),
});

// ============================================================================
// SEARCH SCHEMAS
// ============================================================================

/**
 * Search query schema
 */
export const searchQuerySchema = z.string().max(1000);

/**
 * Advanced search options schema
 */
export const advancedSearchOptionsSchema = z.object({
  query: z.string().max(1000).optional(),
  projectName: z.string().max(500).optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  minTokens: z.number().int().nonnegative().optional(),
  maxTokens: z.number().int().nonnegative().optional(),
  minCost: z.number().nonnegative().optional(),
  maxCost: z.number().nonnegative().optional(),
  tags: z.array(z.string()).optional(),
  sortBy: z.enum(['date', 'tokens', 'cost', 'messages']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  limit: z.number().int().positive().max(1000).optional(),
  offset: z.number().int().nonnegative().optional(),
});

/**
 * Save search schema
 */
export const saveSearchSchema = z.object({
  name: z.string().min(1).max(200),
  query: z.string().max(1000),
  filters: z.record(z.string(), z.unknown()).optional(),
});

// ============================================================================
// GIT SCHEMAS
// ============================================================================

/**
 * Git operation with cwd schema
 */
export const gitCwdSchema = filePathSchema;

/**
 * Git diff options schema
 */
export const gitDiffSchema = z.object({
  cwd: filePathSchema,
  staged: z.boolean().optional(),
});

/**
 * Git add schema
 */
export const gitAddSchema = z.object({
  cwd: filePathSchema,
  files: z.string().optional(),
});

/**
 * Git commit schema
 */
export const gitCommitSchema = z.object({
  cwd: filePathSchema,
  message: z.string().min(1).max(5000),
});

/**
 * Git stash schema
 */
export const gitStashSchema = z.object({
  cwd: filePathSchema,
  action: z.enum(['pop', 'list']).optional(),
});

/**
 * Git reset schema
 */
export const gitResetSchema = z.object({
  cwd: filePathSchema,
  files: z.array(z.string()).optional(),
});

/**
 * Git checkout schema
 */
export const gitCheckoutSchema = z.object({
  cwd: filePathSchema,
  branch: z.string().min(1).max(200),
});

/**
 * Git create branch schema
 */
export const gitCreateBranchSchema = z.object({
  cwd: filePathSchema,
  name: z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/, 'Invalid branch name'),
  checkout: z.boolean().optional(),
});

/**
 * Git stage/unstage schema
 */
export const gitStageSchema = z.object({
  cwd: filePathSchema,
  files: z.array(z.string()),
});

/**
 * Git log detailed schema
 */
export const gitLogDetailedSchema = z.object({
  cwd: filePathSchema,
  limit: z.number().int().positive().max(500).optional(),
});

/**
 * Git discard changes schema
 */
export const gitDiscardChangesSchema = z.object({
  cwd: filePathSchema,
  files: z.array(z.string()),
});

/**
 * Git clean file schema
 */
export const gitCleanFileSchema = z.object({
  cwd: filePathSchema,
  file: z.string(),
});

/**
 * Git show commit schema
 */
export const gitShowCommitSchema = z.object({
  cwd: filePathSchema,
  hash: z.string().regex(/^[a-f0-9]+$/i, 'Invalid commit hash'),
});

/**
 * Git file diff schema
 */
export const gitFileDiffSchema = z.object({
  cwd: filePathSchema,
  file: z.string().optional(),
  options: z.object({
    staged: z.boolean().optional(),
    commit: z.string().optional(),
  }).optional(),
});

/**
 * Git merge schema
 */
export const gitMergeSchema = z.object({
  cwd: filePathSchema,
  branch: z.string().min(1).max(200),
  options: z.object({
    noFf: z.boolean().optional(),
    squash: z.boolean().optional(),
  }).optional(),
});

/**
 * Git remote add schema
 */
export const gitRemoteAddSchema = z.object({
  cwd: filePathSchema,
  name: z.string().min(1).max(100),
  url: z.string().min(1).max(1000),
});

/**
 * Git remote remove schema
 */
export const gitRemoteRemoveSchema = z.object({
  cwd: filePathSchema,
  name: z.string().min(1).max(100),
});

/**
 * Git stash push schema
 */
export const gitStashPushSchema = z.object({
  cwd: filePathSchema,
  message: z.string().max(500).optional(),
});

/**
 * Git stash pop/apply/drop schema
 */
export const gitStashOperationSchema = z.object({
  cwd: filePathSchema,
  index: z.number().int().nonnegative().optional(),
});

/**
 * Git delete branch schema
 */
export const gitDeleteBranchSchema = z.object({
  cwd: filePathSchema,
  branch: z.string().min(1).max(200),
  options: z.object({
    force: z.boolean().optional(),
  }).optional(),
});

/**
 * Git delete remote branch schema
 */
export const gitDeleteRemoteBranchSchema = z.object({
  cwd: filePathSchema,
  remote: z.string().min(1).max(100),
  branch: z.string().min(1).max(200),
});

/**
 * Git commit amend schema
 */
export const gitCommitAmendSchema = z.object({
  cwd: filePathSchema,
  options: z.object({
    message: z.string().max(5000).optional(),
    noEdit: z.boolean().optional(),
  }).optional(),
});

/**
 * Git cherry-pick schema
 */
export const gitCherryPickSchema = z.object({
  cwd: filePathSchema,
  commit: z.string().regex(/^[a-f0-9]+$/i, 'Invalid commit hash'),
});

/**
 * Git rebase schema
 */
export const gitRebaseSchema = z.object({
  cwd: filePathSchema,
  onto: z.string().min(1).max(200),
});

/**
 * Git apply patch schema
 */
export const gitApplyPatchSchema = z.object({
  cwd: filePathSchema,
  patch: z.string().max(1000000), // 1MB limit for patch content
  options: z.object({
    cached: z.boolean().optional(),
    reverse: z.boolean().optional(),
  }).optional(),
});

/**
 * Git diff for staging schema
 */
export const gitDiffForStagingSchema = z.object({
  cwd: filePathSchema,
  file: z.string(),
  staged: z.boolean().optional(),
});

/**
 * Git blame schema
 */
export const gitBlameSchema = z.object({
  cwd: filePathSchema,
  file: z.string(),
  options: z.object({
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  }).optional(),
});

/**
 * Git create tag schema
 */
export const gitCreateTagSchema = z.object({
  cwd: filePathSchema,
  name: z.string().min(1).max(200),
  options: z.object({
    message: z.string().max(5000).optional(),
    commit: z.string().optional(),
  }).optional(),
});

/**
 * Git delete tag schema
 */
export const gitDeleteTagSchema = z.object({
  cwd: filePathSchema,
  name: z.string().min(1).max(200),
});

/**
 * Git push tag schema
 */
export const gitPushTagSchema = z.object({
  cwd: filePathSchema,
  name: z.string().min(1).max(200),
  remote: z.string().max(100).optional(),
});

/**
 * Git push all tags schema
 */
export const gitPushAllTagsSchema = z.object({
  cwd: filePathSchema,
  remote: z.string().max(100).optional(),
});

/**
 * Git file history schema
 */
export const gitFileHistorySchema = z.object({
  cwd: filePathSchema,
  file: z.string(),
  limit: z.number().int().positive().max(500).optional(),
});

/**
 * Git show file schema
 */
export const gitShowFileSchema = z.object({
  cwd: filePathSchema,
  file: z.string(),
  commit: z.string(),
});

/**
 * Git resolve file schema
 */
export const gitResolveFileSchema = z.object({
  cwd: filePathSchema,
  file: z.string(),
});

/**
 * Git mark resolved schema
 */
export const gitMarkResolvedSchema = z.object({
  cwd: filePathSchema,
  files: z.array(z.string()),
});

/**
 * Git reflog schema
 */
export const gitReflogSchema = z.object({
  cwd: filePathSchema,
  limit: z.number().int().positive().max(500).optional(),
});

/**
 * Git reset to reflog schema
 */
export const gitResetToReflogSchema = z.object({
  cwd: filePathSchema,
  index: z.number().int().nonnegative(),
  options: z.object({
    hard: z.boolean().optional(),
    soft: z.boolean().optional(),
  }).optional(),
});

/**
 * Git submodule init schema
 */
export const gitSubmoduleInitSchema = z.object({
  cwd: filePathSchema,
  path: z.string().optional(),
});

/**
 * Git submodule update schema
 */
export const gitSubmoduleUpdateSchema = z.object({
  cwd: filePathSchema,
  options: z.object({
    init: z.boolean().optional(),
    recursive: z.boolean().optional(),
    remote: z.boolean().optional(),
    path: z.string().optional(),
  }).optional(),
});

/**
 * Git worktree add schema
 */
export const gitWorktreeAddSchema = z.object({
  cwd: filePathSchema,
  path: filePathSchema,
  branch: z.string().max(200).optional(),
  options: z.object({
    newBranch: z.boolean().optional(),
    detach: z.boolean().optional(),
  }).optional(),
});

/**
 * Git worktree remove schema
 */
export const gitWorktreeRemoveSchema = z.object({
  cwd: filePathSchema,
  path: filePathSchema,
  force: z.boolean().optional(),
});

// ============================================================================
// EXPORT SCHEMAS
// ============================================================================

/**
 * Export session schema
 */
export const exportSessionSchema = z.object({
  sessionId: sessionIdSchema,
  format: z.enum(['markdown', 'json', 'html']),
});

/**
 * Bulk export schema
 */
export const bulkExportSchema = z.array(sessionIdSchema);

// ============================================================================
// RECENT PROJECTS SCHEMAS
// ============================================================================

/**
 * Add recent project schema
 */
export const addRecentProjectSchema = z.object({
  path: filePathSchema,
  name: z.string().max(200).optional(),
});

// ============================================================================
// ACTIVITY LOG SCHEMAS
// ============================================================================

/**
 * Log activity schema
 */
export const logActivitySchema = z.object({
  type: z.string().min(1).max(100),
  sessionId: sessionIdSchema.nullable(),
  description: z.string().min(1).max(5000),
  metadata: z.unknown().optional(),
});

// ============================================================================
// GITHUB SCHEMAS
// ============================================================================

/**
 * GitHub auth options schema
 */
export const githubAuthOptionsSchema = z.object({
  scopes: z.array(z.string().max(100)).optional(),
}).optional();

/**
 * GitHub repo params schema
 */
export const githubRepoParamsSchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
});

/**
 * GitHub list repos options schema
 */
export const githubListReposOptionsSchema = z.object({
  sort: z.enum(['created', 'updated', 'pushed', 'full_name']).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
  per_page: z.number().int().positive().max(100).optional(),
  page: z.number().int().positive().optional(),
}).optional();

/**
 * GitHub create repo schema
 */
export const githubCreateRepoSchema = z.object({
  name: z.string().min(1).max(100),
  options: z.object({
    description: z.string().max(1000).optional(),
    private: z.boolean().optional(),
    auto_init: z.boolean().optional(),
  }).optional(),
});

/**
 * GitHub list org repos schema
 */
export const githubListOrgReposSchema = z.object({
  org: z.string().min(1).max(100),
  options: githubListReposOptionsSchema,
});

/**
 * GitHub PR list options schema
 */
export const githubPRListOptionsSchema = z.object({
  state: z.enum(['open', 'closed', 'all']).optional(),
  sort: z.enum(['created', 'updated', 'popularity', 'long-running']).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
  per_page: z.number().int().positive().max(100).optional(),
  page: z.number().int().positive().optional(),
}).optional();

/**
 * GitHub list PRs schema
 */
export const githubListPRsSchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  options: githubPRListOptionsSchema,
});

/**
 * GitHub get PR schema
 */
export const githubGetPRSchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  number: z.number().int().positive(),
});

/**
 * GitHub create PR schema
 */
export const githubCreatePRSchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  data: z.object({
    title: z.string().min(1).max(500),
    body: z.string().max(65000).optional(),
    head: z.string().min(1).max(200),
    base: z.string().min(1).max(200),
    draft: z.boolean().optional(),
  }),
});

/**
 * GitHub merge PR schema
 */
export const githubMergePRSchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  number: z.number().int().positive(),
  options: z.object({
    commit_title: z.string().max(500).optional(),
    commit_message: z.string().max(65000).optional(),
    merge_method: z.enum(['merge', 'squash', 'rebase']).optional(),
  }).optional(),
});

/**
 * GitHub ref schema (for checks and status)
 */
export const githubRefSchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  ref: z.string().min(1).max(200),
});

/**
 * GitHub workflow runs options schema
 */
export const githubWorkflowRunsOptionsSchema = z.object({
  branch: z.string().max(200).optional(),
  event: z.string().max(100).optional(),
  status: z.enum(['queued', 'in_progress', 'completed']).optional(),
  per_page: z.number().int().positive().max(100).optional(),
  page: z.number().int().positive().optional(),
}).optional();

/**
 * GitHub list workflow runs schema
 */
export const githubListWorkflowRunsSchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  options: githubWorkflowRunsOptionsSchema,
});

/**
 * GitHub issues options schema
 */
export const githubIssuesOptionsSchema = z.object({
  state: z.enum(['open', 'closed', 'all']).optional(),
  sort: z.enum(['created', 'updated', 'comments']).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
  labels: z.string().max(500).optional(),
  per_page: z.number().int().positive().max(100).optional(),
  page: z.number().int().positive().optional(),
}).optional();

/**
 * GitHub list issues schema
 */
export const githubListIssuesSchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  options: githubIssuesOptionsSchema,
});

/**
 * GitHub create issue schema
 */
export const githubCreateIssueSchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  data: z.object({
    title: z.string().min(1).max(500),
    body: z.string().max(65000).optional(),
    assignees: z.array(z.string().max(100)).optional(),
    labels: z.array(z.string().max(100)).optional(),
  }),
});

/**
 * GitHub branches options schema
 */
export const githubBranchesOptionsSchema = z.object({
  protected_only: z.boolean().optional(),
  per_page: z.number().int().positive().max(100).optional(),
  page: z.number().int().positive().optional(),
}).optional();

/**
 * GitHub list branches schema
 */
export const githubListBranchesSchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  options: githubBranchesOptionsSchema,
});

/**
 * GitHub remote URL schema
 */
export const githubRemoteUrlSchema = z.object({
  remoteUrl: z.string().min(1).max(1000),
});

// ============================================================================
// HOOKS SCHEMAS
// ============================================================================

/**
 * Hook event type schema
 */
export const hookEventTypeSchema = z.enum([
  'session_start',
  'session_end',
  'commit_before',
  'commit_after',
  'push_before',
  'push_after',
  'pull_before',
  'pull_after',
  'branch_checkout',
  'file_change',
]);

/**
 * Hook creation schema
 */
export const createHookSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  eventType: hookEventTypeSchema,
  script: z.string().min(1).max(100000),
  enabled: z.boolean(),
  async: z.boolean().optional(),
  timeout: z.number().int().positive().max(300000).optional(), // 5 min max
  projectPath: z.string().max(1000).optional(),
});

/**
 * Hook update schema
 */
export const updateHookSchema = z.object({
  id: numericIdSchema,
  updates: createHookSchema.partial(),
});

/**
 * Get hooks by event schema
 */
export const getHooksByEventSchema = z.object({
  eventType: hookEventTypeSchema,
  projectPath: z.string().max(1000).optional(),
});

// ============================================================================
// MCP SERVER SCHEMAS
// ============================================================================

/**
 * MCP server creation schema
 */
export const createMCPServerSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  command: z.string().min(1).max(1000),
  args: z.array(z.string().max(1000)).optional(),
  env: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean(),
  autoStart: z.boolean().optional(),
});

/**
 * MCP server update schema
 */
export const updateMCPServerSchema = z.object({
  id: numericIdSchema,
  updates: createMCPServerSchema.partial(),
});

/**
 * MCP server status schema
 */
export const setMCPServerStatusSchema = z.object({
  id: numericIdSchema,
  status: z.enum(['connected', 'disconnected', 'error', 'connecting']),
  errorMessage: z.string().max(5000).optional(),
});

// ============================================================================
// AGENT TEMPLATE SCHEMAS
// ============================================================================

/**
 * Agent template creation schema
 */
export const createAgentTemplateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  systemPrompt: z.string().min(1).max(100000),
  model: z.string().max(100).optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  tools: z.array(z.string().max(200)).optional(),
  enabled: z.boolean(),
});

/**
 * Agent template update schema
 */
export const updateAgentTemplateSchema = z.object({
  id: z.string().min(1).max(100),
  updates: createAgentTemplateSchema.partial(),
});

// ============================================================================
// PROJECT CONFIG SCHEMAS
// ============================================================================

/**
 * Project config creation schema
 */
export const createProjectConfigSchema = z.object({
  projectPath: filePathSchema,
  defaultBranch: z.string().max(200).optional(),
  claudeConfig: z.record(z.string(), z.unknown()).optional(),
  hooks: z.array(z.number().int().positive()).optional(),
  agents: z.array(z.string()).optional(),
});

/**
 * Project config update schema
 */
export const updateProjectConfigSchema = z.object({
  projectPath: filePathSchema,
  updates: createProjectConfigSchema.partial(),
});

// ============================================================================
// AGENT REGISTRY SCHEMAS
// ============================================================================

/**
 * Agent status schema
 */
export const agentStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']);

/**
 * Agent registry entry creation schema
 */
export const createAgentRegistryEntrySchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  templateId: z.string().max(100).optional(),
  parentId: z.string().max(100).optional(),
  sessionId: sessionIdSchema.optional(),
  projectPath: filePathSchema.optional(),
  status: agentStatusSchema,
  task: z.string().max(10000).optional(),
});

/**
 * Agent registry entry update schema
 */
export const updateAgentRegistryEntrySchema = z.object({
  id: z.string().min(1).max(100),
  updates: z.object({
    status: agentStatusSchema.optional(),
    errorMessage: z.string().max(10000).optional(),
  }),
});

// ============================================================================
// SKILL SCHEMAS
// ============================================================================

/**
 * Skill creation schema
 */
export const createSkillSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  content: z.string().min(1).max(100000),
  category: z.string().max(100).optional(),
  tags: z.array(z.string().max(50)).optional(),
  enabled: z.boolean(),
});

/**
 * Skill update schema
 */
export const updateSkillSchema = z.object({
  id: numericIdSchema,
  updates: createSkillSchema.partial(),
});

// ============================================================================
// TASK DEFINITION SCHEMAS
// ============================================================================

/**
 * Task definition creation schema
 */
export const createTaskDefinitionSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  prompt: z.string().min(1).max(100000),
  category: z.string().max(100).optional(),
  agentTemplate: z.string().max(100).optional(),
  enabled: z.boolean(),
});

/**
 * Task definition update schema
 */
export const updateTaskDefinitionSchema = z.object({
  id: numericIdSchema,
  updates: createTaskDefinitionSchema.partial(),
});

// ============================================================================
// SESSION ANALYTICS SCHEMAS
// ============================================================================

/**
 * Session analytics creation schema
 */
export const createSessionAnalyticsSchema = z.object({
  sessionId: sessionIdSchema,
  totalMessages: z.number().int().nonnegative().optional(),
  userMessages: z.number().int().nonnegative().optional(),
  assistantMessages: z.number().int().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  errorCount: z.number().int().nonnegative().optional(),
  avgResponseTime: z.number().nonnegative().optional(),
});

/**
 * Session analytics update schema
 */
export const updateSessionAnalyticsSchema = z.object({
  sessionId: sessionIdSchema,
  updates: createSessionAnalyticsSchema.omit({ sessionId: true }),
});

// ============================================================================
// TOOL USAGE SCHEMAS
// ============================================================================

/**
 * Record tool usage schema
 */
export const recordToolUsageSchema = z.object({
  sessionId: sessionIdSchema,
  toolName: z.string().min(1).max(200),
  input: z.string().max(100000).optional(),
  output: z.string().max(100000).optional(),
  duration: z.number().nonnegative().optional(),
  success: z.boolean(),
  errorMessage: z.string().max(10000).optional(),
});

// ============================================================================
// CONTEXT MENU SCHEMAS
// ============================================================================

/**
 * Context menu options schema
 */
export const contextMenuOptionsSchema = z.object({
  hasSelection: z.boolean(),
  isEditable: z.boolean(),
  isTerminal: z.boolean().optional(),
});

/**
 * Terminal context menu options schema
 */
export const terminalContextMenuOptionsSchema = z.object({
  hasSelection: z.boolean(),
  selectedText: z.string().max(100000).optional(),
});

// ============================================================================
// CLIPBOARD SCHEMAS
// ============================================================================

/**
 * Clipboard write schema
 */
export const clipboardWriteSchema = z.string().max(10000000); // 10MB limit

// ============================================================================
// APP PATH SCHEMA
// ============================================================================

/**
 * App path name schema
 */
export const appPathNameSchema = z.enum([
  'home', 'appData', 'userData', 'sessionData', 'temp', 'exe',
  'module', 'desktop', 'documents', 'downloads', 'music',
  'pictures', 'videos', 'recent', 'logs', 'crashDumps',
]);
