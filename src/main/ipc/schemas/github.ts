// ============================================================================
// GITHUB SCHEMAS
// ============================================================================

import { z } from 'zod';

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
