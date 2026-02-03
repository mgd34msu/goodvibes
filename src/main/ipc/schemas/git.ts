// ============================================================================
// GIT SCHEMAS
// ============================================================================

import { z } from 'zod';
import { filePathSchema } from './primitives.js';

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
